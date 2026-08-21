/**
 * Persistent LINE video-generation job state (SQLite-backed keyed store —
 * never an in-memory Map), so a Railway/Gateway/process restart mid-generation
 * does not lose track of a paid job. Written once at confirmation-time submit
 * (video-confirmation.ts) and updated as the background generation completes
 * or fails.
 */
import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const LINE_VIDEO_JOB_NAMESPACE = "video-job-v1";
export const LINE_VIDEO_JOB_MAX_ENTRIES = 20_000;
// Long TTL: jobs are historical/audit records once terminal, not a picker's
// transient pending state, but must not accumulate forever either.
export const LINE_VIDEO_JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type LineVideoJobStatus = "submitted" | "completed" | "failed";

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
  submittedAt: number;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  videoUrl?: string;
  error?: string;
};

export type LineVideoJobStore = PluginStateKeyedStore<LineVideoJob>;

export async function createLineVideoJob(params: {
  store: LineVideoJobStore;
  draftId: string;
  accountId: string;
  conversationKey: string;
  model: string;
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
    prompt: params.prompt,
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    audio: params.audio,
    status: "submitted",
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
    Pick<LineVideoJob, "status" | "openRouterJobId" | "actualCostUsd" | "videoUrl" | "error">
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
