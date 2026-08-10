import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { NOTION_API_VERSION } from "./notion-schema.js";
import { isRetryableStatus, withBoundedRetry } from "./retry.js";

const NOTION_BASE_URL = "https://api.notion.com";
const WELLNESS_ROOT_PAGE_ID = "39575d42-f42b-808c-8a66-faed4274521b";
const CONSTRUCTION_DATABASE_ID = "9e0360ad-8993-480e-8b79-d7d269c4534e";
const CONSTRUCTION_DATA_SOURCE_ID = "22c0c780-106b-418b-8576-62d0b1fd1030";
const WELLNESS_TOKEN_ENV = "NOTION_WELLNESS_READ_TOKEN";
const CONSTRUCTION_TOKEN_ENV = "NOTION_CONSTRUCTION_WRITE_TOKEN";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_NOTION_TEXT_LENGTH = 1_900;
const MAX_QUERY_RECORDS = 500;
const MAX_SEARCH_RECORDS = 1_000;
const MAX_WELLNESS_ROOT_BLOCKS = 1_000;
const MAX_WELLNESS_CHILD_DATABASES = 100;
const NOTION_ID_PATTERN = /^[0-9a-f]{32}$/;

type FetchLike = typeof fetch;
type NotionParent = {
  type?: string;
  database_id?: string;
  data_source_id?: string;
};
type NotionPage = {
  object?: string;
  id?: string;
  created_time?: string;
  last_edited_time?: string;
  parent?: NotionParent;
  properties?: Record<string, unknown>;
};
type NotionDatabase = {
  object?: string;
  id?: string;
  data_sources?: Array<{ id?: string }>;
};
type NotionBlock = {
  object?: string;
  id?: string;
  type?: string;
  child_database?: { title?: string };
};
type NotionBlockChildrenResponse = {
  results?: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
};
type WellnessDataSourceScope = {
  databaseId: string;
  dataSourceId: string;
};
type NotionPropertySchema = {
  type?: string;
  select?: { options?: Array<{ name?: string }> };
  status?: { options?: Array<{ name?: string }> };
};
type NotionDataSource = {
  id?: string;
  parent?: NotionParent;
  properties?: Record<string, NotionPropertySchema>;
};
type NotionQueryResponse = {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};
type SafeNotionPage = {
  id: string;
  createdAt?: string;
  lastEditedAt?: string;
  properties: Record<string, unknown>;
};
type ScopedWellnessPage = SafeNotionPage & WellnessDataSourceScope;
type WellnessQueryCursor = {
  version: 1;
  sourceIndex: number;
  notionCursor?: string;
};
type ConstructionValues = {
  name?: string;
  capturedAt?: string;
  source?: string;
  sender?: string;
  message?: string;
  mediaType?: string;
  fileUrl?: string;
  aiSummary?: string;
  status?: string;
};

class ScopedNotionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ScopedNotionError";
  }
}

function canonicalNotionId(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "");
  if (!NOTION_ID_PATTERN.test(normalized)) {
    throw new Error("A valid Notion record ID is required");
  }
  return normalized;
}

function sameNotionId(left: string | undefined, right: string): boolean {
  if (!left) {
    return false;
  }
  try {
    return canonicalNotionId(left) === canonicalNotionId(right);
  } catch {
    return false;
  }
}

function requireCredential(scope: "wellness" | "construction"): string {
  const envName = scope === "wellness" ? WELLNESS_TOKEN_ENV : CONSTRUCTION_TOKEN_ENV;
  const token = process.env[envName]?.trim();
  if (!token) {
    throw new Error(
      `${scope === "wellness" ? "Wellness" : "Construction"} Notion connection is not configured`,
    );
  }
  return token;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function safeNotionErrorField(value: unknown, token: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let safe = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 300);
  if (!safe) {
    return undefined;
  }
  safe = safe.replaceAll(token, "[REDACTED]");
  safe = safe.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  return safe;
}

async function notionErrorDetails(
  response: Response,
  token: string,
): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    const code =
      typeof body.code === "string" && /^[a-z0-9_]{1,64}$/i.test(body.code) ? body.code : undefined;
    const message = safeNotionErrorField(body.message, token);
    return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
  } catch {
    return {};
  }
}

