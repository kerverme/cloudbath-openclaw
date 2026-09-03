import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CharacterAssetViewRuntime } from "./character-view-route.js";
import type { CloudbathConversationRouter } from "./conversation-router.js";
import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import type { KeepWatchingPipeline } from "./keep-watching.js";
import type { ArchivePipeline } from "./pipeline.js";
import type { CloudbathPrevisLineRouter } from "./previs-line-router.js";
import type { PrevisReviewRuntime } from "./previs-route.js";
import type { CloudbathPrevisService } from "./previs-service.js";
import type { CloudbathStoryboardLineRouter } from "./storyboard-line-router.js";
import type { ArchiveConfig } from "./types.js";
import type { UgcCharacterImageWorkflow } from "./ugc-character-image.js";
import type { CloudbathUgcVideoWorkflow } from "./ugc-workflow.js";

const WORKSPACE_POLICY_RUNTIME_KEY = "cloudbath.workspace-policy-runtime.v1";

export type CloudbathWorkspacePolicyRuntimeOwner = symbol;

export type CloudbathWorkspacePolicyRuntime = {
  workspaceRegistry: LineGroupWorkspacePolicyRegistry;
  ugcWorkflow?: CloudbathUgcVideoWorkflow;
  ugcCharacterWorkflow?: UgcCharacterImageWorkflow;
  characterAssetView?: CharacterAssetViewRuntime;
  previsReview?: PrevisReviewRuntime;
  /** Bound engine + private-R2 sink. Phase 2B LINE routing calls this. */
  previsService?: CloudbathPrevisService;
  /** Deterministic LINE create/edit/approve routing for previs. */
  previsLineRouter?: CloudbathPrevisLineRouter;
  /**
   * Deterministic LINE routing for the DEFAULT storyboard video flow. Runs
   * ahead of `previsLineRouter`, which now serves explicit legacy requests.
   */
  storyboardLineRouter?: CloudbathStoryboardLineRouter;
  /** Referent arbitration; runs ahead of every handler in before_dispatch. */
  conversationRouter?: CloudbathConversationRouter;
  keepWatchingPipeline?: KeepWatchingPipeline;
  pipeline?: ArchivePipeline;
  activeConfig?: ArchiveConfig;
};

type OwnedWorkspacePolicyRuntime = {
  owner: CloudbathWorkspacePolicyRuntimeOwner;
  runtime: CloudbathWorkspacePolicyRuntime;
};

const runtimeStore = createPluginRuntimeStore<OwnedWorkspacePolicyRuntime>({
  key: WORKSPACE_POLICY_RUNTIME_KEY,
  errorMessage: "Cloudbath workspace policy runtime is unavailable",
});

export function createCloudbathWorkspacePolicyRuntimeOwner(): CloudbathWorkspacePolicyRuntimeOwner {
  return Symbol("cloudbath-workspace-policy-runtime-owner");
}

export function installCloudbathWorkspacePolicyRuntime(
  owner: CloudbathWorkspacePolicyRuntimeOwner,
  runtime: CloudbathWorkspacePolicyRuntime,
): void {
  runtimeStore.setRuntime({ owner, runtime: Object.freeze({ ...runtime }) });
}

export function tryGetCloudbathWorkspacePolicyRuntime(): CloudbathWorkspacePolicyRuntime | null {
  return runtimeStore.tryGetRuntime()?.runtime ?? null;
}

export function clearCloudbathWorkspacePolicyRuntime(
  owner: CloudbathWorkspacePolicyRuntimeOwner,
): boolean {
  const active = runtimeStore.tryGetRuntime();
  if (active?.owner !== owner) {
    return false;
  }
  // Only the service that installed the active runtime may clear it. A stale
  // registry stopping after a replacement must not tear down the new owner.
  runtimeStore.clearRuntime();
  return true;
}
