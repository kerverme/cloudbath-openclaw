import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { NOTION_API_VERSION } from "./notion-schema.js";
import { isRetryableStatus, withBoundedRetry } from "./retry.js";

const NOTION_BASE_URL = "https://api.notion.com";
const WELLNESS_ROOT_PAGE_ID = "39575d42-f42b-808c-8a66-faed4274521b";
const CONSTRUCTION_DATABASE_ID = "9e0360ad-8993-480e-8b79-d7d269c4534e";
const CONSTRUCTION_DATA_SOURCE_ID = "22c0c780-106b-418b-8576-62d0b1fd1030";
const WELLNESS_TOKEN_ENV = "NOTION_WELLNESS_READ_TOKEN";
const CONSTRUCTION_TOKEN_ENV = "OPEN_CLAW_NOTION_WRITE_TOKEN";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_NOTION_TEXT_LENGTH = 1_900;
const MAX_QUERY_RECORDS = 500;
const MAX_SEARCH_RECORDS = 1_000;
const MAX_GET_RECORDS = 100;
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
  title?: Array<{ plain_text?: unknown }>;
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
  databaseTitle?: string;
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
/** A Wellness row as the model sees it: plain property values, no Notion wrappers. */
export type WellnessRecord = {
  id: string;
  database?: string;
  dataSourceIndex: number;
  createdAt?: string;
  lastEditedAt?: string;
  properties: Record<string, unknown>;
};
/** One data source beneath the Wellness root page, by its discovery index. */
export type WellnessTable = Readonly<{
  dataSourceIndex: number;
  dataSourceId: string;
  title?: string;
}>;
/** Every row of one table, read in one operation. */
export type WellnessTableRows = Readonly<{
  records: readonly WellnessRecord[];
  /** Notion property type by name, e.g. `number`, `formula`, `date`, `title`. */
  propertyTypes: Readonly<Record<string, string>>;
  /** False when the table has more rows than one read may scan. */
  complete: boolean;
}>;
type WellnessQueryCursor = {
  version: 1;
  sourceIndex: number;
  notionCursor?: string;
  /** Set when the query named one data source: continuing it must not spill into the next. */
  singleSource?: true;
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

function readRecordIds(params: Record<string, unknown>): string[] | undefined {
  const raw = params.record_ids;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_GET_RECORDS) {
    throw new Error(`record_ids must list 1 to ${MAX_GET_RECORDS} record IDs`);
  }
  return raw.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("record_ids must contain record ID strings");
    }
    return id.trim();
  });
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
    const singleSource: unknown = parsed.singleSource;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.sourceIndex) ||
      (parsed.sourceIndex as number) < 0 ||
      (parsed.sourceIndex as number) > MAX_WELLNESS_CHILD_DATABASES * 100 ||
      (parsed.notionCursor !== undefined &&
        (typeof parsed.notionCursor !== "string" ||
          parsed.notionCursor.length === 0 ||
          parsed.notionCursor.length > 512)) ||
      (singleSource !== undefined && singleSource !== true)
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

type NotionRichText = Array<{ plain_text?: unknown }>;
type NotionUser = { id?: unknown; name?: unknown };
type NotionDate = { start?: unknown; end?: unknown; time_zone?: unknown } | null;
type NotionFile = { name?: unknown; type?: unknown; external?: { url?: unknown } };

function plainText(value: unknown): string {
  return Array.isArray(value)
    ? (value as NotionRichText)
        .map((item) => (typeof item?.plain_text === "string" ? item.plain_text : ""))
        .join("")
    : "";
}

function plainUser(user: NotionUser | null | undefined): unknown {
  return typeof user?.name === "string" && user.name ? user.name : (user?.id ?? null);
}

function plainDate(date: NotionDate | undefined): unknown {
  if (!date) {
    return null;
  }
  // A lone start stays the exact Notion date string; ranges and zones keep every part.
  if (date.end == null && date.time_zone == null) {
    return date.start ?? null;
  }
  return {
    start: date.start ?? null,
    ...(date.end != null ? { end: date.end } : {}),
    ...(date.time_zone != null ? { timeZone: date.time_zone } : {}),
  };
}

