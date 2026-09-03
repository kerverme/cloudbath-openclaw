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
  resolveFalOutputResolution,
  selectDefaultFalModel,
  type FalIncompatibility,
  type FalVideoRequirements,
} from "./fal-model-selection.js";
import { estimateFalVideoCostUsd, type FalVideoPricingConfig } from "./fal-video-pricing.js";
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
function pricedCompatibleModels(
  cfg: FalStoryboardConfig,
  requirements: FalVideoRequirements,
): FalVideoModel[] {
  return listCompatibleFalModels(cfg, requirements).filter(
    (model) =>
      estimateFalVideoCostUsd({
        cfg,
        model,
        durationSeconds: requirements.durationSeconds,
        // The size the endpoint will really produce, which is the one that
        // gets quoted, frozen and charged.
        resolution: resolveFalOutputResolution(model, requirements.resolution),
      }).kind === "available",
  );
}

export function listFalStoryboardModels(
  cfg: FalStoryboardConfig,
  requirements: FalVideoRequirements,
): FalStoryboardModelOption[] {
  return pricedCompatibleModels(cfg, requirements).map(toOption);
}

/** Owner-facing sentence for why the usual default could not run this scene. */
export function describeFalDisplacement(
  modelName: string,
  reasons: readonly FalIncompatibility[],
  replacementName: string,
): string {
  const first = reasons[0];
  const supportedMax =
    first?.kind === "duration" && first.supported && first.supported.length > 0
      ? first.supported[first.supported.length - 1]
      : undefined;
  // Each branch is a complete sentence: a shared prefix reads wrongly in Thai
  // once the reason is a state ("เงียบ") rather than a quantity.
  const detail =
    first?.kind === "duration"
      ? supportedMax === undefined
        ? `งานนี้ยาว ${first.requested} วินาที ซึ่ง ${modelName} รองรับไม่ได้`
        : `งานนี้ยาว ${first.requested} วินาที ${modelName} รองรับสูงสุด ${supportedMax} วินาที`
      : first?.kind === "duration_unknown"
        ? `${modelName} ยังไม่ได้ยืนยันว่ารองรับความยาวของงานนี้`
        : first?.kind === "audio_required"
          ? `งานนี้ต้องมีเสียง ซึ่ง ${modelName} ยังไม่ได้ยืนยันว่ารองรับ`
          : first?.kind === "audio_must_be_silent"
            ? `งานนี้ต้องไม่มีเสียง ซึ่ง ${modelName} ปิดเสียงไม่ได้`
            : first?.kind === "too_many_references"
              ? `งานนี้ใช้ตัวละครอ้างอิง ${first.requested} ตัว เกินที่ ${modelName} รองรับ`
              : `งานนี้มีข้อกำหนดที่ ${modelName} รองรับไม่ได้`;
  return `${detail}\nDefault สำหรับงานนี้จึงเป็น ${replacementName}`;
}

/**
 * Owner-facing sentence for a default dropped on PRICE, not capability.
 *
 * A separate sentence because the situation is different and the fix is
 * different: the endpoint can run this scene, but it has no rate we can stand
 * behind, so quoting it would put a number on the draft that nobody can
 * defend. Saying only "Default is X" would hide that an operator setting is
 * all that stands between the owner and their preferred model.
 */
export function describeFalUnpricedDisplacement(
  modelName: string,
  replacementName: string,
): string {
  const detail = `งานนี้ ${modelName} ทำได้ แต่ยังไม่มีราคาที่ยืนยันได้`;
  return `${detail}\nDefault สำหรับงานนี้จึงเป็น ${replacementName}`;
}

export type FalStoryboardOffer =
  | Readonly<{
      kind: "offered";
      model: FalStoryboardModelOption;
      /** The size this endpoint really produces, which is what was priced. */
      outputResolution: string;
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
  const payable = new Set(pricedCompatibleModels(cfg, requirements).map((model) => model.modelId));
  const priced = [selection.model, ...selection.alternatives].find((model) =>
    payable.has(model.modelId),
  );
  if (!priced) {
    return { kind: "none_compatible" };
  }
  // Priced at the size this endpoint will ACTUALLY produce, which is what the
  // draft freezes and charges. Quoting the requested size would show one
  // number and bill another whenever the endpoint cannot produce it.
  const outputResolution = resolveFalOutputResolution(priced, requirements.resolution);
  const price = estimateFalVideoCostUsd({
    cfg,
    model: priced,
    durationSeconds: requirements.durationSeconds,
    resolution: outputResolution,
  });
  const displaced = selection.preferredUnavailable;
  // Two different ways the preferred endpoint can lose, and the owner is owed
  // the right one: it could not run the scene, or it could but carries no
  // rate. The second is invisible without this branch, because an unpriced
  // model is filtered by `pricedCompatibleModels` AFTER capability selection
  // has already declared it the winner.
  const displacedReason = displaced
    ? describeFalDisplacement(displaced.model.displayName, displaced.reasons, priced.displayName)
    : priced.modelId === selection.model.modelId
      ? undefined
      : describeFalUnpricedDisplacement(selection.model.displayName, priced.displayName);
  return {
    kind: "offered",
    model: toOption(priced),
    outputResolution,
    ...(price.kind === "available" ? { estimatedCostUsd: price.amountUsd } : {}),
    ...(displacedReason ? { displacedReason } : {}),
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
  const compatible = pricedCompatibleModels(cfg, requirements);
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
