// Runtime LLM tests cover plugin provider hooks inside the model runtime adapter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextEngineCapabilities } from "../../agents/embedded-agent-runner/context-engine-capabilities.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithSessionModelScope } from "../../sessions/session-model-scope.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import { createRuntimeLlm, resolvePluginCallReason } from "./runtime-llm.runtime.js";
import type { RuntimeLogger } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel(modelId = "gpt-5.5") {
  return {
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: modelId,
      name: modelId,
      api: "openai",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  };
}

function createLogger(): RuntimeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const [firstArg] = mock.mock.calls[0] ?? [];
  const record = requireRecord(firstArg, label);
  expectFields(record, expected);
  return record;
}

function expectSingleLogPayload(
  loggerMethod: MockCalls,
  message: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(loggerMethod.mock.calls).toHaveLength(1);
  const [actualMessage, payload] = loggerMethod.mock.calls[0] ?? [];
  expect(actualMessage).toBe(message);
  const payloadRecord = requireRecord(payload, "log payload");
  expectFields(payloadRecord, expected);
  return payloadRecord;
}

function primeCompletionMocks() {
  hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      if (!params.modelRef) {
        return {
          provider: "openai",
          modelId: "gpt-5.5",
          agentDir: `/tmp/${params.agentId}`,
        };
      }
      const slash = params.modelRef.indexOf("/");
      return {
        provider: slash > 0 ? params.modelRef.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef.slice(slash + 1) : params.modelRef,
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 25,
      cost: { total: 0.0042 },
    },
  });
}

