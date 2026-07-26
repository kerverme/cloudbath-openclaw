import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2ArchiveClient } from "./r2.js";
import type { SafeLogger } from "./types.js";

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("R2ArchiveClient", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudbath-r2-"));
    filePath = path.join(tempDir, "image.png");
    await fs.writeFile(filePath, new TextEncoder().encode("original-image"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function params() {
    return {
      filePath,
      bucketName: "private-bucket",
      objectKey: "line/2026/07/25/C123/message-original.png",
      contentType: "image/png",
      contentLength: 14,
      sha256: "a".repeat(64),
      messageId: "message",
    };
  }

  it("uploads a missing object privately with conditional creation", async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          throw Object.assign(new Error("missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        const body = (command as PutObjectCommand).input.Body as { destroy?: () => void };
        body.destroy?.();
        return { ETag: "etag-1" };
      }),
    };
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "private-bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      client,
    );

    await expect(archive.ensureObject(params())).resolves.toEqual({
      kind: "uploaded",
      etag: "etag-1",
    });
    const put = commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.IfNoneMatch).toBe("*");
    expect(put.input).not.toHaveProperty("ACL");
    expect(put.input.Metadata?.sha256).toBe("a".repeat(64));
  });

  it("reuses an existing object with matching hash and size", async () => {
    const client = {
      send: vi.fn(async (_command: unknown) => ({
        Metadata: { sha256: "a".repeat(64) },
        ContentLength: 14,
        ETag: "existing",
      })),
    };
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "private-bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      client,
    );

    await expect(archive.ensureObject(params())).resolves.toEqual({
      kind: "existing",
      etag: "existing",
    });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("refuses to overwrite a conflicting object key", async () => {
    const client = {
      send: vi.fn(async () => ({
        Metadata: { sha256: "b".repeat(64) },
        ContentLength: 14,
      })),
    };
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "private-bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      client,
    );
    await expect(archive.ensureObject(params())).rejects.toThrow("conflict");
  });
});
