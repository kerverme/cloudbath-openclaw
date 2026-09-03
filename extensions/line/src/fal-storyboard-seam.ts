import { listCompatibleFalFamilies, matchFalFamily, searchFalModels } from "./fal-model-picker.js";
/**
 * The LINE side of the post-freeze model conversation.
 *
 * The storyboard plugin owns the conversation but holds no model list, price
 * or capability of its own — it asks these functions and renders what comes
 * back, so adding or retiring a fal endpoint changes only `fal-video-registry.ts`.
 *
 * Requirements are derived from the FROZEN version and are the fixed side of
 * every answer here: the default, the family list, the version list and a
 * typed query are all filtered by them, so no path can offer, match, or apply
 * an endpoint that cannot execute the storyboard the owner confirmed.
 */
import {
  listCompatibleFalModels,
  selectDefaultFalModel,
  type FalIncompatibility,
  type FalVideoRequirements,
} from "./fal-model-selection.js";
import {
  estimateFalVideoCostUsd,
  isFalModelPriced,
  type FalVideoPricingConfig,
} from "./fal-video-pricing.js";
import {
  FAL_VIDEO_FAMILIES,
  type FalVideoModel,
  type FalVideoModelConfig,
} from "./fal-video-registry.js";

export type FalStoryboardConfig = FalVideoModelConfig & FalVideoPricingConfig;

/** One endpoint as the storyboard side renders it. */
export type FalStoryboardModelOption = Readonly<{
  modelId: string;
  displayName: string;
  familyId: string;
  familyDisplayName: string;
}>;

function toOption(model: FalVideoModel): FalStoryboardModelOption {
  return Object.freeze({
    modelId: model.modelId,
    displayName: model.displayName,
    familyId: model.familyId,
    familyDisplayName: FAL_VIDEO_FAMILIES[model.familyId]?.displayName ?? model.familyId,
  });
}

/**
 * Compatible AND priced endpoints.
 *
 * Price is part of being offerable: an unpriced endpoint would pass every
 * capability check and then dead-end at the Final Video Draft, which is a
 * worse experience than never being listed.
 */
export function listFalStoryboardModels(
  cfg: FalStoryboardConfig,
  requirements: FalVideoRequirements,
): FalStoryboardModelOption[] {
  return listCompatibleFalModels(cfg, requirements)
    .filter((model) => isFalModelPriced(cfg, model.modelId))
    .map(toOption);
}

/** Owner-facing sentence for why the usual default could not run this scene. */
export function describeFalDisplacement(
  modelName: string,
  reasons: readonly FalIncompatibility[],
  replacementName: string,
): string {
  const first = reasons[0];
  const detail =
    first?.kind === "duration"
      ? `ความยาว ${first.requested} วินาที ซึ่ง ${modelName} รองรับไม่ได้`
      : first?.kind === "duration_unknown"
        ? `ความยาวที่ ${modelName} ยังไม่ได้ยืนยันว่ารองรับ`
        : first?.kind === "audio_required"
          ? `เสียงที่ ${modelName} ยังไม่ได้ยืนยันว่ารองรับ`
          : first?.kind === "audio_must_be_silent"
            ? `งานเงียบ ซึ่ง ${modelName} ปิดเสียงไม่ได้`
            : first?.kind === "too_many_references"
              ? `ตัวละครอ้างอิง ${first.requested} ตัว ซึ่งเกินที่ ${modelName} รองรับ`
              : `ข้อกำหนดที่ ${modelName} รองรับไม่ได้`;
  return `งานนี้มี${detail}\nDefault สำหรับงานนี้จึงเป็น ${replacementName}`;
}

export type FalStoryboardOffer =
  | Readonly<{
      kind: "offered";
      model: FalStoryboardModelOption;
      estimatedCostUsd?: number;
      displacedReason?: string;
    }>
  | Readonly<{ kind: "none_compatible" }>;

/**
 * The default endpoint for a frozen storyboard, with its quote.
 *
 * A default that cannot be priced is not offered: the owner would be shown a
 * model they could never confirm.
 */
export function offerFalStoryboardDefault(
  cfg: FalStoryboardConfig,
  requirements: FalVideoRequirements,
): FalStoryboardOffer {
  const selection = selectDefaultFalModel(cfg, requirements);
  if (selection.kind === "none_compatible") {
    return { kind: "none_compatible" };
  }
  const priced = [selection.model, ...selection.alternatives].find((model) =>
    isFalModelPriced(cfg, model.modelId),
  );
  if (!priced) {
    return { kind: "none_compatible" };
  }
  const price = estimateFalVideoCostUsd({
    cfg,
    model: priced,
    durationSeconds: requirements.durationSeconds,
    resolution: requirements.resolution,
  });
  const displaced = selection.preferredUnavailable;
  return {
    kind: "offered",
    model: toOption(priced),
    ...(price.kind === "available" ? { estimatedCostUsd: price.amountUsd } : {}),
    ...(displaced
      ? {
          displacedReason: describeFalDisplacement(
            displaced.model.displayName,
            displaced.reasons,
            priced.displayName,
          ),
        }
      : {}),
  };
}

export type FalStoryboardMatch =
  | Readonly<{ kind: "model"; modelId: string }>
  | Readonly<{ kind: "family"; familyId: string }>
  | Readonly<{ kind: "candidates"; models: readonly FalStoryboardModelOption[] }>;

/**
 * Resolves a typed query ("seedance 2.5", "minimax h3", "gemini").
 *
 * A brand name narrows to that family rather than selecting inside it, and a
 * weak or ambiguous match renders choices. Only a confident single match
 * applies, because applying a guess here decides which endpoint gets billed.
 */
export function matchFalStoryboardQuery(
  cfg: FalStoryboardConfig,
  requirements: FalVideoRequirements,
  text: string,
): FalStoryboardMatch | undefined {
  const compatible = listCompatibleFalModels(cfg, requirements).filter((model) =>
    isFalModelPriced(cfg, model.modelId),
  );
  if (compatible.length === 0) {
    return undefined;
  }
  const families = listCompatibleFalFamilies(compatible);
  const family = matchFalFamily(families, text);
  const search = searchFalModels(compatible, text);
  // A brand name is a narrowing, not a choice: "gemini", "veo" and "seedance"
  // show that brand's compatible versions rather than selecting one to bill.
  if (family) {
    return { kind: "family", familyId: family.id };
  }
  if (search.autoApply) {
    return { kind: "model", modelId: search.autoApply.modelId };
  }
  return search.candidates.length > 0
    ? { kind: "candidates", models: search.candidates.map((entry) => toOption(entry.model)) }
    : undefined;
}
