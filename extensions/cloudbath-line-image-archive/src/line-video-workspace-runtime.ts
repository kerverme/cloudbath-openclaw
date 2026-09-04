import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { StoryboardRequoteOverrides, StoryboardRequoteResult } from "./storyboard-requote.js";
import type { FrozenUgcVideoScope, LineGroupPolicyBinding } from "./types.js";
import { ugcDraftScopeKey } from "./ugc-workflow.js";

const LINE_VIDEO_WORKSPACE_RUNTIME_KEY = "cloudbath.line-video-workspace-runtime.v1";
const LINE_VIDEO_WORKSPACE_RUNTIME_OWNER_KEY = "cloudbath.line-video-workspace-runtime-owner.v1";

export type CloudbathLineVideoWorkspaceRuntime = {
  lookupBinding(accountId: string, groupId: string): Promise<LineGroupPolicyBinding | undefined>;
  lookupUgcDraftScope(draftId: string): Promise<FrozenUgcVideoScope | undefined>;
  consumeUgcDraftScope(draftId: string): Promise<FrozenUgcVideoScope | undefined>;
  /**
   * Re-prepares the owner's ACTIVE storyboard against whatever video model the
   * LINE side has now selected, or says why it cannot.
   *
   * The only crossing the model picker needs. It mints nothing itself: the
   * draft goes through the same preparation `สร้างวิดีโอ` uses, so the LINE
   * allocator stays the sole owner of the code space and of superseding — and
   * a refusal here leaves the previous code untouched and still payable.
   */
  requoteActiveStoryboardDraft(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    overrides?: StoryboardRequoteOverrides;
  }): Promise<StoryboardRequoteResult>;
  /**
   * This storyboard's current version number, owner-scoped, for the LINE
   * confirmation gate.
   *
   * The gate refuses a payable code whose frozen version is not this one, so
   * undefined must mean "not proven" — no such storyboard, not this owner's, or
   * unreadable — and never "unchanged". Read-only: it mints nothing, retires
   * nothing, and touches no draft.
   */
  readStoryboardVersionNumber(params: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    storyboardId: string;
  }): Promise<number | undefined>;
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
    requoteActiveStoryboardDraft?: (params: {
      accountId: string;
      conversationId: string;
      ownerSenderId: string;
      overrides?: StoryboardRequoteOverrides;
    }) => Promise<StoryboardRequoteResult>;
    readStoryboardVersionNumber?: (params: {
      accountId: string;
      conversationId: string;
      ownerSenderId: string;
      storyboardId: string;
    }) => Promise<number | undefined>;
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
    async readStoryboardVersionNumber(request) {
      // Absent, a build without the storyboard flow cannot establish any
      // version. The gate reads that as unproven and refuses, which is the
      // right answer: nothing here can vouch for a storyboard-backed code.
      return await params.readStoryboardVersionNumber?.(request);
    },
    async requoteActiveStoryboardDraft(request) {
      // Absent, a build without the storyboard flow simply has nothing to
      // re-quote, which is the same answer as having no active storyboard.
      return (
        (await params.requoteActiveStoryboardDraft?.(request)) ?? { kind: "no_active_storyboard" }
      );
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
