/**
 * A user turn queued behind an active run must run the model the user selected
 * after it was queued, whichever surface made the selection.
 *
 * Production: the Control UI selected GPT-6 Luna and LINE's model-state answer
 * said Luna, yet the next ordinary LINE turn -- queued behind a busy run with
 * Qwen captured -- still requested Qwen.
 *
 * Real reply pipeline, follow-up queue and drain, SQLite session store,
 * sessions.patch handler and the LINE/Control UI model-control router; only
 * the embedded model call is controlled, so a turn stays genuinely in flight
 * while the selection changes.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { findModelCatalogEntry } from "../src/agents/model-catalog-lookup.js";
import { getExistingFollowupQueue } from "../src/auto-reply/reply/queue/state.js";
import { resolveStorePath } from "../src/config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createDeferred } from "../src/test-utils/deferred.js";
import {
  getRunEmbeddedAgentMock,
  installTriggerHandlingReplyHarness,
  makeCfg,
  withTempHome,
} from "./helpers/auto-reply/trigger-handling-test-harness.js";

type GetReplyFromConfig = typeof import("../src/auto-reply/reply.js").getReplyFromConfig;

// The harness's shared catalog mock predates the sessions.patch row projection.
Object.assign(
  (globalThis as Record<symbol, object>)[
    Symbol.for("openclaw.trigger-handling.model-catalog-mocks")
  ],
  { findModelCatalogEntry },
);

let getReply: GetReplyFromConfig | undefined;
installTriggerHandlingReplyHarness((impl) => {
  getReply = impl;
});

const OWNER_ID = "U-owner";
const QWEN = { provider: "openrouter", model: "qwen/qwen3.8-27b" };
const LUNA = { provider: "openrouter", model: "openai/gpt-6-luna" };
const ACCOUNT_CATALOG = [
  { id: "qwen/qwen3.8-27b", name: "Qwen: Qwen3.8 27B" },
  { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" },
];

// Follow-up queues are process-global per session key, so each case owns a group.
let groupCounter = 0;
function lineGroup() {
  groupCounter += 1;
  const groupId = `C${groupCounter.toString(16).padStart(32, "0")}`;
  return { groupId, sessionKey: `agent:main:line:group:${groupId.toLowerCase()}` };
}
type LineGroup = ReturnType<typeof lineGroup>;

function productionConfig(home: string): OpenClawConfig {
  const cfg = makeCfg(home);
  delete cfg.session;
  cfg.agents!.defaults!.model = {
    primary: "openrouter/qwen/qwen3.8-27b",
    fallbacks: ["openrouter/deepseek/deepseek-v4-flash-0731"],
  };
  cfg.agents!.defaults!.models = {
    "openrouter/*": {},
    "openrouter/qwen/qwen3.8-27b": {},
    "openrouter/deepseek/deepseek-v4-flash-0731": {},
  };
  cfg.channels = {
    ...cfg.channels,
    line: { groupPolicy: "open", groups: { "*": { requireMention: false } } },
  } as OpenClawConfig["channels"];
  return cfg;
}

function lineGroupTurn(group: LineGroup, body: string, messageId: string) {
  return {
    Body: body,
    BodyForAgent: body,
    BodyForCommands: body,
    CommandBody: body,
    RawBody: body,
    From: `line:group:${group.groupId}`,
    To: `line:group:${group.groupId}`,
    ChatType: "group",
    Provider: "line",
    Surface: "line",
    OriginatingChannel: "line",
    OriginatingTo: `line:group:${group.groupId}`,
    SenderId: OWNER_ID,
    SessionKey: group.sessionKey,
    MessageSid: messageId,
    WasMentioned: true,
    CommandAuthorized: true,
  } as const;
}

function storePath() {
  return resolveStorePath(undefined, { agentId: "main" });
}

async function seedSession(group: LineGroup, entry: Partial<SessionEntry> = {}) {
  await replaceSessionEntry(
    { storePath: storePath(), sessionKey: group.sessionKey },
    {
      sessionId: `session-${group.groupId}`,
      updatedAt: Date.now(),
      chatType: "group",
      channel: "line",
      ...entry,
    },
  );
}

function readSession(group: LineGroup) {
  return loadSessionEntry({
    storePath: storePath(),
    sessionKey: group.sessionKey,
    readConsistency: "latest",
  });
}

/** Control UI model picker: the real gateway sessions.patch handler. */
async function patchModelLikeControlUi(
  cfg: OpenClawConfig,
  group: LineGroup,
  model: string | null,
): Promise<boolean> {
  const { sessionsHandlers } = await import("../src/gateway/server-methods/sessions.js");
  const respond = vi.fn();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: { key: group.sessionKey, model },
    respond,
    context: {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalog: async () =>
        ACCOUNT_CATALOG.map((row) => ({ provider: "openrouter", ...row })),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0]?.[0] === true;
}

