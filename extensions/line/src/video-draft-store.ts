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

export const LINE_VIDEO_DRAFT_NAMESPACE = "video-draft-v1";
export const LINE_VIDEO_DRAFT_MAX_ENTRIES = 5_000;
export const LINE_VIDEO_DRAFT_TTL_MS = 15 * 60 * 1000;
const DRAFT_CODE_MIN = 1000;
const DRAFT_CODE_MAX = 9999;
const MAX_DRAFT_ID_ATTEMPTS = 20;

export type LineVideoDraftStatus = "pending" | "confirmed" | "expired";

export type LineVideoDraft = {
  version: 1;
  draftId: string;
  accountId: string;
  conversationKey: string;
  ownerSenderId: string;
  model: string;
  prompt: string;
  sourceImagePath?: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  estimatedCostUsd: number;
  createdAt: number;
  expiresAt: number;
  status: LineVideoDraftStatus;
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
  prompt: string;
  sourceImagePath?: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  estimatedCostUsd: number;
  deliveryTo?: string;
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
    prompt: params.prompt,
    ...(params.sourceImagePath ? { sourceImagePath: params.sourceImagePath } : {}),
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    audio: params.audio,
    estimatedCostUsd: params.estimatedCostUsd,
    createdAt: now,
    expiresAt: now + LINE_VIDEO_DRAFT_TTL_MS,
    status: "pending",
    ...(params.deliveryTo ? { deliveryTo: params.deliveryTo } : {}),
  };
  await params.store.register(draftId, draft, { ttlMs: LINE_VIDEO_DRAFT_TTL_MS });
  return draft;
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
