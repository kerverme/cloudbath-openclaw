import crypto, { type BinaryLike } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import type {
  ArchiveConfig,
  ArchiveMetadata,
  AsyncKeyedStore,
  ImageAnalysis,
  InboundImageJob,
  NotionWriteResult,
  PersistedArchiveRecord,
  ProcessingStatus,
  SafeLogger,
} from "./types.js";

type R2ClientLike = {
  ensureObject(params: {
    filePath: string;
    bucketName: string;
    objectKey: string;
    contentType: string;
    contentLength: number;
    sha256: string;
    messageId: string;
  }): Promise<{ kind: "uploaded" | "existing"; etag?: string }>;
};

type NotionClientLike = {
  createRecord(metadata: ArchiveMetadata): Promise<NotionWriteResult>;
};

export type ArchivePipelineDependencies = {
  config: ArchiveConfig;
  stateDir: string;
  store: AsyncKeyedStore<PersistedArchiveRecord>;
  r2: R2ClientLike;
  notion: NotionClientLike;
  logger: SafeLogger;
  analyze?: (job: InboundImageJob, filePath: string) => Promise<ImageAnalysis>;
  sendAcknowledgement?: (job: InboundImageJob, text: string) => Promise<void>;
};

function sanitizePathComponent(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .slice(0, 128);
  return sanitized || fallback;
}

function archiveRecordKey(job: InboundImageJob): string {
  return crypto
    .createHash("sha256")
    .update(`${job.accountId ?? "default"}\0${job.groupId}\0${job.messageId}`, "utf8")
    .digest("hex");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 1_000) || "Unknown processing error"
  );
}

function buildObjectDetails(
  config: ArchiveConfig,
  job: InboundImageJob,
): { objectKey: string; originalFilename: string } {
  const received = new Date(job.receivedAt);
  if (Number.isNaN(received.getTime())) {
    throw new Error("Invalid LINE message timestamp");
  }
  const extension = extensionForMime(job.mimeType) || ".bin";
  const safeExtension = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : ".bin";
  const group = sanitizePathComponent(job.groupId, "unknown-group");
  const message = sanitizePathComponent(job.messageId, "unknown-message");
  const datePath = [
    received.getUTCFullYear().toString().padStart(4, "0"),
    (received.getUTCMonth() + 1).toString().padStart(2, "0"),
    received.getUTCDate().toString().padStart(2, "0"),
  ].join("/");
  const filename = `${message}-original${safeExtension}`;
  const archivePath = `line/${datePath}/${group}/${filename}`;
  return {
    objectKey: config.r2.keyPrefix
      ? `${config.r2.keyPrefix.replace(/\/+$/, "")}/${archivePath}`
      : archivePath,
    originalFilename: filename,
  };
}

async function resolveSafeMediaFile(params: {
  filePath: string;
  stateDir: string;
  maxBytes: number;
}): Promise<{ path: string; size: number }> {
  const inboundRoot = await fsp.realpath(path.join(params.stateDir, "media", "inbound"));
  const resolvedFile = await fsp.realpath(params.filePath);
  const relative = path.relative(inboundRoot, resolvedFile);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error("Inbound image path is outside the managed media directory");
  }
  const stat = await fsp.stat(resolvedFile);
  if (!stat.isFile()) {
    throw new Error("Inbound image path is not a regular file");
  }
  if (stat.size <= 0) {
    throw new Error("Inbound image is empty");
  }
  if (stat.size > params.maxBytes) {
    throw new Error(
      `Inbound image exceeds IMAGE_MAX_MB (${Math.ceil(params.maxBytes / 1024 / 1024)} MB)`,
    );
  }
  return { path: resolvedFile, size: stat.size };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as BinaryLike));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function acknowledgementFor(status: ProcessingStatus): string {
  switch (status) {
    case "PROCESSED":
      return "Image archived successfully.";
    case "DUPLICATE":
      return "Image was already archived.";
    case "NEED_REVIEW":
      return "Image archived, but its metadata needs review.";
    case "ERROR":
      return "Sorry, the image could not be archived.";
    case "NEW":
      return "Image archive processing started.";
  }
}

