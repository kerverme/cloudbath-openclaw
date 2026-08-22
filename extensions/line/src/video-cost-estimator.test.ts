/**
 * Production regression: the owner's request
 * "ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ" reached
 * `resolution=unknown_cost` -- past the owner gate, runtime context, canonical
 * OpenRouter credential resolution, catalog fetch, and model lookup -- so the
 * failure was purely cost estimation.
 *
 * Cause: Seedance 2.5 prices per OUTPUT TOKEN, not per second. Its live SKU keys
 * are video_tokens / video_tokens_without_audio / video_tokens_with_video_input,
 * none of which match the old estimator's /second/ pattern or its flat-key set,
 * so it returned undefined and the guard failed closed.
 *
 * Fixtures below are the VERBATIM live payloads from
 * https://openrouter.ai/api/v1/videos/models (fetched 2026-08-22).
 * Token math follows OpenRouter's published formula, quoted on
 * https://openrouter.ai/bytedance/seedance-2.0:
 *   "The number of tokens is given by
 *    (height of output video * width of output video * duration * 24) / 1024"
 */
import { describe, expect, it } from "vitest";
import {
  estimateOpenRouterVideoCostUsd,
  evaluateLineVideoCostGuard,
  resolveLineVideoOutputSize,
} from "./video-cost-guard.js";

/** Verbatim live pricing_skus for bytedance/seedance-2.5. */
const SEEDANCE_25_SKUS = {
  video_tokens: "0.0000107",
  video_tokens_without_audio: "0.0000107",
  video_tokens_with_video_input: "0.0000064",
};

/** Verbatim live supported_sizes for bytedance/seedance-2.5. */
const SEEDANCE_25_SIZES = [
  "854x480",
  "752x560",
  "640x640",
  "560x752",
  "480x854",
  "992x432",
  "1280x720",
  "1112x834",
  "960x960",
  "834x1112",
  "720x1280",
  "1470x630",
];

/** Verbatim live pricing_skus for bytedance/seedance-2.0 (resolution-labelled). */
const SEEDANCE_20_SKUS = {
  video_tokens: "0.000007",
  video_tokens_4k: "0.000004",
  video_tokens_1080p: "0.0000077",
  video_tokens_without_audio: "0.000007",
  video_tokens_with_video_input: "0.0000043",
  video_tokens_4k_with_video_input: "0.0000024",
  video_tokens_1080p_with_video_input: "0.0000047",
};

/** Verbatim live pricing_skus for a per-second, audio/4k-labelled model (google/veo family). */
const PER_SECOND_LABELLED_SKUS = {
  duration_seconds_with_audio: "0.40",
  duration_seconds_with_audio_4k: "0.60",
  duration_seconds_without_audio: "0.20",
  duration_seconds_without_audio_4k: "0.40",
};

function expectedTokenCost(params: {
  width: number;
  height: number;
  durationSeconds: number;
  rate: number;
}): number {
  return ((params.width * params.height * params.durationSeconds * 24) / 1024) * params.rate;
}

describe("output size resolution", () => {
  it("1: resolves 480p 16:9 to the live Seedance 2.5 size", () => {
    expect(
      resolveLineVideoOutputSize({
        supportedSizes: SEEDANCE_25_SIZES,
        resolution: "480p",
        aspectRatio: "16:9",
      }),
    ).toBe("854x480");
  });

  it("2: resolves 720p 16:9 and 720p 9:16 to different sizes", () => {
    expect(
      resolveLineVideoOutputSize({
        supportedSizes: SEEDANCE_25_SIZES,
        resolution: "720p",
        aspectRatio: "16:9",
      }),
    ).toBe("1280x720");
    expect(
      resolveLineVideoOutputSize({
        supportedSizes: SEEDANCE_25_SIZES,
        resolution: "720p",
        aspectRatio: "9:16",
      }),
    ).toBe("720x1280");
  });

  it("3: returns undefined when the model declares no usable size", () => {
    expect(
      resolveLineVideoOutputSize({ supportedSizes: [], resolution: "720p", aspectRatio: "16:9" }),
    ).toBeUndefined();
    expect(
      resolveLineVideoOutputSize({
        supportedSizes: SEEDANCE_25_SIZES,
        resolution: "4K",
        aspectRatio: "16:9",
      }),
    ).toBeUndefined();
  });
});

