/**
 * Family-then-version model selection over the fal registry.
 *
 * A flat list of every fal video endpoint is unusable in a chat, so the owner
 * picks a family ("MiniMax", "ByteDance / Seedance", "Google / Veo") and then a
 * version within it. Both lists are filtered by the FROZEN storyboard's
 * requirements first: a model that cannot execute the confirmed scene is never
 * shown, because showing it would offer the owner a choice that cannot be
 * billed.
 *
 * Typed queries ("seedance 2.5", "minimax h3", "gemini") are ranked with the
 * SAME tiering and edit-distance rule the OpenRouter picker uses
 * (video-model-search.ts), against the registry's own display names and
 * aliases. The auto-apply bar is deliberately high: a weak or ambiguous match
 * always renders choices, because auto-applying a guess here decides which
 * endpoint a later `ยืนยัน VIDEO ####` bills.
 */
import {
  listFalVideoFamilies,
  type FalVideoFamily,
  type FalVideoModel,
} from "./fal-video-registry.js";
import {
  collapseVideoModelText,
  normalizeVideoModelText,
  videoModelFuzzyHit,
  videoModelTokens,
  VIDEO_MODEL_MATCH_TIER,
} from "./video-model-search.js";

/** At or above this tier the query named one model well enough to apply it. */
export const FAL_MODEL_AUTO_APPLY_MIN_TIER: number = VIDEO_MODEL_MATCH_TIER.allTokens;
const MAX_CANDIDATES = 8;

export type RankedFalModel = Readonly<{
  model: FalVideoModel;
  tier: number;
  matchedTokens: number;
}>;

function candidateTexts(model: FalVideoModel): string[] {
  return [model.displayName, model.modelId, ...model.aliases];
}

function rank(
  model: FalVideoModel,
  query: { normalized: string; collapsed: string; tokens: string[] },
): RankedFalModel | undefined {
  const texts = candidateTexts(model);
  const collapsedTexts = texts.map((text) => collapseVideoModelText(text));
  if (model.modelId.toLowerCase() === query.normalized.replaceAll(" ", "/")) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.exactId, matchedTokens: query.tokens.length };
  }
  if (collapsedTexts.some((text) => text === query.collapsed)) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.exactSlug, matchedTokens: query.tokens.length };
  }
  const haystack = texts.map((text) => videoModelTokens(text));
  const matchedTokens = query.tokens.filter((token) =>
    haystack.some((tokens) => tokens.includes(token)),
  ).length;
  if (query.tokens.length > 0 && matchedTokens === query.tokens.length) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.allTokens, matchedTokens };
  }
  if (
    collapsedTexts.some((text) => text.includes(query.collapsed) && query.collapsed.length >= 3)
  ) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.substring, matchedTokens };
  }
  if (collapsedTexts.some((text) => videoModelFuzzyHit(query.collapsed, text))) {
    return { model, tier: VIDEO_MODEL_MATCH_TIER.fuzzy, matchedTokens };
  }
  return matchedTokens > 0
    ? { model, tier: VIDEO_MODEL_MATCH_TIER.brand, matchedTokens }
    : undefined;
}

export type FalModelSearchResult = Readonly<{
  candidates: readonly RankedFalModel[];
  /**
   * The one model to apply without asking, when the query identified it.
   *
   * Set only for a single candidate at or above the auto-apply tier. Two
   * models tied at that tier means the owner said something that fits both,
   * so they choose rather than the product guessing which one to bill.
   */
  autoApply?: FalVideoModel;
}>;

/**
 * Ranks COMPATIBLE models against a typed query.
 *
 * Callers pass the already-filtered compatible list, so an incompatible model
 * can never be matched, auto-applied, or shown — the filter is not something
 * a well-phrased query can talk its way past.
 */
export function searchFalModels(
  compatible: readonly FalVideoModel[],
  query: string,
): FalModelSearchResult {
  const normalized = normalizeVideoModelText(query);
  if (!normalized) {
    return { candidates: Object.freeze([]) };
  }
  const parsed = {
    normalized,
    collapsed: collapseVideoModelText(query),
    tokens: videoModelTokens(query),
  };
  const ranked = compatible
    .map((model) => rank(model, parsed))
    .filter((entry): entry is RankedFalModel => entry !== undefined)
    .toSorted((left, right) => right.tier - left.tier || right.matchedTokens - left.matchedTokens)
    .slice(0, MAX_CANDIDATES);
  const top = ranked[0];
  const confident = ranked.filter((entry) => entry.tier >= FAL_MODEL_AUTO_APPLY_MIN_TIER);
  return {
    candidates: Object.freeze(ranked),
    // One confident match applies; several mean the query was ambiguous, and
    // an ambiguous query must never pick the model that gets billed.
    ...(confident.length === 1 && top ? { autoApply: confident[0]!.model } : {}),
  };
}

/**
 * Families the owner can still choose, given the frozen storyboard.
 *
 * A family with no compatible model is omitted rather than shown empty: every
 * listed choice leads somewhere payable.
 */
export function listCompatibleFalFamilies(compatible: readonly FalVideoModel[]): FalVideoFamily[] {
  return listFalVideoFamilies(compatible);
}

/** Compatible models inside one family, in registry order. */
export function listFalModelsInFamily(
  compatible: readonly FalVideoModel[],
  familyId: string,
): FalVideoModel[] {
  return compatible.filter((model) => model.familyId === familyId);
}

/**
 * Matches a typed family name ("seedance", "gemini", "minimax").
 *
 * "gemini" resolves to the Google family rather than to one Veo endpoint:
 * naming a brand is a narrowing, not a model choice, so it shows that family's
 * compatible versions instead of silently selecting one of them.
 */
export function matchFalFamily(
  families: readonly FalVideoFamily[],
  query: string,
): FalVideoFamily | undefined {
  const collapsed = collapseVideoModelText(query);
  if (!collapsed) {
    return undefined;
  }
  // Brand aliases first: "gemini" and "veo" both name Google without either
  // string appearing in the family's display name.
  return families.find(
    (family) =>
      family.aliases.some((alias) => collapseVideoModelText(alias) === collapsed) ||
      collapseVideoModelText(family.id) === collapsed ||
      collapseVideoModelText(family.displayName).includes(collapsed),
  );
}
