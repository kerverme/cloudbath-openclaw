/**
 * Per-model pricing for fal video endpoints.
 *
 * fal publishes NO machine-readable price. Its API returns none, and its
 * official client's generated schemas (`@fal-ai/client`, checked for both
 * 1.10.1 and 1.11.0-alpha.2) carry no price field on any video input or output
 * type. OpenRouter's Seedance price is a different provider's number and is
 * never reused here.
 *
 * So a rate is an OPERATOR-DECLARED fact, and it is declared PER ENDPOINT and
 * per resolution, because fal does not charge one blended rate across its
 * catalog — a Seedance mini second and an H3 2K second are different products.
 * There is deliberately no global fallback rate: a model with no declared
 * price is simply not payable, which is the same fail-closed exit the cost
 * guard already takes on an unknown estimate.
 */
import type { FalVideoModel } from "./fal-video-registry.js";

/**
 * Seedance 2.5 reference-to-video token pricing, from fal's current published
 * page for that endpoint: $0.0214 per 1000 tokens at 480p and 720p.
 *
 * Tokens are the output pixel area over the clip:
 *   tokens = (width * height * durationSeconds * FPS) / DIVISOR
 * which is the same shape fal and OpenRouter both publish for token-priced
 * video. The 24 is part of the billing formula, not an assumption about the
 * model's real frame rate.
 */
const SEEDANCE_2_5_MODEL_ID = "bytedance/seedance-2.5/reference-to-video";
const SEEDANCE_2_5_USD_PER_1K_TOKENS = 0.0214;
const VIDEO_TOKEN_FPS = 24;
const VIDEO_TOKEN_DIVISOR = 1024;
/** Output pixel dimensions fal lists for the resolutions this endpoint offers. */
const SEEDANCE_2_5_PIXELS: Readonly<Record<string, number>> = Object.freeze({
  "480p": 854 * 480,
  "720p": 1280 * 720,
});

/** Where a quote's rate came from. Carried into the draft, never inferred. */
export type FalVideoPricingSource = Readonly<{
  kind: "operator_configured" | "fal_published_tokens";
  /** The endpoint the rate was declared for. */
  modelId: string;
  /** Resolution the rate applies to, when the operator priced them apart. */
  resolution?: string;
  /** Operator's own citation, e.g. a fal pricing page URL. */
  reference?: string;
}>;

export type FalVideoPriceEstimate =
  | Readonly<{ kind: "available"; amountUsd: number; source: FalVideoPricingSource }>
  | Readonly<{ kind: "unavailable"; reason: "fal_model_rate_not_configured"; modelId: string }>;

/**
 * fal's own published token price for Seedance 2.5, when the request is one
 * this formula covers.
 *
 * Deliberately narrow: it applies to the image-reference path at a resolution
 * fal lists dimensions for. A request carrying reference VIDEO or AUDIO is a
 * different pricing shape, and rather than extrapolate a blended number this
 * returns undefined so the operator rate (or a refusal) takes over.
 */
export function estimateSeedance25TokenCostUsd(params: {
  modelId: string;
  durationSeconds: number;
  resolution: string;
  hasNonImageReferences?: boolean;
}): number | undefined {
  if (params.modelId !== SEEDANCE_2_5_MODEL_ID || params.hasNonImageReferences) {
    return undefined;
  }
  const pixels = SEEDANCE_2_5_PIXELS[params.resolution.trim().toLowerCase()];
  if (!pixels || !Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) {
    return undefined;
  }
  const tokens = (pixels * params.durationSeconds * VIDEO_TOKEN_FPS) / VIDEO_TOKEN_DIVISOR;
  return (tokens / 1000) * SEEDANCE_2_5_USD_PER_1K_TOKENS;
}

export type FalVideoPricingConfig = {
  videoGeneration?: {
    falPricing?: {
      /**
       * Rates by endpoint id. A model absent from this map is not payable.
       *
       * `usdPerSecond` prices the endpoint; `byResolution` overrides it where
       * fal charges differently per output size.
       */
      models?: Record<
        string,
        {
          usdPerSecond?: number;
          byResolution?: Record<string, number>;
          source?: string;
        }
      >;
    };
  };
};

function positiveRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** True when this endpoint has a usable declared rate. Gates payability. */
export function isFalModelPriced(cfg: FalVideoPricingConfig, modelId: string): boolean {
  // Seedance 2.5 carries fal's own published token price, so it is payable
  // without an operator rate. Every other endpoint still needs one.
  if (modelId === SEEDANCE_2_5_MODEL_ID) {
    return true;
  }
  const declared = cfg.videoGeneration?.falPricing?.models?.[modelId];
  if (!declared) {
    return false;
  }
  return (
    positiveRate(declared.usdPerSecond) !== undefined ||
    Object.values(declared.byResolution ?? {}).some((rate) => positiveRate(rate) !== undefined)
  );
}

/**
 * Quotes one fal request at the selected endpoint's own declared rate.
 *
 * Audio deliberately applies no multiplier: fal's stable schema says enabling
 * audio doubles Seedance's cost while its alpha schema says the cost is the
 * same either way, so the two published contracts disagree and neither is safe
 * to encode. The operator's rate is used as declared.
 */
export function estimateFalVideoCostUsd(params: {
  cfg: FalVideoPricingConfig;
  model: Pick<FalVideoModel, "modelId">;
  durationSeconds: number;
  resolution: string;
  /** True when the request carries reference video/audio, a shape the published formula does not cover. */
  hasNonImageReferences?: boolean;
}): FalVideoPriceEstimate {
  const modelId = params.model.modelId;
  const declared = params.cfg.videoGeneration?.falPricing?.models?.[modelId];
  const unavailable = Object.freeze({
    kind: "unavailable",
    reason: "fal_model_rate_not_configured",
    modelId,
  } as const);
  if (!Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) {
    return unavailable;
  }
  // An operator rate for THIS endpoint wins: it is a statement about the
  // account's own billing, which fal's list price cannot override.
  if (!declared) {
    const published = estimateSeedance25TokenCostUsd({
      modelId,
      durationSeconds: params.durationSeconds,
      resolution: params.resolution,
      ...(params.hasNonImageReferences === undefined
        ? {}
        : { hasNonImageReferences: params.hasNonImageReferences }),
    });
    return published === undefined
      ? unavailable
      : Object.freeze({
          kind: "available",
          amountUsd: published,
          source: Object.freeze({
            kind: "fal_published_tokens",
            modelId,
            resolution: params.resolution,
          }),
        });
  }
  // Resolution-specific first: it is the more precise statement of the same
  // fact, so a per-resolution rate always wins over the endpoint-wide one.
  const perResolution = positiveRate(declared.byResolution?.[params.resolution]);
  const rate = perResolution ?? positiveRate(declared.usdPerSecond);
  if (rate === undefined) {
    return unavailable;
  }
  const reference = declared.source?.trim();
  return Object.freeze({
    kind: "available",
    amountUsd: rate * params.durationSeconds,
    source: Object.freeze({
      kind: "operator_configured",
      modelId,
      ...(perResolution === undefined ? {} : { resolution: params.resolution }),
      ...(reference ? { reference } : {}),
    }),
  });
}
