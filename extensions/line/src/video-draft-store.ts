/**
 * Owner-only LINE video-generation draft persistence (two-stage generation,
 * stage A: DRAFT ONLY). Creating a draft never calls OpenRouter's paid video
 * endpoint — see video-draft-tool.ts. A draft is consumed exactly once, by
 * exact-code owner confirmation — see video-confirmation.ts, which uses
 * `store.consume()` (atomic read+delete) so a replayed/duplicate confirmation
 * webhook can never resubmit the same draft twice.
 */
import { randomInt } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
/**
 * The paid path a draft is locked to.
 *
 * fal is the only video-generation provider in this flow, so this carries the
 * endpoint rather than a provider choice. It is still a tagged shape: a draft
 * minted by an older build carries a different tag (or none), and the
 * confirmation gate refuses it instead of submitting it somewhere unintended.
 */
export type LineVideoProviderRoute = Readonly<{
  provider: "fal";
  /** fal endpoint id, submitted as `fal/<modelId>`. */
  modelId: string;
}>;

export const LINE_VIDEO_DRAFT_NAMESPACE = "video-draft-v1";
export const LINE_VIDEO_DRAFT_MAX_ENTRIES = 5_000;
export const LINE_VIDEO_DRAFT_TTL_MS = 15 * 60 * 1000;
const DRAFT_CODE_MIN = 1000;
const DRAFT_CODE_MAX = 9999;
const MAX_DRAFT_ID_ATTEMPTS = 20;

/**
 * `superseded` is a TOMBSTONE, not a draft.
 *
 * A re-quote of the same logical storyboard leaves the old code in the store
 * pointing at its replacement, so confirming it answers with the new code
 * instead of the generic "not found" a delete would produce -- and so the code
 * cannot be reissued to a different job while the owner still has it on screen.
 */
export type LineVideoDraftStatus = "pending" | "confirmed" | "expired" | "superseded";

export type LineVideoDraft = {
  version: 1;
  draftId: string;
  accountId: string;
  conversationKey: string;
  ownerSenderId: string;
  model: string;
  /**
   * The paid path this draft is LOCKED to, frozen before its code was minted.
   *
   * Confirmation reads this back verbatim instead of re-deciding: the owner
   * confirmed a quote for one provider, and re-running the routing at
   * submission time could bill a different one after the price was shown.
   * Absent on drafts created before provider routing existed, which the
   * confirmation gate treats as the OpenRouter path it was quoted against.
   */
  providerRoute?: LineVideoProviderRoute;
  prompt: string;
  sourceImagePath?: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  /**
   * Reference images this draft was quoted with.
   *
   * Frozen because some endpoints charge past a free allowance, so the
   * confirmation gate's re-quote needs the same count the owner was shown.
   * Absent on drafts minted before any endpoint charged per image, where zero
   * and undefined price identically.
   */
  referenceImageCount?: number;
  estimatedCostUsd: number;
  createdAt: number;
  expiresAt: number;
  status: LineVideoDraftStatus;
  /**
   * The storyboard this draft quotes, when it came from the storyboard flow.
   *
   * This is what makes "the same logical draft" decidable: a re-quote of the
   * same storyboard supersedes its earlier codes, while new work (a cast
   * addition opens a new project, and so a new storyboard) has a different id
   * and leaves the previous project's code untouched.
   */
  storyboardId?: string;
  /**
   * The storyboard VERSION this draft quotes, frozen with the rest of it.
   *
   * The confirmation gate proves this is still the storyboard's current
   * version before it submits, so a code minted for a scene that has since
   * been revised cannot be paid for. Absent on drafts minted before that proof
   * existed, which the gate refuses rather than submits: an unproven quote is
   * exactly what it is there to stop.
   */
  storyboardVersionNumber?: number;
  /** On a `superseded` tombstone, the code that replaced this one. */
  supersededByDraftId?: string;
  /**
   * LINE-native `to` address (line:group:<id> / line:room:<id> / line:<userId>)
   * captured from the draft tool's trusted DeliveryContext, so the async
   * completion (seconds to minutes later, outside the confirming webhook
   * turn) can push the finished video to the right conversation without
   * reconstructing routing from the dispatch hook's more limited context.
   */
  deliveryTo?: string;
};

export type LineVideoDraftStore = PluginStateKeyedStore<LineVideoDraft>;

/** Generates a 4-digit confirmation code ("ยืนยัน VIDEO 4827"), retrying on collision. */
export async function generateLineVideoDraftId(
  store: LineVideoDraftStore,
  randomDraftCode: () => number = () => randomInt(DRAFT_CODE_MIN, DRAFT_CODE_MAX + 1),
): Promise<string> {
  for (let attempt = 0; attempt < MAX_DRAFT_ID_ATTEMPTS; attempt += 1) {
    const candidate = String(randomDraftCode());
    if (!(await store.lookup(candidate))) {
      return candidate;
    }
  }
  throw new Error("LINE_VIDEO_DRAFT_ID_EXHAUSTED");
}

