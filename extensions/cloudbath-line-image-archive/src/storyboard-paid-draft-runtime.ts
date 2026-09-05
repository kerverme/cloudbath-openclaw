/**
 * Consumer side of the LINE-owned paid-draft seam.
 *
 * The storyboard flow hands over a provider-neutral request and receives back a
 * `VIDEO ####` code that the LINE plugin allocated in its own store. This
 * plugin never opens that store, never generates a 4-digit code, and owns no
 * part of the paid pipeline: there is exactly one code space, and it is LINE's.
 *
 * The request and result shapes are declared structurally here rather than
 * imported from `extensions/line/**`, because reaching into another plugin's
 * `src/**` is a boundary violation. The existing seam in the opposite direction
 * (`line-video-workspace-runtime.ts` / LINE's `video-ugc-scope.ts`) is typed
 * the same way; the shared registry key is the contract, and a mismatch shows
 * up as a compile error on whichever side drifts.
 */
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const LINE_STORYBOARD_VIDEO_RUNTIME_KEY = "cloudbath.line-storyboard-video-runtime.v1";

export type StoryboardPaidDraftRequest = Readonly<{
  accountId: string;
  /** Raw LINE conversation identity; the LINE side derives its own draft key. */
  conversationId: string;
  ownerSenderId: string;
  deliveryTo?: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  /**
   * The scene's audio decision, as the storyboard's own three-way mode.
   *
   * Not a boolean: "sound with no speech" is a real answer, and the provider
   * side needs it to judge whether a model that cannot be silenced, or cannot
   * be proven to make sound, can execute this scene at all.
   */
  audio: "off" | "ambient" | "full";
  /** True when a beat carries a spoken line. */
  spokenDialogue: boolean;
  storyboardId: string;
  storyboardVersionNumber: number;
  characterLocks: readonly Readonly<{ code: string; pageId: string }>[];
  /**
   * The first frame the owner chose, as an OPAQUE handle.
   *
   * A handle rather than a URL because this crosses a plugin boundary and is
   * persisted on both sides: a signed URL would expire, and storing one would
   * put an asset locator into durable storyboard state. The owning plugin
   * resolves it, so the mode a draft claims and the bytes a provider receives
   * cannot disagree — and a handle that will not resolve fails the draft closed
   * rather than silently submitting a text-only request as image mode.
   */
  sourceImage?: Readonly<{ kind: "owner_selected"; mediaId: string }>;
  referenceAssets: readonly Readonly<{
    kind: "identity" | "product" | "style";
    source: "r2" | "https";
    locator: string;
    /** Canonical Character code, so the provider can name it in its markers. */
    characterCode?: string;
    displayName?: string;
  }>[];
  inputMode: "text_to_video" | "image_to_video" | "reference_to_video" | "storyboard_shot_to_video";
  renderStrategy: "quick_video" | "best_quality_shot_by_shot";
  /** Endpoint the owner chose. Absent means the capability-aware default. */
  requestedModelId?: string;
}>;

export type StoryboardPaidDraftResult =
  | Readonly<{
      kind: "created";
      draftId: string;
      modelId: string;
      modelName: string;
      familyId?: string;
      durationSeconds: number;
      resolution: string;
      aspectRatio: string;
      audio: boolean;
      estimatedCostUsd: number;
      maxAllowedUsd: number;
      /** Opaque provenance string from the owning plugin; never parsed here. */
      pricingSource: string;
      /** Codes this allocation retired; the owner is told these are dead. */
      supersededDraftIds?: readonly string[];
      /**
       * The preferred default this model replaced, when it was displaced.
       *
       * Present so the reply can explain WHY the default differs instead of
       * the owner quietly receiving a model the product does not usually pick.
       */
      displacedPreferred?: Readonly<{
        modelName: string;
        reasons: readonly Readonly<{ kind: string; [key: string]: unknown }>[];
      }>;
    }>
  | Readonly<{ kind: "rejected"; reason: string; [key: string]: unknown }>;

/** What a frozen storyboard needs from an endpoint. Provider-neutral. */
export type StoryboardVideoRequirements = Readonly<{
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: "off" | "ambient" | "full";
  spokenDialogue: boolean;
  identityReferenceCount: number;
  inputMode: StoryboardPaidDraftRequest["inputMode"];
}>;

