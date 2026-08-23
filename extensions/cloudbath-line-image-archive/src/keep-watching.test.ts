import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./r2.js", () => ({
  detectCanonicalImageExtensionFromBytes: () => ".png",
  buildContentAddressedObjectKey: (params: {
    keyPrefix: string;
    sha256: string;
    extension: string;
  }) =>
    `${params.keyPrefix}/assets/sha256/${params.sha256.slice(0, 2)}/${params.sha256}${params.extension}`,
}));

import { KeepWatchingNotionWriter, KeepWatchingPipeline } from "./keep-watching.js";
import type { InboundImageJob, KeepWatchingJobRecord, SafeLogger } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await fsp.rm(root, { recursive: true, force: true })),
  );
});

async function managedPng(): Promise<{ stateDir: string; filePath: string; bytes: Buffer }> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "keep-watching-"));
  temporaryRoots.push(stateDir);
  const inbound = path.join(stateDir, "media", "inbound");
  await fsp.mkdir(inbound, { recursive: true });
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  const filePath = path.join(inbound, "message.png");
  await fsp.writeFile(filePath, bytes);
  return { stateDir, filePath, bytes };
}

function memoryStore() {
  const records = new Map<string, KeepWatchingJobRecord>();
  return {
    records,
    store: {
      async register(key: string, value: KeepWatchingJobRecord) {
        records.set(key, structuredClone(value));
      },
      async registerIfAbsent(key: string, value: KeepWatchingJobRecord) {
        if (records.has(key)) {
          return false;
        }
        records.set(key, structuredClone(value));
        return true;
      },
      async lookup(key: string) {
        return records.get(key);
      },
      async entries() {
        return Array.from(records, ([key, value]) => ({ key, value, createdAt: Date.now() }));
      },
    },
  };
}