/**
 * LINE's and the Control UI's deterministic model control: the real router,
 * catalog matching and session-model applier, as `before_dispatch` runs it.
 */
async function modelControl(
  surface: "line" | "webchat",
  cfg: OpenClawConfig,
  group: LineGroup,
  text: string,
) {
  const { createLineModelControlRouter } =
    await import("../extensions/line/src/model-control-router.js");
  const result = await createLineModelControlRouter({
    readConfig: () => cfg,
    resolveApiKey: async () => "test-openrouter-key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: ACCOUNT_CATALOG }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  }).early(
    surface === "line"
      ? {
          channel: "line",
          content: text,
          body: text,
          senderId: OWNER_ID,
          senderIsOwner: true,
          sessionKey: group.sessionKey,
        }
      : // chat.send on the viewed session: no sender id for the Control UI,
        // owner through the operator.admin scope.
        { channel: "webchat", content: text, body: text, senderIsOwner: true },
    { sessionKey: group.sessionKey, agentId: "main" },
  );
  return result?.text;
}

/** The session fields a model selection writes. */
function storedModelFields(entry: SessionEntry | undefined) {
  return {
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    modelOverrideSource: entry?.modelOverrideSource,
    liveModelSwitchPending: entry?.liveModelSwitchPending,
    modelProvider: entry?.modelProvider,
    model: entry?.model,
  };
}

type RunCall = { provider?: string; model?: string; sessionKey?: string };

function ranModel(params: RunCall) {
  return {
    payloads: [{ text: `ran ${params.provider}/${params.model}` }],
    meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
  };
}

/**
 * Turn A holds the session busy inside its model call until released; Turn B
 * then arrives and is queued by the real follow-up queue with its model captured.
 */
async function queueTurnBehindBusyRun(cfg: OpenClawConfig, group: LineGroup) {
  const runEmbeddedAgent = getRunEmbeddedAgentMock();
  const release = createDeferred();
  // Scoped to this case's session so a turn another case left running cannot skew counts.
  const calls = () =>
    runEmbeddedAgent.mock.calls
      .map((call: unknown[]) => call[0] as RunCall)
      .filter((call: RunCall) => call.sessionKey === group.sessionKey);
  runEmbeddedAgent.mockImplementation(async (params: RunCall) => {
    if (params.sessionKey === group.sessionKey && calls().length === 1) {
      await release.promise;
    }
    return ranModel(params);
  });
  const turnA = getReply!(lineGroupTurn(group, "สรุปงานวันนี้ให้หน่อย", "m-a"), {}, cfg);
  await vi.waitFor(() => expect(calls()).toHaveLength(1), { timeout: 60_000 });
  await expect(getReply!(lineGroupTurn(group, "กี่โมงแล้ว", "m-b"), {}, cfg)).resolves.toBeUndefined();
  expect(getExistingFollowupQueue(group.sessionKey)?.items).toHaveLength(1);

  let released = false;
  return {
    calls,
    /** The queued turn's run as the drain will execute it. */
    queuedRun: () => getExistingFollowupQueue(group.sessionKey)?.items[0]?.run,
    /** Release Turn A and return the model the queued turn actually ran. */
    async drain(): Promise<RunCall | undefined> {
      if (!released) {
        released = true;
        release.resolve();
        await turnA;
      }
      await vi.waitFor(() => expect(calls()).toHaveLength(2), { timeout: 60_000 });
      return calls()[1];
    },
    async settle() {
      if (!released) {
        released = true;
        release.resolve();
      }
      await turnA.catch(() => undefined);
    },
  };
}

function queuedSelection(
  run: ReturnType<Awaited<ReturnType<typeof queueTurnBehindBusyRun>>["queuedRun"]>,
) {
  return {
    provider: run?.provider,
    model: run?.model,
    modelOverrideSource: run?.modelOverrideSource,
    hasSessionModelOverride: run?.hasSessionModelOverride,
    thinkLevel: run?.thinkLevel,
  };
}

async function withQueuedLineTurn(
  seed: Partial<SessionEntry>,
  run: (params: {
    cfg: OpenClawConfig;
    group: LineGroup;
    queued: Awaited<ReturnType<typeof queueTurnBehindBusyRun>>;
  }) => Promise<void>,
) {
  const group = lineGroup();
  await withTempHome(async (home) => {
    const cfg = productionConfig(home);
    await seedSession(group, seed);
    const queued = await queueTurnBehindBusyRun(cfg, group);
    try {
      await run({ cfg, group, queued });
    } finally {
      await queued.settle();
    }
  });
}

describe("explicit model selection reaches a user turn queued behind an active run", () => {
  // Without a built dist/ (CI), bundled plugins are transpiled from source on first use:
  // over a minute for the LINE channel and OpenRouter provider. Pay that once here, as a
  // running gateway has, so no case's in-flight window is spent loading plugins.
  beforeAll(async () => {
    const group = lineGroup();
    await withTempHome(async (home) => {
      const cfg = productionConfig(home);
      await seedSession(group);
      getRunEmbeddedAgentMock().mockImplementation(async (params: RunCall) => ranModel(params));
      await getReply!(lineGroupTurn(group, "สวัสดี", "m-warm"), {}, cfg);
      expect(await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna")).toBe(true);
    });
  }, 600_000);

  it("Control UI sessions.patch retargets the queued LINE turn; the running turn is untouched", async () => {
    await withQueuedLineTurn({}, async ({ cfg, group, queued }) => {
      expect(queued.calls()[0]).toMatchObject(QWEN);
      expect(queued.queuedRun()).toMatchObject(QWEN);

      expect(await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna")).toBe(true);
      expect(readSession(group)).toMatchObject({
        providerOverride: "openrouter",
        modelOverride: LUNA.model,
      });
      expect(await modelControl("line", cfg, group, "ตอนนี้ใช้โมเดลอะไร")).toContain(
        "openai/gpt-6-luna",
      );

      expect(await queued.drain()).toMatchObject(LUNA);
      // Turn A was already sending its request: it kept Qwen and was not re-run.
      expect(queued.calls()).toHaveLength(2);
      expect(queued.calls()[0]).toMatchObject(QWEN);
    });
  });

  it("/model, sessions.patch and the LINE and Control UI switches leave identical state", async () => {
    const seed: Partial<SessionEntry> = {
      thinkingLevel: "low",
      authProfileOverride: "openrouter:work",
      authProfileOverrideSource: "user",
    };
    const selections: Record<string, ReturnType<typeof queuedSelection>> = {};
    const stored: Record<string, ReturnType<typeof storedModelFields>> = {};
    // Each writer decides what it saves for the pinned auth profile;
    // propagation must carry exactly the saved profile.
    const authProfiles: Record<string, { queued?: string; saved?: string }> = {};
    const record = (
      writer: string,
      group: LineGroup,
      queued: Awaited<ReturnType<typeof queueTurnBehindBusyRun>>,
    ) => {
      selections[writer] = queuedSelection(queued.queuedRun());
      stored[writer] = storedModelFields(readSession(group));
      authProfiles[writer] = {
        queued: queued.queuedRun()?.authProfileId,
        saved: readSession(group)?.authProfileOverride,
      };
    };

    await withQueuedLineTurn(seed, async ({ cfg, group, queued }) => {
      await getReply!(lineGroupTurn(group, "/model openrouter/openai/gpt-6-luna", "m-c"), {}, cfg);
      record("model", group, queued);
      expect(await queued.drain()).toMatchObject(LUNA);
    });
    await withQueuedLineTurn(seed, async ({ cfg, group, queued }) => {
      expect(await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna")).toBe(true);
      record("sessionsPatch", group, queued);
      expect(await queued.drain()).toMatchObject(LUNA);
    });
    await withQueuedLineTurn(seed, async ({ cfg, group, queued }) => {
      expect(await modelControl("line", cfg, group, "เปลี่ยนโมเดลเป็น gpt-6-luna")).toContain(
        "GPT-6 Luna",
      );
      expect(await modelControl("line", cfg, group, "ตอนนี้ใช้โมเดลอะไร")).toContain(
        "openai/gpt-6-luna",
      );
      record("lineSwitch", group, queued);
      expect(await queued.drain()).toMatchObject(LUNA);
    });
    await withQueuedLineTurn(seed, async ({ cfg, group, queued }) => {
      expect(await modelControl("webchat", cfg, group, "เปลี่ยนเป็น openai luna หน่อย")).toBe(
        "เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว",
      );
      record("webchatSwitch", group, queued);
      expect(await queued.drain()).toMatchObject(LUNA);
    });

    expect(selections.model).toEqual({
      ...LUNA,
      modelOverrideSource: "user",
      hasSessionModelOverride: true,
      thinkLevel: "low",
    });
    expect(selections.sessionsPatch).toEqual(selections.model);
    expect(selections.lineSwitch).toEqual(selections.model);
    expect(selections.webchatSwitch).toEqual(selections.model);
    expect(stored.model).toMatchObject({
      providerOverride: LUNA.provider,
      modelOverride: LUNA.model,
      modelOverrideSource: "user",
    });
    expect(stored.sessionsPatch).toEqual(stored.model);
    expect(stored.lineSwitch).toEqual(stored.model);
    expect(stored.webchatSwitch).toEqual(stored.model);
    for (const profile of Object.values(authProfiles)) {
      expect(profile.queued).toBe(profile.saved);
    }
    // The natural-language switches save whatever the picker saves for the
    // pinned profile (the preservation rule itself: session-model-selection.test.ts).
    expect(authProfiles.lineSwitch?.saved).toBe(authProfiles.sessionsPatch?.saved);
    expect(authProfiles.webchatSwitch?.saved).toBe(authProfiles.sessionsPatch?.saved);
  });

  it("a Control UI natural-language switch retargets the queued turn, and the next turn runs it", async () => {
    await withQueuedLineTurn({}, async ({ cfg, group, queued }) => {
      expect(queued.queuedRun()).toMatchObject(QWEN);

      expect(await modelControl("webchat", cfg, group, "เปลี่ยนเป็น openai luna หน่อย")).toBe(
        "เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว",
      );
      expect(readSession(group)).toMatchObject({
        providerOverride: "openrouter",
        modelOverride: LUNA.model,
        liveModelSwitchPending: true,
      });
      expect(queued.queuedRun()).toMatchObject(LUNA);
      expect(await queued.drain()).toMatchObject(LUNA);

      // Nothing queued any more: the next ordinary turn runs the selection too.
      await getReply!(lineGroupTurn(group, "ขอบคุณ", "m-next"), {}, cfg);
      expect(queued.calls()).toHaveLength(3);
      expect(queued.calls()[2]).toMatchObject(LUNA);
    });
  });

  it("naming the default model resets the override exactly as the picker does", async () => {
    const lunaOverride = {
      providerOverride: LUNA.provider,
      modelOverride: LUNA.model,
      modelOverrideSource: "user" as const,
    };
    const stored: Record<string, ReturnType<typeof storedModelFields>> = {};
    await withQueuedLineTurn(lunaOverride, async ({ cfg, group, queued }) => {
      expect(await patchModelLikeControlUi(cfg, group, "openrouter/qwen/qwen3.8-27b")).toBe(true);
      stored.picker = storedModelFields(readSession(group));
      expect(await queued.drain()).toMatchObject(QWEN);
    });
    await withQueuedLineTurn(lunaOverride, async ({ cfg, group, queued }) => {
      expect(await modelControl("webchat", cfg, group, "switch to Qwen3.8 27B")).toBe(
        "Switched to Qwen: Qwen3.8 27B (qwen/qwen3.8-27b).",
      );
      stored.webchat = storedModelFields(readSession(group));
      expect(await queued.drain()).toMatchObject(QWEN);
    });

    // A reset, not a pinned copy of the default: the override is gone.
    expect(stored.picker?.modelOverride).toBeUndefined();
    expect(stored.webchat).toEqual(stored.picker);
  });

  it("carries an explicitly selected auth profile into the queued turn", async () => {
    await withQueuedLineTurn({}, async ({ cfg, group, queued }) => {
      expect(
        await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna@openrouter:work"),
      ).toBe(true);
      expect(readSession(group)).toMatchObject({
        authProfileOverride: "openrouter:work",
        authProfileOverrideSource: "user",
      });
      expect(queued.queuedRun()).toMatchObject({
        ...LUNA,
        authProfileId: "openrouter:work",
        authProfileIdSource: "user",
      });
      expect(await queued.drain()).toMatchObject(LUNA);
    });
  });

  it("sessions.patch model: null retargets the queued turn to the resulting default", async () => {
    const lunaOverride = {
      providerOverride: LUNA.provider,
      modelOverride: LUNA.model,
      modelOverrideSource: "user" as const,
    };
    await withQueuedLineTurn(lunaOverride, async ({ cfg, group, queued }) => {
      expect(queued.queuedRun()).toMatchObject(LUNA);

      expect(await patchModelLikeControlUi(cfg, group, null)).toBe(true);
      expect(readSession(group)?.modelOverride).toBeUndefined();

      expect(await queued.drain()).toMatchObject(QWEN);
    });
  });

  it("a rejected sessions.patch leaves the queued turn on its captured model", async () => {
    await withQueuedLineTurn({}, async ({ cfg, group, queued }) => {
      // Outside the openrouter/* allowlist.
      expect(await patchModelLikeControlUi(cfg, group, "deepseek/deepseek-chat")).toBe(false);
      expect(queued.queuedRun()).toMatchObject(QWEN);
      expect(await queued.drain()).toMatchObject(QWEN);
    });
  });

  it("a locked selection rejects sessions.patch and leaves the queued turn alone", async () => {
    await withQueuedLineTurn({ modelSelectionLocked: true }, async ({ cfg, group, queued }) => {
      expect(await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna")).toBe(false);
      expect(queued.queuedRun()).toMatchObject(QWEN);
      expect(await queued.drain()).toMatchObject(QWEN);
    });
  });
});
