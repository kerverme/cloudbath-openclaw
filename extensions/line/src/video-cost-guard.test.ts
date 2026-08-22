/**
 * Cost-ceiling resolution and guard decision shape.
 *
 * Estimator semantics (token / per-second / flat pricing families) are covered
 * in video-cost-estimator.test.ts against verbatim live OpenRouter fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD,
  evaluateLineVideoCostGuard,
  resolveLineVideoMaxEstimatedCostUsd,
} from "./video-cost-guard.js";

describe("resolveLineVideoMaxEstimatedCostUsd", () => {
  it("falls back to the safe built-in default when unconfigured", () => {
    expect(resolveLineVideoMaxEstimatedCostUsd({})).toBe(DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD);
  });

  it("uses the operator-configured ceiling when set", () => {
    expect(
      resolveLineVideoMaxEstimatedCostUsd({ videoGeneration: { maxEstimatedCostUsd: 10 } }),
    ).toBe(10);
  });

  it("ignores a non-positive configured ceiling", () => {
    expect(
      resolveLineVideoMaxEstimatedCostUsd({ videoGeneration: { maxEstimatedCostUsd: -1 } }),
    ).toBe(DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD);
  });
});

describe("evaluateLineVideoCostGuard", () => {
  it("allows a submission within the configured limit", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: { "per-video-second": "0.10" } },
      selector: { durationSeconds: 8 },
      cfg: {},
    });
    expect(decision).toEqual({ allowed: true, estimatedCostUsd: 0.8 });
  });

  it("refuses submission when the estimate exceeds the configured limit", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: { "per-video-second": "1" } },
      selector: { durationSeconds: 8 },
      cfg: { videoGeneration: { maxEstimatedCostUsd: 2 } },
    });
    expect(decision).toEqual({
      allowed: false,
      reason: "over_limit",
      estimatedCostUsd: 8,
      maxAllowedUsd: 2,
    });
  });

  it("fails closed (never submits) when cost cannot be estimated at all", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: { "per-megapixel": "0.01" } },
      selector: { durationSeconds: 8 },
      cfg: {},
    });
    expect(decision).toEqual({ allowed: false, reason: "unknown_cost" });
  });
});