export type StoryboardRuntimeModelOption = Readonly<{
  modelId: string;
  displayName: string;
  familyId: string;
  familyDisplayName: string;
}>;

export type StoryboardRuntimeModelOffer =
  | Readonly<{
      kind: "offered";
      model: StoryboardRuntimeModelOption;
      estimatedCostUsd?: number;
      displacedReason?: string;
    }>
  | Readonly<{ kind: "none_compatible" }>;

export type StoryboardRuntimeModelMatch =
  | Readonly<{ kind: "model"; modelId: string }>
  | Readonly<{ kind: "family"; familyId: string }>
  | Readonly<{ kind: "candidates"; models: readonly StoryboardRuntimeModelOption[] }>;

/**
 * A paid job as the conversation layer needs to describe it.
 *
 * Declared structurally on both halves of this seam, like the rest of the
 * contract. Only what a status sentence needs: no prompt, no cost, no provider
 * identifiers, and a failure reason the owning plugin has already made safe to
 * repeat back.
 */
export type StoryboardVideoJobSnapshot = Readonly<{
  jobId: string;
  /** The `VIDEO ####` code the owner confirmed this job with. */
  draftId: string;
  status: "running" | "completed" | "failed" | "delivery_failed";
  /** Last stage the record proves completed. Absent before the provider answers. */
  stage?:
    | "provider_submission"
    | "provider_generation_completed"
    | "artifact_retrieval"
    | "r2_archive"
    | "line_delivery";
  /** Already-sanitized; never raw provider output. */
  failureReason?: string;
  submittedAt: number;
}>;

export type StoryboardPaidDraftRuntime = {
  /**
   * The capability-aware default for a frozen storyboard, with its quote.
   *
   * Declared on the seam rather than imported, because the model registry,
   * its capabilities and its prices all belong to the owning plugin. This side
   * renders the answer and never holds a model list of its own.
   */
  offerDefaultVideoModel?(
    accountId: string,
    requirements: StoryboardVideoRequirements,
  ): Promise<StoryboardRuntimeModelOffer>;
  /** Endpoints that can execute this frozen storyboard, in preference order. */
  listCompatibleVideoModels?(
    accountId: string,
    requirements: StoryboardVideoRequirements,
  ): Promise<readonly StoryboardRuntimeModelOption[]>;
  /** Ranks a typed model query. Never applies a weak or ambiguous guess. */
  matchVideoModelQuery?(
    accountId: string,
    requirements: StoryboardVideoRequirements,
    text: string,
  ): Promise<StoryboardRuntimeModelMatch | undefined>;
  /**
   * The job this conversation is waiting on, if any.
   *
   * Bounded to the ACTIVE job on purpose: the owning plugin releases its
   * per-conversation lock the moment a job reaches a terminal state, and
   * scanning history for "the last one" would answer "เสร็จยัง" about work the owner
   * already saw finish.
   */
  readActiveVideoJob?(params: {
    accountId: string;
    conversationId: string;
  }): Promise<StoryboardVideoJobSnapshot | undefined>;
  /**
   * Retires every unpaid code still outstanding for this storyboard.
   *
   * Called when the scene itself changes: the owner was quoted for content that
   * no longer exists, so the code they were shown must stop being payable
   * before anything else happens. A fresh code is minted only when the revised
   * storyboard reaches a Final Video Draft again.
   */
  supersedeStoryboardDrafts?(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    storyboardId: string;
  }): Promise<readonly string[]>;
  prepareStoryboardVideoDraft(
    request: StoryboardPaidDraftRequest,
  ): Promise<StoryboardPaidDraftResult>;
};

const runtimeStore = createPluginRuntimeStore<StoryboardPaidDraftRuntime>({
  key: LINE_STORYBOARD_VIDEO_RUNTIME_KEY,
  errorMessage: "LINE storyboard video runtime is unavailable",
});

/**
 * The LINE paid-draft runtime, or null when the LINE plugin is not active.
 *
 * Null is a legitimate state, not an error: the storyboard flow then keeps its
 * provider-neutral draft rather than inventing a code, which is what it did
 * before any provider was bound.
 */
export function tryGetStoryboardPaidDraftRuntime(): StoryboardPaidDraftRuntime | null {
  return runtimeStore.tryGetRuntime();
}
