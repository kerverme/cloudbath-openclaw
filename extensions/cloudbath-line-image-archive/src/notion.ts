import { isRetryableStatus, withBoundedRetry } from "./retry.js";
import {
  NOTION_API_VERSION,
  validateNotionProperties,
  type NotionPropertyDefinition,
} from "./notion-schema.js";
import type {
  ArchiveConfig,
  BusinessRecordMetadata,
  NotionWriteResult,
  SafeLogger,
  SchemaPropertyDefinition,
  SystemFieldRole,
} from "./types.js";

const NOTION_BASE_URL = "https://api.notion.com";
const MAX_TEXT_LENGTH = 1_900;
type FetchLike = typeof fetch;
type NotionDatabaseResponse = { data_sources?: Array<{ id?: string }> };
type NotionDataSourceResponse = { properties?: Record<string, NotionPropertyDefinition> };
type NotionQueryResponse = { results?: Array<{ id?: string }> };
type NotionPageResponse = { id?: string };

class NotionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NotionHttpError";
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim().slice(0, MAX_TEXT_LENGTH);
}

function systemValue(role: SystemFieldRole, metadata: BusinessRecordMetadata): unknown {
  switch (role) {
    case "recordIdentity":
    case "assetId":
      return metadata.recordIdentity;
    case "sha256":
      return metadata.asset.sha256;
    case "r2ObjectKey":
      return metadata.asset.r2ObjectKey;
    case "receivedAt":
      return metadata.job.receivedAt;
    case "lineMessageId":
      return metadata.job.messageId;
    case "lineGroupId":
      return metadata.job.groupId;
    case "lineUserId":
      return metadata.job.userId;
    case "status":
      return metadata.status;
    case "error":
      return metadata.error;
  }
}

function notionPropertyValue(
  property: SchemaPropertyDefinition,
  metadata: BusinessRecordMetadata,
): Record<string, unknown> {
  const extracted = metadata.extractedFields?.values[property.id];
  const raw = property.systemFieldRole ? systemValue(property.systemFieldRole, metadata) : extracted;
  switch (property.notionType) {
    case "title": {
      const title =
        textValue(raw) ||
        `${metadata.agentProfile.name} image ${metadata.job.messageId}`.slice(0, MAX_TEXT_LENGTH);
      return { title: [{ type: "text", text: { content: title } }] };
    }
    case "rich_text":
      return raw === undefined || raw === null
        ? { rich_text: [] }
        : { rich_text: [{ type: "text", text: { content: textValue(raw) } }] };
    case "number":
      return { number: typeof raw === "number" && Number.isFinite(raw) ? raw : null };
    case "checkbox":
      return { checkbox: raw === true };
    case "date":
      return { date: typeof raw === "string" && raw ? { start: raw } : null };
    case "select":
      return { select: typeof raw === "string" && raw ? { name: raw.slice(0, 100) } : null };
    case "multi_select": {
      const values = Array.isArray(raw) ? raw : [];
      return {
        multi_select: values
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .slice(0, 20)
          .map((name) => ({ name: name.trim().slice(0, 100) })),
      };
    }
    case "url":
      return { url: typeof raw === "string" && raw ? raw : null };
    case "email":
      return { email: typeof raw === "string" && raw ? raw : null };
    case "phone_number":
      return { phone_number: typeof raw === "string" && raw ? raw : null };
  }
}

export class NotionArchiveClient {
  private readonly dataSources = new Map<string, Promise<string>>();

  constructor(
    private readonly apiKey: string,
    private readonly retry: ArchiveConfig["retry"],
    private readonly logger: SafeLogger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return await withBoundedRetry(
      async () => {
        const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Notion-Version": NOTION_API_VERSION,
            ...init?.headers,
          },
        });
        if (!response.ok) {
          throw new NotionHttpError(
            response.status,
            `Notion API request failed (${response.status})`,
            retryAfterMs(response.headers),
          );
        }
        return (await response.json()) as T;
      },
      {
        ...this.retry,
        isRetryable: (error) =>
          error instanceof NotionHttpError ? isRetryableStatus(error.status) : true,
        resolveDelayMs: (error, defaultDelayMs) =>
          error instanceof NotionHttpError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : defaultDelayMs,
        onRetry: (_error, attempt, delayMs) => {
          this.logger.warn("notion_retry", { attempt, delayMs });
        },
      },
    );
  }

  private async resolveDataSourceId(metadata: BusinessRecordMetadata): Promise<string> {
    const databaseId = metadata.agentProfile.notionDatabaseId;
    const cacheKey = `${databaseId}\0${metadata.schemaProfile.id}@${metadata.schemaProfile.version}`;
    let pending = this.dataSources.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const database = await this.request<NotionDatabaseResponse>(
          `/v1/databases/${encodeURIComponent(databaseId)}`,
        );
        const ids = (database.data_sources ?? [])
          .map((source) => source.id?.trim())
          .filter((id): id is string => Boolean(id));
        if (ids.length !== 1) {
          throw new Error(`Notion database ${databaseId} must contain exactly one data source`);
        }
        const dataSource = await this.request<NotionDataSourceResponse>(
          `/v1/data_sources/${encodeURIComponent(ids[0])}`,
        );
        const issues = validateNotionProperties(
          metadata.schemaProfile,
          dataSource.properties ?? {},
        );
        if (issues.length > 0) {
          throw new Error(
            `Notion schema ${metadata.schemaProfile.id}@${metadata.schemaProfile.version} is incompatible: ${issues
              .map((issue) => `${issue.propertyName}: ${issue.reason}`)
              .join("; ")}`,
          );
        }
        return ids[0];
      })();
      this.dataSources.set(cacheKey, pending);
    }
    return await pending;
  }

  async createRecord(metadata: BusinessRecordMetadata): Promise<NotionWriteResult> {
    const dataSourceId = await this.resolveDataSourceId(metadata);
    const identityProperty = metadata.schemaProfile.properties.find(
      (property) => property.systemFieldRole === "recordIdentity",
    );
    if (!identityProperty) {
      throw new Error("Schema Profile is missing the recordIdentity system field");
    }
    const existing = await this.request<NotionQueryResponse>(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 1,
          filter: {
            property: identityProperty.name,
            rich_text: { equals: metadata.recordIdentity },
          },
        }),
      },
    );
    const existingPageId = existing.results?.[0]?.id;
    if (existingPageId) {
      return { kind: "duplicate", pageId: existingPageId };
    }
    const properties = Object.fromEntries(
      metadata.schemaProfile.properties.map((property) => [
        property.name,
        notionPropertyValue(property, metadata),
      ]),
    );
    const page = await this.request<NotionPageResponse>("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties,
      }),
    });
    if (!page.id) {
      throw new Error("Notion create page response did not include a page ID");
    }
    return { kind: "created", pageId: page.id };
  }
}
