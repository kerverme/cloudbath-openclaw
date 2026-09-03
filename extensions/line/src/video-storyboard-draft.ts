/**
 * LINE-owned paid-draft preparation for a Cloudbath storyboard, on fal.
 *
 * This is the ONLY way a storyboard reaches the paid pipeline, and every step
 * of it is LINE-owned code running against LINE-owned state:
 *
 *   frozen storyboard -> derived requirements -> fal registry compatibility ->
 *   per-model quote -> fal auth check -> `createLineVideoDraft`
 *   (the one 4-digit code space)
 *
 * fal is the only video-generation provider in this flow. OpenRouter's video
 * catalog is deliberately not consulted: it describes a different provider's
 * models and prices, and using it to choose or quote a fal endpoint would show
 * the owner one thing and bill another. (OpenRouter remains in the repository
 * for chat and non-video use; nothing here removes it.)
 *
 * The storyboard plugin cannot open this plugin's keyed store — plugin state is
 * partitioned by plugin id (`createPluginStateKeyedStore(pluginId, …)`), so a
 * second allocator there would be a second, colliding code space whose codes
 * `video-confirmation.ts` would resolve against ITS drafts and bill the wrong
 * job. Hence the handoff: the storyboard hands over a provider-neutral request
 * and this module selects, quotes and allocates.
 *
 * Nothing here submits. Submission stays behind the exact
 * `ยืนยัน VIDEO ####` gate in video-confirmation.ts.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  evaluateFalModel,
  listCompatibleFalModels,
  resolveFalOutputResolution,
  selectDefaultFalModel,
  type FalIncompatibility,
  type FalVideoRequirements,
} from "./fal-model-selection.js";
import { compileFalProviderPrompt, type FalBoundReference } from "./fal-prompt-bindings.js";
import {
  estimateFalVideoCostUsd,
  isFalModelPriced,
  type FalVideoPricingConfig,
} from "./fal-video-pricing.js";
import {
  resolveFalVideoModel,
  type FalVideoModel,
  type FalVideoModelConfig,
} from "./fal-video-registry.js";
import { resolveLineVideoMaxEstimatedCostUsd } from "./video-cost-guard.js";
import {
  createLineVideoDraft,
  supersedeLineVideoDraftsForStoryboard,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";

export type LineStoryboardReferenceAsset = Readonly<{
  kind: "identity" | "product" | "style";
  source: "r2" | "https";
  locator: string;
  /** Canonical Character Library code, for the model's reference markers. */
  characterCode?: string;
  /** Name as cast in the scene, e.g. "F1". */
  displayName?: string;
}>;

export type LineStoryboardCharacterLock = Readonly<{
  /** Canonical Character Library id (CHAR-6). Never a display name. */
  code: string;
  pageId: string;
}>;

export type LineStoryboardVideoDraftRequest = Readonly<{
  accountId: string;
  /**
   * Raw LINE conversation identity ("C…" or "line:group:C…").
   *
   * Deliberately not the derived draft key: the key format is LINE-owned, and
   * having the storyboard side rebuild it would duplicate a contract the
   * confirmation gate compares byte-for-byte.
   */
  conversationId: string;
  ownerSenderId: string;
  deliveryTo?: string;
  /** Compiled instruction from the FROZEN storyboard version, used verbatim. */
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  /** Scene audio decision, carried across the seam as the storyboard's own mode. */
  audio: FalVideoRequirements["audio"];
  /** True when a beat carries a spoken line. */
  spokenDialogue: boolean;
  storyboardId: string;
  storyboardVersionNumber: number;
  characterLocks: readonly LineStoryboardCharacterLock[];
  referenceAssets: readonly LineStoryboardReferenceAsset[];
  /**
   * Endpoint the owner picked. Absent means "use the capability-aware default".
   *
   * A named model is still checked against the frozen storyboard; choosing is
   * never a way to bypass compatibility.
   */
  requestedModelId?: string;
}>;

/** Why a storyboard draft was refused. Every reason is fail-closed: no draft, no code. */
export type LineStoryboardVideoDraftRejection =
  | { kind: "rejected"; reason: "provider_auth_unavailable" }
  | { kind: "rejected"; reason: "invalid_conversation" }
  | {
      kind: "rejected";
      reason: "model_unavailable";
      model: string;
    }
  | {
      kind: "rejected";
      reason: "model_incompatible";
      model: string;
      incompatibilities: readonly FalIncompatibility[];
    }
  | { kind: "rejected"; reason: "no_compatible_model" }
  | { kind: "rejected"; reason: "unknown_cost"; model: string }
  | {
      kind: "rejected";
      reason: "over_limit";
      estimatedCostUsd: number;
      maxAllowedUsd: number;
    };