function plainFile(file: NotionFile): unknown {
  // Notion-hosted file URLs are short-lived signed links carrying temporary storage
  // credentials; only the name is stable. External files keep their own URL.
  return file.type === "external" && typeof file.external?.url === "string"
    ? { name: file.name ?? null, url: file.external.url }
    : (file.name ?? null);
}

/**
 * Reduces one Notion property value to the value a person would read in the
 * table. Type wrappers, option ids and colors, annotations, avatars, and signed
 * file links are dropped; unknown types keep their unwrapped value.
 */
function plainPropertyValue(property: unknown): unknown {
  if (!property || typeof property !== "object") {
    return property ?? null;
  }
  const record = property as Record<string, unknown> & { type?: unknown };
  const type = typeof record.type === "string" ? record.type : undefined;
  if (!type) {
    return null;
  }
  const value = record[type];
  switch (type) {
    case "title":
    case "rich_text":
      return plainText(value);
    case "select":
    case "status":
      return (value as { name?: unknown } | null)?.name ?? null;
    case "multi_select":
      return Array.isArray(value)
        ? value.map((option: { name?: unknown }) => option?.name ?? null)
        : [];
    case "date":
      return plainDate(value as NotionDate);
    case "people":
      return Array.isArray(value) ? value.map((user: NotionUser) => plainUser(user)) : [];
    case "created_by":
    case "last_edited_by":
      return plainUser(value as NotionUser);
    case "files":
      return Array.isArray(value) ? value.map((file: NotionFile) => plainFile(file)) : [];
    case "relation": {
      const ids = Array.isArray(value) ? value.map((item: { id?: unknown }) => item?.id) : [];
      // Notion lists at most 25 relations per page read; say so instead of implying all.
      return record.has_more === true ? { ids, hasMore: true } : ids;
    }
    case "formula": {
      const formula = value as { type?: unknown } & Record<string, unknown>;
      if (typeof formula?.type !== "string") {
        return null;
      }
      return formula.type === "date"
        ? plainDate(formula.date as NotionDate)
        : (formula[formula.type] ?? null);
    }
    case "rollup": {
      const rollup = value as { type?: unknown } & Record<string, unknown>;
      if (rollup?.type === "array") {
        return Array.isArray(rollup.array) ? rollup.array.map(plainPropertyValue) : [];
      }
      if (rollup?.type === "date") {
        return plainDate(rollup.date as NotionDate);
      }
      return typeof rollup?.type === "string" ? (rollup[rollup.type] ?? null) : null;
    }
    case "unique_id": {
      const unique = value as { prefix?: unknown; number?: unknown } | null;
      if (typeof unique?.number !== "number") {
        return null;
      }
      return typeof unique.prefix === "string" && unique.prefix
        ? `${unique.prefix}-${unique.number}`
        : unique.number;
    }
    case "verification":
      return (value as { state?: unknown } | null)?.state ?? null;
    default:
      return value ?? null;
  }
}

function wellnessRecord(
  page: SafeNotionPage,
  scope: WellnessDataSourceScope,
  dataSourceIndex: number,
): WellnessRecord {
  return {
    id: page.id,
    ...(scope.databaseTitle ? { database: scope.databaseTitle } : {}),
    dataSourceIndex,
    ...(page.createdAt ? { createdAt: page.createdAt } : {}),
    ...(page.lastEditedAt ? { lastEditedAt: page.lastEditedAt } : {}),
    properties: Object.fromEntries(
      Object.entries(page.properties).map(([name, property]) => [
        name,
        plainPropertyValue(property),
      ]),
    ),
  };
}

/**
 * Wellness results are read by the model through a per-result character cap;
 * unindented JSON fits about 1.5x the rows under it that pretty-printed JSON does.
 */
function compactJsonResult<T>(payload: T) {
  return textResult(JSON.stringify(payload), payload);
}

class WellnessNotionReader {
  private scopesPromise: Promise<WellnessDataSourceScope[]> | undefined;

  constructor(private readonly client: ScopedNotionClient) {}

