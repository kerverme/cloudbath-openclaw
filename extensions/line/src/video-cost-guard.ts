/**
 * Owner-only LINE video-generation cost guard.
 *
 * OpenRouter's `pricing_skus` units are heterogeneous across models/providers
 * (per-second, flat per-video, per-megapixel, ...) — see the OpenRouter video
 * model catalog docs' own warning that callers must inspect the matching
 * model's SKUs before routing production traffic. This estimator only trusts
 * SKU keys it can unambiguously interpret; every other shape returns
 * `undefined` ("cannot estimate") rather than guessing, and the confirmation
 * gate (video-confirmation.ts) fails closed on an unknown estimate instead of
 * submitting an unbounded paid job.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenRouterVideoModel } from "./video-model-catalog.js";

/** Safe conservative default when the operator has not configured a limit. */
export const DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD = 2;

const PER_SECOND_SKU_PATTERN = /second/iu;
const FLAT_SKU_KEYS = new Set(["default", "per-video", "flat"]);

/**
 * Estimates USD cost for one video at the given duration, or `undefined` when
 * the model's pricing SKU shape cannot be safely interpreted.
 */
export function estimateOpenRouterVideoCostUsd(params: {
  model: Pick<OpenRouterVideoModel, "pricingSkus">;
  durationSeconds: number;
}): number | undefined {
  const skus = params.model.pricingSkus;
  if (!skus) {
    return undefined;
  }
  for (const [key, raw] of Object.entries(skus)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    if (PER_SECOND_SKU_PATTERN.test(key)) {
      return value * Math.max(1, params.durationSeconds);
    }
  }
  for (const [key, raw] of Object.entries(skus)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    if (FLAT_SKU_KEYS.has(key.toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

/** Resolves the configured cost ceiling, falling back to the safe built-in default. */
export function resolveLineVideoMaxEstimatedCostUsd(cfg: {
  videoGeneration?: { maxEstimatedCostUsd?: number };
}): number {
  const configured = cfg.videoGeneration?.maxEstimatedCostUsd;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD;
}

export type LineVideoCostGuardDecision =
  | { allowed: true; estimatedCostUsd: number }
  | { allowed: false; reason: "unknown_cost" }
  | { allowed: false; reason: "over_limit"; estimatedCostUsd: number; maxAllowedUsd: number };

/** Fails closed: an unestimable cost is treated as unsafe to submit, never as "free". */
export function evaluateLineVideoCostGuard(params: {
  model: Pick<OpenRouterVideoModel, "pricingSkus">;
  durationSeconds: number;
  cfg: Pick<OpenClawConfig, never> & { videoGeneration?: { maxEstimatedCostUsd?: number } };
}): LineVideoCostGuardDecision {
  const estimatedCostUsd = estimateOpenRouterVideoCostUsd({
    model: params.model,
    durationSeconds: params.durationSeconds,
  });
  if (estimatedCostUsd === undefined) {
    return { allowed: false, reason: "unknown_cost" };
  }
  const maxAllowedUsd = resolveLineVideoMaxEstimatedCostUsd(params.cfg);
  if (estimatedCostUsd > maxAllowedUsd) {
    return { allowed: false, reason: "over_limit", estimatedCostUsd, maxAllowedUsd };
  }
  return { allowed: true, estimatedCostUsd };
}
