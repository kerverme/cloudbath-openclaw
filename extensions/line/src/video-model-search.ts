/**
 * Deterministic ranking of the LIVE OpenRouter video catalog against a natural
 * query, for the owner-only picker in video-model-control.ts.
 *
 * No model, brand or family is named anywhere in this file. Every candidate
 * comes from the catalog rows passed in, so a model OpenRouter adds later is
 * selectable with no deployment. The ranking is a pure function of (rows,
 * query): the same inputs always produce the same list and the same tier.
 *
 * Tiers exist so the caller can tell a confident match from a guess. Only an
 * exact or all-tokens-present match may ever be auto-applied; everything
 * weaker has to be shown as a numbered choice, because applying a guess here
 * silently changes which model a later paid confirmation would bill.
 */

import type { OpenRouterVideoModel } from "./video-model-catalog.js";

/** How well a row matched, highest first. Ordering is the contract. */
export const VIDEO_MODEL_MATCH_TIER = {
  exactId: 6,
  exactSlug: 5,
  allTokens: 4,
  brand: 3,
  substring: 2,
  fuzzy: 1,
} as const;

export type VideoModelMatchTier =
  (typeof VIDEO_MODEL_MATCH_TIER)[keyof typeof VIDEO_MODEL_MATCH_TIER];

/** At or above this tier the query identified one row well enough to apply it. */
export const VIDEO_MODEL_AUTO_APPLY_MIN_TIER: number = VIDEO_MODEL_MATCH_TIER.allTokens;

const MIN_CANDIDATES = 3;
const MAX_CANDIDATES = 8;
/** Edit distance is only forgiving for near-misses; beyond this it is noise. */
const MAX_FUZZY_DISTANCE_RATIO = 0.34;

const COMBINING_DIACRITICS_PATTERN = new RegExp("[̀-ͯ]", "gu");

/**
 * Case, punctuation and spacing all collapse to the same shape, so
 * "MiniMax: H3", "minimax-h3", "mini max h3" and "MINIMAX  H3" normalize
 * identically. Digits stay attached to their word ("h3" is one token).
 */
export function normalizeVideoModelText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(COMBINING_DIACRITICS_PATTERN, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function videoModelTokens(value: string): string[] {
  const normalized = normalizeVideoModelText(value);
  return normalized ? normalized.split(" ") : [];
}

/** Spacing-insensitive form, so "mini max" and "minimax" compare equal. */
function collapse(value: string): string {
  return normalizeVideoModelText(value).replaceAll(" ", "");
}

/**
 * The vendor segment of a row, taken from the catalog itself.
 *
 * OpenRouter ids are "<vendor>/<slug>" and display names are usually
 * "<Vendor>: <Model>", so the vendor is read from the row rather than from any
 * list of known brands — an unknown vendor works the same as a familiar one.
 */
export function videoModelBrand(model: OpenRouterVideoModel): string {
  const fromId = model.id.includes("/") ? model.id.slice(0, model.id.indexOf("/")) : "";
  const fromName = model.name.includes(":") ? model.name.slice(0, model.name.indexOf(":")) : "";
  return collapse(fromName || fromId);
}

function modelSlug(model: OpenRouterVideoModel): string {
  return model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
}

/** Bounded Levenshtein: returns `limit + 1` as soon as it cannot do better. */
function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i, ...Array.from<number>({ length: right.length }).fill(0)];
    let best = current[0]!;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, current[j]!);
    }
    if (best > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Near-miss match for a typo'd query.
 *
 * Exported so the fal picker ranks against the same edit-distance rule this
 * one does, instead of growing a second Levenshtein with its own threshold.
 */
export function videoModelFuzzyHit(queryCollapsed: string, candidate: string): boolean {
  if (!queryCollapsed || !candidate) {
    return false;
  }
  const limit = Math.floor(
    Math.max(queryCollapsed.length, candidate.length) * MAX_FUZZY_DISTANCE_RATIO,
  );
  return limit >= 1 && boundedEditDistance(queryCollapsed, candidate, limit) <= limit;
}

/** Spacing-insensitive normalization, shared with the fal picker. */
export function collapseVideoModelText(value: string): string {
  return collapse(value);
}

export type RankedVideoModel = Readonly<{
  model: OpenRouterVideoModel;
  tier: number;
  /** Tie-break within a tier: how many query tokens the row actually contains. */
  matchedTokens: number;
}>;

function scoreModel(
  model: OpenRouterVideoModel,
  query: Readonly<{ normalized: string; collapsed: string; tokens: readonly string[] }>,
): RankedVideoModel | undefined {
  const haystack = normalizeVideoModelText(`${model.id} ${model.name}`);
  const haystackCollapsed = collapse(`${model.id} ${model.name}`);
  const matchedTokens = query.tokens.filter((token) => haystack.includes(token)).length;

  const exact = [model.id, model.name].some(
    (value) => normalizeVideoModelText(value) === query.normalized,
  );
  if (exact) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.exactId, matchedTokens };
  }
  if (normalizeVideoModelText(modelSlug(model)) === query.normalized) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.exactSlug, matchedTokens };
  }
  if (query.tokens.length > 0 && matchedTokens === query.tokens.length) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.allTokens, matchedTokens };
  }
  const brand = videoModelBrand(model);
  // "mini max h3" collapses to "minimaxh3", which starts with the vendor
  // "minimax" — this is what keeps a misremembered model name inside the right
  // family instead of scattering across every vendor.
  const brandHit =
    brand.length > 0 &&
    (query.collapsed.startsWith(brand) ||
      query.tokens.some((token) => token === brand || videoModelFuzzyHit(token, brand)));
  if (brandHit) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.brand, matchedTokens };
  }
  if (
    query.collapsed &&
    (haystackCollapsed.includes(query.collapsed) || query.collapsed.includes(brand))
  ) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.substring, matchedTokens };
  }
  const fuzzy =
    videoModelFuzzyHit(query.collapsed, collapse(modelSlug(model))) ||
    videoModelFuzzyHit(query.collapsed, collapse(model.name)) ||
    query.tokens.some((token) =>
      videoModelTokens(model.name).some((candidate) => videoModelFuzzyHit(token, candidate)),
    );
  return fuzzy ? { model, tier: VIDEO_MODEL_MATCH_TIER.fuzzy, matchedTokens } : undefined;
}

