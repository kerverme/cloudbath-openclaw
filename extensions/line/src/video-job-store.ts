/**
 * Persistent LINE video-generation job state (SQLite-backed keyed store —
 * never an in-memory Map), so a Railway/Gateway/process restart mid-generation
 * does not lose track of a paid job. Written once at confirmation-time submit
 * (video-confirmation.ts) and updated as the background generation completes
 * or fails.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const LINE_VIDEO_JOB_NAMESPACE = "video-job-v1";
export const LINE_VIDEO_JOB_MAX_ENTRIES = 20_000;
// Long TTL: jobs are historical/audit records once terminal, not a picker's
// transient pending state, but must not accumulate forever either.
export const LINE_VIDEO_JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Terminal states, plus the one that is NOT a generation failure.
 *
 * `delivery_failed` means the provider generated successfully and the bytes
 * are archived in R2 — only the LINE send did not land. It exists so that
 * state is recoverable without another paid call, and so the owner is never
 * told "สร้างวิดีโอไม่สำเร็จ" about a video that was in fact generated and paid for.
 */
export type LineVideoJobStatus = "running" | "completed" | "failed" | "delivery_failed";

/**
 * How far a job got. Recorded as each stage completes, so a failure names the
 * stage that failed and a retry knows which stages it may skip.
 *
 * `provider_submission` is the only stage that spends money. Once
 * `provider_generation_completed` is recorded the video EXISTS and is paid
 * for, so every later stage works on an artifact already bought and must
 * never re-enter submission.
 */
export type LineVideoJobStage =
  | "provider_submission"
  | "provider_generation_completed"
  | "artifact_retrieval"
  | "r2_archive"
  | "line_delivery";

export type LineVideoJob = {
  version: 1;
  jobId: string;
  openRouterJobId?: string;
  draftId: string;
  accountId: string;
  conversationKey: string;
  model: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  status: LineVideoJobStatus;
  /** Last stage that completed. Absent until the provider call returns. */
  stage?: LineVideoJobStage;
  /** Which paid provider generated this job. Always "fal" in this flow. */
  provider?: string;
  /**
   * fal's identifiers for the COMPLETED generation.
   *
   * The whole point of persisting these is that a download, archive or send
   * failure can go back to THIS paid generation. Without them a recovery has
   * nothing to resume from and the only option left would be paying twice.
   */
  providerRequestId?: string;
  providerResultUrl?: string;
  /** Delivery attempts made from the archived R2 object. Bounds retry churn. */
  deliveryAttempts?: number;
  /**
   * LINE-native `to` address this job delivers to, copied from the draft.
   *
   * Persisted because a recovery can happen long after the draft was consumed,
   * and re-deriving a destination then would risk sending a paid video to a
   * conversation that never confirmed it.
   */
  deliveryTo?: string;
  submittedAt: number;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  notionPageId?: string;
  videoUrl?: string;
  r2ObjectKey?: string;
  error?: string;
};

export type LineVideoJobStore = PluginStateKeyedStore<LineVideoJob>;

export async function createLineVideoJob(params: {
  store: LineVideoJobStore;
  draftId: string;
  accountId: string;
  conversationKey: string;
  model: string;
  provider?: string;
  deliveryTo?: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  estimatedCostUsd: number;
  now?: () => number;
}): Promise<LineVideoJob> {
  const jobId = randomUUID();
  const job: LineVideoJob = {
    version: 1,
    jobId,
    draftId: params.draftId,
    accountId: params.accountId,
    conversationKey: params.conversationKey,
    model: params.model,
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.deliveryTo ? { deliveryTo: params.deliveryTo } : {}),
    prompt: params.prompt,
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    audio: params.audio,
    status: "running",
    submittedAt: (params.now ?? Date.now)(),
    estimatedCostUsd: params.estimatedCostUsd,
  };
  await params.store.register(jobId, job, { ttlMs: LINE_VIDEO_JOB_TTL_MS });
  return job;
}

