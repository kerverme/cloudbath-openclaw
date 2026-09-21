/**
 * A live model switch is a selection, not a fallback.
 *
 * Production, LINE: the owner switched the session from Qwen to DeepSeek
 * through the validated picker while a turn was still running on Qwen. The
 * picker persisted the new selection and armed `liveModelSwitchPending`, the
 * in-flight attempt saw it and raised `LiveSessionModelSwitchError`:
 *
 *   live session model switch requested during active attempt for <sid>:
 *     openrouter/qwen/qwen3.8-27b -> openrouter/deepseek/deepseek-v4-flash-0731
 *   model fallback decision: requested=openrouter/qwen/qwen3.8-27b
 *     candidate=openrouter/deepseek/deepseek-v4-flash-0731
 *
 * DeepSeek was also a configured fallback of Qwen, so the chain recognised the
 * switch target as a later candidate and jumped straight to it. The error never
 * reached the retry owner, so the run object kept Qwen as its requested model
 * while the turn actually completed on DeepSeek. The fallback notice reads the
 * run's requested model as "the selected model", so the turn persisted
 * `selected=Qwen / active=DeepSeek` with zero recorded attempts — and every
 * later turn rendered "↪️ Model Fallback: …deepseek… (selected …qwen…; selected
 * model unavailable)" against a session whose canonical selection was DeepSeek.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveFallbackTransition } from "../auto-reply/fallback-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { runWithModelFallback } from "./model-fallback.js";

const QWEN = "qwen/qwen3.8-27b";
const DEEPSEEK = "deepseek/deepseek-v4-flash-0731";
/** The deployment's shape: the switch target is also Qwen's configured fallback. */
const CFG = {
  agents: {
    defaults: {
      model: { primary: `openrouter/${QWEN}`, fallbacks: [`openrouter/${DEEPSEEK}`] },
    },
  },
} as unknown as OpenClawConfig;

describe("a live switch into the fallback chain stays the retry owner's to apply", () => {
  it("does not win the turn as a fallback candidate", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "openrouter",
      model: DEEPSEEK,
    });
    const run = vi.fn(async (provider: string, model: string) => {
      if (model === QWEN) {
        throw switchError;
      }
      return `${provider}/${model}`;
    });

    await expect(
      runWithModelFallback({
        cfg: CFG,
        provider: "openrouter",
        model: QWEN,
        skipAuthProfileRuntime: true,
        run,
      }),
    ).rejects.toBe(switchError);

    // DeepSeek is never run here: running it would make the chain the winner
    // and leave the run's requested model on Qwen.
    expect(run.mock.calls.map(([provider, model]) => `${provider}/${model}`)).toStrictEqual([
      `openrouter/${QWEN}`,
    ]);
  });

  it("still treats a target this chain already burned as an ordinary failover", async () => {
    // A stale pointer back at the current candidate is not a live switch; it
    // stays a known failover so the retry owner cannot loop on it (#58496).
    const switchError = new LiveSessionModelSwitchError({
      provider: "openrouter",
      model: QWEN,
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(switchError)
      .mockResolvedValueOnce(`openrouter/${DEEPSEEK}`);

    const result = await runWithModelFallback({
      cfg: CFG,
      provider: "openrouter",
      model: QWEN,
      skipAuthProfileRuntime: true,
      run,
    });

    expect(result.model).toBe(DEEPSEEK);
    expect(result.attempts[0]?.reason).toBe("unknown");
  });
});

describe("the fallback notice follows the model the turn was actually asked for", () => {
  /** What the notice layer derives from a finished turn. */
  function notice(requestedModel: string, activeModel: string) {
    return resolveFallbackTransition({
      selectedProvider: "openrouter",
      selectedModel: requestedModel,
      activeProvider: "openrouter",
      activeModel,
      attempts: [],
    });
  }

  it("reports no fallback once the owner has applied the switch to the run", () => {
    // applyLiveModelSwitchToRun moves the run's requested model to the switch
    // target, so the turn's selected and active models are the same model.
    const transition = notice(DEEPSEEK, DEEPSEEK);

    expect(transition.fallbackActive).toBe(false);
    expect(transition.nextState).toStrictEqual({
      selectedModel: undefined,
      activeModel: undefined,
      reason: undefined,
    });
  });

  it("describes the state the swallowed switch used to persist", () => {
    // The defect's executable description: a run whose requested model was
    // never moved off Qwen, finishing on DeepSeek with nothing recorded to
    // explain it.
    const transition = notice(QWEN, DEEPSEEK);

    expect(transition.fallbackActive).toBe(true);
    expect(transition.nextState).toStrictEqual({
      selectedModel: `openrouter/${QWEN}`,
      activeModel: `openrouter/${DEEPSEEK}`,
      reason: "selected model unavailable",
    });
  });
});
