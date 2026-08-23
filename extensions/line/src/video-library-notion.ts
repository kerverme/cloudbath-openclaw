/**
 * Narrow Notion writer for the persistent Cloudbath LINE video library.
 *
 * The database and its single data source are provisioned once by an
 * administrator. Runtime only validates that exact configured target and
 * creates/updates video-job pages; it never creates or mutates schema and it
 * never exposes a generic Notion request surface to the model.
 */
const NOTION_BASE_URL = "https://api.notion.com";
const NOTION_API_VERSION = "2026-03-11";
// Reuse the existing profile-scoped archive integration. The separate
// NOTION_CONSTRUCTION_WRITE_TOKEN remains exclusive to its hardcoded Upload
// Inbox tool and is never broadened to this database.
const NOTION_TOKEN_ENV = "NOTION_API_KEY";
const NOTION_DATABASE_ID_ENV = "NOTION_VIDEO_LIBRARY_DATABASE_ID";
const NOTION_DATA_SOURCE_ID_ENV = "NOTION_VIDEO_LIBRARY_DATA_SOURCE_ID";
const REQUEST_TIMEOUT_MS = 15_000;
const NOTION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_RICH_TEXT_CHUNK_LENGTH = 1_900;
const MAX_RICH_TEXT_LENGTH = 50_000;

export const LINE_VIDEO_LIBRARY_DATABASE_TITLE = "AI Video Library – Cloudbath";
export const LINE_VIDEO_LIBRARY_STATUS = ["Processing", "Completed", "Failed"] as const;

const REQUIRED_PROPERTY_TYPES = {
  Name: "title",
  Status: "select",
  "R2 URL": "url",
  "R2 Object Key": "rich_text",
  Model: "rich_text",
  Prompt: "rich_text",
  Duration: "number",
  Resolution: "rich_text",
  "Aspect Ratio": "rich_text",
  Audio: "checkbox",
  "Estimated Cost USD": "number",
  "Actual Cost USD": "number",
  "Video Job ID": "rich_text",
  "LINE Account": "rich_text",
  "LINE Conversation ID": "rich_text",
  "Created At": "date",
  "Completed At": "date",
  "Failure Reason": "rich_text",
} as const;

type NotionParent = {
  type?: string;
  database_id?: string;
  data_source_id?: string;
};

type NotionPropertySchema = {
  type?: string;
  select?: { options?: Array<{ name?: string }> };
};

type NotionDataSource = {
  object?: string;
  id?: string;
  parent?: NotionParent;
  properties?: Record<string, NotionPropertySchema>;
};

type NotionPage = {
  object?: string;
  id?: string;
  parent?: NotionParent;
};

type NotionQueryResponse = {
  results?: NotionPage[];
  has_more?: boolean;
};

type VideoLibraryConfig = {
  token: string;
  databaseId: string;
  dataSourceId: string;
};

export type LineVideoLibraryRecord = {
  pageId: string;
};

export type LineVideoLibraryJob = {
  jobId: string;
  accountId: string;
  conversationId: string;
  model: string;
  prompt: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  audio: boolean;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  createdAt: number;
};

export type LineVideoLibraryCompletion = {
  r2Url: string;
  r2ObjectKey: string;
  actualCostUsd?: number;
  completedAt: number;
};

export type LineVideoLibrary = {
  validate(): Promise<void>;
  createProcessing(job: LineVideoLibraryJob): Promise<LineVideoLibraryRecord>;
  markCompleted(
    record: LineVideoLibraryRecord,
    completion: LineVideoLibraryCompletion,
  ): Promise<void>;
  markFailed(record: LineVideoLibraryRecord, reason: string): Promise<void>;
};

export class LineVideoLibraryNotionError extends Error {
  constructor(readonly code: string) {
    super(`LINE video library Notion operation failed (${code})`);
    this.name = "LineVideoLibraryNotionError";
  }
}

function fail(code: string): never {
  throw new LineVideoLibraryNotionError(code);
}

function canonicalNotionId(value: string, errorCode: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "");
  return NOTION_ID_PATTERN.test(normalized) ? normalized : fail(errorCode);
}

function sameNotionId(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }
  try {
    return canonicalNotionId(left, "target_identity_invalid") === right;
  } catch {
    return false;
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  return value || fail("not_configured");
}

function resolveConfig(env: NodeJS.ProcessEnv): VideoLibraryConfig {
  return {
    token: requiredEnv(env, NOTION_TOKEN_ENV),
    databaseId: canonicalNotionId(requiredEnv(env, NOTION_DATABASE_ID_ENV), "database_id_invalid"),
    dataSourceId: canonicalNotionId(
      requiredEnv(env, NOTION_DATA_SOURCE_ID_ENV),
      "data_source_id_invalid",
    ),
  };
}

function richText(value: string): Record<string, unknown> {
  const characters = Array.from(value).slice(0, MAX_RICH_TEXT_LENGTH);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += MAX_RICH_TEXT_CHUNK_LENGTH) {
    chunks.push(characters.slice(offset, offset + MAX_RICH_TEXT_CHUNK_LENGTH).join(""));
  }
  return {
    rich_text: chunks.map((content) => ({ type: "text", text: { content } })),
  };
}

function title(value: string): Record<string, unknown> {
  return { title: [{ type: "text", text: { content: value.slice(0, 1_900) } }] };
}

function date(timestamp: number): Record<string, unknown> {
  return { date: { start: new Date(timestamp).toISOString() } };
}

function querylessHttpsUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("r2_url_invalid");
  }
  if (url.protocol !== "https:") {
    return fail("r2_url_invalid");
  }
  // Persist only a stable object locator. Presigned query credentials are
  // short-lived delivery material and must never be copied into Notion.
  url.search = "";
  url.hash = "";
  return url.toString();
}

