// A user's model selection is applied one way on every surface.
import { describe, expect, it } from "vitest";
import {
  hasUserPinnedSessionModel,
  resolveEffectiveModelFallbacks,
} from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyUserSessionModelSelection } from "./session-model-selection.js";

const cfg = {} as OpenClawConfig;
const DEFAULT_MODEL = { provider: "openrouter", model: "qwen/qwen3.8-27b" };
const LUNA = { provider: "openrouter", model: "openai/gpt-6-luna" };

function entry(fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "s", updatedAt: 1, ...fields } as SessionEntry;
}

describe("applyUserSessionModelSelection", () => {
  it("pins a non-default model and marks the switch live", () => {
    const next = entry({ modelProvider: "openrouter", model: DEFAULT_MODEL.model });

    applyUserSessionModelSelection({
      cfg,
      entry: next,
      selection: LUNA,
      defaultModel: DEFAULT_MODEL,
    });

    expect(next).toMatchObject({
      providerOverride: LUNA.provider,
      modelOverride: LUNA.model,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    // The previous run's model no longer speaks for the session.
    expect(next.model).toBeUndefined();
    expect(next.modelProvider).toBeUndefined();
  });

  it("choosing the configured default pins it; only an explicit reset clears the pin", () => {
    const next = entry({
      providerOverride: LUNA.provider,
      modelOverride: LUNA.model,
      modelOverrideSource: "user",
    });

    applyUserSessionModelSelection({
      cfg,
      entry: next,
      selection: DEFAULT_MODEL,
      defaultModel: DEFAULT_MODEL,
    });

    // A pin on the default still owns every text call and has no fallbacks.
    expect(next).toMatchObject({
      providerOverride: DEFAULT_MODEL.provider,
      modelOverride: DEFAULT_MODEL.model,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    expect(hasUserPinnedSessionModel(next)).toBe(true);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/qwen/qwen3.8-27b",
                fallbacks: ["openrouter/deepseek/deepseek-v4-flash-0731"],
              },
            },
          },
        } as OpenClawConfig,
        agentId: "main",
        hasSessionModelOverride: true,
        modelOverrideSource: next.modelOverrideSource,
      }),
    ).toEqual([]);
  });

  it("keeps a pinned auth profile that still authenticates the target provider", () => {
    const next = entry({
      authProfileOverride: "openrouter:work",
      authProfileOverrideSource: "user",
    });

    applyUserSessionModelSelection({
      cfg,
      entry: next,
      selection: LUNA,
      defaultModel: DEFAULT_MODEL,
    });

    expect(next.authProfileOverride).toBe("openrouter:work");
    expect(next.authProfileOverrideSource).toBe("user");
  });

  it("drops a pinned auth profile for another provider", () => {
    const next = entry({
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
    });

    applyUserSessionModelSelection({
      cfg,
      entry: next,
      selection: LUNA,
      defaultModel: DEFAULT_MODEL,
    });

    expect(next.authProfileOverride).toBeUndefined();
    expect(next.authProfileOverrideSource).toBeUndefined();
  });

  it("an explicitly chosen profile replaces the pinned one", () => {
    const next = entry({ authProfileOverride: "openrouter:work" });

    applyUserSessionModelSelection({
      cfg,
      entry: next,
      selection: LUNA,
      defaultModel: DEFAULT_MODEL,
      profileOverride: "openrouter:personal",
    });

    expect(next.authProfileOverride).toBe("openrouter:personal");
  });
});
