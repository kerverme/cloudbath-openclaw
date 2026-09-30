/**
 * One text model per conversation.
 *
 * Every text-model request a LINE turn causes -- the main agent and its tool
 * follow-up, the Wellness data answer, the referent resolver, the storyboard
 * planner, compaction -- runs on the model the owner pinned for that session,
 * and a pinned model that fails is retried, never replaced by another model.
 *
 * Production: the owner selected openrouter/openai/gpt-6-luna. The main agent
 * ran Luna, but the Wellness fast path called deepseek/deepseek-v4-flash-0731,
 * `agents.defaults.model.primary`: plugin completions resolved the agent's
 * configured model and never read the session.
 *
 * Real core dispatch, the real Cloudbath and LINE `before_dispatch` hooks, the
 * reply pipeline, SQLite session store and LINE model control; plugins complete
 * text through the LLM runtime production hands them. Only the provider
 * boundary is a double: it opens each request on the turn's latency record, as
 * the model transport does, and notes the call reason, provider and model.
 */
import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { resolveStorePath } from "../src/config/sessions/paths.js";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { SessionEntry } from "../src/config/sessions/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  getCompactEmbeddedAgentSessionMock,
  getRunEmbeddedAgentMock,
  installTriggerHandlingReplyHarness,
  makeCfg,
  withTempHome,
} from "./helpers/auto-reply/trigger-handling-test-harness.js";

/** The provider boundary: every text-model request, and which models are down. */
const provider = vi.hoisted(() => ({
  requests: [] as string[],
  failing: new Set<string>(),
  config: undefined as OpenClawConfig | undefined,
  /** This turn's requests as `<call reason> <provider>/<model>`, as the turn record logs them. */
  turnCalls: [] as string[],
  /** The agent each plugin completion was prepared for, in order. */
  preparedAgents: [] as string[],
}));

/** One provider request, recorded where and how the model transport records it. */
async function sendProviderRequest(providerId: string, model: string): Promise<void> {
  const { currentLlmCallReason, currentTurnLatencyLedger } =
    await import("../src/infra/turn-latency-ledger.js");
  const ref = `${providerId}/${model}`;
  const callReason = currentLlmCallReason();
  provider.requests.push(ref);
  provider.turnCalls.push(`${callReason} ${ref}`);
  const call = currentTurnLatencyLedger()?.openModelCall({
    provider: providerId,
    model,
    callReason,
  });
  if (provider.failing.has(ref)) {
    call?.fail();
    throw new Error(`503 ${ref} is unavailable`);
  }
  call?.complete();
}

const REFERENT_VERDICT = JSON.stringify({
  intent: "unrelated",
  referentType: "none",
  confidence: 0.95,
  needsClarification: false,
});
const STORYBOARD_PLAN = JSON.stringify({
  beats: [
    {
      startSeconds: 1,
      endSeconds: 15,
      kind: "action",
      framing: "Medium",
      action: "Twong walks past Twong2",
      camera: "Static",
      characterNames: ["Twong"],
    },
  ],
});

// Model resolution and credentials are real up to the request itself: the
// completion runtime prepares whatever model the plugin runtime selected, and
// the double answers each purpose the way its caller parses.
vi.mock("../src/agents/simple-completion-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/simple-completion-runtime.js")>();
  return {
    ...actual,
    prepareSimpleCompletionModelForAgent: async (
      params: Parameters<typeof actual.resolveSimpleCompletionSelectionForAgent>[0],
    ) => {
      provider.preparedAgents.push(params.agentId);
      const selection = actual.resolveSimpleCompletionSelectionForAgent(params);
      if (!selection) {
        return { error: `No model configured for agent ${params.agentId}.` };
      }
      return {
        selection,
        model: { provider: selection.provider, id: selection.modelId, api: "openai-completions" },
        auth: { apiKey: "test-openrouter-key", mode: "api-key", source: "test" },
      };
    },
    completeWithPreparedSimpleCompletionModel: async (params: {
      model: { provider: string; id: string };
    }) => {
      await sendProviderRequest(params.model.provider, params.model.id);
      const { currentLlmCallReason } = await import("../src/infra/turn-latency-ledger.js");
      const reason = currentLlmCallReason();
      const text =
        reason === "cloudbath_conversation_referent"
          ? REFERENT_VERDICT
          : reason === "storyboard_planner"
            ? STORYBOARD_PLAN
            : "ใช้ไปทั้งหมด 1,303,307.51 บาท";
      return {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: {},
        stopReason: "stop",
      };
    },
  };
});

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
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => provider.config,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-openrouter-key" }),
}));

