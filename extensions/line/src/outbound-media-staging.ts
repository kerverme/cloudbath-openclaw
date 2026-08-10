// Line plugin module stages every outbound image in the configured private R2 bucket.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

const OUTBOUND_LINE_PREFIX = "outbound/line";
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;
const DEFAULT_MAX_IMAGE_MB = 10;
const MAX_MAX_IMAGE_MB = 100;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SIGNED_URL_LENGTH = 2_000;
const LOCAL_MEDIA_ROOTS = ["/tmp", "/data"] as const;
const OUTBOUND_FETCH_POLICY: SsrFPolicy = { allowPrivateNetwork: false };

type S3Command = HeadObjectCommand | PutObjectCommand;
type S3Like = { send(command: S3Command): Promise<unknown> };
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
type GuardedFetchLike = (
  params: Parameters<typeof fetchWithSsrFGuard>[0],
) => Promise<GuardedFetchResult>;
type PresignLike = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

type ImageDescriptor = {
  contentType: string;
  extension: string;
};

export type StagedLineImage = {
  url: string;
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
};

export type LineOutboundImageStagingDependencies = {
  env?: NodeJS.ProcessEnv;
  s3Client?: S3Like;
  presign?: PresignLike;
  guardedFetch?: GuardedFetchLike;
  readLocalFile?: (filePath: string, maxBytes: number) => Promise<Uint8Array>;
};

type OutboundMessage = {
  type: string;
  originalContentUrl?: string;
  previewImageUrl?: string;
};

export class LineOutboundImageStagingError extends Error {
  constructor(readonly code: string) {
    super(`LINE outbound image staging failed (${code})`);
    this.name = "LineOutboundImageStagingError";
  }
}

function fail(code: string): never {
  throw new LineOutboundImageStagingError(code);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    fail("r2_not_configured");
  }
  return value;
}

function resolveMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.IMAGE_MAX_MB?.trim();
  if (!raw) {
    return DEFAULT_MAX_IMAGE_MB * 1024 * 1024;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_MAX_IMAGE_MB) {
    fail("image_size_limit_invalid");
  }
  return Math.floor(parsed * 1024 * 1024);
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
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
    bucketName: requiredEnv(env, "R2_BUCKET_NAME"),
  };
}

function imageDescriptor(bytes: Uint8Array): ImageDescriptor | undefined {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", extension: ".png" };
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }
  if (
    header.subarray(0, 6).toString("ascii") === "GIF87a" ||
    header.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return { contentType: "image/gif", extension: ".gif" };
  }
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: ".webp" };
  }
  if (header.subarray(0, 2).toString("ascii") === "BM") {
    return { contentType: "image/bmp", extension: ".bmp" };
  }
  if (header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") {
      return { contentType: "image/avif", extension: ".avif" };
    }
  }
  return undefined;
}

