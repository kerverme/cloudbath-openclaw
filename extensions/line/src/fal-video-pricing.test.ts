import { describe, expect, it } from "vitest";
import { estimateFalSeedanceCostUsd } from "./fal-video-pricing.js";

describe("fal Seedance pricing adapter", () => {
  it("reports unavailable when the operator has configured no fal rate", () => {
    expect(estimateFalSeedanceCostUsd({ cfg: {}, durationSeconds: 10 })).toEqual({
      kind: "unavailable",
      reason: "fal_rate_not_configured",
    });
  });

  it("never returns a zero or negative quote from a bad rate", () => {
    for (const seedanceReferenceToVideoUsdPerSecond of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        estimateFalSeedanceCostUsd({
          cfg: { videoGeneration: { falPricing: { seedanceReferenceToVideoUsdPerSecond } } },
          durationSeconds: 10,
        }).kind,
      ).toBe("unavailable");
    }
  });

  it("prices from the operator's own rate and carries its source", () => {
    const estimate = estimateFalSeedanceCostUsd({
      cfg: {
        videoGeneration: {
          falPricing: {
            seedanceReferenceToVideoUsdPerSecond: 0.15,
            source: "https://fal.ai/pricing",
          },
        },
      },
      durationSeconds: 10,
    });
    expect(estimate).toEqual({
      kind: "available",
      amountUsd: 1.5,
      source: { kind: "operator_configured", reference: "https://fal.ai/pricing" },
    });
  });

  it("does NOT double the quote for audio: fal's two published schemas disagree", () => {
    const cfg = {
      videoGeneration: { falPricing: { seedanceReferenceToVideoUsdPerSecond: 0.15 } },
    };
    expect(estimateFalSeedanceCostUsd({ cfg, durationSeconds: 8 })).toEqual({
      kind: "available",
      amountUsd: 0.15 * 8,
      source: { kind: "operator_configured" },
    });
  });

  it("reports unavailable rather than quoting a nonsense duration", () => {
    const cfg = {
      videoGeneration: { falPricing: { seedanceReferenceToVideoUsdPerSecond: 0.15 } },
    };
    expect(estimateFalSeedanceCostUsd({ cfg, durationSeconds: 0 }).kind).toBe("unavailable");
    expect(estimateFalSeedanceCostUsd({ cfg, durationSeconds: -5 }).kind).toBe("unavailable");
  });
});
