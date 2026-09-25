/**
 * Ordinary LINE chat pays for one model call: the main agent's.
 *
 * Registers the real Cloudbath and LINE plugin entries into one hook registry,
 * installs a Cloudbath runtime whose referent resolver completes through a
 * double that labels its request exactly as the plugin LLM runtime does, and
 * drives the real core dispatch. The turn latency ledger (the profiler's
 * per-turn record) is the observation: each provider request appears in it
 * with its call reason, so "which model calls did this turn make" is read, not
 * inferred.
 *
 * Production: "วันนี้ฝนตกไหม" cost `cloudbath_conversation_referent` + the main
 * agent, and "ใช้โมเดลไรอยู่" spent ~2.5 s on the referent before anything
 * answered it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { TurnLatencyRecord } from "../src/infra/turn-latency-ledger.js";

const ledgerRecords: TurnLatencyRecord[] = [];

vi.mock("../src/infra/turn-latency-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/turn-latency-ledger.js")>();
  return {
    ...actual,
    // Keeps every finished record: the log line is the only other place it goes.
    createTurnLatencyLedger: (params: Parameters<typeof actual.createTurnLatencyLedger>[0]) => {
      const ledger = actual.createTurnLatencyLedger(params);
      return {
        ...ledger,
        finish: (finishParams: Parameters<typeof ledger.finish>[0]) => {
          const record = ledger.finish(finishParams);
          if (record) {
            ledgerRecords.push(record);
          }
          return record;
        },
      };
    },
  };
});

const CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openrouter/deepseek/deepseek-v4-flash-0731" },
      models: { "openrouter/*": {} },
    },
  },
} as OpenClawConfig;

vi.mock("openclaw/plugin-sdk/channel-entry-contract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-entry-contract")>();
  return {
    ...actual,
    // Loading a bundled channel's sync facade inside a Vitest worker can
    // deadlock it; run the entry's real registerFull callback instead.
    defineBundledChannelEntry: (options: {
      id: string;
      registerFull?: (api: OpenClawPluginApi) => void;
    }) => ({
      id: options.id,
      register(api: OpenClawPluginApi) {
        options.registerFull?.(api);
      },
    }),
  };
});
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => CONFIG }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-openrouter-key" }),
}));

const cloudbathEntry = (await import("../extensions/cloudbath-line-image-archive/index.js"))
  .default;
const lineEntry = (await import("../extensions/line/index.js")).default;
const { CREATE_MESSAGE, harness: cloudbathHarness } =
  await import("../extensions/cloudbath-line-image-archive/src/storyboard-router.test-support.js");
const { createConversationSemanticResolver } =
  await import("../extensions/cloudbath-line-image-archive/src/conversation-semantic-resolver.js");
const { openDirectorSession, storyboardDirectorKey } =
  await import("../extensions/cloudbath-line-image-archive/src/storyboard-director.js");
const {
  clearCloudbathWorkspacePolicyRuntime,
  createCloudbathWorkspacePolicyRuntimeOwner,
  installCloudbathWorkspacePolicyRuntime,
} = await import("../extensions/cloudbath-line-image-archive/src/workspace-policy-runtime.js");
const { settleReplyDispatcher } = await import("../src/auto-reply/dispatch-dispatcher.js");
const { dispatchReplyFromConfig } = await import("../src/auto-reply/reply/dispatch-from-config.js");
const { createReplyDispatcher } = await import("../src/auto-reply/reply/reply-dispatcher.js");
const { buildTestCtx } = await import("../src/auto-reply/reply/test-ctx.js");
const { currentLlmCallReason, currentTurnLatencyLedger, runWithLlmCallReason } =
  await import("../src/infra/turn-latency-ledger.js");
const { initializeGlobalHookRunner, resetGlobalHookRunner } =
  await import("../src/plugins/hook-runner-global.js");
const { addTestHook } = await import("../src/plugins/hooks.test-helpers.js");
const { createEmptyPluginRegistry } = await import("../src/plugins/registry-empty.js");
const { resetPluginRuntimeStateForTest } = await import("../src/plugins/runtime.js");
const { resolvePluginCallReason } = await import("../src/plugins/runtime/runtime-llm.runtime.js");

function openKeyedStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

// The Cloudbath test-support scope: its stores are keyed by these.
const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const SESSION_KEY = `agent:main:line:group:${GROUP.toLowerCase()}`;

/** Opens one model request on the turn's ledger, labeled as production labels it. */
function recordProviderRequest(model: string): void {
  currentTurnLatencyLedger()
    ?.openModelCall({ provider: "openrouter", model, callReason: currentLlmCallReason() })
    .complete();
}