class VideoLibraryNotionClient implements LineVideoLibrary {
  private schemaPromise: Promise<void> | undefined;

  constructor(
    private readonly config: VideoLibraryConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly requestTimeoutMs: number,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.config.token}`);
    headers.set("Notion-Version", NOTION_API_VERSION);
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    try {
      const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return fail(`http_${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof LineVideoLibraryNotionError) {
        throw error;
      }
      return fail(controller.signal.aborted ? "timeout" : "request_failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async validate(): Promise<void> {
    let pending = this.schemaPromise;
    if (!pending) {
      pending = (async () => {
        const source = await this.request<NotionDataSource>(
          `/v1/data_sources/${encodeURIComponent(this.config.dataSourceId)}`,
        );
        if (
          source.object !== "data_source" ||
          !sameNotionId(source.id, this.config.dataSourceId) ||
          source.parent?.type !== "database_id" ||
          !sameNotionId(source.parent.database_id, this.config.databaseId)
        ) {
          fail("target_identity_mismatch");
        }
        const properties = source.properties ?? {};
        for (const [name, expectedType] of Object.entries(REQUIRED_PROPERTY_TYPES)) {
          if (properties[name]?.type !== expectedType) {
            fail("schema_incompatible");
          }
        }
        const statuses = properties.Status?.select?.options?.map((option) => option.name) ?? [];
        if (
          statuses.length !== LINE_VIDEO_LIBRARY_STATUS.length ||
          LINE_VIDEO_LIBRARY_STATUS.some((status) => !statuses.includes(status))
        ) {
          fail("schema_incompatible");
        }
      })();
      this.schemaPromise = pending;
    }
    try {
      await pending;
    } catch (error) {
      if (this.schemaPromise === pending) {
        this.schemaPromise = undefined;
      }
      throw error;
    }
  }

  private assertPage(page: NotionPage): LineVideoLibraryRecord {
    if (
      page.object !== "page" ||
      !page.id ||
      page.parent?.type !== "data_source_id" ||
      !sameNotionId(page.parent.data_source_id, this.config.dataSourceId)
    ) {
      return fail("record_scope_mismatch");
    }
    return { pageId: page.id };
  }

  private async findByJobId(jobId: string): Promise<LineVideoLibraryRecord | undefined> {
    await this.validate();
    const response = await this.request<NotionQueryResponse>(
      `/v1/data_sources/${encodeURIComponent(this.config.dataSourceId)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 2,
          filter: { property: "Video Job ID", rich_text: { equals: jobId } },
        }),
      },
    );
    const pages = response.results ?? [];
    if (response.has_more || pages.length > 1) {
      return fail("duplicate_job_records");
    }
    return pages[0] ? this.assertPage(pages[0]) : undefined;
  }

  async createProcessing(job: LineVideoLibraryJob): Promise<LineVideoLibraryRecord> {
    const existing = await this.findByJobId(job.jobId);
    if (existing) {
      return existing;
    }
    const properties = {
      Name: title(`LINE video ${job.jobId}`),
      Status: { select: { name: "Processing" } },
      Model: richText(job.model),
      Prompt: richText(job.prompt),
      Duration: { number: job.durationSeconds },
      Resolution: richText(job.resolution),
      "Aspect Ratio": richText(job.aspectRatio),
      Audio: { checkbox: job.audio },
      "Estimated Cost USD": { number: job.estimatedCostUsd },
      "Actual Cost USD": { number: job.actualCostUsd ?? null },
      "Video Job ID": richText(job.jobId),
      "LINE Account": richText(job.accountId),
      "LINE Conversation ID": richText(job.conversationId),
      "Created At": date(job.createdAt),
    };
    try {
      const page = await this.request<NotionPage>("/v1/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { type: "data_source_id", data_source_id: this.config.dataSourceId },
          properties,
        }),
      });
      return this.assertPage(page);
    } catch (error) {
      // The create response may have been lost after Notion committed it.
      // Re-query once by the immutable job id; never issue a second create.
      const recovered = await this.findByJobId(job.jobId).catch(() => undefined);
      if (recovered) {
        return recovered;
      }
      throw error;
    }
  }

  private async update(
    record: LineVideoLibraryRecord,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.validate();
    const page = await this.request<NotionPage>(`/v1/pages/${encodeURIComponent(record.pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    this.assertPage(page);
  }

  async markCompleted(
    record: LineVideoLibraryRecord,
    completion: LineVideoLibraryCompletion,
  ): Promise<void> {
    await this.update(record, {
      Status: { select: { name: "Completed" } },
      "R2 URL": { url: querylessHttpsUrl(completion.r2Url) },
      "R2 Object Key": richText(completion.r2ObjectKey),
      "Actual Cost USD": { number: completion.actualCostUsd ?? null },
      "Completed At": date(completion.completedAt),
      "Failure Reason": richText(""),
    });
  }

  async markFailed(record: LineVideoLibraryRecord, reason: string): Promise<void> {
    await this.update(record, {
      Status: { select: { name: "Failed" } },
      "Failure Reason": richText(reason),
    });
  }
}

export function createLineVideoLibraryNotion(
  params: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  } = {},
): LineVideoLibrary {
  return new VideoLibraryNotionClient(
    resolveConfig(params.env ?? process.env),
    params.fetchImpl ?? fetch,
    params.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  );
}

export const LINE_VIDEO_LIBRARY_SCHEMA = {
  databaseTitle: LINE_VIDEO_LIBRARY_DATABASE_TITLE,
  properties: REQUIRED_PROPERTY_TYPES,
  statusOptions: LINE_VIDEO_LIBRARY_STATUS,
} as const;