function logger(): SafeLogger & {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function lineJob(filePath: string): InboundImageJob {
  return {
    accountId: "primary",
    groupId: "C-keep-watching",
    lineTarget: "line:group:C-keep-watching",
    messageId: "message-1",
    userId: "U-sender",
    mediaPath: filePath,
    mimeType: "image/png",
    receivedAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("KEEP_WATCHING silent ingest", () => {
  it("archives a safe image to the fixed R2 prefix and configured Notion target", async () => {
    const media = await managedPng();
    const state = memoryStore();
    const ensureObject = vi.fn(async () => ({ kind: "uploaded" as const }));
    const createRecord = vi.fn(async () => ({ pageId: "page-1", duplicate: false }));
    const subject = new KeepWatchingPipeline({
      stateDir: media.stateDir,
      imageMaxBytes: 1_000,
      bucketName: "existing-cloudbath-bucket",
      policy: {
        notion: { databaseId: "a".repeat(32), dataSourceId: "b".repeat(32) },
        r2Prefix: "keep-watching/fixed",
      },
      store: state.store,
      r2: { ensureObject },
      notion: { createRecord },
      logger: logger(),
    });

    await expect(subject.enqueue(lineJob(media.filePath))).resolves.toBe("queued");
    await subject.waitForIdle();

    expect(ensureObject).toHaveBeenCalledOnce();
    expect(ensureObject.mock.calls[0]![0]).toMatchObject({
      bucketName: "existing-cloudbath-bucket",
      contentType: "image/png",
      contentLength: media.bytes.length,
    });
    expect(ensureObject.mock.calls[0]![0].objectKey).toMatch(
      /^keep-watching\/fixed\/assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/u,
    );
    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { databaseId: "a".repeat(32), dataSourceId: "b".repeat(32) },
      }),
    );
    expect(Array.from(state.records.values())).toEqual([
      expect.objectContaining({
        status: "PROCESSED",
        scope: expect.objectContaining({
          lineGroupId: "C-keep-watching",
          policyId: "KEEP_WATCHING",
          targetDatabaseId: "a".repeat(32),
          targetDataSourceId: "b".repeat(32),
          r2Prefix: "keep-watching/fixed",
        }),
      }),
    ]);
  });

  it("deduplicates stable LINE message identity before any R2 or Notion operation", async () => {
    const media = await managedPng();
    const state = memoryStore();
    const ensureObject = vi.fn(async () => ({ kind: "uploaded" as const }));
    const createRecord = vi.fn(async () => ({ pageId: "page-1", duplicate: false }));
    const subject = new KeepWatchingPipeline({
      stateDir: media.stateDir,
      imageMaxBytes: 1_000,
      bucketName: "existing-cloudbath-bucket",
      policy: {
        notion: { databaseId: "a".repeat(32), dataSourceId: "b".repeat(32) },
        r2Prefix: "keep-watching/fixed",
      },
      store: state.store,
      r2: { ensureObject },
      notion: { createRecord },
      logger: logger(),
    });
    await subject.enqueue(lineJob(media.filePath));
    await subject.waitForIdle();
    await expect(subject.enqueue(lineJob(media.filePath))).resolves.toBe("duplicate");
    expect(ensureObject).toHaveBeenCalledOnce();
    expect(createRecord).toHaveBeenCalledOnce();
  });

  it("fails closed with durable sanitized state and never leaks credentials", async () => {
    const media = await managedPng();
    const state = memoryStore();
    const safeLogger = logger();
    const secret = "secret-access-value";
    const subject = new KeepWatchingPipeline({
      stateDir: media.stateDir,
      imageMaxBytes: 1_000,
      bucketName: "existing-cloudbath-bucket",
      policy: {
        notion: { databaseId: "a".repeat(32), dataSourceId: "b".repeat(32) },
        r2Prefix: "keep-watching/fixed",
      },
      store: state.store,
      r2: {
        ensureObject: vi.fn(async () => {
          throw new Error(`R2 authorization failed ${secret}`);
        }),
      },
      notion: { createRecord: vi.fn() },
      logger: safeLogger,
    });
    await subject.enqueue(lineJob(media.filePath));
    await subject.waitForIdle();
    const record = Array.from(state.records.values())[0]!;
    expect(record.status).toBe("ERROR");
    const logOutput = JSON.stringify([
      safeLogger.info.mock.calls,
      safeLogger.error.mock.calls,
      safeLogger.warn.mock.calls,
    ]);
    expect(logOutput).not.toContain(secret);
  });
});

describe("KEEP_WATCHING fixed Notion target", () => {
  it("validates the configured database/data source and writes only to that target", async () => {
    const databaseId = "a".repeat(32);
    const dataSourceId = "b".repeat(32);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { data_sources: [{ id: dataSourceId }] },
      {
        properties: Object.fromEntries(
          [
            ["Name", "title"],
            ["Captured At", "date"],
            ["Source", "rich_text"],
            ["Sender", "rich_text"],
            ["Media Type", "rich_text"],
            ["File Size", "number"],
            ["R2 Object Key", "rich_text"],
            ["SHA-256", "rich_text"],
            ["Status", "select"],
            ["Record ID", "rich_text"],
          ].map(([name, type]) => [name, { type }]),
        ),
      },
      { results: [] },
      { id: "page-1" },
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const writer = new KeepWatchingNotionWriter(
      "unit-test-credential",
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger(),
      fetchImpl,
    );
    await expect(
      writer.createRecord({
        target: { databaseId, dataSourceId },
        recordId: "record-1",
        job: lineJob("/managed/message.png"),
        sha256: "c".repeat(64),
        objectKey: "keep-watching/assets/sha256/cc/example.png",
        fileSize: 12,
      }),
    ).resolves.toEqual({ pageId: "page-1", duplicate: false });

    expect(requests.map((request) => request.url)).toEqual([
      `https://api.notion.com/v1/databases/${databaseId}`,
      `https://api.notion.com/v1/data_sources/${dataSourceId}`,
      `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
      "https://api.notion.com/v1/pages",
    ]);
    expect(JSON.parse(String(requests[3]!.init?.body))).toMatchObject({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
    });
  });
});