type Turn = {
  delivered: string[];
  /** Every before_dispatch handler that ran, as `<plugin>:<registration index>`. */
  handlers: string[];
  /** The turn's model calls, by reason, from its latency record. */
  modelCalls: string[];
  catalogRequests: number;
};

let messageCounter = 0;
let runtimeOwner: symbol | undefined;

function createHarness() {
  const registry = createEmptyPluginRegistry();
  const handlers: string[] = [];
  for (const [entry, pluginId] of [
    [cloudbathEntry, "cloudbath-line-image-archive"],
    [lineEntry, "line"],
  ] as const) {
    let beforeDispatchIndex = 0;
    entry.register(
      createTestPluginApi({
        id: pluginId,
        name: pluginId,
        source: "test",
        config: CONFIG,
        registrationMode: "full",
        runtime: { state: { openKeyedStore } } as unknown as OpenClawPluginApi["runtime"],
        on(hookName, handler, options) {
          const label = `${pluginId}:${beforeDispatchIndex}`;
          if (hookName === "before_dispatch") {
            beforeDispatchIndex += 1;
          }
          const observed =
            hookName === "before_dispatch"
              ? (((...args: unknown[]) => {
                  handlers.push(label);
                  return (handler as (...params: unknown[]) => unknown)(...args);
                }) as typeof handler)
              : handler;
          addTestHook({
            registry,
            pluginId,
            hookName,
            handler: observed,
            ...(options?.priority !== undefined ? { priority: options.priority } : {}),
          });
        },
      }),
    );
  }
  initializeGlobalHookRunner(registry);

  // index.ts wires the resolver to `api.runtime.llm.complete`, which labels
  // the request with this purpose's call reason before the provider sees it.
  const cloudbath = cloudbathHarness({
    semanticResolver: createConversationSemanticResolver(
      async (request) =>
        await runWithLlmCallReason(resolvePluginCallReason(request.purpose), async () => {
          recordProviderRequest("referent");
          return {
            text: JSON.stringify({
              intent: "unrelated",
              referentType: "none",
              confidence: 0.95,
              needsClarification: false,
            }),
          };
        }),
    ),
    resolverNames: ["Twong", "Twong2"],
  });
  runtimeOwner = createCloudbathWorkspacePolicyRuntimeOwner();
  installCloudbathWorkspacePolicyRuntime(runtimeOwner, {
    workspaceRegistry: {
      handleBeforeDispatch: async () => undefined,
    } as unknown as Parameters<
      typeof installCloudbathWorkspacePolicyRuntime
    >[1]["workspaceRegistry"],
    conversationRouter: cloudbath.conversationRouter,
    storyboardLineRouter: cloudbath.storyboardRouter,
  });

  // The main agent and every tool it could call sit behind the reply resolver.
  const replyResolver = vi.fn(async () =>
    runWithLlmCallReason("main_agent", async () => {
      recordProviderRequest("main");
      return { text: "agent reply" };
    }),
  );
  let catalogRequests = 0;
  globalThis.fetch = vi.fn(async () => {
    catalogRequests += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const ask = async (text: string): Promise<Turn> => {
    messageCounter += 1;
    handlers.length = 0;
    ledgerRecords.length = 0;
    catalogRequests = 0;
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: text,
        BodyForAgent: text,
        BodyForCommands: text,
        CommandBody: text,
        RawBody: text,
        SessionKey: SESSION_KEY,
        MessageSid: `m-${messageCounter}`,
        // LINE's resolveInboundConversation reduces `line:group:<id>` to the
        // native id; its channel plugin is not in this registry, so the
        // addresses carry the id the hooks would see in production.
        From: `line:${GROUP}`,
        To: `line:${GROUP}`,
        OriginatingChannel: "line",
        OriginatingTo: `line:${GROUP}`,
        SenderId: OWNER,
        OwnerAllowFrom: [OWNER],
        ChatType: "group",
        Provider: "line",
        Surface: "line",
        AccountId: ACCOUNT,
        CommandAuthorized: true,
      }),
      cfg: {
        ...CONFIG,
        // The registry above IS the plugin set.
        plugins: { enabled: false },
        // The profiler switch is what makes the ledger record a turn.
        diagnostics: { flags: ["profiler"] },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });
    // The record is emitted when the dispatcher settles, as in production.
    await settleReplyDispatcher({ dispatcher });
    expect(ledgerRecords).toHaveLength(1);
    return {
      delivered,
      handlers: [...handlers],
      modelCalls: ledgerRecords[0]!.modelCalls.map((call) => call.callReason),
      catalogRequests,
    };
  };
  return { ask, cloudbath, replyResolver };
}

