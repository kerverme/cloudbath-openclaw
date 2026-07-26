import { createReadStream } from "node:fs";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { retryableAwsError, withBoundedRetry, type RetryOptions } from "./retry.js";
import type { ArchiveConfig, SafeLogger } from "./types.js";

type S3Command = HeadObjectCommand | PutObjectCommand;
type S3Like = {
  send(command: S3Command): Promise<unknown>;
};

export type EnsureR2ObjectParams = {
  filePath: string;
  bucketName: string;
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
  messageId: string;
};

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

function normalizeMetadataValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "").slice(0, 512);
}

export class R2ArchiveClient {
  private readonly client: S3Like;

  constructor(
    config: ArchiveConfig["r2"],
    private readonly retry: ArchiveConfig["retry"],
    private readonly logger: SafeLogger,
    client?: S3Like,
  ) {
    this.client = (client ??
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      })) as S3Like;
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
    params: EnsureR2ObjectParams,
  ): { kind: "existing"; etag?: string } {
    const storedSha = existing.Metadata?.sha256;
    if (storedSha && storedSha !== params.sha256) {
      throw new Error(`R2 object key conflict for ${params.objectKey}`);
    }
    if (
      typeof existing.ContentLength === "number" &&
      existing.ContentLength !== params.contentLength
    ) {
      throw new Error(`R2 object size conflict for ${params.objectKey}`);
    }
    return { kind: "existing", etag: existing.ETag };
  }

  async ensureObject(
    params: EnsureR2ObjectParams,
  ): Promise<{ kind: "uploaded" | "existing"; etag?: string }> {
    const existing = await this.head(params.bucketName, params.objectKey);
    if (existing) {
      return this.verifyExisting(existing, params);
    }

    try {
      const uploaded = (await withBoundedRetry(
        async () =>
          await this.client.send(
            new PutObjectCommand({
              Bucket: params.bucketName,
              Key: params.objectKey,
              Body: createReadStream(params.filePath),
              ContentLength: params.contentLength,
              ContentType: params.contentType,
              IfNoneMatch: "*",
              Metadata: {
                sha256: normalizeMetadataValue(params.sha256),
                "line-message-id": normalizeMetadataValue(params.messageId),
              },
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
