// Built-in compaction requests are labeled as compaction on the turn latency record.
//
// Compaction runs inside the embedded runner's main_agent scope, so its summary
// and merge requests were recorded as a second main_agent call and derived into
// tool_followup: a turn that compacted once read as extra tool iterations.
import { describe, expect, it, vi } from "vitest";
import {
  createTurnLatencyLedger,
  currentLlmCallReason,
  currentTurnLatencyLedger,
  runWithLlmCallReason,
  runWithTurnLatencyLedger,
} from "../../infra/turn-latency-ledger.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { StreamFn } from "../runtime/index.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const MODEL: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function summaryMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Summary of the earlier conversation." }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Opens a ledger call for each request exactly as the provider transport does. */
const labelingStreamFn: StreamFn = (model) => {
  currentTurnLatencyLedger()
    ?.openModelCall({
      provider: model.provider,
      model: model.id,
      callReason: currentLlmCallReason(),
    })
    .complete();
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: summaryMessage() }));
  return stream;
};

function resourceLoader(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>> = new Map(),
): ResourceLoader {
  const extensions: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** A session long enough that compaction has older turns to summarize. */
async function compactableSession(loader: ResourceLoader) {
  const sessionManager = SessionManager.inMemory();
  for (let turn = 0; turn < 6; turn += 1) {
    sessionManager.appendMessage({
      role: "user",
      content: `question ${turn} ${"q".repeat(40_000)}`,
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      ...summaryMessage(),
      content: [{ type: "text", text: `answer ${turn} ${"a".repeat(40_000)}` }],
    });
  }
  const { session } = await createAgentSession({
    model: MODEL,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  });
  session.agent.streamFn = labelingStreamFn;
  return session;
}

/** Runs a main-agent request, a compaction, and the next agent request in one turn. */
async function turnWithCompaction(compactNow: () => Promise<unknown>) {
  const ledger = createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "turn-1" });
  await runWithTurnLatencyLedger(ledger, () =>
    runWithLlmCallReason("main_agent", async () => {
      await labelingStreamFn(MODEL, { messages: [] }, {});
      await compactNow();
      await labelingStreamFn(MODEL, { messages: [] }, {});
    }),
  );
  return ledger.finish({ outcome: "completed" });
}

describe("built-in compaction requests on the turn latency record", () => {
  it("labels the summary request context_compaction, not tool_followup", async () => {
    const session = await compactableSession(resourceLoader());

    const record = await turnWithCompaction(() => session.compact());

    const reasons = record?.modelCalls.map((call) => call.callReason) ?? [];
    expect(reasons[0]).toBe("main_agent");
    expect(reasons.at(-1)).toBe("tool_followup");
    expect(reasons.slice(1, -1).length).toBeGreaterThan(0);
    expect(new Set(reasons.slice(1, -1))).toEqual(new Set(["context_compaction"]));
    expect(record?.toolIterations).toBe(1);
  });

  it("labels summary and merge requests made by a compaction extension", async () => {
    const extensionReasons: string[] = [];
    const beforeCompact = vi.fn(async () => {
      // A safeguard-style extension summarizes in stages: two partial summaries, one merge.
      for (let request = 0; request < 3; request += 1) {
        extensionReasons.push(currentLlmCallReason());
        await labelingStreamFn(MODEL, { messages: [] }, {});
      }
      return undefined;
    });
    const session = await compactableSession(
      resourceLoader(new Map([["session_before_compact", [beforeCompact]]])),
    );

    const record = await turnWithCompaction(() => session.compact());

    expect(beforeCompact).toHaveBeenCalledOnce();
    expect(extensionReasons).toEqual([
      "context_compaction",
      "context_compaction",
      "context_compaction",
    ]);
    const reasons = record?.modelCalls.map((call) => call.callReason) ?? [];
    expect(reasons.filter((reason) => reason === "tool_followup")).toHaveLength(1);
    expect(reasons.filter((reason) => reason === "context_compaction").length).toBeGreaterThan(3);
  });
});