export class ArchivePipeline {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ArchivePipelineDependencies) {}

  private async persist(record: PersistedArchiveRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.deps.store.register(record.key, record);
  }

  private schedule(record: PersistedArchiveRecord, acknowledge: boolean): void {
    const work = this.tail.then(async () => {
      await this.process(record, acknowledge);
    });
    this.tail = work.catch((error) => {
      this.deps.logger.error("archive_worker_failed", {
        messageId: record.job.messageId,
        groupId: record.job.groupId,
        error: safeErrorMessage(error),
      });
    });
  }

  async enqueue(job: InboundImageJob): Promise<"queued" | "duplicate"> {
    const key = archiveRecordKey(job);
    const record: PersistedArchiveRecord = {
      key,
      job,
      status: "NEW",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    const registered = await this.deps.store.registerIfAbsent(key, record);
    if (!registered) {
      this.deps.logger.info("archive_duplicate_event", {
        messageId: job.messageId,
        groupId: job.groupId,
      });
      return "duplicate";
    }
    this.schedule(record, true);
    return "queued";
  }

  async recoverIncomplete(): Promise<number> {
    const entries = await this.deps.store.entries();
    const recoverable = entries
      .map((entry) => entry.value)
      .filter(
        (record) =>
          (record.status === "NEW" || (record.status === "NEED_REVIEW" && !record.notionPageId)) &&
          record.attempts < this.deps.config.retry.maxAttempts,
      );
    for (const record of recoverable) {
      this.schedule(record, false);
    }
    return recoverable.length;
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }

  private async sendAcknowledgement(
    record: PersistedArchiveRecord,
    acknowledge: boolean,
  ): Promise<void> {
    if (!acknowledge || !this.deps.sendAcknowledgement) {
      return;
    }
    try {
      await this.deps.sendAcknowledgement(record.job, acknowledgementFor(record.status));
    } catch (error) {
      this.deps.logger.warn("line_acknowledgement_failed", {
        messageId: record.job.messageId,
        groupId: record.job.groupId,
        error: safeErrorMessage(error),
      });
    }
  }

  private async process(record: PersistedArchiveRecord, acknowledge: boolean): Promise<void> {
    record.attempts += 1;
    await this.persist(record);
    let analysisError: string | undefined;

    try {
      let mediaFile: { path: string; size: number } | undefined;
      if (!record.sha256 || !record.objectKey || !record.fileSize || !record.originalFilename) {
        mediaFile = await resolveSafeMediaFile({
          filePath: record.job.mediaPath,
          stateDir: this.deps.stateDir,
          maxBytes: this.deps.config.imageMaxBytes,
        });
        const object = buildObjectDetails(this.deps.config, record.job);
        record.fileSize = mediaFile.size;
        record.sha256 = await sha256File(mediaFile.path);
        record.objectKey = object.objectKey;
        record.originalFilename = object.originalFilename;
        await this.persist(record);
      }

      if (!record.sha256 || !record.objectKey || !record.fileSize || !record.originalFilename) {
        throw new Error("Archive state is missing required object metadata");
      }

      if (!mediaFile) {
        try {
          mediaFile = await resolveSafeMediaFile({
            filePath: record.job.mediaPath,
            stateDir: this.deps.stateDir,
            maxBytes: this.deps.config.imageMaxBytes,
          });
        } catch (error) {
          this.deps.logger.warn("recovery_media_unavailable", {
            messageId: record.job.messageId,
            groupId: record.job.groupId,
            error: safeErrorMessage(error),
          });
        }
      }
      await this.deps.r2.ensureObject({
        filePath: mediaFile?.path ?? record.job.mediaPath,
        bucketName: this.deps.config.r2.bucketName,
        objectKey: record.objectKey,
        contentType: record.job.mimeType,
        contentLength: record.fileSize,
        sha256: record.sha256,
        messageId: record.job.messageId,
      });

      if (this.deps.config.analysisEnabled && this.deps.analyze && !record.analysis && mediaFile) {
        try {
          record.analysis = await this.deps.analyze(record.job, mediaFile.path);
        } catch (error) {
          analysisError = `Image analysis failed: ${safeErrorMessage(error)}`;
          this.deps.logger.warn("image_analysis_failed", {
            messageId: record.job.messageId,
            groupId: record.job.groupId,
            error: safeErrorMessage(error),
          });
        }
      } else if (this.deps.config.analysisEnabled && !record.analysis && !mediaFile) {
        analysisError = "Image analysis failed: source media is no longer available";
      }

      const metadata: ArchiveMetadata = {
        receivedAt: record.job.receivedAt,
        lineMessageId: record.job.messageId,
        lineWebhookEventId: record.job.webhookEventId,
        lineGroupId: record.job.groupId,
        lineUserId: record.job.userId,
        senderName: record.job.senderName,
        originalFilename: record.originalFilename,
        mimeType: record.job.mimeType,
        fileSize: record.fileSize,
        sha256: record.sha256,
        r2ObjectKey: record.objectKey,
        analysis: record.analysis,
        status: analysisError ? "NEED_REVIEW" : "PROCESSED",
        error: analysisError,
      };

      let notionResult: NotionWriteResult;
      try {
        notionResult = await this.deps.notion.createRecord(metadata);
      } catch (error) {
        record.status = "NEED_REVIEW";
        record.error = `Notion metadata failed: ${safeErrorMessage(error)}`;
        await this.persist(record);
        this.deps.logger.error("notion_archive_failed", {
          messageId: record.job.messageId,
          groupId: record.job.groupId,
          objectKey: record.objectKey,
          error: safeErrorMessage(error),
        });
        await this.sendAcknowledgement(record, acknowledge);
        return;
      }

      record.notionPageId = notionResult.pageId;
      record.status = notionResult.kind === "duplicate" ? "DUPLICATE" : metadata.status;
      record.error = analysisError;
      await this.persist(record);
      this.deps.logger.info("archive_processed", {
        messageId: record.job.messageId,
        groupId: record.job.groupId,
        objectKey: record.objectKey,
        status: record.status,
        fileSize: record.fileSize,
      });
    } catch (error) {
      record.status = "ERROR";
      record.error = safeErrorMessage(error);
      await this.persist(record);
      this.deps.logger.error("archive_failed", {
        messageId: record.job.messageId,
        groupId: record.job.groupId,
        error: record.error,
      });
    }

    await this.sendAcknowledgement(record, acknowledge);
  }
}

export {
  acknowledgementFor,
  archiveRecordKey,
  buildObjectDetails,
  resolveSafeMediaFile,
  safeErrorMessage,
  sha256File,
};
