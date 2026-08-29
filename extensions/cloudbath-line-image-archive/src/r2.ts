import fsp from "node:fs/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { retryableAwsError, withBoundedRetry, type RetryOptions } from "./retry.js";
import type { ArchiveConfig, SafeLogger } from "./types.js";

type S3Command = HeadObjectCommand | PutObjectCommand;
type S3Like = { send(command: S3Command): Promise<unknown> };
type PresignLike = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

const CHARACTER_VIEW_URL_EXPIRY_SECONDS = 15 * 60;

export type EnsureR2ObjectParams = {
  body: Uint8Array;
  bucketName: string;
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
};

export type FindR2ObjectParams = Pick<
  EnsureR2ObjectParams,
  "bucketName" | "objectKey" | "contentLength" | "sha256"
>;

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object"
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
}

function isNotFound(error: unknown): boolean {
  const name = error && typeof error === "object" ? ((error as { name?: string }).name ?? "") : "";
  return httpStatus(error) === 404 || name === "NotFound" || name === "NoSuchKey";
}

function isPreconditionFailed(error: unknown): boolean {
  return httpStatus(error) === 412;
}

export function buildContentAddressedObjectKey(params: {
  keyPrefix: string;
  sha256: string;
  extension: string;
}): string {
  if (!/^[a-f0-9]{64}$/.test(params.sha256)) {
    throw new Error("SHA-256 must be a lowercase hexadecimal digest");
  }
  if (!/^\.[a-z0-9]{1,10}$/.test(params.extension)) {
    throw new Error("Canonical extension is invalid");
  }
  const assetPath = `assets/sha256/${params.sha256.slice(0, 2)}/${params.sha256}${params.extension}`;
  return params.keyPrefix ? `${params.keyPrefix.replace(/\/+$/, "")}/${assetPath}` : assetPath;
}

export function detectCanonicalImageExtensionFromBytes(bytes: Uint8Array): string {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return ".jpg";
  }
  if (
    header.subarray(0, 6).toString("ascii") === "GIF87a" ||
    header.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return ".gif";
  }
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  if (header.subarray(0, 2).toString("ascii") === "BM") {
    return ".bmp";
  }
  const tiff = header.subarray(0, 4).toString("hex");
  if (tiff === "49492a00" || tiff === "4d4d002a") {
    return ".tiff";
  }
  if (header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") {
      return ".avif";
    }
    if (["heic", "heix", "hevc", "hevx", "mif1"].includes(brand)) {
      return ".heic";
    }
  }
  return ".bin";
}

export async function detectCanonicalImageExtension(filePath: string): Promise<string> {
  const file = await fsp.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return detectCanonicalImageExtensionFromBytes(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export class R2ArchiveClient {
  private readonly client: S3Like;
  private readonly signingClient?: S3Client;

  constructor(
    config: ArchiveConfig["r2"],
    private readonly retry: ArchiveConfig["retry"],
    private readonly logger: SafeLogger,
    client?: S3Like,
    private readonly presign: PresignLike = getSignedUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (client) {
      this.client = client;
      this.signingClient = client instanceof S3Client ? client : undefined;
      return;
    }
    const configuredClient = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.client = configuredClient;
    this.signingClient = configuredClient;
  }

  async createTemporaryReadUrl(params: { bucketName: string; objectKey: string }): Promise<string> {
    if (!this.signingClient || !params.bucketName.trim() || !params.objectKey.trim()) {
      throw new Error("R2 signed read URL is unavailable");
    }
    const signed = await this.presign(
      this.signingClient,
      new GetObjectCommand({ Bucket: params.bucketName, Key: params.objectKey }),
      { expiresIn: CHARACTER_VIEW_URL_EXPIRY_SECONDS },
    );
    const url = new URL(signed);
    if (url.protocol !== "https:" || url.username || url.password || !url.search) {
      throw new Error("R2 signed read URL is invalid");
    }
    return url.toString();
  }

  async fetchPrivateObject(params: {
    bucketName: string;
    objectKey: string;
    maxBytes: number;
    contentTypePrefix: string;
  }): Promise<{ bytes: Uint8Array; contentType: string }> {
    const signedUrl = await this.createTemporaryReadUrl(params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(signedUrl, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        response.status !== 200 ||
        !contentType.toLowerCase().startsWith(params.contentTypePrefix.toLowerCase()) ||
        (Number.isFinite(declaredLength) && declaredLength > params.maxBytes)
      ) {
        throw new Error("R2 private asset response is invalid");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > params.maxBytes) {
        throw new Error("R2 private asset response is invalid");
      }
      return { bytes, contentType };
    } finally {
      clearTimeout(timeout);
    }
  }

  private retryOptions(operation: string): RetryOptions {
    return {
      ...this.retry,
      isRetryable: retryableAwsError,
      onRetry: (_error, attempt, delayMs) => {
        this.logger.warn("r2_retry", { operation, attempt, delayMs });
      },
    };
  }

  private async head(
    bucketName: string,
    objectKey: string,
  ): Promise<HeadObjectCommandOutput | null> {
    try {
      return (await withBoundedRetry(
        async () =>
          await this.client.send(new HeadObjectCommand({ Bucket: bucketName, Key: objectKey })),
        this.retryOptions("head"),
      )) as HeadObjectCommandOutput;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private verifyExisting(
    existing: HeadObjectCommandOutput,
    params: FindR2ObjectParams,
  ): { kind: "existing"; etag?: string } {
    if (existing.Metadata?.sha256 !== params.sha256) {
      throw new Error(`R2 content-addressed object conflict for ${params.objectKey}`);
    }
    if (existing.ContentLength !== params.contentLength) {
      throw new Error(`R2 content-addressed object size conflict for ${params.objectKey}`);
    }
    return { kind: "existing", etag: existing.ETag };
  }

  async findExistingObject(
    params: FindR2ObjectParams,
  ): Promise<{ kind: "existing"; etag?: string } | null> {
    const existing = await this.head(params.bucketName, params.objectKey);
    return existing ? this.verifyExisting(existing, params) : null;
  }

  async ensureObject(
    params: EnsureR2ObjectParams,
  ): Promise<{ kind: "uploaded" | "existing"; etag?: string }> {
    const existing = await this.findExistingObject(params);
    if (existing) {
      return existing;
    }
    try {
      const uploaded = (await withBoundedRetry(
        async () =>
          await this.client.send(
            new PutObjectCommand({
              Bucket: params.bucketName,
              Key: params.objectKey,
              Body: params.body,
              ContentLength: params.contentLength,
              ContentType: params.contentType,
              IfNoneMatch: "*",
              Metadata: { sha256: params.sha256 },
            }),
          ),
        this.retryOptions("put"),
      )) as { ETag?: string };
      return { kind: "uploaded", etag: uploaded.ETag };
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
      const raced = await this.head(params.bucketName, params.objectKey);
      if (!raced) {
        throw error;
      }
      return this.verifyExisting(raced, params);
    }
  }
}