// /compact's runtime facade: the reply harness's embedded-agent mocks, plus
// "no run is active", so a manual compaction proceeds to the compactor.
vi.mock("../src/auto-reply/reply/commands-compact.runtime.js", async () => {
  const embedded = (globalThis as Record<symbol, Record<string, (...args: unknown[]) => unknown>>)[
    Symbol.for("openclaw.trigger-handling.embedded-agent-mocks")
  ]!;
  const sessions = await import("../src/config/sessions.js");
  return {
    abortEmbeddedAgentRun: (...args: unknown[]) => embedded.abortEmbeddedAgentRun!(...args),
    compactEmbeddedAgentSession: (...args: unknown[]) =>
      embedded.compactEmbeddedAgentSession!(...args),
    isEmbeddedAgentRunAbortableForCompaction: () => false,
    waitForEmbeddedAgentRunEnd: async () => true,
    resolveFreshSessionTotalTokens: sessions.resolveFreshSessionTotalTokens,
    resolveSessionFilePath: sessions.resolveSessionFilePath,
    resolveSessionFilePathOptions: sessions.resolveSessionFilePathOptions,
    enqueueSystemEvent: (await import("../src/infra/system-events.js")).enqueueSystemEvent,
    ...(await import("../src/auto-reply/status.js")),
    incrementCompactionCount: (await import("../src/auto-reply/reply/session-updates.js"))
      .incrementCompactionCount,
  };
});

let getReply: typeof import("../src/auto-reply/reply.js").getReplyFromConfig | undefined;
installTriggerHandlingReplyHarness((impl) => {
  getReply = impl;
});

const cloudbathEntry = (await import("../extensions/cloudbath-line-image-archive/index.js"))
  .default;
const lineEntry = (await import("../extensions/line/index.js")).default;
const { CREATE_MESSAGE, harness: cloudbathHarness } =
  await import("../extensions/cloudbath-line-image-archive/src/storyboard-router.test-support.js");
const { createConversationSemanticResolver } =
  await import("../extensions/cloudbath-line-image-archive/src/conversation-semantic-resolver.js");
const { StoryboardLlmPlanner } =
  await import("../extensions/cloudbath-line-image-archive/src/storyboard-planner.js");
const {
  clearCloudbathWorkspacePolicyRuntime,
  createCloudbathWorkspacePolicyRuntimeOwner,
  installCloudbathWorkspacePolicyRuntime,
} = await import("../extensions/cloudbath-line-image-archive/src/workspace-policy-runtime.js");
const { productionShapedWellness, syntheticWellnessFetch } =
  await import("../extensions/cloudbath-line-image-archive/src/notion-tools.test-support.js");
const { settleReplyDispatcher } = await import("../src/auto-reply/dispatch-dispatcher.js");
const { dispatchReplyFromConfig } = await import("../src/auto-reply/reply/dispatch-from-config.js");
const { createReplyDispatcher } = await import("../src/auto-reply/reply/reply-dispatcher.js");
const { buildTestCtx } = await import("../src/auto-reply/reply/test-ctx.js");
const { runWithLlmCallReason } = await import("../src/infra/turn-latency-ledger.js");
const { initializeGlobalHookRunner, resetGlobalHookRunner } =
  await import("../src/plugins/hook-runner-global.js");