export type LineStoryboardVideoDraftResult =
  | Readonly<{
      kind: "created";
      draftId: string;
      /** fal endpoint that will receive the paid request. Shown to the owner. */
      modelId: string;
      modelName: string;
      familyId: string;
      durationSeconds: number;
      resolution: string;
      aspectRatio: string;
      audio: boolean;
      estimatedCostUsd: number;
      /** Snapshotted so confirmation can tell a re-quote from the accepted one. */
      maxAllowedUsd: number;
      /** Provenance for the quote, e.g. "fal:minimax/h3/reference-to-video". */
      pricingSource: string;
      /** Codes this allocation retired, so the caller can say which are dead. */
      supersededDraftIds?: readonly string[];
      /**
       * The preferred default this model replaced, when it was displaced.
       *
       * Lets the reply say WHY the default differs instead of the owner
       * quietly receiving a different model than the product usually picks.
       */
      displacedPreferred?: Readonly<{ modelName: string; reasons: readonly FalIncompatibility[] }>;
    }>
  | Readonly<LineStoryboardVideoDraftRejection>;

export type PrepareLineStoryboardVideoDraftDeps = Readonly<{
  draftStore: LineVideoDraftStore;
  /**
   * Proves fal credentials exist BEFORE a payable code is minted.
   *
   * A code the owner cannot actually spend is worse than a refusal: it looks
   * confirmable, and the failure only surfaces after they have committed.
   */
  resolveFalAuth: () => Promise<boolean>;
  cfg: Pick<OpenClawConfig, never> & {
    videoGeneration?: { maxEstimatedCostUsd?: number };
  } & FalVideoPricingConfig &
    FalVideoModelConfig;
  now?: () => number;
  randomDraftCode?: () => number;
}>;

/**
 * Requirements the frozen storyboard imposes on any model.
 *
 * Exported because the pickers judge candidates against exactly this, so the
 * list the owner is shown and the draft that gets allocated agree by
 * construction rather than by two similar-looking derivations.
 */
export function deriveFalRequirements(
  request: LineStoryboardVideoDraftRequest,
): FalVideoRequirements {
  return Object.freeze({
    durationSeconds: request.durationSeconds,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    audio: request.audio,
    spokenDialogue: request.spokenDialogue,
    identityReferenceCount: request.referenceAssets.filter((asset) => asset.kind === "identity")
      .length,
  });
}

/**
 * References in submission order, carrying the names their markers will use.
 *
 * Built from the frozen character locks so marker N, image URL N and character
 * N are one ordering with one source, not three that happen to agree.
 */
export function orderFalReferenceBindings(
  request: LineStoryboardVideoDraftRequest,
): FalBoundReference[] {
  return request.referenceAssets
    .filter((asset) => asset.kind === "identity")
    .map((asset, index) =>
      Object.freeze({
        index,
        ...(asset.characterCode ? { characterCode: asset.characterCode } : {}),
        ...(asset.displayName ? { displayName: asset.displayName } : {}),
      }),
    );
}

/** The chosen model, or the rejection that stops the draft from existing. */
type ModelChoice =
  | Readonly<{
      model: FalVideoModel;
      displaced?: Readonly<{ modelName: string; reasons: readonly FalIncompatibility[] }>;
    }>
  | Readonly<LineStoryboardVideoDraftRejection>;

function chooseModel(
  request: LineStoryboardVideoDraftRequest,
  requirements: FalVideoRequirements,
  cfg: PrepareLineStoryboardVideoDraftDeps["cfg"],
): ModelChoice {
  if (request.requestedModelId) {
    const model = resolveFalVideoModel(cfg, request.requestedModelId);
    if (!model) {
      return { kind: "rejected", reason: "model_unavailable", model: request.requestedModelId };
    }
    // An explicitly named model is judged exactly like a defaulted one. The
    // owner choosing it is not evidence that it can run their storyboard.
    const evaluation = evaluateFalModel(model, requirements);
    return evaluation.compatible
      ? { model }
      : {
          kind: "rejected",
          reason: "model_incompatible",
          model: model.modelId,
          incompatibilities: evaluation.reasons,
        };
  }
  const selection = selectDefaultFalModel(cfg, requirements);
  if (selection.kind === "none_compatible") {
    return { kind: "rejected", reason: "no_compatible_model" };
  }
  return {
    model: selection.model,
    ...(selection.preferredUnavailable
      ? {
          displaced: {
            modelName: selection.preferredUnavailable.model.displayName,
            reasons: selection.preferredUnavailable.reasons,
          },
        }
      : {}),
  };
}

function isRejection(choice: ModelChoice): choice is Readonly<LineStoryboardVideoDraftRejection> {
  return "kind" in choice && choice.kind === "rejected";
}

