import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD,
  estimateOpenRouterVideoCostUsd,
  evaluateLineVideoCostGuard,
  resolveLineVideoMaxEstimatedCostUsd,
} from "./video-cost-guard.js";

describe("estimateOpenRouterVideoCostUsd", () => {
  it("multiplies a per-second SKU by duration", () => {
    const cost = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: { "per-video-second": "0.50" } },
      durationSeconds: 8,
    });
    expect(cost).toBe(4);
  });

  it("treats a flat 'default' SKU as a per-video cost", () => {
    const cost = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: { default: "1.25" } },
      durationSeconds: 8,
    });
    expect(cost).toBe(1.25);
  });

  it("returns undefined for an unrecognized SKU shape (cannot safely estimate)", () => {
    const cost = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: { "per-megapixel": "0.01" } },
      durationSeconds: 8,
    });
    expect(cost).toBeUndefined();
  });

  it("returns undefined when the model has no pricing SKUs at all", () => {
    const cost = estimateOpenRouterVideoCostUsd({ model: {}, durationSeconds: 8 });
    expect(cost).toBeUndefined();
  });
});

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
      durationSeconds: 8,
      cfg: {},
    });
    expect(decision).toEqual({ allowed: true, estimatedCostUsd: 0.8 });
  });

  it("refuses submission when the estimate exceeds the configured limit", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: { "per-video-second": "1" } },
      durationSeconds: 8,
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
      durationSeconds: 8,
      cfg: {},
    });
    expect(decision).toEqual({ allowed: false, reason: "unknown_cost" });
  });
});