/** Applies a terminal (or intermediate) update to a job record in place. */
export async function updateLineVideoJob(params: {
  store: LineVideoJobStore;
  jobId: string;
  patch: Partial<
    Pick<
      LineVideoJob,
      | "status"
      | "stage"
      | "provider"
      | "providerRequestId"
      | "providerResultUrl"
      | "deliveryAttempts"
      | "openRouterJobId"
      | "actualCostUsd"
      | "notionPageId"
      | "videoUrl"
      | "r2ObjectKey"
      | "error"
    >
  >;
}): Promise<LineVideoJob | undefined> {
  if (!params.store.update) {
    // update() is optional on the PluginStateKeyedStore contract; the live
    // SQLite-backed store always implements it. Fall back to read-modify-write
    // only for minimal test doubles that omit it.
    const current = await params.store.lookup(params.jobId);
    if (!current) {
      return undefined;
    }
    const next = { ...current, ...params.patch };
    await params.store.register(params.jobId, next, { ttlMs: LINE_VIDEO_JOB_TTL_MS });
    return next;
  }
  let updated: LineVideoJob | undefined;
  await params.store.update(
    params.jobId,
    (current) => {
      if (!current) {
        return current;
      }
      updated = { ...current, ...params.patch };
      return updated;
    },
    { ttlMs: LINE_VIDEO_JOB_TTL_MS },
  );
  return updated;
}

export async function getLineVideoJob(params: {
  store: LineVideoJobStore;
  jobId: string;
}): Promise<LineVideoJob | undefined> {
  return params.store.lookup(params.jobId);
}

/**
 * Per-conversation "a video job is currently running" lock — a separate
 * namespace/store from LineVideoJob itself (mirrors video-model-control.ts's
 * separate pending-selection store), so the lock's lifecycle (claim right
 * before background work starts, release the instant it reaches a terminal
 * state) is independent of the job record's own longer-lived audit history.
 *
 * A stale lock is always safely recoverable: resolveLineVideoActiveJobLock
 * clears any lock older than LINE_VIDEO_JOB_STALE_RUNNING_MS before
 * reporting it, so a background worker killed by a process/gateway restart
 * mid-generation (before it ever reaches its own terminal update) can never
 * block a conversation from starting a new draft forever. The store's own
 * TTL (registered at claim time) is a second, independent expiry layer for
 * the same reason.
 */
export const LINE_VIDEO_ACTIVE_JOB_NAMESPACE = "video-active-job-v1";
export const LINE_VIDEO_ACTIVE_JOB_MAX_ENTRIES = 5_000;
// Generous margin over the OpenRouter provider's own single-call timeout
// (600_000ms / 10 minutes, extensions/openrouter/video-generation-provider.ts's
// DEFAULT_TIMEOUT_MS) so a legitimately slow-but-alive generation is never
// mistaken for an abandoned one.
export const LINE_VIDEO_JOB_STALE_RUNNING_MS = 15 * 60 * 1000;

export type LineVideoActiveJobLock = {
  version: 1;
  jobId: string;
  conversationKey: string;
  startedAt: number;
};

export type LineVideoActiveJobLockStore = PluginStateKeyedStore<LineVideoActiveJobLock>;

// Hash the trusted conversation scope key so it never becomes an unbounded or
// unsafe SQLite key, matching video-model-control.ts's resolvePendingKey.
function resolveActiveJobLockKey(conversationKey: string): string {
  return createHash("sha256").update(conversationKey).digest("hex");
}

/** Claims the active-job lock for a conversation right before background submission starts. */
export async function claimLineVideoActiveJobLock(params: {
  store: LineVideoActiveJobLockStore;
  conversationKey: string;
  jobId: string;
  now?: () => number;
}): Promise<void> {
  await params.store.register(
    resolveActiveJobLockKey(params.conversationKey),
    {
      version: 1,
      jobId: params.jobId,
      conversationKey: params.conversationKey,
      startedAt: (params.now ?? Date.now)(),
    },
    { ttlMs: LINE_VIDEO_JOB_STALE_RUNNING_MS },
  );
}

/** Releases the active-job lock once a job reaches a terminal state (completed or failed). */
export async function releaseLineVideoActiveJobLock(params: {
  store: LineVideoActiveJobLockStore;
  conversationKey: string;
}): Promise<void> {
  await params.store.delete(resolveActiveJobLockKey(params.conversationKey));
}

/**
 * Resolves the current active-job lock for a conversation, if any, treating
 * a stale lock (older than LINE_VIDEO_JOB_STALE_RUNNING_MS) as abandoned and
 * clearing it so it can never block a new draft forever.
 */
export async function resolveLineVideoActiveJobLock(params: {
  store: LineVideoActiveJobLockStore;
  conversationKey: string;
  now?: () => number;
}): Promise<LineVideoActiveJobLock | undefined> {
  const key = resolveActiveJobLockKey(params.conversationKey);
  const lock = await params.store.lookup(key);
  if (!lock) {
    return undefined;
  }
  const now = (params.now ?? Date.now)();
  if (now - lock.startedAt > LINE_VIDEO_JOB_STALE_RUNNING_MS) {
    await params.store.delete(key);
    return undefined;
  }
  return lock;
}
