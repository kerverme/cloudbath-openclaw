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
import {
  tryGetStoryboardPaidDraftRuntime,
  type StoryboardPaidDraftRequest,
  type StoryboardPaidDraftResult,
  type StoryboardPaidDraftRuntime,
} from "./storyboard-paid-draft-runtime.js";
import { storyboardHasDialogue } from "./storyboard-revision.js";
import type {
  StoryboardCostEstimate,
  StoryboardDraftConfirmation,
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
  /**
   * How this draft reaches the LINE conversation, needed only for the paid
   * handoff: the LINE draft is scoped to the owner and conversation that will
   * be allowed to confirm it.
   */
  paid?: Readonly<{
    conversationId: string;
    deliveryTo?: string;
    /** Defaults to the installed LINE runtime; injected in tests. */
    runtime?: StoryboardPaidDraftRuntime | null;
  }>;
  /**
   * Owner-approved adjustments for a re-quote, applied to the paid request
   * only. The storyboard document itself is untouched: these exist because a
   * newly chosen model could not satisfy a field, and the owner said what to
   * use instead, so nothing is changed without their word.
   */
  overrides?: Readonly<{
    durationSeconds?: number;
    resolution?: string;
    aspectRatio?: string;
    audio?: boolean;
  }>;
}>;

/**
 * Turns a compiled plan into the single instruction string the provider gets.
 *
 * Beat order and timing are the point of a storyboard, so they are rendered
 * explicitly rather than flattened into prose a model would have to re-derive.
 */
export function compileStoryboardProviderPrompt(plan: StoryboardVideoPlan): string {
  const cast = plan.characters
    .map((character) => `${character.characterId} (${character.displayName})`)
    .join(", ");
  const beats = plan.beats.map(
    (beat) =>
      `${beat.startSeconds}-${beat.endSeconds}s | ${beat.framing} | camera: ${beat.camera} | ${beat.action}` +
      (beat.dialogue ? ` | dialogue: ${beat.dialogue}` : ""),
  );
  return [
    plan.environment ? `Setting: ${plan.environment}` : undefined,
    cast ? `Cast: ${cast}` : undefined,
    `Duration: ${plan.durationSeconds}s · ${plan.aspectRatio} · ${plan.resolution}`,
    "Beats:",
    ...beats,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Reference assets for the paid request, in frozen cast order.
 *
 * Only IDENTITY references are handed over. A downstream adapter binds them to
 * subjects by position, and identity is what keeps CHAR-6 looking like CHAR-6;
 * product and style assets are not identity and would shift that binding.
 */
function paidReferenceAssets(
  version: StoryboardVersion,
): StoryboardPaidDraftRequest["referenceAssets"] {
  return version.characterLocks.flatMap((lock) =>
    lock.identityReferences.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        source: reference.source,
        locator: reference.locator,
      }),
    ),
  );
}

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
  return (await prepareStoryboardFinalVideoDraftWithOutcome(params)).draft;
}

/**
 * The same preparation, with the paid side's own answer kept.
 *
 * `prepareStoryboardFinalVideoDraft` deliberately collapses a refusal into an
 * unbillable draft, which is right for the owner-facing flow. A re-quote needs
 * the reason itself — "this model does not do 15 seconds" is the whole message
 * — so this variant returns it rather than a second preparation path existing.
 */
export async function prepareStoryboardFinalVideoDraftWithOutcome(
  params: PrepareFinalVideoDraftParams,
): Promise<{ draft: StoryboardFinalVideoDraft; paid?: StoryboardPaidDraftResult }> {
  const { version } = params;
  const plan = compileStoryboardVideoPlan(version);
  const paid = await requestPaidDraft(params, plan);
  // A refused paid draft is NOT a failed turn: the storyboard is still real and
  // the owner still gets it, minus a confirmation code. Only the LINE-allocated
  // code makes a draft billable, so a rejection simply leaves it unbillable.
  const model: StoryboardVideoModelSelection =
    paid?.kind === "created"
      ? Object.freeze({
          kind: "provider-bound",
          providerModelId: paid.modelId,
          displayName: STORYBOARD_PREFERRED_VIDEO_MODEL_DISPLAY_NAME,
        })
      : resolveStoryboardVideoModel();
  const estimatedCost: StoryboardCostEstimate =
    paid?.kind === "created"
      ? Object.freeze({
          kind: "available",
          amountUsd: paid.estimatedCostUsd,
          // Provenance comes from the plugin that owns the provider; this side
          // deliberately names no provider of its own.
          source: paid.pricingSource,
        })
      : estimateStoryboardCost(model);
  const confirmation: StoryboardDraftConfirmation =
    paid?.kind === "created"
      ? Object.freeze({ kind: "ready" as const, code: paid.draftId })
      : Object.freeze({ kind: "deferred" as const });
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
    estimatedCost,
    plan,
    // Never minted here. A `ready` code is always the one the LINE plugin
    // allocated in its own store; this side has no 4-digit allocator at all,
    // so it cannot invent a code that collides with a pending paid draft.
    confirmation,
    createdAt: new Date(params.now()).toISOString(),
  });
  const claimed = await params.drafts.registerIfAbsent(storyboardDraftKey(draftId), draft);
  if (!claimed) {
    throw new Error("Storyboard draft id was taken concurrently; retry");
  }
  return { draft, ...(paid ? { paid } : {}) };
}

/**
 * Hands the compiled plan to the LINE plugin, which allocates the paid draft.
 *
 * Returns undefined when no paid handoff is possible (the caller supplied no
 * conversation scope, or the LINE runtime is not installed), which keeps the
 * storyboard's own draft provider-neutral exactly as before. A thrown error is
 * swallowed into a rejection for the same reason: a paid-side failure must not
 * lose the storyboard the owner just asked for.
 */
async function requestPaidDraft(
  params: PrepareFinalVideoDraftParams,
  plan: StoryboardVideoPlan,
): Promise<StoryboardPaidDraftResult | undefined> {
  const paid = params.paid;
  if (!paid) {
    return undefined;
  }
  const runtime = paid.runtime === undefined ? tryGetStoryboardPaidDraftRuntime() : paid.runtime;
  if (!runtime) {
    return undefined;
  }
  const { version } = params;
  try {
    return await runtime.prepareStoryboardVideoDraft({
      accountId: version.accountId,
      conversationId: paid.conversationId,
      ownerSenderId: version.ownerSenderId,
      ...(paid.deliveryTo ? { deliveryTo: paid.deliveryTo } : {}),
      prompt: compileStoryboardProviderPrompt(plan),
      durationSeconds: params.overrides?.durationSeconds ?? plan.durationSeconds,
      aspectRatio: params.overrides?.aspectRatio ?? plan.aspectRatio,
      resolution: params.overrides?.resolution ?? plan.resolution,
      // Asking is not granting: the LINE side only honours this when the live
      // catalog reports audio support for the bound model. A scene with no
      // spoken line asks for none, so dropping dialogue actually re-quotes
      // against the cheaper silent SKU instead of paying for unused audio.
      audio: params.overrides?.audio ?? storyboardHasDialogue(version.document),
      storyboardId: version.storyboardId,
      storyboardVersionNumber: version.versionNumber,
      characterLocks: version.characterLocks.map((lock) =>
        Object.freeze({ code: lock.code, pageId: lock.pageId }),
      ),
      referenceAssets: paidReferenceAssets(version),
    });
  } catch {
    return { kind: "rejected", reason: "paid_draft_unavailable" };
  }
}
