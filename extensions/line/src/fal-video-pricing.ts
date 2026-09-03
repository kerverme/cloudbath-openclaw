/**
 * Pricing adapter for fal.ai video endpoints.
 *
 * Separate from video-cost-guard.ts on purpose. That module interprets
 * OpenRouter's `pricing_skus`, which OpenRouter publishes in its live
 * `/api/v1/videos/models` catalog; fal publishes NO equivalent machine-readable
 * price in its API or in its official client's generated schemas
 * (`@fal-ai/client`, `src/types/endpoints.d.ts`, checked for both the stable
 * 1.10.1 and the 1.11.0-alpha.2 releases: the Seedance input/output types
 * carry no price field, and the queue API returns none). Reusing an OpenRouter
 * Seedance rate here would quote a number this provider never published.
 *
 * So the rate is an OPERATOR-DECLARED fact, read from LINE's own
 * `videoGeneration.falPricing` config, and every quote carries the source it
 * came from. With no configured rate the result is a typed `unavailable`, and
 * the cost guard fails closed (video-cost-guard.ts: an unknown estimate is
 * never treated as free) rather than showing the owner $0 for a payable job.
 */

/** Where a fal quote's rate came from. Carried into the draft, never inferred. */
export type FalVideoPricingSource = {
  kind: "operator_configured";
  /** Operator's own citation for the rate, e.g. a fal pricing page URL. */
  reference?: string;
};

export type FalVideoPriceEstimate =
  | Readonly<{ kind: "available"; amountUsd: number; source: FalVideoPricingSource }>
  | Readonly<{ kind: "unavailable"; reason: "fal_rate_not_configured" }>;

export type FalVideoPricingConfig = {
  videoGeneration?: {
    falPricing?: {
      /** USD per generated video second for the Seedance reference-to-video endpoint. */
      seedanceReferenceToVideoUsdPerSecond?: number;
      /** Operator's citation for the rate above. */
      source?: string;
    };
  };
};

const UNAVAILABLE: FalVideoPriceEstimate = Object.freeze({
  kind: "unavailable",
  reason: "fal_rate_not_configured",
});

/**
 * Whether the operator has enabled the fal path at all.
 *
 * The fal rate is what makes a fal draft quotable, and an unquotable draft is
 * refused. So the presence of that rate IS the operator's decision to use fal:
 * without it, routing a request there would take a working flow offline rather
 * than add a provider. Read once, BEFORE the quote, and frozen into the draft.
 */
export function isFalVideoRoutingConfigured(cfg: FalVideoPricingConfig): boolean {
  const rate = cfg.videoGeneration?.falPricing?.seedanceReferenceToVideoUsdPerSecond;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Quotes one fal Seedance reference-to-video request.
 *
 * `generate_audio` deliberately does NOT double the quote. fal's stable
 * (1.10.1) schema says enabling audio doubles the cost while its alpha
 * (1.11.0-alpha.2) schema says the cost is the same either way, so the two
 * published contracts disagree and neither is safe to encode as a multiplier.
 * The operator's configured per-second rate is used as-is; if their plan bills
 * audio separately they set the rate that reflects it.
 */
export function estimateFalSeedanceCostUsd(params: {
  cfg: FalVideoPricingConfig;
  durationSeconds: number;
}): FalVideoPriceEstimate {
  const pricing = params.cfg.videoGeneration?.falPricing;
  const rate = pricing?.seedanceReferenceToVideoUsdPerSecond;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return UNAVAILABLE;
  }
  if (!Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) {
    return UNAVAILABLE;
  }
  const reference = pricing?.source?.trim();
  return Object.freeze({
    kind: "available",
    amountUsd: rate * params.durationSeconds,
    source: Object.freeze({
      kind: "operator_configured",
      ...(reference ? { reference } : {}),
    }),
  });
}