class ScopedNotionClient {
  constructor(
    private readonly scope: "wellness" | "construction",
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    return await withBoundedRetry(
      async () => {
        const controller = new AbortController();
        let timedOut = false;
        const cancel = () => controller.abort();
        if (signal?.aborted) {
          cancel();
        } else {
          signal?.addEventListener("abort", cancel, { once: true });
        }
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${this.token}`);
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
            const status = response.status;
            const details = await notionErrorDetails(response, this.token);
            const label = this.scope === "wellness" ? "Wellness" : "Construction";
            const diagnostic = [
              `status ${status}`,
              ...(details.code ? [`code ${details.code}`] : []),
            ].join(", ");
            throw new ScopedNotionError(
              `${label} Notion request failed (${diagnostic})${details.message ? `: ${details.message}` : ""}`,
              status,
              parseRetryAfterMs(response.headers),
              isRetryableStatus(status),
            );
          }
          return (await response.json()) as T;
        } catch (error) {
          if (error instanceof ScopedNotionError) {
            throw error;
          }
          if (controller.signal.aborted) {
            throw new ScopedNotionError(
              timedOut ? "Notion request timed out" : "Notion request was cancelled",
            );
          }
          throw new ScopedNotionError("Notion service request failed", undefined, undefined, true);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
        }
      },
      {
        maxAttempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 2_000,
        isRetryable: (error) => error instanceof ScopedNotionError && error.retryable,
        resolveDelayMs: (error, defaultDelayMs) =>
          error instanceof ScopedNotionError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : defaultDelayMs,
      },
    );
  }
}

function paramsRecord(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Tool parameters must be an object");
  }
  return params as Record<string, unknown>;
}

function assertAllowedKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(params).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unsupported tool parameter: ${unknown[0]}`);
  }
}

function readString(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const value = raw.trim();
  if (!value) {
    if (options.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }
  const maxLength = options.maxLength ?? MAX_NOTION_TEXT_LENGTH;
  if (value.length > maxLength) {
    throw new Error(`${key} exceeds the maximum length`);
  }
  return value;
}

function readInteger(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const raw = params[key];
  if (raw === undefined) {
    return fallback;
  }
  if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > maximum) {
    throw new Error(`${key} must be an integer from 1 to ${maximum}`);
  }
  return raw as number;
}

function readDataSourceIndex(params: Record<string, unknown>): number | undefined {
  const raw = params.data_source_index;
  if (raw === undefined) {
    return undefined;
  }
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > 100) {
    throw new Error("data_source_index must be an integer from 0 to 100");
  }
  return raw as number;
}

function encodeWellnessCursor(cursor: WellnessQueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeWellnessCursor(value: string | undefined): WellnessQueryCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<WellnessQueryCursor>;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.sourceIndex) ||
      (parsed.sourceIndex as number) < 0 ||
      (parsed.sourceIndex as number) > MAX_WELLNESS_CHILD_DATABASES * 100 ||
      (parsed.notionCursor !== undefined &&
        (typeof parsed.notionCursor !== "string" ||
          parsed.notionCursor.length === 0 ||
          parsed.notionCursor.length > 512))
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as WellnessQueryCursor;
  } catch {
    throw new Error("start_cursor is not a valid Wellness continuation cursor");
  }
}

function safePage(page: NotionPage, expectedDataSourceId: string): SafeNotionPage {
  if (
    page.object !== "page" ||
    !page.id ||
    !sameNotionId(page.parent?.data_source_id, expectedDataSourceId)
  ) {
    throw new Error("Notion returned a record outside the configured data source");
  }
  return {
    id: page.id,
    ...(page.created_time ? { createdAt: page.created_time } : {}),
    ...(page.last_edited_time ? { lastEditedAt: page.last_edited_time } : {}),
    properties: page.properties ?? {},
  };
}

class WellnessNotionReader {
  private scopesPromise: Promise<WellnessDataSourceScope[]> | undefined;

  constructor(private readonly client: ScopedNotionClient) {}

