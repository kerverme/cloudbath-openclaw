/**
 * The active job for a conversation, reduced to what a status sentence needs.
 *
 * Resolved through the same active-job lock the confirmation gate uses, so
 * "what is running here" has one answer: the lock is claimed as background work
 * starts and released the moment the job is terminal, and a lock left behind by
 * a killed process ages out instead of pinning a stale job forever.
 *
 * The failure text is sanitized HERE, before it leaves the plugin. A provider
 * error can carry a signed URL or a key fragment, and the consumer's whole job
 * is to repeat this back to the owner in chat.
 */
import {
  getLineVideoJob,
  resolveLineVideoActiveJobLock,
  type LineVideoActiveJobLockStore,
  type LineVideoJob,
  type LineVideoJobStore,
} from "./video-job-store.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";
import type { LineStoryboardVideoJobSnapshot } from "./video-storyboard-runtime.js";

/** Short enough to read in a chat bubble, long enough to name a real cause. */
const FAILURE_REASON_MAX = 160;

/**
 * Strips anything that could carry a credential or a signed link before the
 * reason is repeated in chat: URLs, long opaque tokens, and `key=value` pairs.
 */
function sanitizeFailureReason(error: string | undefined): string | undefined {
  const cleaned = (error ?? "")
    .replace(/https?:\/\/\S+/giu, "[link]")
    .replace(/\b[\w-]*(?:key|token|secret|authorization)[\w-]*\s*[=:]\s*\S+/giu, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, FAILURE_REASON_MAX) : undefined;
}

function toSnapshot(job: LineVideoJob): LineStoryboardVideoJobSnapshot {
  const failureReason =
    job.status === "failed" || job.status === "delivery_failed"
      ? sanitizeFailureReason(job.error)
      : undefined;
  return {
    jobId: job.jobId,
    draftId: job.draftId,
    status: job.status,
    ...(job.stage ? { stage: job.stage } : {}),
    ...(failureReason ? { failureReason } : {}),
    submittedAt: job.submittedAt,
  };
}

export async function readLineActiveVideoJobSnapshot(params: {
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  accountId: string;
  conversationId: string;
  now?: () => number;
}): Promise<LineStoryboardVideoJobSnapshot | undefined> {
  const conversationKey = buildLineVideoConversationKey({
    accountId: params.accountId,
    conversationId: params.conversationId,
  });
  if (!conversationKey) {
    return undefined;
  }
  const lock = await resolveLineVideoActiveJobLock({
    store: params.activeJobLockStore,
    conversationKey,
    ...(params.now ? { now: params.now } : {}),
  });
  if (!lock) {
    return undefined;
  }
  const job = await getLineVideoJob({ store: params.jobStore, jobId: lock.jobId });
  // A lock whose job record is gone is not an active job: reporting the lock
  // alone would describe work nothing can confirm still exists.
  return job ? toSnapshot(job) : undefined;
}
