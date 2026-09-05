import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { LineRequoteOverrides, LineRequoteResult } from "./video-model-requote.js";
import type { LineGroupPolicyBinding, LineVideoUgcScope } from "./video-ugc-scope.js";

const LINE_VIDEO_WORKSPACE_RUNTIME_KEY = "cloudbath.line-video-workspace-runtime.v1";

export type LineVideoWorkspaceRuntime = {
  lookupBinding(accountId: string, groupId: string): Promise<LineGroupPolicyBinding | undefined>;
  lookupUgcDraftScope(draftId: string): Promise<LineVideoUgcScope | undefined>;
  consumeUgcDraftScope(draftId: string): Promise<LineVideoUgcScope | undefined>;
  /**
   * Re-prepares the owner's active storyboard against the video model this
   * plugin has just selected.
   *
   * Declared structurally rather than imported from the archive plugin, like
   * every other member here: the registry key is the contract, and a drift on
   * either side shows up as a compile error. It allocates through THIS
   * plugin's draft store, so the single code space and its supersede are
   * unaffected.
   */
  requoteActiveStoryboardDraft(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    overrides?: LineRequoteOverrides;
  }): Promise<LineRequoteResult>;
  /**
   * The storyboard's CURRENT version number, owner-scoped, or undefined when it
   * cannot be established.
   *
   * A read, never a write: the confirmation gate calls it to prove that a
   * payable code still quotes the scene that exists now. Undefined therefore
   * has to mean "not proven" — no such storyboard, not this owner's, or the
   * service could not answer — because the gate turns it into a refusal.
   */
  /**
   * Resolves a storyboard's opaque first-frame handle to a local media path.
   *
   * The media belongs to the storyboard plugin, so only it can turn a handle
   * into bytes. Undefined means the selection cannot be honoured, and the paid
   * side refuses rather than quoting image mode it cannot deliver.
   */
  resolveStoryboardSourceImage(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    mediaId: string;
  }): Promise<Readonly<{ path: string; mimeType: string }> | undefined>;
  readStoryboardVersionNumber(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    storyboardId: string;
  }): Promise<number | undefined>;
};

const runtimeStore = createPluginRuntimeStore<LineVideoWorkspaceRuntime>({
  key: LINE_VIDEO_WORKSPACE_RUNTIME_KEY,
  errorMessage: "Cloudbath LINE video workspace runtime is unavailable",
});

export function tryGetLineVideoWorkspaceRuntime(): LineVideoWorkspaceRuntime | null {
  return runtimeStore.tryGetRuntime();
}
