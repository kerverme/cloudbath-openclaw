import { isRetryableStatus, withBoundedRetry } from "./retry.js";
import type { ArchiveConfig, ArchiveMetadata, NotionWriteResult, SafeLogger } from "./types.js";

const NOTION_VERSION = "2026-03-11";
const NOTION_BASE_URL = "https://api.notion.com";
const MAX_RICH_TEXT_LENGTH = 1_900;

type FetchLike = typeof fetch;

type NotionDatabaseResponse = {
  data_sources?: Array<{ id?: string; name?: string }>;
};

type NotionDataSourceResponse = {
  properties?: Record<string, { type?: string }>;
};

type NotionQueryResponse = {
  results?: Array<{ id?: string }>;
};

type NotionPageResponse = {
  id?: string;
};

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

const REQUIRED_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ["Name", "title"],
  ["Received At", "date"],
  ["LINE Message ID", "rich_text"],
  ["LINE Webhook Event ID", "rich_text"],
  ["LINE Group ID", "rich_text"],
  ["LINE User ID", "rich_text"],
  ["Sender Name", "rich_text"],
  ["Original Filename", "rich_text"],
  ["MIME Type", "rich_text"],
  ["File Size", "number"],
  ["SHA-256", "rich_text"],
  ["R2 Object Key", "rich_text"],
  ["AI Description", "rich_text"],
  ["Category", "select"],
  ["Tags", "multi_select"],
  ["Vendor", "rich_text"],
  ["Amount", "number"],
  ["Status", "select"],
  ["Error", "rich_text"],
];

function richText(content: string | undefined): { rich_text: unknown[] } {
  const trimmed = content?.trim().slice(0, MAX_RICH_TEXT_LENGTH) ?? "";
  return trimmed
    ? { rich_text: [{ type: "text", text: { content: trimmed } }] }
    : { rich_text: [] };
}

function title(content: string): { title: unknown[] } {
  return {
    title: [{ type: "text", text: { content: content.slice(0, MAX_RICH_TEXT_LENGTH) } }],
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function sanitizeSelect(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/[\n\r]/g, " ")
    .slice(0, 100);
  return normalized || undefined;
}

export class NotionArchiveClient {
  private dataSourceIdPromise?: Promise<string>;

  constructor(
    private readonly config: ArchiveConfig["notion"],
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
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "Notion-Version": NOTION_VERSION,
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

  private async resolveDataSourceId(): Promise<string> {
    const database = await this.request<NotionDatabaseResponse>(
      `/v1/databases/${encodeURIComponent(this.config.databaseId)}`,
    );
    const ids = (database.data_sources ?? [])
      .map((source) => source.id?.trim())
      .filter((id): id is string => Boolean(id));
    if (ids.length !== 1) {
      throw new Error(
        `NOTION_DATABASE_ID must reference a database with exactly one data source; found ${ids.length}`,
      );
    }
    await this.validateSchema(ids[0]);
    return ids[0];
  }

  private async dataSourceId(): Promise<string> {
    this.dataSourceIdPromise ??= this.resolveDataSourceId();
    return await this.dataSourceIdPromise;
  }

  private async validateSchema(dataSourceId: string): Promise<void> {
    const dataSource = await this.request<NotionDataSourceResponse>(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
    );
    const properties = dataSource.properties ?? {};
    const invalid = REQUIRED_PROPERTIES.filter(
      ([name, type]) => properties[name]?.type !== type,
    ).map(([name, type]) => `${name} (${type})`);
    if (invalid.length > 0) {
      throw new Error(`Notion data source is missing required properties: ${invalid.join(", ")}`);
    }
  }

  private async findExisting(
    dataSourceId: string,
    metadata: ArchiveMetadata,
  ): Promise<string | undefined> {
    const response = await this.request<NotionQueryResponse>(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 1,
          filter: {
            or: [
              {
                property: "LINE Message ID",
                rich_text: { equals: metadata.lineMessageId },
              },
              {
                property: "SHA-256",
                rich_text: { equals: metadata.sha256 },
              },
            ],
          },
        }),
      },
    );
    return response.results?.[0]?.id;
  }

  async createRecord(metadata: ArchiveMetadata): Promise<NotionWriteResult> {
    const dataSourceId = await this.dataSourceId();
    const existingPageId = await this.findExisting(dataSourceId, metadata);
    if (existingPageId) {
      return { kind: "duplicate", pageId: existingPageId };
    }

    const analysis = metadata.analysis;
    const category = sanitizeSelect(analysis?.category);
    const tags = [
      ...new Set(
        analysis?.tags.map(sanitizeSelect).filter((value): value is string => Boolean(value)) ?? [],
      ),
    ].slice(0, 20);
    const properties: Record<string, unknown> = {
      Name: title(`LINE image ${metadata.lineMessageId}`),
      "Received At": { date: { start: metadata.receivedAt } },
      "LINE Message ID": richText(metadata.lineMessageId),
      "LINE Webhook Event ID": richText(metadata.lineWebhookEventId),
      "LINE Group ID": richText(metadata.lineGroupId),
      "LINE User ID": richText(metadata.lineUserId),
      "Sender Name": richText(metadata.senderName),
      "Original Filename": richText(metadata.originalFilename),
      "MIME Type": richText(metadata.mimeType),
      "File Size": { number: metadata.fileSize },
      "SHA-256": richText(metadata.sha256),
      "R2 Object Key": richText(metadata.r2ObjectKey),
      "AI Description": richText(analysis?.description),
      Category: category ? { select: { name: category } } : { select: null },
      Tags: { multi_select: tags.map((name) => ({ name })) },
      Vendor: richText(analysis?.vendor),
      Amount: { number: analysis?.amount ?? null },
      Status: { select: { name: metadata.status } },
      Error: richText(metadata.error),
    };

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

export { NOTION_VERSION, REQUIRED_PROPERTIES };
