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
  audio: boolean;
  storyboardId: string;
  storyboardVersionNumber: number;
  characterLocks: readonly Readonly<{ code: string; pageId: string }>[];
  referenceAssets: readonly Readonly<{
    kind: "identity" | "product" | "style";
    source: "r2" | "https";
    locator: string;
  }>[];
}>;

export type StoryboardPaidDraftResult =
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
      maxAllowedUsd: number;
      /** Opaque provenance string from the owning plugin; never parsed here. */
      pricingSource: string;
      outputSize?: string;
      /** Codes this allocation retired; the owner is told these are dead. */
      supersededDraftIds?: readonly string[];
    }>
  | Readonly<{ kind: "rejected"; reason: string; [key: string]: unknown }>;

export type StoryboardPaidDraftRuntime = {
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