/** A storyboard the owner made earlier and has since stopped talking about. */
async function withStaleStoryboard() {
  const harness = createHarness();
  await harness.cloudbath.dispatch(CREATE_MESSAGE);
  expect(await harness.cloudbath.active.entries()).toHaveLength(1);
  return harness;
}

const MAIN_AGENT_ONLY = ["main_agent"];
const REFERENT_THEN_AGENT = ["cloudbath_conversation_referent", "main_agent"];
/** LINE's per-turn reset, then model control: Cloudbath never ran. */
const CLAIMED_BEFORE_CLOUDBATH = ["line:0", "line:1"];

let tempDir: string;
let previousStateDir: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-referent-gate-")));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDir;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(() => {
  if (runtimeOwner) {
    clearCloudbathWorkspacePolicyRuntime(runtimeOwner);
    runtimeOwner = undefined;
  }
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  globalThis.fetch = originalFetch;
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ordinary chat makes one model call, the main agent's", () => {
  it("A: fresh conversation, วันนี้ฝนตกไหม", async () => {
    const { ask } = createHarness();

    const turn = await ask("วันนี้ฝนตกไหม");

    expect(turn.modelCalls).toEqual(MAIN_AGENT_ONLY);
    expect(turn.delivered).toEqual(["agent reply"]);
  });

  it.each(["วันนี้ฝนตกไหม", "วันนี้ฝนตกไหมครับ", "ช่วยเขียนอีเมล", "สวัสดี"])(
    "B: stale storyboard, %s",
    async (text) => {
      const { ask } = await withStaleStoryboard();

      const turn = await ask(text);

      expect(turn.modelCalls).toEqual(MAIN_AGENT_ONLY);
      expect(turn.delivered).toEqual(["agent reply"]);
    },
  );

  it.each(["สรุปข่าวอาทิตย์ที่แล้ว", "ข่าวล่าสุด"])(
    "C: dated wording is answered by the agent, fresh or with a stale storyboard: %s",
    async (text) => {
      for (const harness of [createHarness(), await withStaleStoryboard()]) {
        const turn = await harness.ask(text);

        // No referent call and no "which work do you mean?" clarification.
        expect(turn.modelCalls).toEqual(MAIN_AGENT_ONLY);
        expect(turn.delivered).toEqual(["agent reply"]);
      }
    },
  );

  it("E: a bare refusal with only a stale storyboard", async () => {
    const { ask } = await withStaleStoryboard();

    const turn = await ask("ไม่เอาแบบนี้");

    expect(turn.modelCalls).toEqual(MAIN_AGENT_ONLY);
  });
});

describe("Cloudbath turns still reach the referent", () => {
  it("D: a back-reference to the storyboard the owner is working on", async () => {
    const { ask } = await withStaleStoryboard();

    const turn = await ask("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    // The double answers "unrelated", so the turn continues to the agent.
    expect(turn.modelCalls).toEqual(REFERENT_THEN_AGENT);
  });

  it("F: a bare refusal while a director question is waiting", async () => {
    const harness = createHarness();
    await harness.cloudbath.director.register(
      storyboardDirectorKey(harness.cloudbath.claim),
      openDirectorSession({
        claim: harness.cloudbath.claim,
        scenePrompt: "Twong เดินในสวน",
        characterNames: ["Twong"],
        environment: "สวน",
        updatedAt: "2026-08-30T10:00:00.000Z",
      }),
    );

    const turn = await harness.ask("ไม่เอาแบบนี้");

    expect(turn.modelCalls[0]).toBe("cloudbath_conversation_referent");
  });
});

describe("model-state questions are answered before Cloudbath runs", () => {
  it.each([
    "ใช้โมเดลไรอยู่",
    "ตอนนี้ใช้โมเดลไร",
    "ตอนนี้รันตัวไหน",
    "ใช้ตัวไหนอยู่",
    "what are you running",
    "what model are you on",
  ])("G: %s makes no model call and reads no catalog", async (text) => {
    const { ask, replyResolver } = await withStaleStoryboard();

    const turn = await ask(text);

    expect(turn.handlers).toEqual(CLAIMED_BEFORE_CLOUDBATH);
    expect(turn.modelCalls).toEqual([]);
    expect(turn.catalogRequests).toBe(0);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(turn.delivered.join("\n")).toContain("deepseek/deepseek-v4-flash-0731");
  });
});
