import { describe, expect, it } from "vitest";
import { estimateFalVideoCostUsd, isFalModelPriced } from "./fal-video-pricing.js";

const H3 = { modelId: "minimax/h3/reference-to-video" };
/** A DIFFERENT endpoint with its own page: never priced from H3's numbers. */
const H3_MAX = { modelId: "minimax/h3-max/reference-to-video" };
const SEEDANCE = { modelId: "bytedance/seedance-2.0/reference-to-video" };
const SEEDANCE_25 = { modelId: "bytedance/seedance-2.5/reference-to-video" };

describe("per-model fal pricing", () => {
  it("reports unavailable when the operator has declared no rate for the endpoint", () => {
    // H3 Max publishes no price we have read, so it needs an operator rate.
    expect(
      estimateFalVideoCostUsd({ cfg: {}, model: H3_MAX, durationSeconds: 15, resolution: "768P" }),
    ).toEqual({
      kind: "unavailable",
      reason: "fal_model_rate_not_configured",
      modelId: H3_MAX.modelId,
    });
    expect(isFalModelPriced({}, H3_MAX.modelId)).toBe(false);
  });

  it("does NOT price one endpoint from another endpoint's rate", () => {
    const cfg = {
      videoGeneration: { falPricing: { models: { [SEEDANCE.modelId]: { usdPerSecond: 0.1 } } } },
    };
    expect(isFalModelPriced(cfg, SEEDANCE.modelId)).toBe(true);
    // A Seedance rate says nothing about H3 Max, which stays unpayable.
    expect(isFalModelPriced(cfg, H3_MAX.modelId)).toBe(false);
    expect(
      estimateFalVideoCostUsd({ cfg, model: H3_MAX, durationSeconds: 15, resolution: "768P" }).kind,
    ).toBe("unavailable");
  });

  it("prices from the endpoint's own rate and carries its source", () => {
    const cfg = {
      videoGeneration: {
        falPricing: {
          models: {
            [H3.modelId]: { usdPerSecond: 0.2, source: "https://fal.ai/pricing" },
          },
        },
      },
    };
    expect(
      estimateFalVideoCostUsd({ cfg, model: H3, durationSeconds: 15, resolution: "2K" }),
    ).toEqual({
      kind: "available",
      amountUsd: 3,
      source: {
        kind: "operator_configured",
        modelId: H3.modelId,
        reference: "https://fal.ai/pricing",
      },
    });
  });

  it("prefers a resolution-specific rate over the endpoint-wide one", () => {
    const cfg = {
      videoGeneration: {
        falPricing: {
          models: {
            [SEEDANCE.modelId]: { usdPerSecond: 0.1, byResolution: { "1080p": 0.4 } },
          },
        },
      },
    };
    const cheap = estimateFalVideoCostUsd({
      cfg,
      model: SEEDANCE,
      durationSeconds: 10,
      resolution: "720p",
    });
    const dear = estimateFalVideoCostUsd({
      cfg,
      model: SEEDANCE,
      durationSeconds: 10,
      resolution: "1080p",
    });
    expect(cheap).toMatchObject({ kind: "available", amountUsd: 1 });
    expect(dear).toMatchObject({ kind: "available", amountUsd: 4 });
    // The more precise statement names the resolution it applied to.
    expect(dear).toMatchObject({ source: { resolution: "1080p" } });
  });

  it("never returns a zero or negative quote from a bad rate", () => {
    for (const usdPerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cfg = {
        videoGeneration: { falPricing: { models: { [H3_MAX.modelId]: { usdPerSecond } } } },
      };
      expect(isFalModelPriced(cfg, H3_MAX.modelId)).toBe(false);
      expect(
        estimateFalVideoCostUsd({ cfg, model: H3_MAX, durationSeconds: 15, resolution: "768P" })
          .kind,
      ).toBe("unavailable");
    }
  });

  it("does NOT double the quote for audio: fal's two published schemas disagree", () => {
    const cfg = {
      videoGeneration: { falPricing: { models: { [SEEDANCE.modelId]: { usdPerSecond: 0.1 } } } },
    };
    expect(
      estimateFalVideoCostUsd({
        cfg,
        model: SEEDANCE,
        durationSeconds: 8,
        resolution: "720p",
      }),
    ).toMatchObject({ kind: "available", amountUsd: 0.8 });
  });

  it("reports unavailable rather than quoting a nonsense duration", () => {
    const cfg = {
      videoGeneration: { falPricing: { models: { [H3.modelId]: { usdPerSecond: 0.2 } } } },
    };
    for (const durationSeconds of [0, -5]) {
      expect(
        estimateFalVideoCostUsd({ cfg, model: H3, durationSeconds, resolution: "2K" }).kind,
      ).toBe("unavailable");
    }
  });

  describe("Seedance 2.5 carries fal's own published token price", () => {
    it("prices an image-reference request from the published formula", () => {
      // 720p (1280x720) x 10s x 24fps / 1024 tokens, at $0.0214 / 1000 tokens.
      const expected = ((1280 * 720 * 10 * 24) / 1024 / 1000) * 0.0214;
      const estimate = estimateFalVideoCostUsd({
        cfg: {},
        model: SEEDANCE_25,
        durationSeconds: 10,
        resolution: "720p",
      });
      expect(estimate).toMatchObject({ kind: "available" });
      if (estimate.kind !== "available") {
        return;
      }
      expect(estimate.amountUsd).toBeCloseTo(expected, 6);
      expect(estimate.source).toMatchObject({
        kind: "fal_published_tokens",
        modelId: SEEDANCE_25.modelId,
        resolution: "720p",
      });
      expect(isFalModelPriced({}, SEEDANCE_25.modelId)).toBe(true);
    });

    it("is payable with no operator rate, unlike every other endpoint", () => {
      expect(isFalModelPriced({}, SEEDANCE_25.modelId)).toBe(true);
      expect(isFalModelPriced({}, SEEDANCE.modelId)).toBe(false);
      expect(isFalModelPriced({}, H3_MAX.modelId)).toBe(false);
    });

    it("lets an operator rate for the same endpoint win over the list price", () => {
      const cfg = {
        videoGeneration: { falPricing: { models: { [SEEDANCE_25.modelId]: { usdPerSecond: 1 } } } },
      };
      expect(
        estimateFalVideoCostUsd({
          cfg,
          model: SEEDANCE_25,
          durationSeconds: 10,
          resolution: "720p",
        }),
      ).toMatchObject({ kind: "available", amountUsd: 10 });
    });

    it("fails closed on a pricing shape the published formula does not cover", () => {
      // Reference video/audio is a different shape; no blended rate is invented.
      expect(
        estimateFalVideoCostUsd({
          cfg: {},
          model: SEEDANCE_25,
          durationSeconds: 10,
          resolution: "720p",
          hasNonImageReferences: true,
        }).kind,
      ).toBe("unavailable");
      // 1080p is not a size this endpoint offers, so no dimensions exist.
      expect(
        estimateFalVideoCostUsd({
          cfg: {},
          model: SEEDANCE_25,
          durationSeconds: 10,
          resolution: "1080p",
        }).kind,
      ).toBe("unavailable");
    });

    it("never lets Seedance 2.5's token formula reach another endpoint", () => {
      // H3 is priced, but by its OWN per-second rate, not Seedance's tokens.
      const quote = estimateFalVideoCostUsd({
        cfg: {},
        model: H3,
        durationSeconds: 10,
        resolution: "2K",
      });
      expect(quote.kind === "available" && quote.source.kind).toBe("fal_published_rate");
    });
  });

  describe("MiniMax H3 carries fal's own published per-second rate", () => {
    /** One Character Library reference: the ordinary production shape. */
    function h3Quote(resolution: string, referenceImageCount = 1) {
      return estimateFalVideoCostUsd({
        cfg: {},
        model: H3,
        durationSeconds: 15,
        resolution,
        referenceImageCount,
      });
    }

    it.each([
      ["768P", 1.2],
      ["2K", 1.95],
      ["4K", 2.4],
    ])("H/I/J: prices 15 seconds at %s as $%s", (resolution, expected) => {
      const quote = h3Quote(resolution);
      expect(quote.kind).toBe("available");
      expect(quote.kind === "available" && quote.amountUsd).toBeCloseTo(expected, 6);
      expect(quote.kind === "available" && quote.source).toMatchObject({
        kind: "fal_published_rate",
        modelId: H3.modelId,
        resolution,
      });
    });

    it("K: the first five reference images cost nothing", () => {
      for (const count of [0, 1, 2, 3, 4, 5]) {
        const quote = h3Quote("2K", count);
        expect(quote.kind === "available" && quote.amountUsd, `${count} images`).toBeCloseTo(
          1.95,
          6,
        );
      }
    });

    it("L: each reference image past the fifth adds $0.08", () => {
      expect(h3Quote("2K", 6).kind === "available" && h3Quote("2K", 6).amountUsd).toBeCloseTo(
        2.03,
        6,
      );
      expect(h3Quote("2K", 9).kind === "available" && h3Quote("2K", 9).amountUsd).toBeCloseTo(
        1.95 + 4 * 0.08,
        6,
      );
    });

    it("is payable with no operator rate, and an operator rate still wins", () => {
      expect(isFalModelPriced({}, H3.modelId)).toBe(true);
      const cfg = {
        videoGeneration: { falPricing: { models: { [H3.modelId]: { usdPerSecond: 1 } } } },
      };
      expect(
        estimateFalVideoCostUsd({ cfg, model: H3, durationSeconds: 15, resolution: "2K" }),
      ).toMatchObject({
        kind: "available",
        amountUsd: 15,
        source: { kind: "operator_configured" },
      });
    });

    it("fails closed on shapes fal's H3 page does not price", () => {
      // Reference video/audio: the page publishes output seconds and reference
      // images, and says nothing about charging for the other two.
      expect(
        estimateFalVideoCostUsd({
          cfg: {},
          model: H3,
          durationSeconds: 15,
          resolution: "2K",
          referenceImageCount: 1,
          hasNonImageReferences: true,
        }).kind,
      ).toBe("unavailable");
      // Sizes outside H3's own enum have no published rate.
      for (const resolution of ["480P", "1080P"]) {
        expect(h3Quote(resolution).kind, resolution).toBe("unavailable");
      }
    });

    it("G: never prices H3 Max from H3's rate", () => {
      expect(isFalModelPriced({}, H3_MAX.modelId)).toBe(false);
      expect(
        estimateFalVideoCostUsd({
          cfg: {},
          model: H3_MAX,
          durationSeconds: 15,
          resolution: "768P",
          referenceImageCount: 1,
        }).kind,
      ).toBe("unavailable");
    });
  });
});
