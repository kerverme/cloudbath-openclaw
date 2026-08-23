import crypto from "node:crypto";
import { freezeWorkspaceJobScope } from "./group-workspace-policy.js";
import { NOTION_API_VERSION, type NotionPropertyDefinition } from "./notion-schema.js";
import { readSafeMediaFile } from "./pipeline.js";
import { buildContentAddressedObjectKey, detectCanonicalImageExtensionFromBytes } from "./r2.js";
import { isRetryableStatus, withBoundedRetry } from "./retry.js";
import type {
  ArchiveConfig,
  AsyncKeyedStore,
  InboundImageJob,
  KeepWatchingJobRecord,
  NotionTarget,
  SafeLogger,
  WorkspacePolicyConfig,
} from "./types.js";

const NOTION_BASE_URL = "https://api.notion.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 1_900;

type R2Like = {
  ensureObject(params: {
    body: Uint8Array;
    bucketName: string;
    objectKey: string;
    contentType: string;
    contentLength: number;
    sha256: string;
  }): Promise<{ kind: "uploaded" | "existing"; etag?: string }>;
};

type KeepWatchingNotionLike = {
  createRecord(params: {
    target: NotionTarget;
    recordId: string;
    job: InboundImageJob;
    sha256: string;
    objectKey: string;
    fileSize: number;
  }): Promise<{ pageId: string; duplicate: boolean }>;
};

type NotionDatabaseResponse = { data_sources?: Array<{ id?: string }> };
type NotionDataSourceResponse = { properties?: Record<string, NotionPropertyDefinition> };
type NotionQueryResponse = { results?: Array<{ id?: string }> };
type NotionPageResponse = { id?: string };

const REQUIRED_PROPERTIES = {
  Name: "title",
  "Captured At": "date",
  Source: "rich_text",
  Sender: "rich_text",
  "Media Type": "rich_text",
  "File Size": "number",
  "R2 Object Key": "rich_text",
  "SHA-256": "rich_text",
  Status: "select",
  "Record ID": "rich_text",
} as const;

function safeText(value: string | undefined): string {
  return (value?.trim() ?? "").slice(0, MAX_TEXT_LENGTH);
}

function richText(content: string | undefined): Record<string, unknown> {
  const value = safeText(content);
  return value ? { rich_text: [{ type: "text", text: { content: value } }] } : { rich_text: [] };
}

function safeError(_error: unknown): string {
  return "Workspace ingest operation failed";
}

export class KeepWatchingNotionWriter {
  private readonly validatedTargets = new Map<string, Promise<void>>();