describe("runtime.llm.complete", () => {
  beforeEach(() => {
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    primeCompletionMocks();
  });

  it("binds context-engine completions to the active session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
      purpose: "memory-maintenance",
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "ada",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
    expect(result.agentId).toBe("ada");
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.after-turn" },
      purpose: "memory-maintenance",
      sessionKey: "agent:ada:session:abc",
    });
  });

  it("passes the active auth profile to context-engine completions", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      authProfileId: "openai:claude@martian.engineering",
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "ada",
      preferredProfile: "openai:claude@martian.engineering",
      allowBundledStaticCatalogFallback: true,
      allowMissingApiKeyModes: ["aws-sdk"],
      skipAgentDiscovery: true,
    });
  });

  it("uses trusted context-engine attribution inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:ada:session:abc",
      purpose: "context-engine.after-turn",
    });

    const result = await withPluginRuntimePluginIdScope("memory-core", () =>
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
        purpose: "memory-maintenance",
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.after-turn",
    });
    expect(result.agentId).toBe("ada");
  });

  it("does not fall back to the default agent for unbound active-session hooks", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "legacy-session",
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("fails closed for context-engine completions without any session agent", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      purpose: "context-engine.after-turn",
    });

    await expect(
      runtimeContext.llm!.complete({
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("not bound to an active session agent");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies context-engine model overrides without owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("allows context-engine model overrides through the owning plugin llm policy", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini", "minimax/MiniMax-M2.7"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai/gpt-5.4-mini",
    });
    expectFields(requireRecord(result.audit, "audit"), {
      caller: { kind: "context-engine", id: "context-engine.compaction" },
      sessionKey: "agent:main:session:abc",
    });
  });

  it("denies context-engine model overrides outside the owning plugin allowlist", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    await expect(
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow(
      'model override "openai/gpt-5.5" is not allowlisted for plugin "lossless-claw"',
    );
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("matches allowlist entries for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openrouter/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("openrouter/gpt-5.4-mini"),
    );
    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { agentId: string }) => ({
        provider: "openrouter",
        modelId: "openrouter/gpt-5.4-mini",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );

    await runtimeContext.llm!.complete({
      agentId: "main",
      model: "openrouter/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openrouter/gpt-5.4-mini",
    });
  });

  it("reports denials for provider-qualified model ids without doubling the provider prefix", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openrouter/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
      (params: { agentId: string }) => ({
        provider: "openrouter",
        modelId: "openrouter/gpt-5.5",
        agentDir: `/tmp/${params.agentId}`,
      }),
    );

    let caught: unknown;
    try {
      await runtimeContext.llm!.complete({
        model: "openrouter/gpt-5.5",
        messages: [{ role: "user", content: "summarize" }],
      });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('"openrouter/gpt-5.5"');
    expect(message).not.toContain("openrouter/openrouter/");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("keeps context-engine attribution and host-derived policy inside plugin runtime scope", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: {
        ...cfg,
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      sessionKey: "agent:main:session:abc",
      contextEnginePluginId: "lossless-claw",
      purpose: "context-engine.compaction",
    });

    const result = await withPluginRuntimePluginIdScope("spoofed-plugin", () =>
      runtimeContext.llm!.complete({
        model: "openai/gpt-5.4-mini",
        messages: [{ role: "user", content: "summarize" }],
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<NonNullable<typeof runtimeContext.llm>["complete"]>[0] & {
        caller: unknown;
      }),
    );

    expect(result.audit.caller).toEqual({
      kind: "context-engine",
      id: "context-engine.compaction",
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4-mini",
    });
  });

  it("allows the bound context-engine agent and denies cross-agent overrides", async () => {
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: "main",
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({
      agentId: "main",
      messages: [{ role: "user", content: "summarize" }],
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
    });

    await expect(
      runtimeContext.llm!.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "summarize" }],
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("allows explicit agentId for non-session plugin calls", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        allowAgentIdOverride: true,
        allowModelOverride: true,
        allowComplete: true,
      },
    });

    await llm.complete({
      agentId: "worker",
      messages: [{ role: "user", content: "draft" }],
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "worker",
    });
  });

  it("ignores request auth profile preferences without a trusted authority binding", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await llm.complete({
      authProfileId: "openai:work",
      messages: [{ role: "user", content: "draft" }],
    } as Parameters<typeof llm.complete>[0] & { authProfileId: string });

    const call = expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "main",
    });
    expect(call.preferredProfile).toBeUndefined();
  });

  it("allows host model overrides only when explicit authority allowlists the model", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
        allowComplete: true,
      },
    });

    await llm.complete({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "Ping" }],
    });
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
  });

  it("uses runtime-scoped config and the host preparation/dispatch path", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        caller: { kind: "host", id: "runtime-test" },
        allowComplete: true,
      },
    });

    const result = await llm.complete({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Ping" },
      ],
      temperature: 0.2,
      maxTokens: 64,
      purpose: "test-purpose",
    });

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      cfg,
      agentId: "main",
    });
    const completionArg = expectSingleCallFirstArg(
      hoisted.completeWithPreparedSimpleCompletionModel,
      {
        cfg,
      },
    );
    const context = requireRecord(completionArg.context, "completion context");
    expect(context.systemPrompt).toBe("Be terse.");
    const [message] = requireArray(context.messages, "completion messages");
    expectFields(requireRecord(message, "completion message"), {
      role: "user",
      content: "Ping",
    });
    expectFields(requireRecord(completionArg.options, "completion options"), {
      maxTokens: 64,
      temperature: 0.2,
    });
    expectFields(requireRecord(result, "completion result"), {
      text: "done",
      provider: "openai",
      model: "gpt-5.5",
    });
    expectFields(requireRecord(result.usage, "completion usage"), {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 25,
      costUsd: 0.0042,
    });
    const logPayload = expectSingleLogPayload(
      logger.info as unknown as MockCalls,
      "plugin llm completion",
      {
        caller: { kind: "host", id: "runtime-test" },
        purpose: "test-purpose",
      },
    );
    expectFields(requireRecord(logPayload.usage, "log usage"), { costUsd: 0.0042 });
  });

  it("uses scoped plugin identity and ignores caller-shaped spoofing input", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        caller: { kind: "host", id: "ignored-host" },
        allowComplete: true,
      },
    });

    const result = await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
        purpose: "identity-test",
        caller: { kind: "plugin", id: "spoofed-plugin" },
      } as Parameters<typeof llm.complete>[0] & { caller: unknown }),
    );

    expect(result.audit.caller).toEqual({ kind: "plugin", id: "trusted-plugin" });
    expectSingleLogPayload(logger.info as unknown as MockCalls, "plugin llm completion", {
      caller: { kind: "plugin", id: "trusted-plugin" },
      purpose: "identity-test",
    });
  });

  it("denies plugin model overrides by default", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target model");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("denies plugin agent overrides by default and allows them only when configured", async () => {
    const denied = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
      },
    });

    await expect(
      withPluginRuntimePluginIdScope("plain-plugin", () =>
        denied.complete({
          agentId: "worker",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow("cannot override the target agent");

    const allowed = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowAgentIdOverride: true,
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      allowed.complete({
        agentId: "worker",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "worker",
    });
  });

  it("allows plugin model overrides only when configured and allowlisted", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
            },
          },
        },
      }),
      authority: {
        allowComplete: true,
      },
    });

    await withPluginRuntimePluginIdScope("trusted-plugin", () =>
      llm.complete({
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "Ping" }],
      }),
    );
    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openai/gpt-5.4",
    });

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: "openai/gpt-5.5",
          messages: [{ role: "user", content: "Ping" }],
        }),
      ),
    ).rejects.toThrow('model override "openai/gpt-5.5" is not allowlisted');
  });

  it("denies completions when runtime authority disables the capability", async () => {
    const logger = createLogger();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      logger,
      authority: {
        allowComplete: false,
        denyReason: "not trusted",
      },
    });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toThrow("Plugin LLM completion denied: not trusted");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expectSingleLogPayload(logger.warn as unknown as MockCalls, "plugin llm completion denied", {
      reason: "not trusted",
    });
  });
});