  private async discoverScopes(signal?: AbortSignal): Promise<WellnessDataSourceScope[]> {
    let pending = this.scopesPromise;
    if (!pending) {
      pending = (async () => {
        const childDatabaseIds: string[] = [];
        let cursor: string | undefined;
        let scannedBlocks = 0;
        let hasMore = true;
        while (hasMore) {
          const query = new URLSearchParams({ page_size: "100" });
          if (cursor) {
            query.set("start_cursor", cursor);
          }
          const result = await this.client.request<NotionBlockChildrenResponse>(
            `/v1/blocks/${encodeURIComponent(WELLNESS_ROOT_PAGE_ID)}/children?${query}`,
            {},
            signal,
          );
          for (const block of result.results ?? []) {
            scannedBlocks += 1;
            if (scannedBlocks > MAX_WELLNESS_ROOT_BLOCKS) {
              throw new Error("Wellness root page exceeds the safe discovery limit");
            }
            if (block.object === "block" && block.type === "child_database" && block.id) {
              canonicalNotionId(block.id);
              childDatabaseIds.push(block.id);
              if (
                new Set(childDatabaseIds.map(canonicalNotionId)).size > MAX_WELLNESS_CHILD_DATABASES
              ) {
                throw new Error("Wellness root page has too many child databases");
              }
            }
          }
          hasMore = result.has_more === true;
          cursor = result.next_cursor ?? undefined;
          if (hasMore && !cursor) {
            throw new Error("Wellness root page pagination response is invalid");
          }
        }

        const databaseIds = [
          ...new Map(childDatabaseIds.map((id) => [canonicalNotionId(id), id])).values(),
        ];
        if (databaseIds.length === 0) {
          throw new Error("Wellness root page has no accessible child database");
        }

        const scopes: WellnessDataSourceScope[] = [];
        for (const databaseId of databaseIds) {
          const database = await this.client.request<NotionDatabase>(
            `/v1/databases/${encodeURIComponent(databaseId)}`,
            {},
            signal,
          );
          if (database.object !== "database" || !sameNotionId(database.id, databaseId)) {
            throw new Error("Wellness child database identity could not be verified");
          }
          for (const source of database.data_sources ?? []) {
            if (!source.id) {
              continue;
            }
            canonicalNotionId(source.id);
            scopes.push({ databaseId, dataSourceId: source.id });
          }
        }
        const uniqueScopes = [
          ...new Map(
            scopes.map((scope) => [canonicalNotionId(scope.dataSourceId), scope]),
          ).values(),
        ];
        if (uniqueScopes.length === 0) {
          throw new Error("Wellness child databases have no accessible data source");
        }
        return uniqueScopes;
      })();
      this.scopesPromise = pending;
    }
    try {
      return await pending;
    } catch (error) {
      if (this.scopesPromise === pending) {
        this.scopesPromise = undefined;
      }
      throw error;
    }
  }

