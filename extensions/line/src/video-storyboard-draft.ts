/**
 * LINE-owned paid-draft preparation for a Cloudbath storyboard.
 *
 * This is the ONLY way a storyboard reaches the paid pipeline, and every step
 * of it is LINE-owned code running against LINE-owned state:
 *
 *   live OpenRouter catalog -> capability validation -> live quote ->
 *   cost guard -> `createLineVideoDraft` (the one 4-digit code space)
 *
 * The storyboard plugin cannot open this plugin's keyed store — plugin state is
 * partitioned by plugin id (`createPluginStateKeyedStore(pluginId, …)`), so a
 * second allocator there would be a second, colliding code space whose codes
 * `video-confirmation.ts` would resolve against ITS drafts and bill the wrong
 * job. Hence the handoff: the storyboard hands over a provider-neutral request
 * and this module allocates.
 *
 * Nothing here submits. Submission stays behind the exact
 * `ยืนยัน VIDEO ####` gate in video-confirmation.ts.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  evaluateLineVideoCostGuard,
  resolveLineVideoMaxEstimatedCostUsd,
  resolveLineVideoOutputSize,
} from "./video-cost-guard.js";
import {
  createLineVideoDraft,
  supersedeLineVideoDraftsForStoryboard,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import { loadOpenRouterVideoModels, type OpenRouterVideoModel } from "./video-model-catalog.js";
import {
  buildLineVideoConversationKey,
  DEFAULT_LINE_VIDEO_MODEL,
  resolveLineVideoModelPreference,
  type LineVideoModelPreferenceStore,
} from "./video-model-preference.js";

/**
 * The model a storyboard draft binds to.
 *
 * Reuses this plugin's existing default rather than restating the slug, so the
 * storyboard path and the conversation preference can never bind different
 * models. The slug is the only fixed fact: duration, resolution, aspect,
 * frame-image support, audio and price all come from the live catalog below,
 * so a provider capability or price change is observed rather than assumed.
 */
export const LINE_STORYBOARD_VIDEO_MODEL_ID = DEFAULT_LINE_VIDEO_MODEL;

export type LineStoryboardReferenceAsset = Readonly<{
  kind: "identity" | "product" | "style";
  source: "r2" | "https";
  locator: string;
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
  /** Compiled provider-neutral instruction from the storyboard version. */
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  /** Requested only when the live catalog reports audio support. */
  audio: boolean;
  storyboardId: string;
  storyboardVersionNumber: number;
  characterLocks: readonly LineStoryboardCharacterLock[];
  referenceAssets: readonly LineStoryboardReferenceAsset[];
}>;

/** Why a storyboard draft was refused. Every reason is fail-closed: no draft, no code. */
export type LineStoryboardVideoDraftRejection =
  | { kind: "rejected"; reason: "provider_auth_unavailable" }
  | { kind: "rejected"; reason: "catalog_unavailable" }
  | { kind: "rejected"; reason: "invalid_conversation" }
  | { kind: "rejected"; reason: "model_unavailable"; model: string }
  | {
      kind: "rejected";
      reason: "unsupported_duration";
      requested: number;
      supported: readonly number[];
    }
  | {
      kind: "rejected";
      reason: "unsupported_resolution";
      requested: string;
      supported: readonly string[];
    }
  | {
      kind: "rejected";
      reason: "unsupported_aspect_ratio";
      requested: string;
      supported: readonly string[];
    }
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
      modelId: string;
      modelName: string;
      durationSeconds: number;
      resolution: string;
      aspectRatio: string;
      audio: boolean;
      estimatedCostUsd: number;
      /** Snapshotted so confirmation can tell a re-quote from the accepted one. */
      maxAllowedUsd: number;
      /**
       * Provenance for the quote, e.g. "openrouter:bytedance/seedance-2.5".
       *
       * Produced here because the provider is this plugin's concern: the
       * storyboard side must be able to show where a price came from without
       * naming a provider in its own source.
       */
      pricingSource: string;
      outputSize?: string;
      /** Codes this allocation retired, so the caller can say which are dead. */
      supersededDraftIds?: readonly string[];
    }>
  | Readonly<LineStoryboardVideoDraftRejection>;

export type PrepareLineStoryboardVideoDraftDeps = Readonly<{
  draftStore: LineVideoDraftStore;
  resolveApiKey: () => Promise<string | undefined>;
  /** Account-scoped config; `videoGeneration.maxEstimatedCostUsd` is the budget. */
  cfg: Pick<OpenClawConfig, never> & { videoGeneration?: { maxEstimatedCostUsd?: number } };
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomDraftCode?: () => number;
  /** Test seam only: substitutes the live catalog fetch. */
  loadModels?: (params: { apiKey: string }) => Promise<OpenRouterVideoModel[]>;
  /**
   * The conversation's video-model preference, read at quote time.
   *
   * Absent, the draft binds the default model, which is the pre-preference
   * behaviour; the plugin always supplies it in production.
   */
  preferenceStore?: LineVideoModelPreferenceStore;
}>;

