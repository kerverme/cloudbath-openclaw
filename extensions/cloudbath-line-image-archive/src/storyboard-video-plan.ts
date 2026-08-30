/**
 * Storyboard -> provider-neutral video plan, and the Final Video Draft.
 *
 * Nothing here calls a provider. `prepareStoryboardFinalVideoDraft` compiles the
 * latest storyboard version into a vendor-independent instruction and records
 * the parameters the owner is about to be asked to confirm. Submitting a paid
 * job remains the exclusive job of the existing exact `ยืนยัน VIDEO ####`
 * gate in the LINE plugin, which this module neither replaces nor bypasses.
 */

import { randomBytes } from "node:crypto";
import type {
  StoryboardCostEstimate,
  StoryboardFinalVideoDraft,
  StoryboardPlanCharacter,
  StoryboardVideoModelSelection,
  StoryboardVideoPlan,
  StoryboardVersion,
} from "./storyboard-types.js";
import type { AsyncKeyedStore } from "./types.js";

/**
 * Preferred model, by DISPLAY NAME only.
 *
 * This repository resolves video model ids from the provider's live catalog at
 * confirmation time and holds no verified canonical id for this model, so the
 * draft stays provider-neutral. Inventing an api id here would bind the paid
 * pipeline to a string no catalog can resolve.
 */
export const STORYBOARD_PREFERRED_VIDEO_MODEL_DISPLAY_NAME = "Seedance 2.5";

const MAX_DRAFT_ID_ATTEMPTS = 20;

export function storyboardDraftKey(draftId: string): string {
  return `storyboard-draft:${draftId}`;
}

/** The model a draft names. Provider binding is deferred to a follow-up change. */
export function resolveStoryboardVideoModel(): StoryboardVideoModelSelection {
  return Object.freeze({
    kind: "deferred",
    displayName: STORYBOARD_PREFERRED_VIDEO_MODEL_DISPLAY_NAME,
  });
}

/**
 * Cost for a model selection.
 *
 * Estimates in this product come from the provider's live pricing for a BOUND
 * model; with binding deferred there is no honest figure, so this returns a
 * typed "unavailable" rather than a number the owner might act on.
 */
export function estimateStoryboardCost(
  model: StoryboardVideoModelSelection,
): StoryboardCostEstimate {
  if (model.kind === "deferred") {
    return Object.freeze({ kind: "unavailable", reason: "provider-binding-deferred" });
  }
  return Object.freeze({ kind: "unavailable", reason: "pricing-unavailable" });
}

function planCharacters(version: StoryboardVersion): readonly StoryboardPlanCharacter[] {
  const lockByCode = new Map(version.characterLocks.map((lock) => [lock.code, lock]));
  return Object.freeze(
    version.document.cast.map((member) =>
      Object.freeze({
        characterId: member.characterId,
        characterPageId: member.characterPageId,
        displayName: member.displayName,
        identityReferences: Object.freeze(
          (lockByCode.get(member.characterId)?.identityReferences ?? []).map(
            (reference) => reference.locator,
          ),
        ),
      }),
    ),
  );
}

/**
 * Compiles one storyboard version into a provider-neutral plan.
 *
 * Cast ORDER is preserved from the frozen lock, because a downstream adapter
 * uses position to bind reference images to subjects; reordering here would
 * silently recast the video.
 */
export function compileStoryboardVideoPlan(version: StoryboardVersion): StoryboardVideoPlan {
  return Object.freeze({
    version: 1,
    durationSeconds: version.document.durationSeconds,
    aspectRatio: version.document.aspectRatio,
    resolution: version.document.resolution,
    environment: version.document.environment,
    characters: planCharacters(version),
    beats: Object.freeze(
      version.document.beats.map((beat) =>
        Object.freeze({
          beatId: beat.beatId,
          startSeconds: beat.startSeconds,
          endSeconds: beat.endSeconds,
          framing: beat.framing,
          action: beat.action,
          camera: beat.camera,
          ...(beat.dialogue ? { dialogue: beat.dialogue } : {}),
          characterIds: beat.characterIds,
        }),
      ),
    ),
  });
}

/**
 * Allocates a storyboard-scoped draft id.
 *
 * Deliberately NOT a 4-digit `VIDEO ####` code. That code space belongs to the
 * LINE paid draft store, which this plugin cannot read across the extension
 * boundary; minting into it blind could collide with the owner's own pending
 * paid draft and bill an unrelated job on confirmation.
 */
export async function generateStoryboardDraftId(
  drafts: AsyncKeyedStore<StoryboardFinalVideoDraft>,
  randomId: () => string = () => randomBytes(8).toString("hex"),
): Promise<string> {
  for (let attempt = 0; attempt < MAX_DRAFT_ID_ATTEMPTS; attempt += 1) {
    const candidate = randomId();
    if (!(await drafts.lookup(storyboardDraftKey(candidate)))) {
      return candidate;
    }
  }
  throw new Error("STORYBOARD_DRAFT_ID_EXHAUSTED");
}

export type PrepareFinalVideoDraftParams = Readonly<{
  version: StoryboardVersion;
  drafts: AsyncKeyedStore<StoryboardFinalVideoDraft>;
  now: () => number;
  randomId?: () => string;
}>;

/**
 * Prepares a Final Video Draft from a storyboard version. Calls NO provider.
 *
 * The draft records what WOULD be generated. It carries no `ยืนยัน VIDEO ####`
 * code and is not registered with the LINE paid draft store, because a draft
 * with no bound provider model must not be reachable by the billing path at
 * all. Binding the provider — and only then minting a code through the paid
 * store's own allocator, so it cannot collide — is a follow-up change.
 */
export async function prepareStoryboardFinalVideoDraft(
  params: PrepareFinalVideoDraftParams,
): Promise<StoryboardFinalVideoDraft> {
  const { version } = params;
  const model = resolveStoryboardVideoModel();
  const draftId = await generateStoryboardDraftId(
    params.drafts,
    ...(params.randomId ? ([params.randomId] as const) : ([] as const)),
  );
  const draft: StoryboardFinalVideoDraft = Object.freeze({
    version: 1,
    draftId,
    storyboardId: version.storyboardId,
    storyboardVersionNumber: version.versionNumber,
    projectInstanceId: version.projectInstanceId,
    projectPageId: version.projectPageId,
    sceneId: version.sceneId,
    scenePageId: version.scenePageId,
    accountId: version.accountId,
    lineGroupId: version.lineGroupId,
    ownerSenderId: version.ownerSenderId,
    characterLocks: version.characterLocks,
    durationSeconds: version.document.durationSeconds,
    aspectRatio: version.document.aspectRatio,
    resolution: version.document.resolution,
    model,
    estimatedCost: estimateStoryboardCost(model),
    plan: compileStoryboardVideoPlan(version),
    // Always deferred here. A `ready` confirmation carries a code minted by the
    // LINE paid draft store's own allocator, which only exists once a provider
    // model is bound -- constructing one from this side could only invent an
    // empty or colliding code.
    confirmation: Object.freeze({ kind: "deferred" as const }),
    createdAt: new Date(params.now()).toISOString(),
  });
  const claimed = await params.drafts.registerIfAbsent(storyboardDraftKey(draftId), draft);
  if (!claimed) {
    throw new Error("Storyboard draft id was taken concurrently; retry");
  }
  return draft;
}
