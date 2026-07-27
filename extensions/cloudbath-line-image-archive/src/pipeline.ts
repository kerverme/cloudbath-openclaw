import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildContentAddressedObjectKey, detectCanonicalImageExtension } from "./r2.js";
import type {
  AgentProfile,
  ArchiveConfig,
  AsyncKeyedStore,
  BusinessRecordMetadata,
  ExtractedFields,
  InboundImageJob,
  NotionWriteResult,
  PersistedArchiveRecord,
  ProcessingStatus,
  SafeLogger,
  SchemaProfile,
} from "./types.js";

type R2ClientLike = {
  ensureObject(params: {
    filePath: string;
    bucketName: string;
    objectKey: string;
    contentType: string;
    contentLength: number;
    sha256: string;
  }): Promise<{ kind: "uploaded" | "existing"; etag?: string }>;
};

type NotionClientLike = {
  createRecord(metadata: BusinessRecordMetadata): Promise<NotionWriteResult>;
};

export type ArchivePipelineDependencies = {
  config: ArchiveConfig;
  stateDir: string;
  store: AsyncKeyedStore<PersistedArchiveRecord>;
  r2: R2ClientLike;
  notion: NotionClientLike;
  logger: SafeLogger;
  extract?: (
    job: InboundImageJob,
    filePath: string,
    agentProfile: AgentProfile,
    schemaProfile: SchemaProfile,
  ) => Promise<ExtractedFields>;
  sendAcknowledgement?: (job: InboundImageJob, text: string) => Promise<void>;
};

function archiveRecordKey(job: InboundImageJob, agentProfileId: string): string {
  return crypto
    .createHash("sha256")
    .update(
      `${job.accountId ?? "default"}\0${agentProfileId}\0${job.groupId}\0${job.messageId}`,
      "utf8",
    )
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
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function canonicalIdentityValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    throw new Error("Record identity property is missing");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify([...value].map(canonicalIdentityValue).toSorted());
  }
  throw new Error("Record identity property must be a scalar or array");
}

function resolveRecordIdentity(params: {
  agentProfile: AgentProfile;
  schemaProfile: SchemaProfile;
  sha256: string;
  extractedFields?: ExtractedFields;
}): string {
  const rule = params.agentProfile.recordIdentityRule ?? params.schemaProfile.recordIdentityRule;
  if (rule.kind === "agent-profile-plus-sha256") {
    return `${params.agentProfile.id}:${params.sha256}`;
  }
  const parts = rule.propertyIds.map((propertyId) =>
    canonicalIdentityValue(params.extractedFields?.values[propertyId]),
  );
  const digest = crypto
    .createHash("sha256")
    .update(`${params.agentProfile.id}\0${parts.join("\0")}`, "utf8")
    .digest("hex");
  return `${params.agentProfile.id}:${digest}`;
}

function acknowledgementFor(status: ProcessingStatus): string {
  switch (status) {
    case "PROCESSED":
      return "Image archived successfully.";
    case "DUPLICATE":
      return "Image was already archived for this agent.";
    case "NEED_REVIEW":
      return "Image archived, but its business record needs review.";
    case "ERROR":
      return "Sorry, the image could not be archived.";
    case "NEW":
      return "Image archive processing started.";
  }
  throw new Error("Unsupported processing status");
}