function normalizeMime(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function validateImageBytes(
  bytes: Uint8Array,
  maxBytes: number,
  declaredContentType?: string | null,
): ImageDescriptor {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    fail("image_size_invalid");
  }
  const descriptor = imageDescriptor(bytes);
  if (!descriptor) {
    fail("image_type_invalid");
  }
  if (declaredContentType !== undefined) {
    const declared = normalizeMime(declaredContentType);
    if (!declared.startsWith("image/") || declared === "image/svg+xml") {
      fail("image_content_type_invalid");
    }
    const compatible =
      declared === descriptor.contentType ||
      (descriptor.contentType === "image/jpeg" && declared === "image/jpg");
    if (!compatible) {
      fail("image_content_type_mismatch");
    }
  }
  return descriptor;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readManagedLocalImage(filePath: string, maxBytes: number): Promise<Uint8Array> {
  let resolvedInput: string;
  try {
    resolvedInput = filePath.startsWith("file:") ? fileURLToPath(filePath) : filePath;
  } catch {
    fail("local_path_invalid");
  }
  if (!path.isAbsolute(resolvedInput)) {
    fail("local_path_invalid");
  }
  let realPath: string;
  try {
    realPath = await fsp.realpath(resolvedInput);
  } catch {
    fail("local_file_unavailable");
  }
  if (!LOCAL_MEDIA_ROOTS.some((root) => isContainedPath(root, realPath))) {
    fail("local_path_outside_managed_roots");
  }

  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    handle = await fsp.open(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail("local_file_unavailable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail("local_file_invalid");
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      fail("image_size_invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      fail("local_file_changed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    fail("image_size_invalid");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      fail("image_size_invalid");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        fail("image_size_invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isHttpsSource(source: string): boolean {
  try {
    return new URL(source).protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchExternalImage(
  source: string,
  maxBytes: number,
  guardedFetch: GuardedFetchLike,
): Promise<{ bytes: Uint8Array; descriptor: ImageDescriptor }> {
  if (!isHttpsSource(source)) {
    fail("source_invalid");
  }
  let guarded: GuardedFetchResult;
  try {
    guarded = await guardedFetch({
      url: source,
      requireHttps: true,
      maxRedirects: 3,
      timeoutMs: FETCH_TIMEOUT_MS,
      policy: OUTBOUND_FETCH_POLICY,
      auditContext: "line-outbound-image-source",
    });
  } catch {
    fail("source_fetch_failed");
  }
  try {
    if (guarded.response.status !== 200) {
      fail("source_http_status_invalid");
    }
    const bytes = await readResponseBytes(guarded.response, maxBytes);
    return {
      bytes,
      descriptor: validateImageBytes(bytes, maxBytes, guarded.response.headers.get("content-type")),
    };
  } finally {
    await guarded.release();
  }
}

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object"
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
}

function errorName(error: unknown): string {
  return error && typeof error === "object" ? ((error as { name?: string }).name ?? "") : "";
}

function isNotFound(error: unknown): boolean {
  return httpStatus(error) === 404 || ["NotFound", "NoSuchKey"].includes(errorName(error));
}

function isPreconditionFailed(error: unknown): boolean {
  return httpStatus(error) === 412 || errorName(error) === "PreconditionFailed";
}

function verifyHead(
  head: HeadObjectCommandOutput,
  expected: { sha256: string; contentLength: number; contentType: string },
): void {
  if (
    head.Metadata?.sha256 !== expected.sha256 ||
    head.ContentLength !== expected.contentLength ||
    normalizeMime(head.ContentType ?? null) !== expected.contentType
  ) {
    fail("r2_object_conflict");
  }
}

async function ensureR2Image(
  client: S3Like,
  bucketName: string,
  objectKey: string,
  bytes: Uint8Array,
  descriptor: ImageDescriptor,
  sha256: string,
): Promise<void> {
  const expected = {
    sha256,
    contentLength: bytes.byteLength,
    contentType: descriptor.contentType,
  };
  try {
    const head = (await client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }),
    )) as HeadObjectCommandOutput;
    verifyHead(head, expected);
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      if (error instanceof LineOutboundImageStagingError) {
        throw error;
      }
      fail("r2_head_failed");
    }
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: descriptor.contentType,
        IfNoneMatch: "*",
        Metadata: { sha256 },
      }),
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) {
      fail("r2_upload_failed");
    }
    try {
      const raced = (await client.send(
        new HeadObjectCommand({ Bucket: bucketName, Key: objectKey }),
      )) as HeadObjectCommandOutput;
      verifyHead(raced, expected);
    } catch (headError) {
      if (headError instanceof LineOutboundImageStagingError) {
        throw headError;
      }
      fail("r2_upload_race_invalid");
    }
  }
}