/**
 * Prepares a pending paid draft for one frozen storyboard version.
 *
 * Returns a rejection rather than throwing, so the storyboard flow can tell the
 * owner exactly why nothing was drafted; every rejection path allocates no code
 * and writes no draft.
 */
export async function prepareLineStoryboardVideoDraft(
  request: LineStoryboardVideoDraftRequest,
  deps: PrepareLineStoryboardVideoDraftDeps,
): Promise<LineStoryboardVideoDraftResult> {
  // Auth first: everything below builds toward a payable code, and a code the
  // owner cannot spend must never exist. No provider call is made either way.
  if (!(await deps.resolveFalAuth())) {
    return { kind: "rejected", reason: "provider_auth_unavailable" };
  }

  const conversationKey = buildLineVideoConversationKey({
    accountId: request.accountId,
    conversationId: request.conversationId,
  });
  if (!conversationKey) {
    return { kind: "rejected", reason: "invalid_conversation" };
  }

  const requirements = deriveFalRequirements(request);
  const choice = chooseModel(request, requirements, deps.cfg);
  if (isRejection(choice)) {
    return choice;
  }
  const model = choice.model;

  if (!isFalModelPriced(deps.cfg, model.modelId)) {
    return { kind: "rejected", reason: "unknown_cost", model: model.modelId };
  }
  // The size this endpoint will really produce, which is what gets quoted,
  // frozen and displayed -- never the requested one when they differ.
  const resolution = resolveFalOutputResolution(model, request.resolution);
  const price = estimateFalVideoCostUsd({
    cfg: deps.cfg,
    model,
    durationSeconds: request.durationSeconds,
    resolution,
  });
  if (price.kind !== "available") {
    return { kind: "rejected", reason: "unknown_cost", model: model.modelId };
  }
  const maxAllowedUsd = resolveLineVideoMaxEstimatedCostUsd(deps.cfg);
  if (price.amountUsd > maxAllowedUsd) {
    return {
      kind: "rejected",
      reason: "over_limit",
      estimatedCostUsd: price.amountUsd,
      maxAllowedUsd,
    };
  }

  // The prompt is compiled ONCE, here, and frozen into the draft: the marker
  // dialect depends on the chosen model, so it cannot be re-derived later
  // without risking a prompt that differs from the one that was quoted.
  const references = orderFalReferenceBindings(request);
  const prompt = compileFalProviderPrompt({
    storyboardPrompt: request.prompt,
    model,
    references,
  });
  const audio = requirements.audio !== "off";

  // The one collision-safe allocator, against LINE's own draft store.
  const draft = await createLineVideoDraft({
    store: deps.draftStore,
    accountId: request.accountId,
    conversationKey,
    ownerSenderId: request.ownerSenderId,
    model: model.modelId,
    providerRoute: Object.freeze({ provider: "fal", modelId: model.modelId }),
    prompt,
    durationSeconds: request.durationSeconds,
    aspectRatio: request.aspectRatio,
    resolution,
    audio,
    estimatedCostUsd: price.amountUsd,
    storyboardId: request.storyboardId,
    ...(request.deliveryTo ? { deliveryTo: request.deliveryTo } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.randomDraftCode ? { randomDraftCode: deps.randomDraftCode } : {}),
  });

  // Retire the previous code for THIS storyboard only, and only now that its
  // replacement exists. New work (a cast addition opens a new project, hence a
  // new storyboard id) never matches, so its code survives untouched.
  const superseded = await supersedeLineVideoDraftsForStoryboard({
    store: deps.draftStore,
    accountId: request.accountId,
    conversationKey,
    ownerSenderId: request.ownerSenderId,
    storyboardId: request.storyboardId,
    supersededByDraftId: draft.draftId,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    kind: "created",
    ...(superseded.length > 0 ? { supersededDraftIds: superseded } : {}),
    draftId: draft.draftId,
    modelId: model.modelId,
    modelName: model.displayName,
    familyId: model.familyId,
    durationSeconds: request.durationSeconds,
    resolution,
    aspectRatio: request.aspectRatio,
    audio,
    estimatedCostUsd: price.amountUsd,
    maxAllowedUsd,
    pricingSource: `fal:${price.source.modelId}`,
    ...(choice.displaced ? { displacedPreferred: choice.displaced } : {}),
  };
}

/** Compatible endpoints for a frozen storyboard, for the pickers. */
export function listStoryboardCompatibleModels(
  request: LineStoryboardVideoDraftRequest,
  cfg: FalVideoModelConfig & FalVideoPricingConfig,
): FalVideoModel[] {
  // Priced-only: an unpriced model cannot be billed, so offering it as a
  // choice would dead-end the owner at the Final Video Draft.
  return listCompatibleFalModels(cfg, deriveFalRequirements(request)).filter((model) =>
    isFalModelPriced(cfg, model.modelId),
  );
}