describe("token-priced models (the unknown_cost root cause)", () => {
  it("4: Seedance 2.5 at 480p/5s now produces a numeric cost from catalog metadata", () => {
    const cost = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
    });

    expect(cost).toBeDefined();
    expect(cost).toBeCloseTo(
      expectedTokenCost({ width: 854, height: 480, durationSeconds: 5, rate: 0.0000107 }),
      10,
    );
    // Sanity: 854*480*24/1024 * 0.0000107 = $0.1028/sec.
    expect(cost).toBeCloseTo(0.1028 * 5, 4);
  });

  it("5: cost scales with duration and with pixel area", () => {
    const at5s = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
    })!;
    const at10s = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 10, size: "854x480", resolution: "480p", audio: false },
    })!;
    const at720p = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 5, size: "1280x720", resolution: "720p", audio: false },
    })!;

    expect(at10s).toBeCloseTo(at5s * 2, 10);
    expect(at720p).toBeGreaterThan(at5s);
    expect(at720p).toBeCloseTo(at5s * ((1280 * 720) / (854 * 480)), 8);
  });

  it("6: a video-input SKU is never used for a text/image request", () => {
    // 0.0000064 (with_video_input) is cheaper; picking it would under-estimate.
    const cost = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
    })!;

    expect(cost).toBeCloseTo(
      expectedTokenCost({ width: 854, height: 480, durationSeconds: 5, rate: 0.0000107 }),
      10,
    );
    expect(cost).not.toBeCloseTo(
      expectedTokenCost({ width: 854, height: 480, durationSeconds: 5, rate: 0.0000064 }),
      10,
    );
  });

  it("7: resolution-labelled token SKUs are matched to the requested resolution", () => {
    const at1080p = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_20_SKUS },
      selector: { durationSeconds: 4, size: "1920x1080", resolution: "1080p", audio: true },
    })!;
    const at4k = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_20_SKUS },
      selector: { durationSeconds: 4, size: "3840x2160", resolution: "4K", audio: true },
    })!;
    const at720p = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: SEEDANCE_20_SKUS },
      selector: { durationSeconds: 4, size: "1280x720", resolution: "720p", audio: true },
    })!;

    expect(at1080p).toBeCloseTo(
      expectedTokenCost({ width: 1920, height: 1080, durationSeconds: 4, rate: 0.0000077 }),
      10,
    );
    expect(at4k).toBeCloseTo(
      expectedTokenCost({ width: 3840, height: 2160, durationSeconds: 4, rate: 0.000004 }),
      10,
    );
    // 720p has no labelled SKU, so the bare family rate applies.
    expect(at720p).toBeCloseTo(
      expectedTokenCost({ width: 1280, height: 720, durationSeconds: 4, rate: 0.000007 }),
      10,
    );
  });

  it("8: token pricing without a resolvable output size stays unknown", () => {
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: SEEDANCE_25_SKUS },
        selector: { durationSeconds: 5, resolution: "480p", audio: false },
      }),
    ).toBeUndefined();
  });
});

describe("per-second models keep working, with correct variant selection", () => {
  it("9: audio state selects the matching per-second SKU", () => {
    const withAudio = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: PER_SECOND_LABELLED_SKUS },
      selector: { durationSeconds: 5, resolution: "1080p", audio: true },
    });
    const withoutAudio = estimateOpenRouterVideoCostUsd({
      model: { pricingSkus: PER_SECOND_LABELLED_SKUS },
      selector: { durationSeconds: 5, resolution: "1080p", audio: false },
    });

    expect(withAudio).toBeCloseTo(0.4 * 5, 10);
    expect(withoutAudio).toBeCloseTo(0.2 * 5, 10);
  });

  it("10: the 4K variant applies only at 4K", () => {
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: PER_SECOND_LABELLED_SKUS },
        selector: { durationSeconds: 5, resolution: "4K", audio: true },
      }),
    ).toBeCloseTo(0.6 * 5, 10);
  });

  it("11: a simple per-second SKU still works", () => {
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: { "per-video-second": "0.10" } },
        selector: { durationSeconds: 8, size: "1280x720", resolution: "720p", audio: false },
      }),
    ).toBeCloseTo(0.8, 10);
  });

  it("12: a flat per-video SKU still works and ignores duration", () => {
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: { default: "0.25" } },
        selector: { durationSeconds: 30, resolution: "720p", audio: false },
      }),
    ).toBeCloseTo(0.25, 10);
  });
});

describe("unknown pricing still fails closed", () => {
  it("13: an unrecognized SKU shape yields unknown_cost, never a guess", () => {
    const unrecognizedShapes: Record<string, string>[] = [
      { "per-megapixel": "0.02" },
      { credits: "12" },
      { some_future_unit: "1.00" },
    ];
    for (const pricingSkus of unrecognizedShapes) {
      expect(
        estimateOpenRouterVideoCostUsd({
          model: { pricingSkus },
          selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
        }),
      ).toBeUndefined();
      expect(
        evaluateLineVideoCostGuard({
          model: { pricingSkus },
          selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
          cfg: {},
        }),
      ).toStrictEqual({ allowed: false, reason: "unknown_cost" });
    }
  });

  it("14: absent pricing metadata yields unknown_cost", () => {
    expect(
      evaluateLineVideoCostGuard({
        model: {},
        selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
        cfg: {},
      }),
    ).toStrictEqual({ allowed: false, reason: "unknown_cost" });
  });

  it("15: a negative or non-numeric rate is not trusted", () => {
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: { video_tokens: "-1" } },
        selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
      }),
    ).toBeUndefined();
    expect(
      estimateOpenRouterVideoCostUsd({
        model: { pricingSkus: { video_tokens: "free" } },
        selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
      }),
    ).toBeUndefined();
  });
});

describe("cost ceiling still blocks", () => {
  it("16: Seedance 2.5 at 480p/5s is allowed under the default ceiling", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
      cfg: {},
    });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.estimatedCostUsd).toBeCloseTo(0.514, 3);
  });

  it("17: a long high-resolution request exceeds the ceiling and is blocked", () => {
    const decision = evaluateLineVideoCostGuard({
      model: { pricingSkus: SEEDANCE_25_SKUS },
      selector: { durationSeconds: 30, size: "1280x720", resolution: "720p", audio: false },
      cfg: {},
    });

    expect(decision).toMatchObject({ allowed: false, reason: "over_limit" });
  });

  it("18: an explicit configured ceiling is honored", () => {
    expect(
      evaluateLineVideoCostGuard({
        model: { pricingSkus: SEEDANCE_25_SKUS },
        selector: { durationSeconds: 5, size: "854x480", resolution: "480p", audio: false },
        cfg: { videoGeneration: { maxEstimatedCostUsd: 0.1 } },
      }),
    ).toMatchObject({ allowed: false, reason: "over_limit" });
  });
});
