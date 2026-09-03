import { describe, expect, it, vi } from "vitest";
import { recoverLineVideoJob } from "./video-job-execution.js";
import {
  createLineVideoJob,
  updateLineVideoJob,
  type LineVideoJob,
  type LineVideoJobStore,
} from "./video-job-store.js";

function memoryJobStore(): LineVideoJobStore & { entriesMap: Map<string, LineVideoJob> } {
  const entriesMap = new Map<string, LineVideoJob>();
  return {
    entriesMap,
    async register(key: string, value: LineVideoJob) {
      entriesMap.set(key, value);
    },
    async registerIfAbsent(key: string, value: LineVideoJob) {
      if (entriesMap.has(key)) {
        return false;
      }
      entriesMap.set(key, value);
      return true;
    },
    async lookup(key: string) {
      return entriesMap.get(key);
    },
    async consume(key: string) {
      const value = entriesMap.get(key);
      entriesMap.delete(key);
      return value;
    },
    async delete(key: string) {
      return entriesMap.delete(key);
    },
    async entries() {
      return [...entriesMap.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      entriesMap.clear();
    },
  } as never;
}

const ACCOUNT = {
  accountId: "primary",
  channelAccessToken: "token",
  config: {},
} as never;

async function archivedJob(store: LineVideoJobStore) {
  const job = await createLineVideoJob({
    store,
    draftId: "1234",
    accountId: "primary",
    conversationKey: "primary:C1",
    model: "bytedance/seedance-2.5",
    provider: "fal",
    prompt: "walk in the garden",
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: true,
    estimatedCostUsd: 1.5,
  });
  // The archive stage completed; only the LINE send did not.
  await updateLineVideoJob({
    store,
    jobId: job.jobId,
    patch: {
      status: "delivery_failed",
      stage: "line_delivery",
      r2ObjectKey: "outbound/line-video/sha256/ab/abcd.mp4",
      error: "LINE push failed",
    },
  });
  return job;
}

describe("delivery is a separate lifecycle stage from generation", () => {
  it("retries delivery from the ARCHIVED R2 object and calls no provider", async () => {
    const store = memoryJobStore();
    const job = await archivedJob(store);
    const signUrl = vi.fn(async (key: string) => `https://r2.example/${key}?X-Amz-Signature=sig`);
    const deliver = vi.fn(async () => {});

    const result = await recoverLineVideoJob({
      jobStore: store,
      jobId: job.jobId,
      account: ACCOUNT,
      deliveryTo: "line:group:C1",
      cfg: {} as never,
      signUrl: signUrl as never,
      deliver: deliver as never,
    });

    expect(result).toEqual({ kind: "delivered", jobId: job.jobId });
    // Re-signed from the persisted key -- not the expired URL of the first try.
    expect(signUrl).toHaveBeenCalledWith("outbound/line-video/sha256/ab/abcd.mp4");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.entriesMap.get(job.jobId)).toMatchObject({
      status: "completed",
      stage: "line_delivery",
    });
  });

  it("leaves the job recoverable, and counts the attempt, when the retry also fails", async () => {
    const store = memoryJobStore();
    const job = await archivedJob(store);

    const result = await recoverLineVideoJob({
      jobStore: store,
      jobId: job.jobId,
      account: ACCOUNT,
      deliveryTo: "line:group:C1",
      cfg: {} as never,
      signUrl: (async () => "https://r2.example/x?sig") as never,
      deliver: (async () => {
        throw new Error("LINE push failed again");
      }) as never,
    });

    expect(result.kind).toBe("failed");
    const stored = store.entriesMap.get(job.jobId);
    // NOT "failed": the video exists and was paid for.
    expect(stored?.status).toBe("delivery_failed");
    expect(stored?.r2ObjectKey).toBe("outbound/line-video/sha256/ab/abcd.mp4");
    expect(stored?.deliveryAttempts).toBe(1);
  });

  it("refuses to retry a job with no archived object, rather than regenerating it", async () => {
    const store = memoryJobStore();
    const job = await createLineVideoJob({
      store,
      draftId: "1234",
      accountId: "primary",
      conversationKey: "primary:C1",
      model: "bytedance/seedance-2.5",
      prompt: "walk in the garden",
      durationSeconds: 10,
      aspectRatio: "9:16",
      resolution: "720p",
      audio: true,
      estimatedCostUsd: 1.5,
    });
    const deliver = vi.fn(async () => {});

    await expect(
      recoverLineVideoJob({
        jobStore: store,
        jobId: job.jobId,
        account: ACCOUNT,
        cfg: {} as never,
        signUrl: (async () => "https://r2.example/x") as never,
        deliver: deliver as never,
      }),
    ).resolves.toEqual({ kind: "no_recoverable_job" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not re-deliver a job already completed", async () => {
    const store = memoryJobStore();
    const job = await archivedJob(store);
    await updateLineVideoJob({ store, jobId: job.jobId, patch: { status: "completed" } });
    const deliver = vi.fn(async () => {});

    await expect(
      recoverLineVideoJob({
        jobStore: store,
        jobId: job.jobId,
        account: ACCOUNT,
        cfg: {} as never,
        signUrl: (async () => "https://r2.example/x") as never,
        deliver: deliver as never,
      }),
    ).resolves.toEqual({ kind: "no_recoverable_job" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("R: resumes from fal's OWN result when the artifact was never archived", async () => {
    const store = memoryJobStore();
    const created = await createLineVideoJob({
      store,
      draftId: "1234",
      accountId: "primary",
      conversationKey: "primary:C1",
      model: "bytedance/seedance-2.0/reference-to-video",
      provider: "fal",
      prompt: "walk in the garden",
      durationSeconds: 10,
      aspectRatio: "9:16",
      resolution: "720p",
      audio: true,
      estimatedCostUsd: 1.5,
    });
    // The paid generation FINISHED; only the download failed afterwards.
    await updateLineVideoJob({
      store,
      jobId: created.jobId,
      patch: {
        status: "failed",
        stage: "artifact_retrieval",
        providerRequestId: "fal-req-1",
        providerResultUrl: "https://queue.fal.run/requests/fal-req-1",
        error: "download failed",
      },
    });
    const archive = vi.fn(async () => ({
      url: "https://r2.example/archived.mp4?sig",
      objectKey: "outbound/line-video/sha256/cd/cdef.mp4",
      contentType: "video/mp4",
      contentLength: 10,
      sha256: "cdef",
    }));
    const deliver = vi.fn(async () => {});

    const result = await recoverLineVideoJob({
      jobStore: store,
      jobId: created.jobId,
      account: ACCOUNT,
      deliveryTo: "line:group:C1",
      cfg: {} as never,
      archive: archive as never,
      signUrl: (async (key: string) => `https://r2.example/${key}?sig`) as never,
      deliver: deliver as never,
    });

    expect(result).toEqual({ kind: "delivered", jobId: created.jobId });
    // Re-fetched from THIS generation's own fal result, never regenerated.
    expect(archive).toHaveBeenCalledWith("https://queue.fal.run/requests/fal-req-1");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.entriesMap.get(created.jobId)).toMatchObject({
      status: "completed",
      r2ObjectKey: "outbound/line-video/sha256/cd/cdef.mp4",
    });
  });

  it("records the provider that generated the job, for audit", async () => {
    const store = memoryJobStore();
    const job = await archivedJob(store);
    expect(store.entriesMap.get(job.jobId)?.provider).toBe("fal");
  });
});