  private async discoverScopes(signal?: AbortSignal): Promise<WellnessDataSourceScope[]> {
    let pending = this.scopesPromise;
    if (!pending) {
      pending = (async () => {
        const childDatabaseIds: string[] = [];
        const childDatabaseTitles = new Map<string, string>();
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
              const databaseKey = canonicalNotionId(block.id);
              const title = block.child_database?.title?.trim();
              if (title) {
                childDatabaseTitles.set(databaseKey, title);
              }
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
            // A linked or full-page database block carries no title of its own;
            // the database does, and it is what owners call the table.
            const databaseTitle =
              childDatabaseTitles.get(canonicalNotionId(databaseId)) ||
              plainText(database.title).trim() ||
              undefined;
            scopes.push({
              databaseId,
              dataSourceId: source.id,
              ...(databaseTitle ? { databaseTitle } : {}),
            });
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
    // Continuing one data source is naturally asked with both its index and the
    // cursor; only a cursor from a different source is a contradiction.
    if (decoded && dataSourceIndex !== undefined && decoded.sourceIndex !== dataSourceIndex) {
      throw new Error("start_cursor belongs to a different data_source_index");
    }
    let sourceIndex = decoded?.sourceIndex ?? dataSourceIndex ?? 0;
    if (!scopes[sourceIndex]) {
      throw new Error("Wellness continuation is outside the root-page scope");
    }
    const singleSource = dataSourceIndex !== undefined || decoded?.singleSource === true;
    const records: WellnessRecord[] = [];
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
      records.push(...result.records.map((page) => wellnessRecord(page, scope, sourceIndex)));
      scanned += result.scanned;
      if (result.hasMore) {
        if (!result.nextCursor) {
          throw new Error("Wellness Notion continuation cursor is missing");
        }
        nextCursor = encodeWellnessCursor({
          version: 1,
          sourceIndex,
          notionCursor: result.nextCursor,
          ...(singleSource ? { singleSource: true } : {}),
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
      ...(singleSource ? { dataSourceIndex: sourceIndex } : {}),
    };
  }

  async listTables(signal?: AbortSignal): Promise<readonly WellnessTable[]> {
    return (await this.discoverScopes(signal)).map((scope, dataSourceIndex) =>
      scope.databaseTitle
        ? { dataSourceIndex, dataSourceId: scope.dataSourceId, title: scope.databaseTitle }
        : { dataSourceIndex, dataSourceId: scope.dataSourceId },
    );
  }

  /**
   * Every row of one discovered data source, paging inside this call up to the
   * scan limit, so a caller totalling a table never walks cursors turn by turn.
   */
  async readTable(dataSourceIndex: number, signal?: AbortSignal): Promise<WellnessTableRows> {
    const scope = (await this.discoverScopes(signal))[dataSourceIndex];
    if (!scope) {
      throw new Error("Wellness table is outside the root-page scope");
    }
    const result = await this.queryDataSource(scope.dataSourceId, MAX_SEARCH_RECORDS, signal);
    const propertyTypes: Record<string, string> = {};
    for (const page of result.records) {
      for (const [name, property] of Object.entries(page.properties)) {
        const type = (property as { type?: unknown } | null)?.type;
        if (typeof type === "string" && !(name in propertyTypes)) {
          propertyTypes[name] = type;
        }
      }
    }
    return {
      records: result.records.map((page) => wellnessRecord(page, scope, dataSourceIndex)),
      propertyTypes,
      complete: !result.hasMore,
    };
  }

  /**
   * Finds the requested records in one pass over the discovered data sources,
   * stopping once all are found. Records are only ever read through a scoped
   * data-source query, so an id outside the root page is reported missing,
   * never fetched.
   */
  async getRecords(recordIds: string[], signal?: AbortSignal) {
    const wanted = new Map(recordIds.map((id) => [canonicalNotionId(id), id]));
    const found = new Map<string, WellnessRecord>();
    const scopes = await this.discoverScopes(signal);
    for (const [index, scope] of scopes.entries()) {
      if (found.size === wanted.size) {
        break;
      }
      await this.queryDataSource(scope.dataSourceId, 10_000, signal, (page) => {
        const key = canonicalNotionId(page.id);
        if (wanted.has(key) && !found.has(key)) {
          found.set(key, wellnessRecord(page, scope, index));
        }
        return found.size === wanted.size ? "stop" : false;
      });
    }
    return {
      records: [...wanted.keys()].flatMap((key) => found.get(key) ?? []),
      missing: [...wanted].filter(([key]) => !found.has(key)).map(([, id]) => id),
    };
  }

  async search(query: string, maxResults: number, maxRecordsScanned: number, signal?: AbortSignal) {
    const needle = query.toLocaleLowerCase();
    const matches: WellnessRecord[] = [];
    let scanned = 0;
    let hasMore = false;
    const scopes = await this.discoverScopes(signal);
    for (const [index, scope] of scopes.entries()) {
      if (scanned >= maxRecordsScanned || matches.length >= maxResults) {
        hasMore = true;
        break;
      }
      const result = await this.queryDataSource(
        scope.dataSourceId,
        maxRecordsScanned - scanned,
        signal,
        (page) => {
          // Match what the row says, not Notion's wrapper keys, option ids, or colors.
          const record = wellnessRecord(page, scope, index);
          const matched = JSON.stringify(record.properties).toLocaleLowerCase().includes(needle);
          if (matched && matches.length < maxResults) {
            matches.push(record);
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
        description:
          "Opaque nextCursor returned by the previous Wellness query; it continues the same data source(s).",
      }),
    ),
  },
  { additionalProperties: false },
);
const WellnessGetRecordSchema = Type.Object(
  {
    record_id: Type.Optional(
      Type.String({ description: "One Notion page ID returned by a Wellness query or search." }),
    ),
    record_ids: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MAX_GET_RECORDS,
        description:
          "Several Notion page IDs returned by a Wellness query or search, fetched in one call. Use instead of record_id when more than one record needs detail.",
      }),
    ),
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
const WELLNESS_GET_KEYS = new Set(["record_id", "record_ids"]);
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

/** Read-only access to whole Wellness tables, under the same root-page scope as the tools. */
export function createWellnessTableReader(
  fetchImpl: FetchLike = fetch,
): Pick<WellnessNotionReader, "listTables" | "readTable"> {
  return new WellnessNotionReader(
    new ScopedNotionClient("wellness", requireCredential("wellness"), fetchImpl),
  );
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
        "READ ONLY. Query records only from child databases directly beneath the configured Wellness root page. Each returned record already carries every property as a plain value (text, numbers, dates, options, people, relations, formulas, rollups), so totals and summaries can be computed from one query; do not fetch records one by one to read them. Cannot create, update, delete, archive, comment, or change schemas.",
      parameters: WellnessQuerySchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, WELLNESS_QUERY_KEYS);
        const dataSourceIndex = readDataSourceIndex(params);
        const maxRecords = readInteger(params, "max_records", 100, MAX_QUERY_RECORDS);
        const startCursor = readString(params, "start_cursor", { maxLength: 512 });
        return compactJsonResult(
          await wellnessReader().query(dataSourceIndex, maxRecords, startCursor, signal),
        );
      },
    },
    {
      name: "wellness_notion_get_record",
      label: "Wellness Notion Get Record",
      description:
        "READ ONLY. Retrieve records only after proving they belong to a data source discovered beneath the configured Wellness root page. Query and search results already include every property, so use this only when a known record's details are missing; pass all such IDs together in record_ids rather than one call per record. Cannot mutate Notion.",
      parameters: WellnessGetRecordSchema,
      execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
        const params = paramsRecord(rawParams);
        assertAllowedKeys(params, WELLNESS_GET_KEYS);
        const recordId = readString(params, "record_id");
        const recordIds = readRecordIds(params);
        if (Boolean(recordId) === Boolean(recordIds)) {
          throw new Error("Provide exactly one of record_id or record_ids");
        }
        const result = await wellnessReader().getRecords(recordIds ?? [recordId!], signal);
        if (recordIds) {
          return compactJsonResult(result);
        }
        const [record] = result.records;
        if (!record) {
          throw new Error("Wellness record is outside the allowed root page or does not exist");
        }
        return compactJsonResult(record);
      },
    },
    {
      name: "wellness_notion_search",
      label: "Wellness Notion Search",
      description:
        "READ ONLY. Search property values only inside data sources discovered beneath the configured Wellness root page; never workspace-wide. Each match already carries every property as a plain value; do not fetch matches one by one to read them. Cannot mutate Notion.",
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
        return compactJsonResult(
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