export class ArchivePipeline {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ArchivePipelineDependencies) {}

  private async persist(record: PersistedArchiveRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.deps.store.register(record.key, record);
  }

  private schedule(
    record: PersistedArchiveRecord,
    agentProfile: AgentProfile,
    schemaProfile: SchemaProfile,
    acknowledge: boolean,
  ): void {
    const work = this.tail.then(async () => {
      await this.process(record, agentProfile, schemaProfile, acknowledge);
    });
    this.tail = work.catch((error: unknown) => {
      this.deps.logger.error("archive_worker_failed", {
        agentProfileId: agentProfile.id,
        messageId: record.job.messageId,
        groupId: record.job.groupId,
        error: safeErrorMessage(error),
      });
    });
  }

  async enqueue(
    job: InboundImageJob,
    agentProfile: AgentProfile,
    schemaProfile: SchemaProfile,
  ): Promise<"queued" | "duplicate"> {
    const key = archiveRecordKey(job, agentProfile.id);
    const record: PersistedArchiveRecord = {
      key,
      job,
      agentProfileId: agentProfile.id,
      schemaProfileId: schemaProfile.id,
      schemaVersion: schemaProfile.version,
      status: "NEW",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    if (!(await this.deps.store.registerIfAbsent(key, record))) {
      this.deps.logger.info("archive_duplicate_event", {
        agentProfileId: agentProfile.id,
        messageId: job.messageId,
        groupId: job.groupId,
      });
      return "duplicate";
    }
    this.schedule(record, agentProfile, schemaProfile, true);
    return "queued";
  }

  async recoverIncomplete(): Promise<number> {
    const recoverable = (await this.deps.store.entries())
      .map((entry) => entry.value)
      .filter(
        (record) =>
          (record.status === "NEW" || (record.status === "NEED_REVIEW" && !record.notionPageId)) &&
          record.attempts < this.deps.config.retry.maxAttempts,
      );
    let scheduled = 0;
    for (const record of recoverable) {
      const agentProfile = this.deps.config.profiles.agentProfiles.find(
        (profile) => profile.id === record.agentProfileId && profile.active,
      );
      const schemaProfile = this.deps.config.profiles.schemasByKey.get(
        `${record.schemaProfileId}@${record.schemaVersion}`,
      );
      if (!agentProfile || !schemaProfile) {
        this.deps.logger.error("archive_recovery_profile_missing", {
          agentProfileId: record.agentProfileId,
          schemaProfileId: record.schemaProfileId,
          schemaVersion: record.schemaVersion,
        });
        continue;
      }
      this.schedule(record, agentProfile, schemaProfile, false);
      scheduled += 1;
    }
    return scheduled;
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }

  private async acknowledge(
    record: PersistedArchiveRecord,
    agentProfile: AgentProfile,
    enabled: boolean,
  ): Promise<void> {
    if (
      !enabled ||
      !agentProfile.archiveAcknowledgementsEnabled ||
      !this.deps.sendAcknowledgement
    ) {
      return;
    }
    try {
      await this.deps.sendAcknowledgement(record.job, acknowledgementFor(record.status));
    } catch (error) {
      this.deps.logger.warn("line_acknowledgement_failed", {
        agentProfileId: agentProfile.id,
        messageId: record.job.messageId,
        error: safeErrorMessage(error),
      });
    }
  }

  private async process(
    record: PersistedArchiveRecord,
    agentProfile: AgentProfile,
    schemaProfile: SchemaProfile,
    acknowledge: boolean,
  ): Promise<void> {
    record.attempts += 1;
    await this.persist(record);
    let extractionError: string | undefined;
    try {
      let mediaFile: { path: string; size: number } | undefined;
      if (
        !record.sha256 ||
        !record.objectKey ||
        !record.fileSize ||
        !record.canonicalExtension
      ) {
        mediaFile = await resolveSafeMediaFile({
          filePath: record.job.mediaPath,
          stateDir: this.deps.stateDir,
          maxBytes: this.deps.config.imageMaxBytes,
        });
        record.fileSize = mediaFile.size;
        record.sha256 = await sha256File(mediaFile.path);
        record.canonicalExtension = await detectCanonicalImageExtension(mediaFile.path);
        record.objectKey = buildContentAddressedObjectKey({
          keyPrefix: this.deps.config.r2.keyPrefix,
          sha256: record.sha256,
          extension: record.canonicalExtension,
        });
        await this.persist(record);
      }
      if (
        !record.sha256 ||
        !record.objectKey ||
        !record.fileSize ||
        !record.canonicalExtension
      ) {
        throw new Error("Archive state is missing content-addressed asset metadata");
      }
      if (!mediaFile) {
        mediaFile = await resolveSafeMediaFile({
          filePath: record.job.mediaPath,
          stateDir: this.deps.stateDir,
          maxBytes: this.deps.config.imageMaxBytes,
        }).catch(() => undefined);
      }
      await this.deps.r2.ensureObject({
        filePath: mediaFile?.path ?? record.job.mediaPath,
        bucketName: this.deps.config.r2.bucketName,
        objectKey: record.objectKey,
        contentType: record.job.mimeType,
        contentLength: record.fileSize,
        sha256: record.sha256,
      });

      if (
        this.deps.config.analysisEnabled &&
        this.deps.extract &&
        !record.extractedFields &&
        mediaFile &&
        agentProfile.allowedTools.includes("extract-schema-fields")
      ) {
        try {
          record.extractedFields = await this.deps.extract(
            record.job,
            mediaFile.path,
            agentProfile,
            schemaProfile,
          );
          await this.persist(record);
        } catch (error) {
          extractionError = `Schema extraction failed: ${safeErrorMessage(error)}`;
          this.deps.logger.warn("schema_extraction_failed", {
            agentProfileId: agentProfile.id,
            messageId: record.job.messageId,
            error: safeErrorMessage(error),
          });
        }
      } else if (
        this.deps.config.analysisEnabled &&
        agentProfile.allowedTools.includes("extract-schema-fields") &&
        !record.extractedFields &&
        !mediaFile
      ) {
        extractionError = "Schema extraction failed: source media is no longer available";
      } else if (
        (!this.deps.config.analysisEnabled ||
          !agentProfile.allowedTools.includes("extract-schema-fields")) &&
        schemaProfile.properties.some(
          (property) => property.required && !property.systemFieldRole,
        )
      ) {
        extractionError = "Schema extraction is disabled";
      }

      record.recordIdentity = resolveRecordIdentity({
        agentProfile,
        schemaProfile,
        sha256: record.sha256,
        extractedFields: record.extractedFields,
      });
      const metadata: BusinessRecordMetadata = {
        agentProfile,
        schemaProfile,
        recordIdentity: record.recordIdentity,
        asset: {
          sha256: record.sha256,
          r2ObjectKey: record.objectKey,
          canonicalExtension: record.canonicalExtension,
          fileSize: record.fileSize,
          mimeType: record.job.mimeType,
        },
        job: record.job,
        extractedFields: record.extractedFields,
        status: extractionError ? "NEED_REVIEW" : "PROCESSED",
        error: extractionError,
      };
      let notionResult: NotionWriteResult;
      try {
        notionResult = await this.deps.notion.createRecord(metadata);
      } catch (error) {
        record.status = "NEED_REVIEW";
        record.error = `Notion business record failed: ${safeErrorMessage(error)}`;
        await this.persist(record);
        this.deps.logger.error("notion_archive_failed", {
          agentProfileId: agentProfile.id,
          messageId: record.job.messageId,
          objectKey: record.objectKey,
          error: safeErrorMessage(error),
        });
        await this.acknowledge(record, agentProfile, acknowledge);
        return;
      }
      record.notionPageId = notionResult.pageId;
      record.status = notionResult.kind === "duplicate" ? "DUPLICATE" : metadata.status;
      record.error = extractionError;
      await this.persist(record);
      this.deps.logger.info("archive_processed", {
        agentProfileId: agentProfile.id,
        schemaProfileId: schemaProfile.id,
        messageId: record.job.messageId,
        objectKey: record.objectKey,
        status: record.status,
        fileSize: record.fileSize,
      });
    } catch (error) {
      record.status = "ERROR";
      record.error = safeErrorMessage(error);
      await this.persist(record);
      this.deps.logger.error("archive_failed", {
        agentProfileId: agentProfile.id,
        messageId: record.job.messageId,
        error: record.error,
      });
    }
    await this.acknowledge(record, agentProfile, acknowledge);
  }
}

export {
  acknowledgementFor,
  archiveRecordKey,
  resolveRecordIdentity,
  resolveSafeMediaFile,
  safeErrorMessage,
  sha256File,
};
