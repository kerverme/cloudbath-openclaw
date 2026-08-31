/**
 * The typed seam the Cloudbath storyboard flow uses to reach the paid pipeline.
 *
 * Direction matters. `video-workspace-runtime.ts` is the existing seam in the
 * other direction (Cloudbath installs, LINE consumes a frozen UGC scope). This
 * one is installed by LINE and consumed by Cloudbath, so the allocator still
 * EXECUTES as LINE-owned code against LINE-owned state: the storyboard side
 * holds only a function reference, never this plugin's keyed store.
 *
 * That is the whole point. Plugin state is partitioned by plugin id, so an
 * allocator running on the storyboard side would write into a different
 * physical namespace — a second 4-digit code space whose codes
 * `video-confirmation.ts` would resolve against ITS drafts.
 *
 * Ownership is guarded the same way as the existing pair: only the installer's
 * symbol can clear the slot, so a reload cannot leave another plugin's runtime
 * installed.
 */
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type {
  LineStoryboardVideoDraftRequest,
  LineStoryboardVideoDraftResult,
} from "./video-storyboard-draft.js";

const LINE_STORYBOARD_VIDEO_RUNTIME_KEY = "cloudbath.line-storyboard-video-runtime.v1";
const LINE_STORYBOARD_VIDEO_RUNTIME_OWNER_KEY = "cloudbath.line-storyboard-video-runtime-owner.v1";

export type LineStoryboardVideoRuntime = {
  /** Allocates a pending paid draft. Never submits; never charges. */
  prepareStoryboardVideoDraft(
    request: LineStoryboardVideoDraftRequest,
  ): Promise<LineStoryboardVideoDraftResult>;
};

const runtimeStore = createPluginRuntimeStore<LineStoryboardVideoRuntime>({
  key: LINE_STORYBOARD_VIDEO_RUNTIME_KEY,
  errorMessage: "LINE storyboard video runtime is unavailable",
});
const ownerStore = createPluginRuntimeStore<symbol>({
  key: LINE_STORYBOARD_VIDEO_RUNTIME_OWNER_KEY,
  errorMessage: "LINE storyboard video runtime owner is unavailable",
});

export function installLineStoryboardVideoRuntime(
  owner: symbol,
  runtime: LineStoryboardVideoRuntime,
): void {
  runtimeStore.setRuntime(runtime);
  ownerStore.setRuntime(owner);
}

/** Clears the slot only for the installer, so one plugin cannot evict another's. */
export function clearLineStoryboardVideoRuntime(owner: symbol): boolean {
  if (ownerStore.tryGetRuntime() !== owner) {
    return false;
  }
  runtimeStore.clearRuntime();
  ownerStore.clearRuntime();
  return true;
}

export function tryGetLineStoryboardVideoRuntime(): LineStoryboardVideoRuntime | null {
  return runtimeStore.tryGetRuntime();
}