const { addTestHook } = await import("../src/plugins/hooks.test-helpers.js");
const { createEmptyPluginRegistry } = await import("../src/plugins/registry-empty.js");
const { resetPluginRuntimeStateForTest } = await import("../src/plugins/runtime.js");
const { createRuntimeLlm } = await import("../src/plugins/runtime/runtime-llm.runtime.js");
const { withPluginRuntimePluginIdScope } =
  await import("../src/plugins/runtime/gateway-request-scope.js");
const { buildEmbeddedCompactionRuntimeContext, resolveEmbeddedCompactionTarget } =
  await import("../src/agents/embedded-agent-runner/compaction-runtime-context.js");
const { __testing: compactTesting } =
  await import("../src/agents/embedded-agent-runner/compact.js");
// The reply harness stubs the fallback runner; the chain it would walk is read
// from the real one, with the exact options the reply path handed it.
const realModelFallback = await vi.importActual<typeof import("../src/agents/model-fallback.js")>(
  "../src/agents/model-fallback.js",
);
// The harness's fallback stub predates the error path a failed turn takes.
Object.assign(
  (globalThis as Record<symbol, object>)[
    Symbol.for("openclaw.trigger-handling.model-fallback-mocks")
  ]!,
  { isFallbackSummaryError: realModelFallback.isFallbackSummaryError },
);

const DEEPSEEK = "openrouter/deepseek/deepseek-v4-flash-0731";
const EXPLICIT_MODEL_PLUGIN = "explicit-model-plugin";
const QWEN = "openrouter/qwen/qwen3.6-plus";
const LUNA = "openrouter/openai/gpt-6-luna";
const ACCOUNT_CATALOG = [
  { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" },
  { id: "qwen/qwen3.6-plus", name: "Qwen: Qwen3.6 Plus" },
  { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash" },
];

// The Cloudbath test-support scope: its stores are keyed by these.
const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const SESSION_KEY = `agent:main:line:group:${GROUP.toLowerCase()}`;

/** Production's text-model config: DeepSeek primary; the test adds a Qwen fallback. */
function productionConfig(home: string, extra: { compactionModel?: string } = {}): OpenClawConfig {
  const cfg = makeCfg(home);
  delete cfg.session;
  cfg.agents!.defaults!.model = { primary: DEEPSEEK, fallbacks: [QWEN] };
  cfg.agents!.defaults!.models = { "openrouter/*": {} };
  if (extra.compactionModel) {
    cfg.agents!.defaults!.compaction = { model: extra.compactionModel };
  }
  // A plugin the operator trusts to name its own completion model.
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      [EXPLICIT_MODEL_PLUGIN]: { llm: { allowModelOverride: true, allowAgentIdOverride: true } },
    },
  };
  // Specialist media models are separate capabilities, never the chat pin.
  cfg.agents!.defaults!.imageGenerationModel = { primary: "openrouter/google/gemini-3-pro-image" };
  cfg.agents!.defaults!.videoGenerationModel = { primary: "fal/kling-video-v3" };
  cfg.agents!.defaults!.imageModel = { primary: "openrouter/google/gemini-3-flash" };
  cfg.channels = {
    ...cfg.channels,
    line: { groupPolicy: "open", groups: { "*": { requireMention: false } } },
  } as OpenClawConfig["channels"];
  return cfg;
}

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

function storePath() {
  return resolveStorePath(undefined, { agentId: "main" });
}

function readSession(): SessionEntry | undefined {
  return loadSessionEntry({
    storePath: storePath(),
    sessionKey: SESSION_KEY,
    readConsistency: "latest",
  });
}

type RunParams = {
  provider: string;
  model: string;
  config: OpenClawConfig;
  authProfileId?: string;
  modelFallbacksOverride?: string[];
  sessionModelPinned?: boolean;
  modelSelectionLocked?: boolean;
};
type CompactionParams = RunParams & {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
};
type FallbackOptions = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  fallbacksOverride?: string[];
};

