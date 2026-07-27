import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContentAddressedObjectKey,
  detectCanonicalImageExtension,
  R2ArchiveClient,
} from "./r2.js";
import type { SafeLogger } from "./types.js";

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("content-addressed R2 archive", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudbath-r2-"));
    filePath = path.join(tempDir, "untrusted-name.bin");
    await fs.writeFile(
      filePath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses a canonical SHA-256 key and content-derived extension", async () => {
    const sha256 = "a".repeat(64);
    await expect(detectCanonicalImageExtension(filePath)).resolves.toBe(".png");
    expect(
      buildContentAddressedObjectKey({
        keyPrefix: "cloudbath",
        sha256,
        extension: ".png",
      }),
    ).toBe(`cloudbath/assets/sha256/aa/${sha256}.png`);
  });

  it("uploads once with conditional creation and no ACL", async () => {
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
        return { ETag: "etag" };
      }),
    };
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      client,
    );
    const sha256 = "a".repeat(64);
    await expect(
      archive.ensureObject({
        filePath,
        bucketName: "bucket",
        objectKey: `assets/sha256/aa/${sha256}.png`,
        contentType: "image/png",
        contentLength: 10,
        sha256,
      }),
    ).resolves.toEqual({ kind: "uploaded", etag: "etag" });
    const put = commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.IfNoneMatch).toBe("*");
    expect(put.input).not.toHaveProperty("ACL");
  });

  it("reuses an existing globally matching object", async () => {
    const sha256 = "a".repeat(64);
    const client = {
      send: vi.fn(async () => ({
        Metadata: { sha256 },
        ContentLength: 10,
        ETag: "existing",
      })),
    };
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      client,
    );
    await expect(
      archive.ensureObject({
        filePath,
        bucketName: "bucket",
        objectKey: `assets/sha256/aa/${sha256}.png`,
        contentType: "image/png",
        contentLength: 10,
        sha256,
      }),
    ).resolves.toEqual({ kind: "existing", etag: "existing" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});
