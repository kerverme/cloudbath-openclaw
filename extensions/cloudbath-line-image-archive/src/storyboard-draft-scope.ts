import type { StoryboardAccessClaim, StoryboardFinalVideoDraft } from "./storyboard-types.js";
/**
 * The workspace scope a confirmed storyboard draft is validated against.
 *
 * The LINE confirmation gate refuses to spend anything in a UGC-bound group
 * unless it finds a scope for the draft it is about to submit, and it checks
 * that scope hard: the scene's cast must line up positionally with the frozen
 * locks, and the scene prompt must be the SAME string the draft froze. This
 * builds one from a storyboard version so that existing validation runs over
 * the storyboard path unchanged, rather than a second contract being invented
 * for it.
 *
 * Pure on purpose: the shape is a cross-plugin contract, so it is worth being
 * able to assert it directly against the validator that consumes it.
 */
import { compileStoryboardProviderPrompt } from "./storyboard-video-plan.js";
import type { FrozenUgcVideoScope, NotionTarget, UgcCapabilityId } from "./types.js";

export function buildStoryboardDraftScope(params: {
  draft: StoryboardFinalVideoDraft;
  claim: StoryboardAccessClaim;
  capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  createdAt: string;
}): FrozenUgcVideoScope | undefined {
  const { draft, claim } = params;
  // A UGC scope describes a UGC project. Standalone work has none, and there is
  // nothing to fabricate here: the LINE gate reads this scope only for drafts
  // in a bound group, and a draft without one is confirmed on its own terms.
  const project = draft.project;
  if (!project) {
    return undefined;
  }
  // "SCENE-3" -> 3. A scene the gate cannot number is one it will reject, so
  // returning undefined leaves the draft unconfirmable rather than storing a
  // scope that fails validation later for a reason nobody can see.
  const sceneNumber = Number(/(\d+)$/u.exec(project.sceneId)?.[1]);
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1) {
    return undefined;
  }
  // The gate compares this against the draft's frozen prompt, so it must be
  // compiled the same way the paid request was.
  const prompt = compileStoryboardProviderPrompt(draft.plan);
  return Object.freeze({
    version: 1,
    policyId: "UGC",
    accountId: claim.accountId,
    lineGroupId: claim.lineGroupId,
    ownerSenderId: claim.ownerSenderId,
    characterLocks: draft.characterLocks,
    projectInstanceId: project.projectInstanceId,
    projectPageId: project.projectPageId,
    // A storyboard's project record IS its instance id; there is no second
    // identifier for the same project.
    projectRecordId: project.projectInstanceId,
    shotPageIds: Object.freeze([project.scenePageId]),
    scene: Object.freeze({
      sceneNumber,
      characterPageIds: Object.freeze(draft.characterLocks.map((lock) => lock.pageId)),
      characterCodes: Object.freeze(draft.characterLocks.map((lock) => lock.code)),
      prompt,
      durationSeconds: draft.durationSeconds,
    }),
    scenePageId: project.scenePageId,
    referenceAssets: Object.freeze(
      draft.characterLocks.flatMap((lock) => [...lock.identityReferences]),
    ),
    frozenPrompt: prompt,
    durationSeconds: draft.durationSeconds,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    capabilities: params.capabilities,
    r2Prefix: "outbound/line-video",
    createdAt: params.createdAt,
  });
}