async function verifyStagedUrl(
  url: string,
  expected: {
    sha256: string;
    contentLength: number;
    contentType: string;
    maxBytes: number;
  },
  guardedFetch: GuardedFetchLike,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail("signed_url_invalid");
  }
  if (parsed.protocol !== "https:" || url.length > MAX_SIGNED_URL_LENGTH) {
    fail("signed_url_invalid");
  }

  let guarded: GuardedFetchResult;
  try {
    guarded = await guardedFetch({
      url,
      requireHttps: true,
      maxRedirects: 0,
      timeoutMs: FETCH_TIMEOUT_MS,
      policy: OUTBOUND_FETCH_POLICY,
      auditContext: "line-outbound-r2-verification",
    });
  } catch {
    fail("signed_url_fetch_failed");
  }
  try {
    if (guarded.response.status !== 200) {
      fail("signed_url_http_status_invalid");
    }
    const contentType = normalizeMime(guarded.response.headers.get("content-type"));
    if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
      fail("signed_url_content_type_invalid");
    }
    const bytes = await readResponseBytes(guarded.response, expected.maxBytes);
    const descriptor = validateImageBytes(bytes, expected.maxBytes, contentType);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      descriptor.contentType !== expected.contentType ||
      bytes.byteLength !== expected.contentLength ||
      sha256 !== expected.sha256
    ) {
      fail("signed_url_content_mismatch");
    }
  } finally {
    await guarded.release();
  }
}

export async function stageLineOutboundImage(
  rawSource: string,
  dependencies: LineOutboundImageStagingDependencies = {},
): Promise<StagedLineImage> {
  try {
    const source = rawSource.trim();
    if (!source) {
      fail("source_invalid");
    }
    const env = dependencies.env ?? process.env;
    const maxBytes = resolveMaxBytes(env);
    const config = resolveR2Config(env);
    const guardedFetch = dependencies.guardedFetch ?? fetchWithSsrFGuard;
    const localSource = source.startsWith("/") || source.startsWith("file:");
    const bytes = localSource
      ? await (dependencies.readLocalFile ?? readManagedLocalImage)(source, maxBytes)
      : (await fetchExternalImage(source, maxBytes, guardedFetch)).bytes;
    const descriptor = validateImageBytes(bytes, maxBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `${OUTBOUND_LINE_PREFIX}/sha256/${sha256.slice(0, 2)}/${sha256}${descriptor.extension}`;
    const concreteClient =
      dependencies.s3Client ??
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    await ensureR2Image(concreteClient, config.bucketName, objectKey, bytes, descriptor, sha256);
    const presign = dependencies.presign ?? getSignedUrl;
    let url: string;
    try {
      url = await presign(
        concreteClient as S3Client,
        new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
        { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
      );
    } catch {
      fail("signed_url_generation_failed");
    }
    await verifyStagedUrl(
      url,
      {
        sha256,
        contentLength: bytes.byteLength,
        contentType: descriptor.contentType,
        maxBytes,
      },
      guardedFetch,
    );
    return {
      url,
      objectKey,
      contentType: descriptor.contentType,
      contentLength: bytes.byteLength,
      sha256,
    };
  } catch (error) {
    if (error instanceof LineOutboundImageStagingError) {
      throw error;
    }
    return fail("unexpected_error");
  }
}

export async function stageLineOutboundMessageImages<T extends OutboundMessage>(
  messages: readonly T[],
  stage: (source: string) => Promise<StagedLineImage> = stageLineOutboundImage,
): Promise<T[]> {
  const stagedBySource = new Map<string, Promise<StagedLineImage>>();
  const stageOnce = async (source: string): Promise<string> => {
    const normalized = source.trim();
    if (!normalized) {
      fail("source_invalid");
    }
    let pending = stagedBySource.get(normalized);
    if (!pending) {
      pending = stage(normalized);
      stagedBySource.set(normalized, pending);
    }
    return (await pending).url;
  };

  const staged: T[] = [];
  for (const message of messages) {
    if (message.type === "image") {
      const original = message.originalContentUrl;
      if (typeof original !== "string") {
        fail("source_invalid");
      }
      const preview =
        typeof message.previewImageUrl === "string" ? message.previewImageUrl : original;
      staged.push({
        ...message,
        originalContentUrl: await stageOnce(original),
        previewImageUrl: await stageOnce(preview),
      } as T);
      continue;
    }
    if (message.type === "video" && typeof message.previewImageUrl === "string") {
      staged.push({
        ...message,
        previewImageUrl: await stageOnce(message.previewImageUrl),
      } as T);
      continue;
    }
    staged.push(message);
  }
  return staged;
}