type Turn = {
  delivered: string[];
  /** Every provider request the turn made, as `<call reason> <provider>/<model>`. */
  modelCalls: string[];
};

let messageCounter = 0;

/**
 * An owner's LINE group conversation, wired as production wires it. `ask`
 * delivers one message through core dispatch and returns what the provider saw.
 */
async function openConversation(home: string, options: { compactionModel?: string } = {}) {
  const cfg = productionConfig(home, options);
  provider.config = cfg;
  provider.requests.length = 0;
  provider.preparedAgents.length = 0;
  provider.failing.clear();
  await replaceSessionEntry(
    { storePath: storePath(), sessionKey: SESSION_KEY },
    {
      sessionId: `session-${messageCounter}`,
      updatedAt: Date.now(),
      chatType: "group",
      channel: "line",
    },
  );

  // The host LLM runtime every plugin receives as `api.runtime.llm`.
  const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
  const registry = createEmptyPluginRegistry();
  for (const [entry, pluginId] of [
    [cloudbathEntry, "cloudbath-line-image-archive"],
    [lineEntry, "line"],
  ] as const) {
    entry.register(
      createTestPluginApi({
        id: pluginId,
        name: pluginId,
        source: "test",
        config: cfg,
        registrationMode: "full",
        runtime: { state: { openKeyedStore }, llm } as unknown as OpenClawPluginApi["runtime"],
        on(hookName, handler, hookOptions) {
          addTestHook({
            registry,
            pluginId,
            hookName,
            handler,
            ...(hookOptions?.priority !== undefined ? { priority: hookOptions.priority } : {}),
          });
        },
      }),
    );
  }
  initializeGlobalHookRunner(registry);

  // The referent resolver and storyboard planner, wired to the runtime exactly
  // as the Cloudbath plugin entry wires them.
  const cloudbath = cloudbathHarness({
    semanticResolver: createConversationSemanticResolver(
      async (request) => await llm.complete({ ...request, messages: [...request.messages] }),
    ),
    planner: new StoryboardLlmPlanner(
      async (request) => await llm.complete({ ...request, messages: [...request.messages] }),
    ),
    resolverNames: ["Twong", "Twong2"],
  });
  const runtimeOwner = createCloudbathWorkspacePolicyRuntimeOwner();
  installCloudbathWorkspacePolicyRuntime(runtimeOwner, {
    workspaceRegistry: {
      handleBeforeDispatch: async () => undefined,
    } as unknown as Parameters<
      typeof installCloudbathWorkspacePolicyRuntime
    >[1]["workspaceRegistry"],
    conversationRouter: cloudbath.conversationRouter,
    storyboardLineRouter: cloudbath.storyboardRouter,
  });

  const notion = syntheticWellnessFetch(productionShapedWellness(), []);
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.notion.com/")) {
      return await notion(input, init);
    }
    // The OpenRouter account catalog LINE model control switches against.
    return new Response(JSON.stringify({ data: ACCOUNT_CATALOG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // The embedded agent turn, as its provider sees it: the agent's request, then
  // the follow-up after a tool result, both on the model the run was given.
  const runs: RunParams[] = [];
  getRunEmbeddedAgentMock().mockImplementation(async (params: RunParams) => {
    runs.push(params);
    await runWithLlmCallReason("main_agent", () =>
      sendProviderRequest(params.provider, params.model),
    );
    await runWithLlmCallReason("tool_followup", () =>
      sendProviderRequest(params.provider, params.model),
    );
    return {
      payloads: [{ text: "agent reply" }],
      meta: {
        durationMs: 1,
        agentMeta: { sessionId: "s", provider: params.provider, model: params.model },
      },
    };
  });
  // Compaction summarizes on the target the real resolver picks for it.
  const compactions: CompactionParams[] = [];
  getCompactEmbeddedAgentSessionMock().mockImplementation(async (params: CompactionParams) => {
    compactions.push(params);
    const target = resolveEmbeddedCompactionTarget({
      config: params.config,
      provider: params.provider,
      modelId: params.model,
      authProfileId: params.authProfileId,
      modelSelectionLocked: params.modelSelectionLocked,
      sessionModelPinned: params.sessionModelPinned,
    });
    await runWithLlmCallReason("context_compaction", () =>
      sendProviderRequest(target.provider!, target.model!),
    );
    return {
      ok: true,
      compacted: true,
      result: {
        summary: "summary",
        firstKeptEntryId: "e1",
        tokensBefore: 90_000,
        tokensAfter: 9_000,
      },
    };
  });

  const ask = async (text: string): Promise<Turn> => {
    messageCounter += 1;
    provider.turnCalls.length = 0;
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
        MessageSid: `model-ownership-${messageCounter}`,
        // The native group id the LINE channel resolves `line:group:<id>` to.
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
        WasMentioned: true,
        CommandAuthorized: true,
      }),
      cfg: {
        ...cfg,
        // The registry above IS the plugin set.
        plugins: { enabled: false },
        // The profiler switch is what makes the ledger record a turn.
        diagnostics: { flags: ["profiler"] },
      } as OpenClawConfig,
      dispatcher,
      replyResolver: getReply!,
    });
    await settleReplyDispatcher({ dispatcher });
    return { delivered, modelCalls: [...provider.turnCalls] };
  };

  const close = () => {
    clearCloudbathWorkspacePolicyRuntime(runtimeOwner);
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  };
  /**
   * A trusted plugin's own completion naming `model`, made from
   * `before_dispatch` on every turn (inside the turn) or directly (outside any
   * turn, as a background job would).
   */
  const explicitModelCompletion = (model: string, agentId?: string) => () =>
    withPluginRuntimePluginIdScope(EXPLICIT_MODEL_PLUGIN, () =>
      llm.complete({
        model,
        ...(agentId ? { agentId } : {}),
        messages: [{ role: "user", content: "summarize" }],
      }),
    );
  const completeInEveryTurn = (model: string, agentId?: string) => {
    const complete = explicitModelCompletion(model, agentId);
    addTestHook({
      registry,
      pluginId: EXPLICIT_MODEL_PLUGIN,
      hookName: "before_dispatch",
      handler: async () => {
        await complete();
        return undefined;
      },
      priority: 1_000,
    });
  };
  return {
    ask,
    cfg,
    cloudbath,
    runs,
    compactions,
    close,
    completeInEveryTurn,
    completeInBackground: (model: string) => explicitModelCompletion(model)(),
  };
}

