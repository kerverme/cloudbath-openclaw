/**
 * Stages a generated video's bytes in the same Cloudbath R2 bucket already
 * used for outbound LINE images (outbound-media-staging.ts), producing a
 * signed HTTPS URL LINE's servers can fetch directly. Deliberately a
 * separate, minimal module rather than folding into outbound-media-staging.ts:
 * that file's staging pipeline (image magic-byte validation, the LINE
 * Flex/image message-tree walker) is image-specific, and generalizing it to
 * also cover video content would be a materially larger refactor than this
 * PR's scope. Reuses the identical R2 environment variables, bucket, and
 * signing mechanism — only the object prefix and content validation differ.
 *
 * The required video-message thumbnail (`previewImageUrl`) is staged through
 * the existing `stageLineOutboundImage` unchanged (see
 * buildLineVideoPreviewImage below) instead of duplicating that logic.
 */
import { createHash, randomInt } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { stageLineOutboundImage, type StagedLineImage } from "./outbound-media-staging.js";

const OUTBOUND_LINE_VIDEO_PREFIX = "outbound/line-video";
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

export class LineVideoOutboundStagingError extends Error {
  constructor(readonly code: string) {
    super(`LINE video outbound staging failed (${code})`);
    this.name = "LineVideoOutboundStagingError";
  }
}

function fail(code: string): never {
  throw new LineVideoOutboundStagingError(code);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    fail("r2_not_configured");
  }
  return value;
}

function resolveR2Config(env: NodeJS.ProcessEnv) {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  const endpointRaw = env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    fail("r2_endpoint_invalid");
  }
  if (endpoint.protocol !== "https:") {
    fail("r2_endpoint_invalid");
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
    bucketName: requiredEnv(env, "R2_BUCKET_NAME"),
  };
}

function isMp4(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function isWebm(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

function detectVideoContentType(bytes: Buffer): string {
  if (isMp4(bytes)) {
    return "video/mp4";
  }
  if (isWebm(bytes)) {
    return "video/webm";
  }
  fail("video_type_invalid");
}

export type LineVideoOutboundStagingDependencies = {
  env?: NodeJS.ProcessEnv;
  s3Client?: { send(command: HeadObjectCommand | PutObjectCommand): Promise<unknown> };
  presign?: typeof getSignedUrl;
};

/** Uploads (idempotently, content-addressed) a generated video buffer to R2 and returns a signed URL. */
export async function stageLineOutboundVideo(
  bytes: Buffer,
  dependencies: LineVideoOutboundStagingDependencies = {},
): Promise<StagedLineImage> {
  if (bytes.byteLength === 0) {
    fail("video_size_invalid");
  }
  const env = dependencies.env ?? process.env;
  const config = resolveR2Config(env);
  const contentType = detectVideoContentType(bytes);
  const extension = contentType === "video/webm" ? ".webm" : ".mp4";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `${OUTBOUND_LINE_VIDEO_PREFIX}/sha256/${sha256.slice(0, 2)}/${sha256}${extension}`;

  const client =
    dependencies.s3Client ??
    new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });

  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: objectKey }));
  } catch {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: objectKey,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          IfNoneMatch: "*",
          Metadata: { sha256 },
        }),
      );
    } catch {
      fail("r2_upload_failed");
    }
  }

  const presign = dependencies.presign ?? getSignedUrl;
  try {
    const url = await presign(
      client as S3Client,
      new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
      { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
    );
    return { url, objectKey, contentType, contentLength: bytes.byteLength, sha256 };
  } catch {
    fail("signed_url_generation_failed");
  }
}

/**
 * Stages a minimal solid-color placeholder thumbnail through the existing,
 * already-hardened image staging pipeline (LINE requires every video message
 * to carry a `previewImageUrl`). Reuses `stageLineOutboundImage` unchanged —
 * only the temp-file write is new.
 */
export async function stageLineVideoPreviewImage(
  stageImage: (source: string) => Promise<StagedLineImage> = stageLineOutboundImage,
): Promise<StagedLineImage> {
  // Minimal valid 8x8 black JPEG, embedded so no network call or bundled
  // asset file is needed for the placeholder thumbnail.
  const placeholderJpegBase64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";
  // Write directly under the literal "/tmp" managed root that
  // stageLineOutboundImage's readManagedLocalImage checks containment
  // against — os.tmpdir() is not "/tmp" on every platform (notably macOS,
  // where it resolves under /var/folders), which would otherwise fail that
  // check even though the file is a legitimate short-lived local temp file.
  const tempPath = path.join("/tmp", `line-video-thumb-${Date.now()}-${randomInt(1e9)}.jpg`);
  await fsp.writeFile(tempPath, Buffer.from(placeholderJpegBase64, "base64"));
  try {
    return await stageImage(tempPath);
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
}
