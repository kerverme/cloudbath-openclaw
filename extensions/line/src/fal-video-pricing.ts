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

/** Where a quote's rate came from. Carried into the draft, never inferred. */
export type FalVideoPricingSource = Readonly<{
  kind: "operator_configured";
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
}): FalVideoPriceEstimate {
  const modelId = params.model.modelId;
  const declared = params.cfg.videoGeneration?.falPricing?.models?.[modelId];
  const unavailable = Object.freeze({
    kind: "unavailable",
    reason: "fal_model_rate_not_configured",
    modelId,
  } as const);
  if (!declared || !Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) {
    return unavailable;
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
