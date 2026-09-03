/**
 * Deterministic provider routing for LINE paid video.
 *
 * There are exactly two paid paths and this module is the only place that
 * chooses between them:
 *
 *   - fal's `bytedance/seedance-2.0/reference-to-video`, for a Seedance
 *     request that carries Character identity references. It is the only
 *     reference-to-video endpoint on either provider that takes MULTIPLE
 *     reference images.
 *   - OpenRouter, for everything else — unchanged, and still the path for
 *     every non-Seedance model the live picker can select.
 *
 * Both submit through core's `generateVideo()`; only `modelOverride` differs.
 * This plugin deliberately holds NO fal HTTP client: `extensions/fal` already
 * implements this endpoint's queue submit, poll, reference-count caps and
 * SSRF-guarded artifact download, and is registered as the `fal` video
 * provider. A second client here would be a second contract to keep in sync
 * with the same endpoint.
 *
 * The decision is a pure function of the model id and whether the request has
 * identity references, and it is taken ONCE, before a `ยืนยัน VIDEO ####` code
 * exists. The route is then frozen into the draft (video-draft-store.ts) and
 * read back verbatim at confirmation. There is deliberately no fallback edge:
 * a fal failure never re-submits to OpenRouter and vice versa, because either
 * would bill a second paid job the owner did not confirm.
 */

export const FAL_PROVIDER_ID = "fal";
export const OPENROUTER_PROVIDER_ID = "openrouter";

/**
 * fal's reference-to-video endpoint, as `extensions/fal` registers it.
 *
 * Seedance 2.0, not 2.5: fal publishes reference-to-video only under
 * `seedance-2.0` (plus its `fast`/`mini` variants). Verified against fal's own
 * generated endpoint map in `@fal-ai/client` — `src/types/endpoints.d.ts` maps
 * `"bytedance/seedance-2.0/reference-to-video"` to `Seedance2R2VInput` /
 * `{ seed, video: File }`, and no `seedance-2.5` reference endpoint exists.
 */
export const FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL = "bytedance/seedance-2.0/reference-to-video";

/**
 * The endpoint's own accepted values, from that same generated schema.
 *
 * Held here because a DRAFT must be validated and priced before its code is
 * minted, and fal publishes no live catalog to validate against. Only fields
 * present in BOTH the stable (1.10.1) and alpha (1.11.0-alpha.2) schemas are
 * accepted, so a draft stays submittable across whichever the endpoint serves:
 * the alpha additions (1080p/4k) are omitted deliberately.
 */
export const FAL_SEEDANCE_MIN_DURATION_SECONDS = 4;
export const FAL_SEEDANCE_MAX_DURATION_SECONDS = 15;
export const FAL_SEEDANCE_RESOLUTIONS = ["480p", "720p"] as const;
export const FAL_SEEDANCE_ASPECT_RATIOS = [
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
/** `Seedance2R2VInput.image_urls` accepts at most 9 entries. */
export const FAL_SEEDANCE_MAX_REFERENCE_IMAGES = 9;

export type LineVideoProviderRoute =
  | Readonly<{
      provider: typeof FAL_PROVIDER_ID;
      /** Passed to `generateVideo` as `fal/<modelId>`. */
      modelId: string;
      /** Catalog model the owner selected, kept for display and audit. */
      catalogModelId: string;
    }>
  | Readonly<{ provider: typeof OPENROUTER_PROVIDER_ID; modelId: string }>;

/**
 * Seedance family detection.
 *
 * Matches the vendor/family segment rather than a pinned version, so a catalog
 * that renames `bytedance/seedance-2.5` to a later revision still routes. It is
 * NOT a per-model special case: no other model id is named anywhere in this
 * module, and every non-Seedance model keeps its existing OpenRouter route.
 */
const SEEDANCE_MODEL_PATTERN = /(?:^|[/\-_.])seedance(?:$|[/\-_.\d])/iu;

export function isSeedanceVideoModel(modelId: string): boolean {
  return SEEDANCE_MODEL_PATTERN.test(modelId.trim());
}

/**
 * Chooses the paid path for one request. Pure; makes no network call.
 *
 * Three conditions, all required, all known before the quote:
 *
 *   - `falEnabled` — the operator configured fal for this product (see
 *     `isFalVideoRoutingConfigured`). fal publishes no live price, so without
 *     that configuration a fal draft is unquotable and would be refused;
 *     routing there anyway would take the working OpenRouter flow offline
 *     instead of adding a provider.
 *   - a Seedance model, because fal's reference endpoint is a Seedance one.
 *   - at least one identity reference. A Seedance request WITHOUT references
 *     is not reference-to-video: it would send an empty `image_urls`, which
 *     the endpoint's own schema requires to be populated.
 *
 * This is NOT a fallback. It is evaluated once, before any price is shown, and
 * frozen into the draft; nothing re-routes after a provider failure.
 */
export function resolveLineVideoProviderRoute(params: {
  modelId: string;
  identityReferenceCount: number;
  falEnabled: boolean;
}): LineVideoProviderRoute {
  const modelId = params.modelId.trim();
  if (params.falEnabled && params.identityReferenceCount > 0 && isSeedanceVideoModel(modelId)) {
    return Object.freeze({
      provider: FAL_PROVIDER_ID,
      modelId: FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL,
      catalogModelId: modelId,
    });
  }
  return Object.freeze({ provider: OPENROUTER_PROVIDER_ID, modelId });
}

/** Whole-second durations the endpoint accepts, ascending. */
export function falSeedanceDurations(): number[] {
  return Array.from(
    { length: FAL_SEEDANCE_MAX_DURATION_SECONDS - FAL_SEEDANCE_MIN_DURATION_SECONDS + 1 },
    (_unused, offset) => FAL_SEEDANCE_MIN_DURATION_SECONDS + offset,
  );
}