/**
 * A catalog list that constrains the request, or undefined when the model
 * declares none.
 *
 * An empty list means "the catalog does not say", which must not be read as
 * "nothing is supported" — that would refuse every request for a model whose
 * catalog row omits the field.
 */
function violatesCatalogChoice(supported: readonly string[], requested: string): boolean {
  return supported.length > 0 && !supported.includes(requested);
}

/**
 * Prepares a pending paid draft for one storyboard version.
 *
 * Returns a rejection rather than throwing, so the storyboard flow can tell the
 * owner exactly why nothing was drafted; every rejection path allocates no code
 * and writes no draft.
 */
export async function prepareLineStoryboardVideoDraft(
  request: LineStoryboardVideoDraftRequest,
  deps: PrepareLineStoryboardVideoDraftDeps,
): Promise<LineStoryboardVideoDraftResult> {
  const apiKey = (await deps.resolveApiKey())?.trim();
  if (!apiKey) {
    return { kind: "rejected", reason: "provider_auth_unavailable" };
  }

  let models: OpenRouterVideoModel[];
  try {
    models = deps.loadModels
      ? await deps.loadModels({ apiKey })
      : await loadOpenRouterVideoModels({
          apiKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
  } catch {
    return { kind: "rejected", reason: "catalog_unavailable" };
  }

  const conversationKey = buildLineVideoConversationKey({
    accountId: request.accountId,
    conversationId: request.conversationId,
  });
  if (!conversationKey) {
    return { kind: "rejected", reason: "invalid_conversation" };
  }

  // The conversation's chosen video model, not a hardcoded one. Seedance stays
  // the DEFAULT that `resolveLineVideoModelPreference` falls back to when the
  // owner has never picked, so an unset conversation behaves exactly as before.
  const modelId = deps.preferenceStore
    ? await resolveLineVideoModelPreference({
        store: deps.preferenceStore,
        key: conversationKey,
      })
    : LINE_STORYBOARD_VIDEO_MODEL_ID;

  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    return { kind: "rejected", reason: "model_unavailable", model: modelId };
  }

  if (
    model.supportedDurationSeconds.length > 0 &&
    !model.supportedDurationSeconds.includes(request.durationSeconds)
  ) {
    return {
      kind: "rejected",
      reason: "unsupported_duration",
      requested: request.durationSeconds,
      supported: model.supportedDurationSeconds.toSorted((left, right) => left - right),
    };
  }
  if (violatesCatalogChoice(model.supportedResolutions, request.resolution)) {
    return {
      kind: "rejected",
      reason: "unsupported_resolution",
      requested: request.resolution,
      supported: model.supportedResolutions,
    };
  }
  if (violatesCatalogChoice(model.supportedAspectRatios, request.aspectRatio)) {
    return {
      kind: "rejected",
      reason: "unsupported_aspect_ratio",
      requested: request.aspectRatio,
      supported: model.supportedAspectRatios,
    };
  }

  // Audio is never invented: the request may ask for it, but only the live
  // catalog can grant it. `supportsAudio === undefined` means the row does not
  // declare the field, which is not permission.
  const audio = request.audio && model.supportsAudio === true;

  // Token-priced models bill by output pixel area, so the concrete size — not
  // the "720p" label — is what the estimate needs.
  const outputSize = resolveLineVideoOutputSize({
    supportedSizes: model.supportedSizes,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
  });
  const costGuard = evaluateLineVideoCostGuard({
    model,
    selector: {
      durationSeconds: request.durationSeconds,
      ...(outputSize ? { size: outputSize } : {}),
      resolution: request.resolution,
      audio,
    },
    cfg: deps.cfg,
  });
  if (!costGuard.allowed) {
    return costGuard.reason === "unknown_cost"
      ? { kind: "rejected", reason: "unknown_cost", model: model.id }
      : {
          kind: "rejected",
          reason: "over_limit",
          estimatedCostUsd: costGuard.estimatedCostUsd,
          maxAllowedUsd: costGuard.maxAllowedUsd,
        };
  }

  // The one collision-safe allocator, against LINE's own draft store.
  const draft = await createLineVideoDraft({
    store: deps.draftStore,
    accountId: request.accountId,
    conversationKey,
    ownerSenderId: request.ownerSenderId,
    model: model.id,
    prompt: request.prompt,
    durationSeconds: request.durationSeconds,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    audio,
    estimatedCostUsd: costGuard.estimatedCostUsd,
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
    modelId: model.id,
    modelName: model.name,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    audio,
    estimatedCostUsd: costGuard.estimatedCostUsd,
    // The guard's own resolver, so the snapshotted ceiling is by construction
    // the one the guard just compared against.
    maxAllowedUsd: resolveLineVideoMaxEstimatedCostUsd(deps.cfg),
    pricingSource: `openrouter:${model.id}`,
    ...(outputSize ? { outputSize } : {}),
  };
}
