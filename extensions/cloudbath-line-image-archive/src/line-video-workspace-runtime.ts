import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { FrozenUgcVideoScope, LineGroupPolicyBinding } from "./types.js";
import { ugcDraftScopeKey } from "./ugc-workflow.js";

const LINE_VIDEO_WORKSPACE_RUNTIME_KEY = "cloudbath.line-video-workspace-runtime.v1";
const LINE_VIDEO_WORKSPACE_RUNTIME_OWNER_KEY = "cloudbath.line-video-workspace-runtime-owner.v1";

export type CloudbathLineVideoWorkspaceRuntime = {
  lookupBinding(accountId: string, groupId: string): Promise<LineGroupPolicyBinding | undefined>;
  lookupUgcDraftScope(draftId: string): Promise<FrozenUgcVideoScope | undefined>;
  consumeUgcDraftScope(draftId: string): Promise<FrozenUgcVideoScope | undefined>;
};

const runtimeStore = createPluginRuntimeStore<CloudbathLineVideoWorkspaceRuntime>({
  key: LINE_VIDEO_WORKSPACE_RUNTIME_KEY,
  errorMessage: "Cloudbath LINE video workspace runtime is unavailable",
});
const ownerStore = createPluginRuntimeStore<symbol>({
  key: LINE_VIDEO_WORKSPACE_RUNTIME_OWNER_KEY,
  errorMessage: "Cloudbath LINE video workspace runtime owner is unavailable",
});

export function installCloudbathLineVideoWorkspaceRuntime(
  owner: symbol,
  params: {
    lookupBinding: (
      accountId: string,
      groupId: string,
    ) => Promise<LineGroupPolicyBinding | null | undefined>;
    ugcScopeStore?: PluginStateKeyedStore<FrozenUgcVideoScope>;
  },
): void {
  runtimeStore.setRuntime({
    async lookupBinding(accountId, groupId) {
      return (await params.lookupBinding(accountId, groupId)) ?? undefined;
    },
    async lookupUgcDraftScope(draftId) {
      return await params.ugcScopeStore?.lookup(ugcDraftScopeKey(draftId));
    },
    async consumeUgcDraftScope(draftId) {
      return await params.ugcScopeStore?.consume(ugcDraftScopeKey(draftId));
    },
  });
  ownerStore.setRuntime(owner);
}

export function clearCloudbathLineVideoWorkspaceRuntime(owner: symbol): boolean {
  if (ownerStore.tryGetRuntime() !== owner) {
    return false;
  }
  runtimeStore.clearRuntime();
  ownerStore.clearRuntime();
  return true;
}
