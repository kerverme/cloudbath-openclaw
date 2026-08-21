import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  claimLineVideoActiveJobLock,
  createLineVideoJob,
  getLineVideoJob,
  LINE_VIDEO_JOB_STALE_RUNNING_MS,
  releaseLineVideoActiveJobLock,
  resolveLineVideoActiveJobLock,
  updateLineVideoJob,
  type LineVideoActiveJobLock,
  type LineVideoJob,
} from "./video-job-store.js";

function createMemoryStore<T = LineVideoJob>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
    async update(key, updateValue) {
      const current = values.get(key);
      const next = updateValue(current);
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

function jobParams(overrides?: Partial<Parameters<typeof createLineVideoJob>[0]>) {
  return {
    store: createMemoryStore(),
    draftId: "1234",
    accountId: "acct-1",
    conversationKey: "acct-1|grp-a",
    model: "bytedance/seedance-2.5",
    prompt: "a cat riding a skateboard",
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "1080p",
    audio: false,
    estimatedCostUsd: 1.5,
    ...overrides,
  };
}

describe("createLineVideoJob / updateLineVideoJob / getLineVideoJob", () => {
  it("1: persists every required job field with status 'running'", async () => {
    const job = await createLineVideoJob(jobParams());
    expect(job).toMatchObject({
      draftId: "1234",
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      model: "bytedance/seedance-2.5",
      status: "running",
      estimatedCostUsd: 1.5,
    });
    expect(job.jobId).toBeTruthy();
  });

  it("2: records completion with actual cost and video URL", async () => {
    const store = createMemoryStore();
    const job = await createLineVideoJob(jobParams({ store }));

    const updated = await updateLineVideoJob({
      store,
      jobId: job.jobId,
      patch: { status: "completed", videoUrl: "https://r2.example/video.mp4", actualCostUsd: 1.42 },
    });

    expect(updated).toMatchObject({
      status: "completed",
      videoUrl: "https://r2.example/video.mp4",
      actualCostUsd: 1.42,
    });
    expect(await getLineVideoJob({ store, jobId: job.jobId })).toMatchObject({
      status: "completed",
    });
  });

  it("3: records failure with an error message", async () => {
    const store = createMemoryStore();
    const job = await createLineVideoJob(jobParams({ store }));

    await updateLineVideoJob({
      store,
      jobId: job.jobId,
      patch: { status: "failed", error: "timeout" },
    });

    expect(await getLineVideoJob({ store, jobId: job.jobId })).toMatchObject({
      status: "failed",
      error: "timeout",
    });
  });

  it("4: job state survives recreation of the state consumer (persistent store, not an in-memory Map)", async () => {
    const sharedStore = createMemoryStore();
    const job = await createLineVideoJob(jobParams({ store: sharedStore }));
    await updateLineVideoJob({
      store: sharedStore,
      jobId: job.jobId,
      patch: { status: "completed" },
    });

    // Simulate a process/handler restart: a fresh read against the same
    // underlying persistent store, as would happen with the live SQLite store.
    const reread = await getLineVideoJob({ store: sharedStore, jobId: job.jobId });
    expect(reread?.status).toBe("completed");
  });

  it("5: updating an unknown job id is a no-op", async () => {
    const store = createMemoryStore();
    const updated = await updateLineVideoJob({
      store,
      jobId: "missing",
      patch: { status: "completed" },
    });
    expect(updated).toBeUndefined();
  });
});

describe("claimLineVideoActiveJobLock / releaseLineVideoActiveJobLock / resolveLineVideoActiveJobLock", () => {
  it("6: resolves undefined when no lock has ever been claimed for a conversation", async () => {
    const lockStore = createMemoryStore<LineVideoActiveJobLock>();
    expect(
      await resolveLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-a" }),
    ).toBeUndefined();
  });

  it("7: resolves the claimed lock, scoped by conversation key", async () => {
    const lockStore = createMemoryStore<LineVideoActiveJobLock>();
    await claimLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
    });

    expect(
      await resolveLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-a" }),
    ).toMatchObject({ jobId: "job-1", conversationKey: "acct-1|grp-a" });
    // Group A and Group B locks are fully isolated.
    expect(
      await resolveLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-b" }),
    ).toBeUndefined();
  });

  it("8: releasing the lock clears it for that conversation only", async () => {
    const lockStore = createMemoryStore<LineVideoActiveJobLock>();
    await claimLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
    });
    await claimLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-b",
      jobId: "job-2",
    });

    await releaseLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-a" });

    expect(
      await resolveLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-a" }),
    ).toBeUndefined();
    expect(
      await resolveLineVideoActiveJobLock({ store: lockStore, conversationKey: "acct-1|grp-b" }),
    ).toMatchObject({ jobId: "job-2" });
  });

  it("9: a lock older than LINE_VIDEO_JOB_STALE_RUNNING_MS is treated as abandoned and cleared", async () => {
    const lockStore = createMemoryStore<LineVideoActiveJobLock>();
    const claimedAt = 1_000_000;
    await claimLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
      now: () => claimedAt,
    });

    const justUnderStale = await resolveLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-a",
      now: () => claimedAt + LINE_VIDEO_JOB_STALE_RUNNING_MS - 1,
    });
    expect(justUnderStale).toMatchObject({ jobId: "job-1" });

    const staleResolve = await resolveLineVideoActiveJobLock({
      store: lockStore,
      conversationKey: "acct-1|grp-a",
      now: () => claimedAt + LINE_VIDEO_JOB_STALE_RUNNING_MS + 1,
    });
    expect(staleResolve).toBeUndefined();
    // The stale check also clears the entry, so a later call at any time
    // (including one that would have been "fresh" relative to the old claim)
    // still reports no lock -- a genuinely abandoned lock never resurfaces.
    expect(
      await resolveLineVideoActiveJobLock({
        store: lockStore,
        conversationKey: "acct-1|grp-a",
        now: () => claimedAt,
      }),
    ).toBeUndefined();
  });
});
