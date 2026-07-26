import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivePipeline } from "./pipeline.js";
import type {
  ArchiveConfig,
  AsyncKeyedStore,
  InboundImageJob,
  PersistedArchiveRecord,
  SafeLogger,
} from "./types.js";

class MemoryStore implements AsyncKeyedStore<PersistedArchiveRecord> {
  readonly values = new Map<string, PersistedArchiveRecord>();

  async register(key: string, value: PersistedArchiveRecord): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async registerIfAbsent(key: string, value: PersistedArchiveRecord): Promise<boolean> {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, structuredClone(value));
    return true;
  }

  async lookup(key: string): Promise<PersistedArchiveRecord | undefined> {
    return this.values.get(key);
  }

  async entries() {
    return [...this.values.entries()].map(([key, value]) => ({
      key,
      value: structuredClone(value),
      createdAt: Date.now(),
    }));
  }
}

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function config(): ArchiveConfig {
  return {
    enabled: true,
    analysisEnabled: false,
    allowedGroupIds: new Set(["C123"]),
    imageMaxBytes: 1024 * 1024,
    r2: {
      accountId: "account",
      accessKeyId: "access",
      secretAccessKey: "secret",
      bucketName: "private-bucket",
      endpoint: "https://account.r2.cloudflarestorage.com",
      keyPrefix: "",
    },
    notion: { apiKey: "notion", databaseId: "database" },
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
  };
}

describe("ArchivePipeline", () => {
  let stateDir: string;
  let mediaPath: string;
  let originalBytes: Uint8Array;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudbath-line-archive-"));
    const mediaDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(mediaDir, { recursive: true });
    mediaPath = path.join(mediaDir, "official-line-download.png");
    originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]);
    await fs.writeFile(mediaPath, originalBytes);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function job(): InboundImageJob {
    return {
      accountId: "default",
      groupId: "C123",
      lineTarget: "line:group:C123",
      messageId: "message-1",
      userId: "U123",
      mediaPath,
      mimeType: "image/png",
      receivedAt: "2026-07-25T01:02:03.000Z",
    };
  }

  it("preserves original bytes and archives R2 plus Notion metadata", async () => {
    const store = new MemoryStore();
    const r2 = {
      ensureObject: vi.fn(async ({ filePath }: { filePath: string }) => {
        expect([...(await fs.readFile(filePath))]).toEqual([...originalBytes]);
        return { kind: "uploaded" as const };
      }),
    };
    const notion = {
      createRecord: vi.fn(async () => ({ kind: "created" as const, pageId: "page-1" })),
    };
    const sendAcknowledgement = vi.fn(async () => undefined);
    const pipeline = new ArchivePipeline({
      config: config(),
      stateDir,
      store,
      r2,
      notion,
      logger,
      sendAcknowledgement,
    });

    await expect(pipeline.enqueue(job())).resolves.toBe("queued");
    await pipeline.waitForIdle();

    const record = [...store.values.values()][0];
    expect(record?.status).toBe("PROCESSED");
    expect(record?.objectKey).toBe("line/2026/07/25/C123/message-1-original.png");
    expect(record?.fileSize).toBe(originalBytes.length);
    expect(record?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(notion.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        lineMessageId: "message-1",
        r2ObjectKey: "line/2026/07/25/C123/message-1-original.png",
        status: "PROCESSED",
      }),
    );
    expect(sendAcknowledgement).toHaveBeenCalledWith(
      expect.anything(),
      "Image archived successfully.",
    );
  });

  it("deduplicates a repeated LINE webhook event persistently", async () => {
    const store = new MemoryStore();
    const r2 = {
      ensureObject: vi.fn(
        async (): Promise<{ kind: "uploaded" | "existing" }> => ({ kind: "uploaded" }),
      ),
    };
    const notion = {
      createRecord: vi.fn(async () => ({ kind: "created" as const, pageId: "page-1" })),
    };
    const pipeline = new ArchivePipeline({
      config: config(),
      stateDir,
      store,
      r2,
      notion,
      logger,
    });

    await expect(pipeline.enqueue(job())).resolves.toBe("queued");
    await expect(pipeline.enqueue(job())).resolves.toBe("duplicate");
    await pipeline.waitForIdle();

    expect(r2.ensureObject).toHaveBeenCalledTimes(1);
    expect(notion.createRecord).toHaveBeenCalledTimes(1);
    expect(store.values.size).toBe(1);
  });

  it("keeps archiving successful when model analysis fails", async () => {
    const store = new MemoryStore();
    const enabled = config();
    enabled.analysisEnabled = true;
    const r2 = { ensureObject: vi.fn(async () => ({ kind: "uploaded" as const })) };
    const notion = {
      createRecord: vi.fn(async () => ({ kind: "created" as const, pageId: "page-1" })),
    };
    const sendAcknowledgement = vi.fn(async () => undefined);
    const pipeline = new ArchivePipeline({
      config: enabled,
      stateDir,
      store,
      r2,
      notion,
      logger,
      analyze: vi.fn(async () => {
        throw new Error("model has no image capability");
      }),
      sendAcknowledgement,
    });

    await pipeline.enqueue(job());
    await pipeline.waitForIdle();

    const record = [...store.values.values()][0];
    expect(r2.ensureObject).toHaveBeenCalledTimes(1);
    expect(notion.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "NEED_REVIEW",
        error: expect.stringContaining("model has no image capability"),
      }),
    );
    expect(record?.status).toBe("NEED_REVIEW");
    expect(record?.notionPageId).toBe("page-1");
    expect(sendAcknowledgement).toHaveBeenCalledWith(
      expect.anything(),
      "Image archived, but its metadata needs review.",
    );
  });

  it("persists a restart-recoverable NEED_REVIEW record when Notion fails", async () => {
    const store = new MemoryStore();
    const r2 = {
      ensureObject: vi.fn(
        async (): Promise<{ kind: "uploaded" | "existing" }> => ({ kind: "uploaded" }),
      ),
    };
    const pipeline = new ArchivePipeline({
      config: config(),
      stateDir,
      store,
      r2,
      notion: {
        createRecord: vi.fn(async () => {
          throw new Error("Notion unavailable");
        }),
      },
      logger,
    });

    await pipeline.enqueue(job());
    await pipeline.waitForIdle();

    const record = [...store.values.values()][0];
    expect(record?.status).toBe("NEED_REVIEW");
    expect(record?.objectKey).toBeTruthy();
    expect(record?.sha256).toBeTruthy();
    expect(record?.notionPageId).toBeUndefined();
    expect(record?.error).toContain("Notion unavailable");

    r2.ensureObject.mockResolvedValue({ kind: "existing" as const });
    const recoveredNotion = {
      createRecord: vi.fn(async () => ({ kind: "created" as const, pageId: "page-recovered" })),
    };
    const restarted = new ArchivePipeline({
      config: config(),
      stateDir,
      store,
      r2,
      notion: recoveredNotion,
      logger,
    });

    await expect(restarted.recoverIncomplete()).resolves.toBe(1);
    await restarted.waitForIdle();

    const recoveredRecord = [...store.values.values()][0];
    expect(recoveredRecord?.status).toBe("PROCESSED");
    expect(recoveredRecord?.notionPageId).toBe("page-recovered");
    expect(r2.ensureObject).toHaveBeenCalledTimes(2);
    expect(recoveredNotion.createRecord).toHaveBeenCalledTimes(1);
  });
});
