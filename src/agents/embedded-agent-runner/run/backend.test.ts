// An attempt runs inside its session's model scope, carrying the model it executes.
import { describe, expect, it, vi } from "vitest";
import { currentSessionModelScope } from "../../../sessions/session-model-scope.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

const seenScopes = vi.hoisted(() => [] as unknown[]);

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: async () => {
    seenScopes.push(currentSessionModelScope());
    return {} as EmbeddedRunAttemptResult;
  },
}));

const { runEmbeddedAttemptWithBackend } = await import("./backend.js");

describe("runEmbeddedAttemptWithBackend", () => {
  it("scopes the attempt to its session and the model it executes", async () => {
    seenScopes.length = 0;

    await runEmbeddedAttemptWithBackend({
      sessionKey: "agent:main:line:group:c1",
      agentId: "main",
      provider: "openrouter",
      modelId: "openai/gpt-6-luna",
      authProfileId: "openrouter:default",
    } as EmbeddedRunAttemptParams);
    // Outside the attempt nothing is scoped.
    expect(currentSessionModelScope()).toBeUndefined();

    expect(seenScopes).toEqual([
      {
        sessionKey: "agent:main:line:group:c1",
        agentId: "main",
        runModel: {
          provider: "openrouter",
          model: "openai/gpt-6-luna",
          authProfileId: "openrouter:default",
        },
      },
    ]);
  });

  it("runs an attempt with no session unscoped", async () => {
    seenScopes.length = 0;

    await runEmbeddedAttemptWithBackend({
      provider: "openrouter",
      modelId: "openai/gpt-6-luna",
    } as EmbeddedRunAttemptParams);

    expect(seenScopes).toEqual([undefined]);
  });
});
