/**
 * The status seam reads LINE-owned job state and hands out something safe to
 * repeat in chat. No provider is reachable from here: the stores are in-memory
 * and no job is ever submitted.
 */

import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { readLineActiveVideoJobSnapshot } from "./video-job-snapshot.js";
import {
  claimLineVideoActiveJobLock,
  releaseLineVideoActiveJobLock,
  type LineVideoActiveJobLock,
  type LineVideoJob,
} from "./video-job-store.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";

const ACCOUNT = "acct-1";
const CONVERSATION = "C1234567890abcdef";

/** The subset of the keyed-store contract these helpers actually touch. */
function store<T>(): PluginStateKeyedStore<T> {
  const rows = new Map<string, T>();
  const minimal = {
    register: async (key: string, value: T) => void rows.set(key, value),
    registerIfAbsent: async (key: string, value: T) =>
      rows.has(key) ? false : (rows.set(key, value), true),
    lookup: async (key: string) => rows.get(key),
    delete: async (key: string) => void rows.delete(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return minimal as unknown as PluginStateKeyedStore<T>;
}

function job(overrides: Partial<LineVideoJob> = {}): LineVideoJob {
  return {
    version: 1,
    jobId: "job-1",
    draftId: "9566",
    accountId: ACCOUNT,
    conversationKey: buildLineVideoConversationKey({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
    })!,
    model: "minimax/h3/reference-to-video",
    prompt: "a scene",
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "2K",
    audio: true,
    status: "running",
    submittedAt: 1,
    estimatedCostUsd: 1.95,
    ...overrides,
  };
}

async function setup(record: LineVideoJob) {
  const jobStore = store<LineVideoJob>();
  const activeJobLockStore = store<LineVideoActiveJobLock>();
  await jobStore.register(record.jobId, record);
  await claimLineVideoActiveJobLock({
    store: activeJobLockStore,
    conversationKey: record.conversationKey,
    jobId: record.jobId,
    now: () => 1,
  });
  return { jobStore, activeJobLockStore };
}

describe("the active job a conversation is waiting on", () => {
  it("reports the stage the record proves, and nothing more", async () => {
    const stores = await setup(job({ stage: "provider_submission" }));

    const snapshot = await readLineActiveVideoJobSnapshot({
      ...stores,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      now: () => 2,
    });

    expect(snapshot).toEqual({
      jobId: "job-1",
      draftId: "9566",
      status: "running",
      stage: "provider_submission",
      submittedAt: 1,
    });
  });

  it("strips links and key-shaped tokens out of a failure before repeating it", async () => {
    const stores = await setup(
      job({
        status: "failed",
        error:
          "fal rejected the request: see https://fal.run/x?sig=abc api_key=sk-9f8 aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsbw",
      }),
    );

    const snapshot = await readLineActiveVideoJobSnapshot({
      ...stores,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      now: () => 2,
    });

    expect(snapshot?.failureReason).toBe(
      "fal rejected the request: see [link] [redacted] [redacted]",
    );
  });

  it("reports nothing once the job is terminal and its lock released", async () => {
    const record = job({ status: "completed" });
    const stores = await setup(record);
    await releaseLineVideoActiveJobLock({
      store: stores.activeJobLockStore,
      conversationKey: record.conversationKey,
    });

    const snapshot = await readLineActiveVideoJobSnapshot({
      ...stores,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      now: () => 2,
    });

    // The owner already saw this finish; a status question is about newer work.
    expect(snapshot).toBeUndefined();
  });

  it("reports nothing when a lock outlived the job record it names", async () => {
    const record = job();
    const stores = await setup(record);
    await stores.jobStore.delete(record.jobId);

    const snapshot = await readLineActiveVideoJobSnapshot({
      ...stores,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      now: () => 2,
    });

    expect(snapshot).toBeUndefined();
  });
});