type Conversation = Awaited<ReturnType<typeof openConversation>>;

/** Runs a case in its own state dir, with the Wellness credential present. */
async function inConversation(
  run: (conversation: Conversation) => Promise<void>,
  options: { compactionModel?: string } = {},
): Promise<void> {
  const originalFetch = globalThis.fetch;
  vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
  try {
    await withTempHome(async (home) => {
      fs.mkdirSync(`${home}/openclaw`, { recursive: true });
      const conversation = await openConversation(home, options);
      try {
        await run(conversation);
      } finally {
        conversation.close();
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  }
}

/** The fallback chain the reply path asked for, walked by the real fallback runner. */
async function candidatesTried(options: FallbackOptions): Promise<string[]> {
  const tried: string[] = [];
  await realModelFallback
    .runWithModelFallback({
      cfg: options.cfg,
      provider: options.provider,
      model: options.model,
      fallbacksOverride: options.fallbacksOverride,
      run: async (candidateProvider: string, candidateModel: string) => {
        tried.push(`${candidateProvider}/${candidateModel}`);
        throw Object.assign(new Error("503 upstream unavailable"), { status: 503 });
      },
    })
    .catch(() => undefined);
  return tried;
}

function lastFallbackOptions(): FallbackOptions {
  const mocks = (
    globalThis as Record<symbol, { runWithModelFallback: { mock: { calls: unknown[][] } } }>
  )[Symbol.for("openclaw.trigger-handling.model-fallback-mocks")];
  return mocks!.runWithModelFallback.mock.calls.at(-1)![0] as FallbackOptions;
}

const WELLNESS_TOTAL = "Cashflow - Cloudbath ใช้ไปเท่าไร";
const PIN_LUNA = "เปลี่ยนโมเดลเป็น gpt-6-luna";

describe("an owner-pinned text model owns every text request of the conversation", () => {
  it("warms the reply pipeline", async () => {
    await inConversation(async ({ ask }) => {
      await ask("สวัสดี");
    });
  }, 600_000);

  it("A: the Wellness data answer runs on the pinned model, not the configured default", async () => {
    await inConversation(async ({ ask }) => {
      await ask(PIN_LUNA);

      const turn = await ask(WELLNESS_TOTAL);

      expect(turn.modelCalls).toEqual([`plugin_llm ${LUNA}`]);
      expect(turn.delivered).toEqual(["ใช้ไปทั้งหมด 1,303,307.51 บาท"]);
    });
  });

  it("B, C, D: referent resolver, storyboard planner, main agent and its tool follow-up", async () => {
    await inConversation(async ({ ask }) => {
      await ask(PIN_LUNA);

      const created = await ask(CREATE_MESSAGE);
      // New work is checked against open work, then planned: both on Luna.
      expect(created.modelCalls).toEqual([
        `cloudbath_conversation_referent ${LUNA}`,
        `storyboard_planner ${LUNA}`,
      ]);

      const backReference = await ask("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");
      expect(backReference.modelCalls).toEqual([
        `cloudbath_conversation_referent ${LUNA}`,
        `main_agent ${LUNA}`,
        `tool_followup ${LUNA}`,
      ]);
    });
  });

  it("E: compaction summarizes on the pinned model, whatever compaction.model says", async () => {
    await inConversation(
      async ({ ask, cfg, runs, compactions }) => {
        await ask(PIN_LUNA);
        await ask("สวัสดี");

        // Out of the run: /compact.
        const manual = await ask("/compact");
        expect(manual.modelCalls).toEqual([`context_compaction ${LUNA}`]);
        expect(compactions.at(-1)).toMatchObject({ sessionModelPinned: true });
        expect(compactTesting.resolveCompactionFallbacksOverride(compactions.at(-1)!)).toEqual([]);

        // In the run: the embedded runner builds overflow compaction from the
        // run it was handed.
        const run = runs.at(-1)!;
        expect(run).toMatchObject({ sessionModelPinned: true, modelFallbacksOverride: [] });
        const inRun = buildEmbeddedCompactionRuntimeContext({
          workspaceDir: "/tmp/workspace",
          agentDir: "/tmp/agent",
          config: cfg,
          provider: run.provider,
          modelId: run.model,
          sessionModelPinned: run.sessionModelPinned,
          modelFallbacksOverride: run.modelFallbacksOverride,
        });
        expect(`${inRun.provider}/${inRun.model}`).toBe(LUNA);
      },
      { compactionModel: DEEPSEEK },
    );
  });

  it("F: a failing pinned model is retried, never replaced by another model", async () => {
    await inConversation(async ({ ask, cfg }) => {
      await ask(PIN_LUNA);
      provider.failing.add(LUNA);
      provider.requests.length = 0;

      await ask(WELLNESS_TOTAL);

      // The data answer failed on Luna, so the turn fell to the agent: on Luna.
      expect(provider.requests.length).toBeGreaterThanOrEqual(2);
      expect(new Set(provider.requests)).toEqual(new Set([LUNA]));
      // The chain the reply path asked for holds exactly one model.
      const options = lastFallbackOptions();
      expect(options.fallbacksOverride).toEqual([]);
      expect(await candidatesTried({ ...options, cfg })).toEqual([LUNA]);
    });
  });

  it("G: after switching to Qwen, every text request of the next turn is Qwen", async () => {
    await inConversation(async ({ ask }) => {
      await ask(PIN_LUNA);
      const onLuna = await ask(WELLNESS_TOTAL);
      expect(onLuna.modelCalls).toEqual([`plugin_llm ${LUNA}`]);

      const switched = await ask("เปลี่ยนโมเดลเป็น qwen3.6-plus");
      expect(switched.delivered.join("")).toContain("Qwen");
      provider.requests.length = 0;

      const data = await ask(WELLNESS_TOTAL);
      const chat = await ask("สวัสดี");
      const compaction = await ask("/compact");

      expect(data.modelCalls).toEqual([`plugin_llm ${QWEN}`]);
      expect(chat.modelCalls).toEqual([`main_agent ${QWEN}`, `tool_followup ${QWEN}`]);
      expect(compaction.modelCalls).toEqual([`context_compaction ${QWEN}`]);
      expect(provider.requests.filter((request) => request !== QWEN)).toEqual([]);
    });
  });

  it("H: explicitly choosing the configured default pins it; it is not a reset", async () => {
    await inConversation(async ({ ask, cfg, runs }) => {
      await ask(PIN_LUNA);

      await ask("เปลี่ยนโมเดลเป็น deepseek-v4-flash-0731");

      expect(readSession()).toMatchObject({
        providerOverride: "openrouter",
        modelOverride: "deepseek/deepseek-v4-flash-0731",
        modelOverrideSource: "user",
      });
      const data = await ask(WELLNESS_TOTAL);
      const chat = await ask("สวัสดี");
      expect(data.modelCalls).toEqual([`plugin_llm ${DEEPSEEK}`]);
      expect(chat.modelCalls).toEqual([`main_agent ${DEEPSEEK}`, `tool_followup ${DEEPSEEK}`]);
      // Pinned: no Qwen fallback behind DeepSeek.
      expect(runs.at(-1)).toMatchObject({ sessionModelPinned: true, modelFallbacksOverride: [] });
      expect(await candidatesTried({ ...lastFallbackOptions(), cfg })).toEqual([DEEPSEEK]);
    });
  });

  it("I: a session the owner never pinned keeps the configured default and its fallbacks", async () => {
    await inConversation(async ({ ask, cfg, runs }) => {
      const data = await ask(WELLNESS_TOTAL);
      const chat = await ask("สวัสดี");

      expect(data.modelCalls).toEqual([`plugin_llm ${DEEPSEEK}`]);
      expect(chat.modelCalls).toEqual([`main_agent ${DEEPSEEK}`, `tool_followup ${DEEPSEEK}`]);
      expect(runs.at(-1)?.sessionModelPinned).toBe(false);
      expect(await candidatesTried({ ...lastFallbackOptions(), cfg })).toEqual([DEEPSEEK, QWEN]);
    });
  });

  it("J: a plugin naming its own model inside a pinned turn still gets the pin", async () => {
    await inConversation(async ({ ask, completeInEveryTurn }) => {
      await ask(PIN_LUNA);
      completeInEveryTurn(DEEPSEEK);

      const chat = await ask("สวัสดี");

      expect(chat.modelCalls).toEqual([
        `plugin_llm ${LUNA}`,
        `main_agent ${LUNA}`,
        `tool_followup ${LUNA}`,
      ]);
    });
  });

  it("J: without a pin, or outside the turn, a plugin's own model is used as named", async () => {
    await inConversation(async ({ ask, completeInEveryTurn, completeInBackground }) => {
      completeInEveryTurn(QWEN);
      const unpinned = await ask("สวัสดี");
      expect(unpinned.modelCalls).toEqual([
        `plugin_llm ${QWEN}`,
        `main_agent ${DEEPSEEK}`,
        `tool_followup ${DEEPSEEK}`,
      ]);

      await ask(PIN_LUNA);
      provider.requests.length = 0;
      await completeInBackground(QWEN);
      expect(provider.requests).toEqual([QWEN]);
    });
  });

  // Multi-agent guard: the pin owns the text model, never the agent. A helper
  // call an operator authorized to target another agent stays that agent.
  it("J: an authorized helper call for another agent keeps that agent and runs on the pin", async () => {
    await inConversation(async ({ ask, completeInEveryTurn }) => {
      await ask(PIN_LUNA);
      completeInEveryTurn(DEEPSEEK, "creative");
      provider.preparedAgents.length = 0;

      const chat = await ask("สวัสดี");

      expect(chat.modelCalls).toEqual([
        `plugin_llm ${LUNA}`,
        `main_agent ${LUNA}`,
        `tool_followup ${LUNA}`,
      ]);
      expect(provider.preparedAgents).toEqual(["creative"]);
      expect(provider.requests).not.toContain(DEEPSEEK);
    });
  });

  it("J: unpinned, an authorized helper call keeps its agent and its own model", async () => {
    await inConversation(async ({ ask, completeInEveryTurn }) => {
      completeInEveryTurn(QWEN, "creative");

      const chat = await ask("สวัสดี");

      expect(chat.modelCalls[0]).toBe(`plugin_llm ${QWEN}`);
      expect(provider.preparedAgents).toEqual(["creative"]);
    });
  });

  it("the current-model answer names exactly the model the turn's requests used", async () => {
    await inConversation(async ({ ask }) => {
      await ask(PIN_LUNA);
      const data = await ask(WELLNESS_TOTAL);
      const chat = await ask("สวัสดี");

      const question = await ask("ใช้โมเดลไรอยู่");

      expect(question.modelCalls).toEqual([]);
      expect(question.delivered.join("")).toContain("ตอนนี้ใช้โมเดล openai/gpt-6-luna ผ่าน openrouter");
      const observed = new Set(
        [...data.modelCalls, ...chat.modelCalls].map((call) => call.split(" ")[1]),
      );
      expect(observed).toEqual(new Set([LUNA]));
    });
  });

  it("specialist media models are not text models: the pin leaves them alone", async () => {
    await inConversation(async ({ ask, cfg }) => {
      await ask(PIN_LUNA);
      const { resolveImageGenerationModelConfigForTool } =
        await import("../src/agents/tools/image-generate-tool.js");
      const { resolveVideoGenerationModelConfigForTool } =
        await import("../src/agents/tools/video-generate-tool.js");
      const { resolveImageModelConfigForTool } = await import("../src/agents/tools/image-tool.js");
      const { resolveDefaultMediaModel } = await import("../src/media-understanding/defaults.js");
      const { runWithSessionModelScope } = await import("../src/sessions/session-model-scope.js");

      // Inside the pinned conversation's scope, as a tool call mid-turn would be.
      const resolved = runWithSessionModelScope(
        {
          sessionKey: SESSION_KEY,
          agentId: "main",
          runModel: { provider: "openrouter", model: "openai/gpt-6-luna" },
        },
        () => ({
          imageGeneration: resolveImageGenerationModelConfigForTool({ cfg })?.primary,
          videoGeneration: resolveVideoGenerationModelConfigForTool({ cfg })?.primary,
          imageEdit: resolveImageModelConfigForTool({ cfg, agentDir: "/tmp/agent" })?.primary,
          transcription: resolveDefaultMediaModel({
            providerId: "openai",
            capability: "audio",
            cfg,
            providerRegistry: new Map([
              ["openai", { id: "openai", defaultModels: { audio: "gpt-4o-transcribe" } }],
            ]) as never,
          }),
        }),
      );

      expect(resolved).toEqual({
        imageGeneration: "openrouter/google/gemini-3-pro-image",
        videoGeneration: "fal/kling-video-v3",
        imageEdit: "openrouter/google/gemini-3-flash",
        transcription: "gpt-4o-transcribe",
      });
    });
  });
});
