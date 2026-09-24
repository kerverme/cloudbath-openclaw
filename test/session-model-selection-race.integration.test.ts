/**
 * A user turn queued behind an active run must run the model the user selected
 * after it was queued, whichever surface made the selection.
 *
 * Production: the Control UI selected GPT-6 Luna and LINE's model-state answer
 * said Luna, yet the next ordinary LINE turn -- queued behind a busy run with
 * Qwen captured -- still requested Qwen.
 *
 * Real reply pipeline, follow-up queue and drain, SQLite session store,
 * sessions.patch handler, LINE model-state router and LINE switch router; only
 * the embedded model call is controlled, so a turn stays genuinely in flight
 * while the selection changes.
 */
import { describe, expect, it, vi } from "vitest";
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

/** LINE deterministic model-state question, answered from the session row. */
async function askModelStateLikeLine(cfg: OpenClawConfig, group: LineGroup) {
  const { createLineModelStateRouter } =
    await import("../extensions/line/src/model-state-router.js");
  const result = await createLineModelStateRouter({
    readConfig: () => cfg,
    resolveApiKey: async () => "test-openrouter-key",
  })(
    {
      channel: "line",
      senderIsOwner: true,
      sessionKey: group.sessionKey,
      senderId: OWNER_ID,
      body: "ตอนนี้ใช้โมเดลอะไร",
    } as never,
    { sessionKey: group.sessionKey, agentId: "main" } as never,
  );
  return result?.text;
}

/** LINE typed switch: the real switch router and session-model applier. */
async function switchModelLikeLine(group: LineGroup, text: string) {
  const { createLineModelSwitchIntentRouter } =
    await import("../extensions/line/src/model-switch-router.js");
  const result = await createLineModelSwitchIntentRouter({
    resolveApiKey: async () => "test-openrouter-key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: ACCOUNT_CATALOG }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })(
    {
      channel: "line",
      content: text,
      body: text,
      senderId: OWNER_ID,
      senderIsOwner: true,
      sessionKey: group.sessionKey,
    } as never,
    { sessionKey: group.sessionKey, agentId: "main" } as never,
  );
  return result?.text;
}

type RunCall = { provider?: string; model?: string; sessionKey?: string };

/**
 * Turn A holds the session busy inside its model call until released; Turn B
 * then arrives and is queued by the real follow-up queue with its model captured.
 */
async function queueTurnBehindBusyRun(cfg: OpenClawConfig, group: LineGroup) {
  const runEmbeddedAgent = getRunEmbeddedAgentMock();
  const release = createDeferred();
  runEmbeddedAgent.mockReset();
  runEmbeddedAgent.mockImplementation(async (params: RunCall) => {
    if (runEmbeddedAgent.mock.calls.length === 1) {
      await release.promise;
    }
    return {
      payloads: [{ text: `ran ${params.provider}/${params.model}` }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    };
  });
  const turnA = getReply!(lineGroupTurn(group, "สรุปงานวันนี้ให้หน่อย", "m-a"), {}, cfg);
  await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(1), { timeout: 60_000 });
  await expect(getReply!(lineGroupTurn(group, "กี่โมงแล้ว", "m-b"), {}, cfg)).resolves.toBeUndefined();
  expect(getExistingFollowupQueue(group.sessionKey)?.items).toHaveLength(1);

  const calls = () => runEmbeddedAgent.mock.calls.map((call: unknown[]) => call[0] as RunCall);
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
      await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(2), {
        timeout: 60_000,
      });
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
  it("Control UI sessions.patch retargets the queued LINE turn; the running turn is untouched", async () => {
    await withQueuedLineTurn({}, async ({ cfg, group, queued }) => {
      expect(queued.calls()[0]).toMatchObject(QWEN);
      expect(queued.queuedRun()).toMatchObject(QWEN);

      expect(await patchModelLikeControlUi(cfg, group, "openrouter/openai/gpt-6-luna")).toBe(true);
      expect(readSession(group)).toMatchObject({
        providerOverride: "openrouter",
        modelOverride: LUNA.model,
      });
      expect(await askModelStateLikeLine(cfg, group)).toContain("openai/gpt-6-luna");

      expect(await queued.drain()).toMatchObject(LUNA);
      // Turn A was already sending its request: it kept Qwen and was not re-run.
      expect(queued.calls()).toHaveLength(2);
      expect(queued.calls()[0]).toMatchObject(QWEN);
    });
  });

  it("/model, sessions.patch and the LINE typed switch leave identical queued-run state", async () => {
    const seed: Partial<SessionEntry> = {
      thinkingLevel: "low",
      authProfileOverride: "openrouter:work",
      authProfileOverrideSource: "user",
    };
    const selections: Record<string, ReturnType<typeof queuedSelection>> = {};
    // Each writer decides what it saves (only sessions.patch keeps a same-provider
    // auth profile); propagation must carry exactly the saved profile.
    const authProfiles: Record<string, { queued?: string; saved?: string }> = {};
    const record = (
      writer: string,
      group: LineGroup,
      queued: Awaited<ReturnType<typeof queueTurnBehindBusyRun>>,
    ) => {
      selections[writer] = queuedSelection(queued.queuedRun());
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
      expect(await switchModelLikeLine(group, "เปลี่ยนโมเดลเป็น gpt-6-luna")).toContain("GPT-6 Luna");
      expect(await askModelStateLikeLine(cfg, group)).toContain("openai/gpt-6-luna");
      record("lineSwitch", group, queued);
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
    for (const profile of Object.values(authProfiles)) {
      expect(profile.queued).toBe(profile.saved);
    }
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
      expect(await patchModelLikeControlUi(cfg, group, "anthropic/claude-opus-4-7")).toBe(false);
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
