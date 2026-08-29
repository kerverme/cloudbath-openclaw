import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
    vi.clearAllMocks();
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
        body: await fs.readFile(filePath),
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
    expect(put.input.Body).toEqual(await fs.readFile(filePath));
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
      archive.findExistingObject({
        bucketName: "bucket",
        objectKey: `assets/sha256/aa/${sha256}.png`,
        contentLength: 10,
        sha256,
      }),
    ).resolves.toEqual({ kind: "existing", etag: "existing" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("creates a private 15-minute HTTPS GET URL without logging credentials", async () => {
    const client = new S3Client({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    });
    const presign = vi.fn(
      async (_client: S3Client, _command: GetObjectCommand, _options: { expiresIn: number }) =>
        "https://account.r2.cloudflarestorage.com/bucket/ugc/characters/kerver/main.png?X-Amz-Expires=900&X-Amz-Signature=temporary",
    );
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
      presign,
    );

    const url = await archive.createTemporaryReadUrl({
      bucketName: "bucket",
      objectKey: "ugc/characters/kerver/main.png",
    });

    expect(url).toContain("X-Amz-Expires=900&X-Amz-Signature=temporary");
    const command = presign.mock.calls[0]?.[1];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command?.input).toEqual({ Bucket: "bucket", Key: "ugc/characters/kerver/main.png" });
    expect(presign.mock.calls[0]?.[2]).toEqual({ expiresIn: 900 });
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("creates a fresh internal signed URL on every proxy read without returning it", async () => {
    const client = new S3Client({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    });
    let signature = 0;
    const presign = vi.fn(async () => {
      signature += 1;
      return `https://account.r2.cloudflarestorage.com/bucket/private.png?X-Amz-Expires=900&X-Amz-Signature=${signature}`;
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "4" },
        }),
    );
    const archive = new R2ArchiveClient(
      {
        accountId: "account",
        accessKeyId: "access",
        secretAccessKey: "secret",
        bucketName: "bucket",
        endpoint: "https://account.r2.cloudflarestorage.com",
        keyPrefix: "",
      },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger,
      client,
      presign,
      fetchImpl as unknown as typeof fetch,
    );

    const first = await archive.fetchPrivateObject({
      bucketName: "bucket",
      objectKey: "ugc/characters/kerver/private.png",
      maxBytes: 1024,
      contentTypePrefix: "image/",
    });
    const second = await archive.fetchPrivateObject({
      bucketName: "bucket",
      objectKey: "ugc/characters/kerver/private.png",
      maxBytes: 1024,
      contentTypePrefix: "image/",
    });

    expect(first).toEqual(second);
    expect(presign).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).not.toBe(fetchImpl.mock.calls[1]?.[0]);
    expect(first).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