export async function createLineVideoDraft(params: {
  store: LineVideoDraftStore;
  accountId: string;
  conversationKey: string;
  ownerSenderId: string;
  model: string;
  providerRoute?: LineVideoProviderRoute;
  prompt: string;
  sourceImagePath?: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  referenceImageCount?: number;
  estimatedCostUsd: number;
  deliveryTo?: string;
  storyboardId?: string;
  storyboardVersionNumber?: number;
  now?: () => number;
  randomDraftCode?: () => number;
}): Promise<LineVideoDraft> {
  const now = (params.now ?? Date.now)();
  const draftId = params.randomDraftCode
    ? await generateLineVideoDraftId(params.store, params.randomDraftCode)
    : await generateLineVideoDraftId(params.store);
  const draft: LineVideoDraft = {
    version: 1,
    draftId,
    accountId: params.accountId,
    conversationKey: params.conversationKey,
    ownerSenderId: params.ownerSenderId,
    model: params.model,
    ...(params.providerRoute ? { providerRoute: params.providerRoute } : {}),
    prompt: params.prompt,
    ...(params.sourceImagePath ? { sourceImagePath: params.sourceImagePath } : {}),
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    audio: params.audio,
    ...(params.referenceImageCount === undefined
      ? {}
      : { referenceImageCount: params.referenceImageCount }),
    estimatedCostUsd: params.estimatedCostUsd,
    createdAt: now,
    expiresAt: now + LINE_VIDEO_DRAFT_TTL_MS,
    status: "pending",
    ...(params.storyboardId ? { storyboardId: params.storyboardId } : {}),
    ...(params.storyboardVersionNumber === undefined
      ? {}
      : { storyboardVersionNumber: params.storyboardVersionNumber }),
    ...(params.deliveryTo ? { deliveryTo: params.deliveryTo } : {}),
  };
  await params.store.register(draftId, draft, { ttlMs: LINE_VIDEO_DRAFT_TTL_MS });
  return draft;
}

/**
 * Retires every earlier pending code for one storyboard, in this owner's scope.
 *
 * Called AFTER the replacement draft exists, so a failure here leaves the old
 * code valid rather than leaving the owner with no confirmable code at all.
 * The scope comparison is the whole trusted triple plus the storyboard id: a
 * different owner, conversation or account never matches, so no one can
 * invalidate a code that is not theirs.
 */
export async function supersedeLineVideoDraftsForStoryboard(params: {
  store: LineVideoDraftStore;
  accountId: string;
  conversationKey: string;
  ownerSenderId: string;
  storyboardId: string;
  /**
   * The draft that replaces them, when one exists. Omitted when the storyboard
   * itself moved on: a revised scene retires its outstanding code immediately,
   * long before any replacement is quoted, so the owner cannot pay for content
   * they have already changed.
   */
  supersededByDraftId?: string;
  now?: () => number;
}): Promise<readonly string[]> {
  const now = (params.now ?? Date.now)();
  const superseded: string[] = [];
  for (const entry of await params.store.entries()) {
    const draft = entry.value;
    if (
      draft.status !== "pending" ||
      draft.draftId === params.supersededByDraftId ||
      draft.storyboardId !== params.storyboardId ||
      draft.accountId !== params.accountId ||
      draft.conversationKey !== params.conversationKey ||
      draft.ownerSenderId !== params.ownerSenderId ||
      draft.expiresAt <= now
    ) {
      continue;
    }
    // Keeps the original expiry: a tombstone is only useful while the owner
    // could still be looking at the code it replaced.
    await params.store.register(
      draft.draftId,
      {
        ...draft,
        status: "superseded",
        ...(params.supersededByDraftId ? { supersededByDraftId: params.supersededByDraftId } : {}),
      },
      { ttlMs: Math.max(1, draft.expiresAt - now) },
    );
    superseded.push(draft.draftId);
  }
  return Object.freeze(superseded);
}

export type LineVideoDraftConsumeResult =
  | { kind: "ok"; draft: LineVideoDraft }
  | { kind: "not_found" }
  | { kind: "expired" };

/**
 * Atomically consumes (reads and deletes in one step) a pending draft. Two
 * concurrent/replayed confirmations for the same draftId can therefore never
 * both succeed — the second call always sees `not_found`, since the store's
 * `consume()` is the sole read+delete primitive used here.
 */
export async function consumeLineVideoDraft(params: {
  store: LineVideoDraftStore;
  draftId: string;
  now?: () => number;
}): Promise<LineVideoDraftConsumeResult> {
  const draft = await params.store.consume(params.draftId);
  if (!draft) {
    return { kind: "not_found" };
  }
  const now = (params.now ?? Date.now)();
  if (draft.expiresAt <= now) {
    return { kind: "expired" };
  }
  return { kind: "ok", draft };
}