  private async queryDataSource(
    dataSourceId: string,
    maxRecords: number,
    signal?: AbortSignal,
    onPage?: (page: SafeNotionPage) => boolean | "stop",
    startCursor?: string,
  ): Promise<{
    records: SafeNotionPage[];
    hasMore: boolean;
    scanned: number;
    nextCursor?: string;
  }> {
    const records: SafeNotionPage[] = [];
    let cursor = startCursor;
    let scanned = 0;
    let hasMore: boolean;
    do {
      const pageSize = Math.min(100, maxRecords - scanned);
      const result = await this.client.request<NotionQueryResponse>(
        `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            page_size: pageSize,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
        signal,
      );
      const pages = result.results ?? [];
      for (const rawPage of pages) {
        const page = safePage(rawPage, dataSourceId);
        scanned += 1;
        const decision = onPage?.(page);
        if (!onPage || decision === true) {
          records.push(page);
        }
        if (decision === "stop") {
          return { records, hasMore: true, scanned };
        }
        if (scanned >= maxRecords) {
          const moreInPage = pages.indexOf(rawPage) < pages.length - 1;
          return {
            records,
            hasMore: result.has_more === true || moreInPage,
            scanned,
            ...(result.next_cursor ? { nextCursor: result.next_cursor } : {}),
          };
        }
      }
      hasMore = result.has_more === true;
      cursor = result.next_cursor ?? undefined;
      if (hasMore && !cursor) {
        throw new Error("Wellness Notion pagination response is invalid");
      }
    } while (hasMore && scanned < maxRecords);
    return { records, hasMore: false, scanned };
  }

  async query(
    dataSourceIndex: number | undefined,
    maxRecords: number,
    startCursor?: string,
    signal?: AbortSignal,
  ) {
    const scopes = await this.discoverScopes(signal);
    const decoded = decodeWellnessCursor(startCursor);
    if (decoded && dataSourceIndex !== undefined) {
      throw new Error("data_source_index cannot be combined with start_cursor");
    }
    let sourceIndex = decoded?.sourceIndex ?? dataSourceIndex ?? 0;
    if (!scopes[sourceIndex]) {
      throw new Error("Wellness continuation is outside the root-page scope");
    }
    const singleSource = dataSourceIndex !== undefined;
    const records: ScopedWellnessPage[] = [];
    let scanned = 0;
    let nextCursor: string | undefined;
    let notionCursor = decoded?.notionCursor;

    while (sourceIndex < scopes.length && scanned < maxRecords) {
      const scope = scopes[sourceIndex]!;
      const result = await this.queryDataSource(
        scope.dataSourceId,
        maxRecords - scanned,
        signal,
        undefined,
        notionCursor,
      );
      records.push(
        ...result.records.map((page) => ({
          ...page,
          databaseId: scope.databaseId,
          dataSourceId: scope.dataSourceId,
        })),
      );
      scanned += result.scanned;
      if (result.hasMore) {
        if (!result.nextCursor) {
          throw new Error("Wellness Notion continuation cursor is missing");
        }
        nextCursor = encodeWellnessCursor({
          version: 1,
          sourceIndex,
          notionCursor: result.nextCursor,
        });
        break;
      }
      if (singleSource) {
        break;
      }
      sourceIndex += 1;
      notionCursor = undefined;
      if (scanned >= maxRecords && sourceIndex < scopes.length) {
        nextCursor = encodeWellnessCursor({ version: 1, sourceIndex });
      }
    }

    return {
      rootPageId: WELLNESS_ROOT_PAGE_ID,
      dataSourceCount: scopes.length,
      databaseCount: new Set(scopes.map((scope) => canonicalNotionId(scope.databaseId))).size,
      records,
      recordCount: scanned,
      hasMore: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
      ...(singleSource ? { dataSourceIndex } : {}),
    };
  }

  async getRecord(recordId: string, signal?: AbortSignal): Promise<ScopedWellnessPage> {
    const wanted = canonicalNotionId(recordId);
    for (const scope of await this.discoverScopes(signal)) {
      let found: SafeNotionPage | undefined;
      await this.queryDataSource(scope.dataSourceId, 10_000, signal, (page) => {
        if (canonicalNotionId(page.id) === wanted) {
          found = page;
          return "stop";
        }
        return false;
      });
      if (found) {
        return { ...found, databaseId: scope.databaseId, dataSourceId: scope.dataSourceId };
      }
    }
    throw new Error("Wellness record is outside the allowed root page or does not exist");
  }

  async search(query: string, maxResults: number, maxRecordsScanned: number, signal?: AbortSignal) {
    const needle = query.toLocaleLowerCase();
    const matches: ScopedWellnessPage[] = [];
    let scanned = 0;
    let hasMore = false;
    const scopes = await this.discoverScopes(signal);
    for (const scope of scopes) {
      if (scanned >= maxRecordsScanned || matches.length >= maxResults) {
        hasMore = true;
        break;
      }
      const result = await this.queryDataSource(
        scope.dataSourceId,
        maxRecordsScanned - scanned,
        signal,
        (page) => {
          const matched = JSON.stringify(page.properties).toLocaleLowerCase().includes(needle);
          if (matched && matches.length < maxResults) {
            matches.push({
              ...page,
              databaseId: scope.databaseId,
              dataSourceId: scope.dataSourceId,
            });
          }
          return matches.length >= maxResults ? "stop" : false;
        },
      );
      scanned += result.scanned;
      hasMore ||= result.hasMore || matches.length >= maxResults;
    }
    return {
      rootPageId: WELLNESS_ROOT_PAGE_ID,
      query,
      matches,
      scannedRecords: scanned,
      hasMore,
    };
  }
}

const CONSTRUCTION_PROPERTY_TYPES = {
  Name: ["title"],
  "Captured At": ["date"],
  Source: ["rich_text", "select"],
  Sender: ["rich_text"],
  Message: ["rich_text"],
  "Media Type": ["rich_text", "select"],
  "File URL": ["url"],
  "AI Summary": ["rich_text"],
  Status: ["status", "select"],
  "Record ID": ["rich_text"],
  Created: ["created_time"],
} as const;

class ConstructionNotionWriter {
  private schemaPromise: Promise<Record<string, NotionPropertySchema>> | undefined;

  constructor(private readonly client: ScopedNotionClient) {}

  private async schema(signal?: AbortSignal): Promise<Record<string, NotionPropertySchema>> {
    let pending = this.schemaPromise;
    if (!pending) {
      pending = (async () => {
        const dataSource = await this.client.request<NotionDataSource>(
          `/v1/data_sources/${encodeURIComponent(CONSTRUCTION_DATA_SOURCE_ID)}`,
          {},
          signal,
        );
        if (
          !sameNotionId(dataSource.id, CONSTRUCTION_DATA_SOURCE_ID) ||
          dataSource.parent?.type !== "database_id" ||
          !sameNotionId(dataSource.parent.database_id, CONSTRUCTION_DATABASE_ID)
        ) {
          throw new Error("Construction Upload Inbox identity could not be verified");
        }
        const properties = dataSource.properties ?? {};
        for (const [name, allowedTypes] of Object.entries(CONSTRUCTION_PROPERTY_TYPES)) {
          const actualType = properties[name]?.type;
          if (!actualType || !(allowedTypes as readonly string[]).includes(actualType)) {
            throw new Error(
              `Construction Upload Inbox property is missing or incompatible: ${name}`,
            );
          }
        }
        return properties;
      })();
      this.schemaPromise = pending;
    }
    try {
      return await pending;
    } catch (error) {
      if (this.schemaPromise === pending) {
        this.schemaPromise = undefined;
      }
      throw error;
    }
  }

  private selectValue(
    propertyName: string,
    value: string,
    property: NotionPropertySchema,
  ): Record<string, unknown> {
    const options =
      property.type === "status" ? property.status?.options : property.select?.options;
    const optionExists = (options ?? []).some((option) => option.name === value);
    if (!optionExists) {
      throw new Error(`${propertyName} must use an existing Notion option`);
    }
    return property.type === "status" ? { status: { name: value } } : { select: { name: value } };
  }

  private propertyValue(
    propertyName: keyof typeof CONSTRUCTION_PROPERTY_TYPES,
    value: string,
    property: NotionPropertySchema,
  ): Record<string, unknown> {
    switch (property.type) {
      case "title":
        return { title: [{ type: "text", text: { content: value } }] };
      case "rich_text":
        return { rich_text: [{ type: "text", text: { content: value } }] };
      case "date": {
        if (!Number.isFinite(Date.parse(value))) {
          throw new Error(`${propertyName} must be an ISO date or date-time`);
        }
        return { date: { start: value } };
      }
      case "url": {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error(`${propertyName} must be a valid HTTPS URL`);
        }
        if (parsed.protocol !== "https:") {
          throw new Error(`${propertyName} must be a valid HTTPS URL`);
        }
        return { url: parsed.toString() };
      }
      case "select":
      case "status":
        return this.selectValue(propertyName, value, property);
      default:
        throw new Error(`Construction Upload Inbox property is not writable: ${propertyName}`);
    }
  }

  private async properties(values: ConstructionValues, signal?: AbortSignal) {
    const schema = await this.schema(signal);
    const fields: Array<[keyof typeof CONSTRUCTION_PROPERTY_TYPES, string | undefined]> = [
      ["Name", values.name],
      ["Captured At", values.capturedAt],
      ["Source", values.source],
      ["Sender", values.sender],
      ["Message", values.message],
      ["Media Type", values.mediaType],
      ["File URL", values.fileUrl],
      ["AI Summary", values.aiSummary],
      ["Status", values.status],
    ];
    return Object.fromEntries(
      fields
        .filter((entry): entry is [keyof typeof CONSTRUCTION_PROPERTY_TYPES, string] =>
          Boolean(entry[1]),
        )
        .map(([name, value]) => [name, this.propertyValue(name, value, schema[name]!)]),
    );
  }

  private async findByRecordId(recordId: string, signal?: AbortSignal): Promise<NotionPage[]> {
    await this.schema(signal);
    const result = await this.client.request<NotionQueryResponse>(
      `/v1/data_sources/${encodeURIComponent(CONSTRUCTION_DATA_SOURCE_ID)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 2,
          filter: {
            property: "Record ID",
            rich_text: { equals: recordId },
          },
        }),
      },
      signal,
    );
    const pages = result.results ?? [];
    for (const page of pages) {
      safePage(page, CONSTRUCTION_DATA_SOURCE_ID);
    }
    return pages;
  }

  async create(recordId: string, values: ConstructionValues, signal?: AbortSignal) {
    const existing = await this.findByRecordId(recordId, signal);
    if (existing.length > 0) {
      return { created: false, reason: "record_exists", pageId: existing[0]!.id };
    }
    const properties = await this.properties(values, signal);
    properties["Record ID"] = {
      rich_text: [{ type: "text", text: { content: recordId } }],
    };
    const page = await this.client.request<NotionPage>(
      "/v1/pages",
      {
        method: "POST",
        body: JSON.stringify({
          parent: {
            type: "data_source_id",
            data_source_id: CONSTRUCTION_DATA_SOURCE_ID,
          },
          properties,
        }),
      },
      signal,
    );
    const created = safePage(page, CONSTRUCTION_DATA_SOURCE_ID);
    return { created: true, pageId: created.id, recordId };
  }

  async update(recordId: string, values: ConstructionValues, signal?: AbortSignal) {
    const matches = await this.findByRecordId(recordId, signal);
    if (matches.length !== 1 || !matches[0]?.id) {
      throw new Error(
        matches.length === 0
          ? "Construction upload record was not found"
          : "Construction upload Record ID is not unique",
      );
    }
    const properties = await this.properties(values, signal);
    if (Object.keys(properties).length === 0) {
      throw new Error("At least one construction upload field must be updated");
    }
    const page = await this.client.request<NotionPage>(
      `/v1/pages/${encodeURIComponent(matches[0].id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      },
      signal,
    );
    const updated = safePage(page, CONSTRUCTION_DATA_SOURCE_ID);
    return { updated: true, pageId: updated.id, recordId };
  }
}

const WellnessQuerySchema = Type.Object(
  {
    data_source_index: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 100,
        default: 0,
        description:
          "Optional zero-based root-scoped data-source index. Omit to query across every discovered Wellness child database.",
      }),
    ),
    max_records: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_QUERY_RECORDS, default: 100 }),
    ),
    start_cursor: Type.Optional(
      Type.String({
        maxLength: 512,
        description: "Opaque nextCursor returned by the previous Wellness query.",
      }),
    ),
  },
  { additionalProperties: false },
);
const WellnessGetRecordSchema = Type.Object(
  {
    record_id: Type.String({ description: "Notion page ID returned by a Wellness query." }),
  },
  { additionalProperties: false },
);
const WellnessSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Text to match inside Wellness record properties." }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    max_records_scanned: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RECORDS, default: 500 }),
    ),
  },
  { additionalProperties: false },
);
const ConstructionCreateSchema = Type.Object(
  {
    record_id: Type.String({ description: "Stable business identifier for duplicate protection." }),
    name: Type.String(),
    captured_at: Type.String({ description: "ISO date or date-time." }),
    source: Type.String(),
    sender: Type.String(),
    message: Type.Optional(Type.String()),
    media_type: Type.String(),
    file_url: Type.String({ description: "HTTPS URL for the uploaded file." }),
    ai_summary: Type.Optional(Type.String()),
    status: Type.Optional(Type.String({ description: "Existing Notion Status option only." })),
  },
  { additionalProperties: false },
);
const ConstructionUpdateSchema = Type.Object(
  {
    record_id: Type.String({ description: "Stable Record ID in the Construction Upload Inbox." }),
    name: Type.Optional(Type.String()),
    captured_at: Type.Optional(Type.String({ description: "ISO date or date-time." })),
    source: Type.Optional(Type.String()),
    sender: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    media_type: Type.Optional(Type.String()),
    file_url: Type.Optional(Type.String({ description: "HTTPS URL for the uploaded file." })),
    ai_summary: Type.Optional(Type.String()),
    status: Type.Optional(Type.String({ description: "Existing Notion Status option only." })),
  },
  { additionalProperties: false },
);

const WELLNESS_QUERY_KEYS = new Set(["data_source_index", "max_records", "start_cursor"]);
const WELLNESS_GET_KEYS = new Set(["record_id"]);
const WELLNESS_SEARCH_KEYS = new Set(["query", "max_results", "max_records_scanned"]);
const CONSTRUCTION_CREATE_KEYS = new Set([
  "record_id",
  "name",
  "captured_at",
  "source",
  "sender",
  "message",
  "media_type",
  "file_url",
  "ai_summary",
  "status",
]);
const CONSTRUCTION_UPDATE_KEYS = new Set(CONSTRUCTION_CREATE_KEYS);

function constructionValues(
  params: Record<string, unknown>,
  required: boolean,
): ConstructionValues {
  return {
    name: readString(params, "name", { required }),
    capturedAt: readString(params, "captured_at", { required }),
    source: readString(params, "source", { required }),
    sender: readString(params, "sender", { required }),
    message: readString(params, "message"),
    mediaType: readString(params, "media_type", { required }),
    fileUrl: readString(params, "file_url", { required }),
    aiSummary: readString(params, "ai_summary"),
    status: readString(params, "status", { maxLength: 100 }),
  };
}

export const CLOUDBATH_NOTION_TOOL_NAMES = [
  "wellness_notion_query",
  "wellness_notion_get_record",
  "wellness_notion_search",
  "construction_upload_create",
  "construction_upload_update",
] as const;

export function createCloudbathNotionTools(fetchImpl: FetchLike = fetch) {
  const wellnessReader = () =>
    new WellnessNotionReader(
      new ScopedNotionClient("wellness", requireCredential("wellness"), fetchImpl),
    );
  const constructionWriter = () =>
    new ConstructionNotionWriter(
      new ScopedNotionClient("construction", requireCredential("construction"), fetchImpl),
    );
  return [
    {
      name: "wellness_notion_query",
      label: "Wellness Notion Query",
      description:
        "READ ONLY. Query records only from child databases directly beneath the configured Wellness root page. Cannot create, update, delete, archive, comment, or change schemas.",
      parameters: WellnessQuerySchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, WELLNESS_QUERY_KEYS);
        const dataSourceIndex = readDataSourceIndex(params);
        const maxRecords = readInteger(params, "max_records", 100, MAX_QUERY_RECORDS);
        const startCursor = readString(params, "start_cursor", { maxLength: 512 });
        return jsonResult(
          await wellnessReader().query(dataSourceIndex, maxRecords, startCursor, signal),
        );
      },
    },
    {
      name: "wellness_notion_get_record",
      label: "Wellness Notion Get Record",
      description:
        "READ ONLY. Retrieve one record only after proving it belongs to a data source discovered beneath the configured Wellness root page. Cannot mutate Notion.",
      parameters: WellnessGetRecordSchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, WELLNESS_GET_KEYS);
        const recordId = readString(params, "record_id", { required: true })!;
        return jsonResult(await wellnessReader().getRecord(recordId, signal));
      },
    },
    {
      name: "wellness_notion_search",
      label: "Wellness Notion Search",
      description:
        "READ ONLY. Search property values only inside data sources discovered beneath the configured Wellness root page; never workspace-wide. Cannot mutate Notion.",
      parameters: WellnessSearchSchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, WELLNESS_SEARCH_KEYS);
        const query = readString(params, "query", { required: true, maxLength: 500 })!;
        const maxResults = readInteger(params, "max_results", 20, 100);
        const maxRecordsScanned = readInteger(
          params,
          "max_records_scanned",
          500,
          MAX_SEARCH_RECORDS,
        );
        return jsonResult(
          await wellnessReader().search(query, maxResults, maxRecordsScanned, signal),
        );
      },
    },
    {
      name: "construction_upload_create",
      label: "Construction Upload Create",
      description:
        "WRITE ONLY to the fixed Construction Upload Inbox. Creates a record with allowlisted properties; cannot choose another database, mutate schemas, archive, or delete.",
      parameters: ConstructionCreateSchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, CONSTRUCTION_CREATE_KEYS);
        const recordId = readString(params, "record_id", { required: true })!;
        return jsonResult(
          await constructionWriter().create(recordId, constructionValues(params, true), signal),
        );
      },
    },
    {
      name: "construction_upload_update",
      label: "Construction Upload Update",
      description:
        "WRITE ONLY to an existing Record ID in the fixed Construction Upload Inbox. Cannot choose a page or database, mutate schemas, archive, or delete.",
      parameters: ConstructionUpdateSchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, CONSTRUCTION_UPDATE_KEYS);
        const recordId = readString(params, "record_id", { required: true })!;
        return jsonResult(
          await constructionWriter().update(recordId, constructionValues(params, false), signal),
        );
      },
    },
  ];
}
