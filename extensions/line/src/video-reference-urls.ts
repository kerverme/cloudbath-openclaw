/**
 * Signed R2 URLs for the reference images fal's endpoint requires.
 *
 * fal's `Seedance2R2VInput.image_urls` takes fetchable HTTPS URLs, not bytes.
 * The OpenRouter path uploads reference BYTES, so the identity assets the
 * Character Library froze must be published to fal somehow. Two rules shape
 * this module:
 *
 *   - The Character Library is not re-read and not duplicated. Ordering comes
 *     from `orderLineVideoUgcReferences` — the same function the OpenRouter
 *     path uses — so the same scene submits the same characters in the same
 *     positions on either provider.
 *   - The Cloudbath bucket stays private. Each reference gets a SHORT-LIVED
 *     presigned GET; a permanent private R2 URL is never handed out, and the
 *     bucket is never made public.
 *
 * An `https` reference is not passed through as-is: it may be a permanent
 * private URL or an origin fal cannot reach. Its bytes are materialized
 * through the existing guarded reader and re-staged under a temporary R2
 * prefix, then signed like any other object.
 */
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  materializeLineVideoUgcReferences,
  orderLineVideoUgcReferences,
  type LineVideoUgcReferenceDependencies,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";

/**
 * Presigned lifetime for a reference handed to fal.
 *
 * Long enough for fal to fetch every image while the request is being queued,
 * short enough that a leaked URL from a provider-side log expires quickly.
 */
export const REFERENCE_SIGNED_URL_EXPIRY_SECONDS = 30 * 60;
const TEMP_REFERENCE_PREFIX = "outbound/line-video-reference";
const log = createSubsystemLogger("line/video-reference-urls");

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});

type S3Like = { send(command: GetObjectCommand | PutObjectCommand): Promise<unknown> };

export type LineVideoReferenceUrlDependencies = LineVideoUgcReferenceDependencies & {
  s3ClientForSigning?: S3Like;
  presign?: typeof getSignedUrl;
  expirySeconds?: number;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error("R2 reference publishing is not configured");
  }
  return value;
}

function resolveR2Config(env: NodeJS.ProcessEnv) {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  const endpointRaw = env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  const endpoint = new URL(endpointRaw);
  if (endpoint.protocol !== "https:") {
    throw new Error("R2 reference publishing endpoint is invalid");
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    bucketName: requiredEnv(env, "R2_BUCKET_NAME"),
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
  };
}

/** One reference as fal will see it, plus the provenance the caller logs. */
export type LineVideoReferenceUrl = Readonly<{
  /** Position in `image_urls`; also the `@Image<n>` index, which is 1-based. */
  index: number;
  url: string;
  mimeType: string;
  characterCode?: string;
}>;

/**
 * Publishes a scene's ordered references as signed R2 URLs.
 *
 * Content-addressed keys: the same reference bytes reuse the same object
 * across scenes and re-quotes instead of accumulating one temp copy per paid
 * attempt, and the content type stored is the one the magic-byte check in
 * video-ugc-scope.ts derived — not a value taken on trust from a filename.
 */
export async function resolveLineVideoReferenceUrls(
  scope: LineVideoUgcScope,
  dependencies: LineVideoReferenceUrlDependencies = {},
): Promise<LineVideoReferenceUrl[]> {
  const ordered = orderLineVideoUgcReferences(scope);
  if (ordered.length === 0) {
    return [];
  }
  const assets = await materializeLineVideoUgcReferences(scope, dependencies);
  const config = resolveR2Config(dependencies.env ?? process.env);
  const client =
    dependencies.s3ClientForSigning ??
    new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  const presign = dependencies.presign ?? getSignedUrl;
  const expiresIn = dependencies.expirySeconds ?? REFERENCE_SIGNED_URL_EXPIRY_SECONDS;

  const published: LineVideoReferenceUrl[] = [];
  for (const [index, asset] of assets.entries()) {
    const bytes = asset.buffer;
    const mimeType = asset.mimeType;
    if (!bytes || !mimeType) {
      throw new Error("Video reference asset has no materialized bytes");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const extension = MIME_EXTENSIONS[mimeType] ?? "bin";
    const objectKey = `${TEMP_REFERENCE_PREFIX}/${digest}.${extension}`;
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
    const url = await presign(
      client as never,
      new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }) as never,
      { expiresIn },
    );
    const characterCode = asset.metadata?.characterCode;
    published.push(
      Object.freeze({
        index,
        url,
        mimeType,
        ...(typeof characterCode === "string" ? { characterCode } : {}),
      }),
    );
  }
  // Diagnostics carry position, character and content type only. The signed
  // query string is the credential here, so no URL is ever logged.
  log.info("fal video references published", {
    correlationId: dependencies.correlationId,
    expirySeconds: expiresIn,
    references: published.map((reference) => ({
      index: reference.index,
      mimeType: reference.mimeType,
      characterCode: reference.characterCode,
    })),
  });
  return published;
}