export type VideoModelSearchResult = Readonly<{
  /** Best candidates, already trimmed for display. Empty means no match. */
  candidates: readonly RankedVideoModel[];
  /** Set only when exactly one row matched confidently enough to apply. */
  autoApply?: RankedVideoModel;
}>;

/**
 * Ranks the live catalog against one query.
 *
 * An empty query lists the catalog (the "browse" case). Otherwise candidates
 * are narrowed to the best-matching vendor family whenever the top hit is a
 * brand-level match or better, so a confident family match never shows rows
 * from unrelated vendors alongside it.
 */
export function searchVideoModels(
  models: readonly OpenRouterVideoModel[],
  rawQuery: string,
): VideoModelSearchResult {
  const normalized = normalizeVideoModelText(rawQuery);
  if (!normalized) {
    return { candidates: models.slice(0, MAX_CANDIDATES).map(toBrowseEntry) };
  }
  const query = { normalized, collapsed: collapse(rawQuery), tokens: videoModelTokens(rawQuery) };
  const scored = models
    .map((model) => scoreModel(model, query))
    .filter((entry): entry is RankedVideoModel => entry !== undefined)
    .toSorted(
      (left, right) =>
        right.tier - left.tier ||
        right.matchedTokens - left.matchedTokens ||
        left.model.name.localeCompare(right.model.name),
    );
  if (scored.length === 0) {
    return { candidates: [] };
  }
  const best = scored[0]!;
  const family =
    best.tier >= VIDEO_MODEL_MATCH_TIER.brand
      ? scored.filter((entry) => videoModelBrand(entry.model) === videoModelBrand(best.model))
      : scored;
  const candidates = family.slice(0, Math.max(MIN_CANDIDATES, MAX_CANDIDATES));
  // Auto-apply only when the query picked out exactly one row at a confident
  // tier. A guess must reach the owner as a numbered choice, because applying
  // it silently changes which model a later paid confirmation would bill.
  const confident = family.filter((entry) => entry.tier >= VIDEO_MODEL_AUTO_APPLY_MIN_TIER);
  return {
    candidates,
    ...(confident.length === 1 ? { autoApply: confident[0]! } : {}),
  };
}

function toBrowseEntry(model: OpenRouterVideoModel): RankedVideoModel {
  return { model, tier: VIDEO_MODEL_MATCH_TIER.substring, matchedTokens: 0 };
}

/** Compact one-line capability summary, omitted entirely when unknown. */
export function formatVideoModelCapabilities(model: OpenRouterVideoModel): string {
  const durations = model.supportedDurationSeconds.length
    ? `${model.supportedDurationSeconds.join("/")}s`
    : "";
  const resolutions = model.supportedResolutions.slice(0, 3).join("/");
  const audio = model.supportsAudio ? "Audio" : "";
  return [durations, resolutions, audio].filter(Boolean).join(" · ");
}