/**
 * The owner's pinned session model is the text-model authority for every
 * completion made on that session's behalf. The agent's configured primary is
 * used only while the session has no pin.
 */
describe("runtime.llm.complete inside a session with a pinned model", () => {
  const SESSION = "agent:main:line:group:c1234567890abcdef";
  const ASSISTANT_SESSION = "agent:assistant:line:group:c1234567890abcdef";
  const LUNA = { providerOverride: "openrouter", modelOverride: "openai/gpt-6-luna" } as const;

  // A real SQLite session store: the pin resolver reads the row the same way
  // production does.
  let stateDir: string;
  let logger: RuntimeLogger;
  beforeEach(() => {
    logger = createLogger();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-llm-pin-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    hoisted.prepareSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    primeCompletionMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  async function pin(fields: Partial<SessionEntry>, agentId = "main", sessionKey = SESSION) {
    await replaceSessionEntry(
      { storePath: resolveStorePath(undefined, { agentId }), sessionKey },
      { sessionId: "s1", updatedAt: Date.now(), ...fields },
    );
  }

  function globalRuntime() {
    return createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
  }

  function preparedModelRef(): unknown {
    return requireRecord(
      hoisted.prepareSimpleCompletionModelForAgent.mock.calls.at(-1)?.[0],
      "prepare params",
    ).modelRef;
  }

  it("uses the session's pin, not the agent default, for a call made during the turn", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user", authProfileOverride: "openrouter:work" });

    const result = await runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
      globalRuntime().complete({ messages: [{ role: "user", content: "q" }], purpose: "p" }),
    );

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openrouter/openai/gpt-6-luna",
      preferredProfile: "openrouter:work",
    });
    expect(result.audit.sessionKey).toBe(SESSION);
  });

  it("stays on the model the run attempt executes, even after the owner switches", async () => {
    // The owner switched to Qwen while an attempt was still running on Luna.
    await pin({ providerOverride: "openrouter", modelOverride: "qwen/qwen3.6-plus" });

    await runWithSessionModelScope(
      {
        sessionKey: SESSION,
        agentId: "main",
        runModel: { provider: "openrouter", model: "openai/gpt-6-luna" },
      },
      () => globalRuntime().complete({ messages: [{ role: "user", content: "q" }] }),
    );

    expect(preparedModelRef()).toBe("openrouter/openai/gpt-6-luna");
  });

  it("binds session-bound authorities (context engines, commands) to the pin", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" });
    const runtimeContext = resolveContextEngineCapabilities({
      config: cfg,
      sessionKey: SESSION,
      purpose: "context-engine.compaction",
    });

    await runtimeContext.llm!.complete({ messages: [{ role: "user", content: "summarize" }] });

    expect(preparedModelRef()).toBe("openrouter/openai/gpt-6-luna");
  });

  it.each([
    ["no pin", undefined],
    ["an automatic fallback", { ...LUNA, modelOverrideSource: "auto" as const }],
  ])("keeps the configured default for a session with %s", async (_label, fields) => {
    if (fields) {
      await pin(fields);
    }

    await runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
      globalRuntime().complete({ messages: [{ role: "user", content: "q" }] }),
    );

    expect(preparedModelRef()).toBeUndefined();
  });

  it("fails rather than falling back to the default when the pin cannot be prepared", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" });
    hoisted.prepareSimpleCompletionModelForAgent.mockResolvedValue({
      error: "Unknown model: openrouter/openai/gpt-6-luna",
    });

    await expect(
      runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
        globalRuntime().complete({ messages: [{ role: "user", content: "q" }] }),
      ),
    ).rejects.toThrow("Unknown model: openrouter/openai/gpt-6-luna");
    // One preparation, for the pinned model; the default was never tried.
    expect(hoisted.prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
    expect(preparedModelRef()).toBe("openrouter/openai/gpt-6-luna");
    expect(hoisted.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  function trustedRuntime() {
    return createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: {
          entries: {
            "trusted-plugin": { llm: { allowModelOverride: true, allowAgentIdOverride: true } },
          },
        },
      }),
      authority: { allowComplete: true },
      logger,
    });
  }

  function trustedComplete(request: { model?: string; agentId?: string }) {
    return withPluginRuntimePluginIdScope("trusted-plugin", () =>
      trustedRuntime().complete({ messages: [{ role: "user", content: "q" }], ...request }),
    );
  }

  it("uses the pin even when a trusted plugin names its own model inside the turn", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user", authProfileOverride: "openrouter:work" });

    const result = await runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
      trustedComplete({ model: "openrouter/deepseek/deepseek-v4-flash-0731" }),
    );

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "main",
      modelRef: "openrouter/openai/gpt-6-luna",
      preferredProfile: "openrouter:work",
    });
    expect(result.agentId).toBe("main");
    expectSingleLogPayload(logger.info as unknown as MockCalls, "plugin llm completion", {
      modelSource: "session",
      supersededModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
  });

  // The pin owns the text model only. An authorized agent override keeps its
  // agent: that agent's directory, credentials and model catalog prepare the
  // conversation's model, and the conversation's auth profile stays behind.
  function prepareForEachAgent() {
    hoisted.prepareSimpleCompletionModelForAgent.mockImplementation(
      async (params: { agentId: string; modelRef?: string }) => {
        const prepared = createPreparedModel(params.modelRef ?? "gpt-5.5");
        return {
          ...prepared,
          selection: { ...prepared.selection, agentDir: `/tmp/${params.agentId}` },
        };
      },
    );
  }

  it("keeps an authorized agent override and runs it on the pin", async () => {
    await pin(
      { ...LUNA, modelOverrideSource: "user", authProfileOverride: "openrouter:work" },
      "assistant",
      ASSISTANT_SESSION,
    );
    prepareForEachAgent();

    const result = await runWithSessionModelScope(
      { sessionKey: ASSISTANT_SESSION, agentId: "assistant" },
      () =>
        trustedComplete({
          agentId: "creative",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
        }),
    );

    const prepare = expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "creative",
      modelRef: "openrouter/openai/gpt-6-luna",
    });
    expect(prepare.preferredProfile).toBeUndefined();
    const completion = requireRecord(
      hoisted.completeWithPreparedSimpleCompletionModel.mock.calls[0]?.[0],
      "completion params",
    );
    expect(completion.model).toMatchObject({ id: "openrouter/openai/gpt-6-luna" });
    expect(result.agentId).toBe("creative");
    expectSingleLogPayload(logger.info as unknown as MockCalls, "plugin llm completion", {
      agentId: "creative",
      modelSource: "session",
      supersededModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
  });

  it("keeps an authorized agent override and its model when the session is unpinned", async () => {
    prepareForEachAgent();

    const result = await runWithSessionModelScope(
      { sessionKey: ASSISTANT_SESSION, agentId: "assistant" },
      () =>
        trustedComplete({
          agentId: "creative",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
        }),
    );

    expectSingleCallFirstArg(hoisted.prepareSimpleCompletionModelForAgent, {
      agentId: "creative",
      modelRef: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(result.agentId).toBe("creative");
  });

  it("still rejects an unauthorized agent override inside a pinned turn", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" }, "assistant", ASSISTANT_SESSION);

    await expect(
      runWithSessionModelScope({ sessionKey: ASSISTANT_SESSION, agentId: "assistant" }, () =>
        withPluginRuntimePluginIdScope("plain-plugin", () =>
          globalRuntime().complete({
            agentId: "creative",
            messages: [{ role: "user", content: "q" }],
          }),
        ),
      ),
    ).rejects.toThrow("Plugin LLM completion cannot override the target agent.");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("uses the pin over an explicit model for a session-bound authority", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" });
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
        sessionKey: SESSION,
        agentId: "main",
        allowModelOverride: true,
      },
    });

    await llm.complete({ model: "openai/gpt-5.4", messages: [{ role: "user", content: "q" }] });

    expect(preparedModelRef()).toBe("openrouter/openai/gpt-6-luna");
  });

  it("still denies a model request the plugin is not trusted to make", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" });

    await expect(
      runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
        withPluginRuntimePluginIdScope("plain-plugin", () =>
          globalRuntime().complete({
            model: "openai/gpt-5.4",
            messages: [{ role: "user", content: "q" }],
          }),
        ),
      ),
    ).rejects.toThrow("Plugin LLM completion cannot override the target model.");
    expect(hoisted.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
  });

  it("keeps an explicit model request in a session the owner never pinned", async () => {
    await runWithSessionModelScope({ sessionKey: SESSION, agentId: "main" }, () =>
      trustedComplete({ model: "openai/gpt-5.4" }),
    );

    expect(preparedModelRef()).toBe("openai/gpt-5.4");
  });

  it("keeps an explicit model request for a background call outside any turn", async () => {
    await pin({ ...LUNA, modelOverrideSource: "user" });

    await trustedComplete({ model: "openai/gpt-5.4" });

    expect(preparedModelRef()).toBe("openai/gpt-5.4");
  });
});

/**
 * A plugin completion's declared purpose, as a turn-record call reason.
 *
 * The transport sees every provider request and knows why none of them
 * happened. Purposes are plugin-authored strings; the record's reasons are a
 * closed set, and only the ones an operator needs to tell apart on a timeline
 * are named. The pre-agent LINE helper is the one this investigation exists
 * for, so it gets its own reason rather than landing in `plugin_llm`.
 */
describe("resolvePluginCallReason", () => {
  it.each([
    ["cloudbath-conversation-referent", "cloudbath_conversation_referent"],
    ["cloudbath-storyboard-create", "storyboard_planner"],
    ["cloudbath-storyboard-edit", "storyboard_planner"],
    ["context-engine.compaction", "context_compaction"],
    ["context-engine.after-turn", "context_compaction"],
    ["logbook.standup", "plugin_llm"],
    ["", "plugin_llm"],
  ])("reads %s as %s", (purpose, expected) => {
    expect(resolvePluginCallReason(purpose)).toBe(expected);
  });

  it("reports an undeclared purpose as a plugin completion", () => {
    expect(resolvePluginCallReason(undefined)).toBe("plugin_llm");
  });
});
