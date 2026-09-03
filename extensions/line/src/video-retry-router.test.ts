import { describe, expect, it, vi } from "vitest";
import type { LineVideoJob, LineVideoJobStore } from "./video-job-store.js";
import {
  handleLineVideoRetryCommand,
  isLineVideoRetryCommand,
  resolveRecoverableLineVideoJob,
} from "./video-retry-router.js";

const OWNER = "U-owner";
const CTX = { accountId: "acct-1", conversationId: "grp-a" };

function job(overrides: Partial<LineVideoJob> = {}): LineVideoJob {
  return {
    version: 1,
    jobId: "job-1",
    draftId: "1234",
    accountId: "acct-1",
    conversationKey: "acct-1|grp-a",
    model: "bytedance/seedance-2.0/reference-to-video",
    provider: "fal",
    prompt: "walk in the garden",
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: true,
    status: "delivery_failed",
    stage: "line_delivery",
    submittedAt: 1000,
    estimatedCostUsd: 1,
    r2ObjectKey: "outbound/line-video/sha256/ab/abcd.mp4",
    deliveryTo: "line:group:grp-a",
    ...overrides,
  } as LineVideoJob;
}

function store(jobs: readonly LineVideoJob[]): LineVideoJobStore {
  const values = new Map(jobs.map((entry) => [entry.jobId, entry]));
  return {
    async register(key: string, value: LineVideoJob) {
      values.set(key, value);
    },
    async registerIfAbsent() {
      return true;
    },
    async lookup(key: string) {
      return values.get(key);
    },
    async consume(key: string) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  } as never;
}

const ACCOUNT = { accountId: "acct-1", channelAccessToken: "token", config: {} } as never;

function event(body: string, overrides: Record<string, unknown> = {}) {
  return { channel: "line", body, senderId: OWNER, senderIsOwner: true, ...overrides };
}

describe("the ส่งวิดีโออีกครั้ง command", () => {
  it("recognises the command and not ordinary conversation about it", () => {
    expect(isLineVideoRetryCommand("ส่งวิดีโออีกครั้ง")).toBe(true);
    expect(isLineVideoRetryCommand("ขอวิดีโออีกที")).toBe(true);
    expect(isLineVideoRetryCommand("เดี๋ยวจะส่งวิดีโออีกครั้งให้ทีมดู")).toBe(false);
    expect(isLineVideoRetryCommand("ส่งวิดีโอ")).toBe(false);
  });

  it("S: re-delivers the archived R2 object and calls no provider", async () => {
    const recover = vi.fn(async () => ({ kind: "delivered" as const, jobId: "job-1" }));
    const result = await handleLineVideoRetryCommand(event("ส่งวิดีโออีกครั้ง"), CTX, {
      jobStore: store([job()]),
      resolveAccount: (() => ACCOUNT) as never,
      recover: recover as never,
      cfg: {} as never,
    });

    expect(result?.text).toContain("ไม่มีค่าใช้จ่ายเพิ่ม");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls.at(0)?.at(0)).toMatchObject({
      jobId: "job-1",
      deliveryTo: "line:group:grp-a",
    });
  });

  it("T: never resolves a job from another conversation", async () => {
    const recover = vi.fn();
    const result = await handleLineVideoRetryCommand(event("ส่งวิดีโออีกครั้ง"), CTX, {
      jobStore: store([job({ conversationKey: "acct-1|other-group" })]),
      resolveAccount: (() => ACCOUNT) as never,
      recover: recover as never,
      cfg: {} as never,
    });

    expect(result?.text).toContain("ไม่พบวิดีโอ");
    expect(recover).not.toHaveBeenCalled();
  });

  it("T: never resolves a job from another LINE account", async () => {
    const recover = vi.fn();
    await handleLineVideoRetryCommand(event("ส่งวิดีโออีกครั้ง"), CTX, {
      jobStore: store([job({ accountId: "acct-2", conversationKey: "acct-2|grp-a" })]),
      resolveAccount: (() => ACCOUNT) as never,
      recover: recover as never,
      cfg: {} as never,
    });
    expect(recover).not.toHaveBeenCalled();
  });

  it("is owner-only, exactly like confirming a paid video", async () => {
    const recover = vi.fn();
    const result = await handleLineVideoRetryCommand(
      event("ส่งวิดีโออีกครั้ง", { senderIsOwner: false }),
      CTX,
      {
        jobStore: store([job()]),
        resolveAccount: (() => ACCOUNT) as never,
        recover: recover as never,
        cfg: {} as never,
      },
    );
    expect(result).toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it("gives the same reply whether nothing exists or it belongs to someone else", async () => {
    const mine = await handleLineVideoRetryCommand(event("ส่งวิดีโออีกครั้ง"), CTX, {
      jobStore: store([]),
      resolveAccount: (() => ACCOUNT) as never,
      recover: (async () => ({ kind: "no_recoverable_job" as const })) as never,
      cfg: {} as never,
    });
    const theirs = await handleLineVideoRetryCommand(event("ส่งวิดีโออีกครั้ง"), CTX, {
      jobStore: store([job({ conversationKey: "acct-1|other-group" })]),
      resolveAccount: (() => ACCOUNT) as never,
      recover: (async () => ({ kind: "no_recoverable_job" as const })) as never,
      cfg: {} as never,
    });
    // A distinguishing message would confirm another owner's job exists.
    expect(mine?.text).toBe(theirs?.text);
  });

  it("falls through entirely for an unrelated message", async () => {
    await expect(
      handleLineVideoRetryCommand(event("เอา F1 ไปเดินในสวน"), CTX, {
        jobStore: store([job()]),
        resolveAccount: (() => ACCOUNT) as never,
        cfg: {} as never,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("which jobs are recoverable at all", () => {
  const scope = { accountId: "acct-1", conversationKey: "acct-1|grp-a" };

  it("takes the newest recoverable job in this conversation", () => {
    const older = job({ jobId: "old", submittedAt: 1 });
    const newer = job({ jobId: "new", submittedAt: 2 });
    expect(resolveRecoverableLineVideoJob([older, newer], scope)?.jobId).toBe("new");
  });

  it("ignores a job whose paid generation never finished", () => {
    // No archived object and no fal result: there is nothing bought to resend,
    // and 'retrying' it would mean paying again.
    const unfinished = job({ r2ObjectKey: undefined, providerResultUrl: undefined });
    expect(resolveRecoverableLineVideoJob([unfinished], scope)).toBeUndefined();
  });

  it("accepts a generation that completed but was never archived", () => {
    const generated = job({
      status: "failed",
      stage: "artifact_retrieval",
      r2ObjectKey: undefined,
      providerResultUrl: "https://queue.fal.run/requests/abc",
    });
    expect(resolveRecoverableLineVideoJob([generated], scope)?.jobId).toBe("job-1");
  });

  it("ignores a job that already completed", () => {
    expect(resolveRecoverableLineVideoJob([job({ status: "completed" })], scope)).toBeUndefined();
  });
});