  constructor(
    private readonly token: string,
    private readonly retry: ArchiveConfig["retry"],
    private readonly logger: SafeLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return await withBoundedRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        headers.set("Notion-Version", NOTION_API_VERSION);
        headers.set("Authorization", `Bearer ${this.token}`);
        try {
          const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
            ...init,
            signal: controller.signal,
            headers,
          });
          if (!response.ok) {
            throw Object.assign(new Error(`Notion request failed (${response.status})`), {
              status: response.status,
            });
          }
          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        ...this.retry,
        isRetryable: (error) =>
          isRetryableStatus(
            typeof error === "object" && error !== null && "status" in error
              ? Number((error as { status: unknown }).status)
              : 500,
          ),
        onRetry: (_error, attempt, delayMs) =>
          this.logger.warn("keep_watching_notion_retry", { attempt, delayMs }),
      },
    );
  }

  private async validateTarget(target: NotionTarget): Promise<void> {
    const key = `${target.databaseId}\0${target.dataSourceId}`;
    let pending = this.validatedTargets.get(key);
    if (!pending) {
      pending = (async () => {
        const database = await this.request<NotionDatabaseResponse>(
          `/v1/databases/${encodeURIComponent(target.databaseId)}`,
        );
        const dataSourceIds = (database.data_sources ?? [])
          .map((item) => item.id?.replace(/-/g, "").toLowerCase())
          .filter((id): id is string => Boolean(id));
        if (!dataSourceIds.includes(target.dataSourceId)) {
          throw new Error("Configured Keep Watching data source does not belong to its database");
        }
        const dataSource = await this.request<NotionDataSourceResponse>(
          `/v1/data_sources/${encodeURIComponent(target.dataSourceId)}`,
        );
        for (const [name, expectedType] of Object.entries(REQUIRED_PROPERTIES)) {
          if (dataSource.properties?.[name]?.type !== expectedType) {
            throw new Error(`Keep Watching Notion schema is incompatible at ${name}`);
          }
        }
      })();
      this.validatedTargets.set(key, pending);
    }
    try {
      await pending;
    } catch (error) {
      if (this.validatedTargets.get(key) === pending) {
        this.validatedTargets.delete(key);
      }
      throw error;
    }
  }

  async createRecord(params: {
    target: NotionTarget;
    recordId: string;
    job: InboundImageJob;
    sha256: string;
    objectKey: string;
    fileSize: number;
  }): Promise<{ pageId: string; duplicate: boolean }> {
    await this.validateTarget(params.target);
    const query = await this.request<NotionQueryResponse>(
      `/v1/data_sources/${encodeURIComponent(params.target.dataSourceId)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 1,
          filter: { property: "Record ID", rich_text: { equals: params.recordId } },
        }),
      },
    );
    const existing = query.results?.[0]?.id;
    if (existing) {
      return { pageId: existing, duplicate: true };
    }
    const page = await this.request<NotionPageResponse>("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: params.target.dataSourceId },
        properties: {
          Name: {
            title: [{ type: "text", text: { content: `LINE media ${params.job.messageId}` } }],
          },
          "Captured At": { date: { start: params.job.receivedAt } },
          Source: richText("LINE KEEP_WATCHING"),
          Sender: richText(params.job.userId),
          "Media Type": richText(params.job.mimeType),
          "File Size": { number: params.fileSize },
          "R2 Object Key": richText(params.objectKey),
          "SHA-256": richText(params.sha256),
          Status: { select: { name: "Completed" } },
          "Record ID": richText(params.recordId),
        },
      }),
    });
    if (!page.id) {
      throw new Error("Notion create response did not include a page ID");
    }
    return { pageId: page.id, duplicate: false };
  }
}

function keepWatchingRecordKey(job: InboundImageJob): string {
  return crypto
    .createHash("sha256")
    .update(`${job.accountId ?? "default"}\0KEEP_WATCHING\0${job.groupId}\0${job.messageId}`)
    .digest("hex");
}

export class KeepWatchingPipeline {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      stateDir: string;
      imageMaxBytes: number;
      bucketName: string;
      policy: NonNullable<WorkspacePolicyConfig["keepWatching"]>;
      store: AsyncKeyedStore<KeepWatchingJobRecord>;
      r2: R2Like;
      notion: KeepWatchingNotionLike;
      logger: SafeLogger;
    },
  ) {}

  async enqueue(job: InboundImageJob): Promise<"queued" | "duplicate"> {
    const key = keepWatchingRecordKey(job);
    const scope = freezeWorkspaceJobScope({
      lineGroupId: job.groupId,
      policyId: "KEEP_WATCHING",
      jobType: "KEEP_WATCHING_MEDIA",
      sourceCapabilityIds: [],
      targetDatabaseId: this.deps.policy.notion.databaseId,
      targetDataSourceId: this.deps.policy.notion.dataSourceId,
      r2Prefix: this.deps.policy.r2Prefix,
    });
    const record: KeepWatchingJobRecord = {
      key,
      status: "NEW",
      scope,
      job,
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    if (!(await this.deps.store.registerIfAbsent(key, record))) {
      return "duplicate";
    }
    const work = this.tail.then(async () => await this.process(record));
    this.tail = work.catch((error: unknown) => {
      this.deps.logger.error("keep_watching_worker_failed", {
        recordKey: record.key,
        error: safeError(error),
      });
    });
    return "queued";
  }

  private async process(record: KeepWatchingJobRecord): Promise<void> {
    try {
      record.attempts += 1;
      const file = await readSafeMediaFile({
        filePath: record.job.mediaPath,
        stateDir: this.deps.stateDir,
        maxBytes: this.deps.imageMaxBytes,
      });
      const extension = detectCanonicalImageExtensionFromBytes(file.bytes);
      if (extension === ".bin") {
        throw new Error("Unsupported Keep Watching image type");
      }
      const objectKey = buildContentAddressedObjectKey({
        keyPrefix: record.scope.r2Prefix,
        sha256: file.sha256,
        extension,
      });
      await this.deps.r2.ensureObject({
        body: file.bytes,
        bucketName: this.deps.bucketName,
        objectKey,
        contentType: record.job.mimeType,
        contentLength: file.size,
        sha256: file.sha256,
      });
      const notion = await this.deps.notion.createRecord({
        target: {
          databaseId: record.scope.targetDatabaseId,
          dataSourceId: record.scope.targetDataSourceId,
        },
        recordId: record.key,
        job: record.job,
        sha256: file.sha256,
        objectKey,
        fileSize: file.size,
      });
      Object.assign(record, {
        status: "PROCESSED",
        sha256: file.sha256,
        objectKey,
        fileSize: file.size,
        notionPageId: notion.pageId,
        updatedAt: new Date().toISOString(),
      });
      await this.deps.store.register(record.key, record);
      this.deps.logger.info("keep_watching_ingest_completed", { recordKey: record.key });
    } catch (error) {
      record.status = "ERROR";
      record.error = safeError(error);
      record.updatedAt = new Date().toISOString();
      await this.deps.store.register(record.key, record);
      throw error;
    }
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }
}
