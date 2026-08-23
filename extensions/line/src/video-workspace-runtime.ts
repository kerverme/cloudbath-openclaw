import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { LineGroupPolicyBinding, LineVideoUgcScope } from "./video-ugc-scope.js";

const LINE_VIDEO_WORKSPACE_RUNTIME_KEY = "cloudbath.line-video-workspace-runtime.v1";

export type LineVideoWorkspaceRuntime = {
  lookupBinding(accountId: string, groupId: string): Promise<LineGroupPolicyBinding | undefined>;
  lookupUgcDraftScope(draftId: string): Promise<LineVideoUgcScope | undefined>;
  consumeUgcDraftScope(draftId: string): Promise<LineVideoUgcScope | undefined>;
};

const runtimeStore = createPluginRuntimeStore<LineVideoWorkspaceRuntime>({
  key: LINE_VIDEO_WORKSPACE_RUNTIME_KEY,
  errorMessage: "Cloudbath LINE video workspace runtime is unavailable",
});

export function tryGetLineVideoWorkspaceRuntime(): LineVideoWorkspaceRuntime | null {
  return runtimeStore.tryGetRuntime();
}
