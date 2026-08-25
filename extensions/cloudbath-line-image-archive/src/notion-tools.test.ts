import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUDBATH_NOTION_TOOL_NAMES, createCloudbathNotionTools } from "./notion-tools.js";

const WELLNESS_ROOT_PAGE_ID = "39575d42-f42b-808c-8a66-faed4274521b";
const WELLNESS_DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const WELLNESS_DATABASE_2_ID = "22222222-2222-4222-8222-222222222222";
const WELLNESS_DATA_SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WELLNESS_DATA_SOURCE_2_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WELLNESS_PAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WELLNESS_PAGE_2_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONSTRUCTION_DATABASE_ID = "9e0360ad-8993-480e-8b79-d7d269c4534e";
const CONSTRUCTION_DATA_SOURCE_ID = "22c0c780-106b-418b-8576-62d0b1fd1030";
const CONSTRUCTION_PAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WELLNESS_TEST_CREDENTIAL = "test-only-wellness-credential";
const CONSTRUCTION_TEST_CREDENTIAL = "test-only-construction-credential";

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown };
type TestTool = {
  name: string;
  description: string;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};

function tool(name: string, fetchImpl: typeof fetch): TestTool {
  const result = createCloudbathNotionTools(fetchImpl).find((candidate) => candidate.name === name);
  if (!result) {
    throw new Error(`Missing test tool ${name}`);
  }
  return result as TestTool;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function authorization(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

function wellnessPage(
  dataSourceId = WELLNESS_DATA_SOURCE_ID,
  pageId = WELLNESS_PAGE_ID,
  overrides: Record<string, unknown> = {},
) {
  return {
    object: "page",
    id: pageId,
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    created_time: "2026-08-01T01:02:03.000Z",
    last_edited_time: "2026-08-02T01:02:03.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Wellness cashflow" }] },
      Amount: { type: "number", number: 125 },
    },
    ...overrides,
  };
}

function childDatabaseBlock(id: string) {
  return {
    object: "block",
    id,
    type: "child_database",
    child_database: { title: "Wellness child database" },
  };
}

function constructionSchema() {
  return {
    Name: { type: "title", title: {} },
    "Captured At": { type: "date", date: {} },
    Source: { type: "rich_text", rich_text: {} },
    Sender: { type: "rich_text", rich_text: {} },
    Message: { type: "rich_text", rich_text: {} },
    "Media Type": { type: "select", select: { options: [{ name: "image" }] } },
    "File URL": { type: "url", url: {} },
    "AI Summary": { type: "rich_text", rich_text: {} },
    Status: { type: "status", status: { options: [{ name: "New" }, { name: "Reviewed" }] } },
    "Record ID": { type: "rich_text", rich_text: {} },
    Created: { type: "created_time", created_time: {} },
  };
}

function constructionPage(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    id: CONSTRUCTION_PAGE_ID,
    parent: { type: "data_source_id", data_source_id: CONSTRUCTION_DATA_SOURCE_ID },
    properties: {},
    ...overrides,
  };
}

function validConstructionCreate() {
  return {
    record_id: "line-message-001",
    name: "Site progress upload",
    captured_at: "2026-08-01T01:02:03.000Z",
    source: "LINE",
    sender: "Pilot user",
    message: "Sauna wall progress",
    media_type: "image",
    file_url: "https://example.invalid/private-object",
    status: "New",
  };
}

beforeEach(() => {
  vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", WELLNESS_TEST_CREDENTIAL);
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", CONSTRUCTION_TEST_CREDENTIAL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Cloudbath scoped Notion tools", () => {
  it("registers only the five declared tools", () => {
    const names = createCloudbathNotionTools(vi.fn() as typeof fetch).map(
      (candidate) => candidate.name,
    );
    expect(names).toEqual(CLOUDBATH_NOTION_TOOL_NAMES);
  });

  it("treats the configured Wellness ID as a root page and reads multiple child databases", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: authorization(init),
      });
      if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
        return Response.json({
          results: [
            childDatabaseBlock(WELLNESS_DATABASE_ID),
            childDatabaseBlock(WELLNESS_DATABASE_2_ID),
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_ID }],
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_2_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_2_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_2_ID }],
        });
      }
      if (url.endsWith(`/v1/data_sources/${WELLNESS_DATA_SOURCE_ID}/query`)) {
        return Response.json({
          results: [wellnessPage()],
          has_more: false,
          next_cursor: null,
        });
      }
      if (url.endsWith(`/v1/data_sources/${WELLNESS_DATA_SOURCE_2_ID}/query`)) {
        return Response.json({
          results: [wellnessPage(WELLNESS_DATA_SOURCE_2_ID, WELLNESS_PAGE_2_ID)],
          has_more: false,
          next_cursor: null,
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await tool("wellness_notion_query", fetchImpl).execute("call", {
      max_records: 10,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        rootPageId: WELLNESS_ROOT_PAGE_ID,
        databaseCount: 2,
        dataSourceCount: 2,
        recordCount: 2,
      }),
    );
    expect(
      requests.some((request) => request.url.endsWith(`/v1/databases/${WELLNESS_ROOT_PAGE_ID}`)),
    ).toBe(false);
    expect(
      requests.every((request) => request.authorization === `Bearer ${WELLNESS_TEST_CREDENTIAL}`),
    ).toBe(true);
    expect(requests.every((request) => !["PATCH", "PUT", "DELETE"].includes(request.method))).toBe(
      true,
    );
    expect(requests.some((request) => request.url.endsWith("/v1/pages"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(WELLNESS_TEST_CREDENTIAL);
    expect(JSON.stringify(result)).not.toContain(CONSTRUCTION_TEST_CREDENTIAL);
  });

  it("paginates root-page block discovery before retrieving child databases", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("start_cursor")) {
          return Response.json({
            results: [childDatabaseBlock(WELLNESS_DATABASE_ID)],
            has_more: true,
            next_cursor: "root-page-2",
          });
        }
        expect(parsed.searchParams.get("start_cursor")).toBe("root-page-2");
        return Response.json({
          results: [childDatabaseBlock(WELLNESS_DATABASE_2_ID)],
          has_more: false,
          next_cursor: null,
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_ID }],
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_2_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_2_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_2_ID }],
        });
      }
      if (url.includes("/query")) {
        return Response.json({ results: [], has_more: false, next_cursor: null });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await tool("wellness_notion_query", fetchImpl).execute("call", {
      max_records: 10,
    });

    expect(result.details).toEqual(
      expect.objectContaining({ databaseCount: 2, dataSourceCount: 2 }),
    );
    expect(
      urls.filter((url) => url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)),
    ).toHaveLength(2);
  });

  it("continues root-scoped data-source pagination with an opaque tool cursor", async () => {
    const notionCursor = "notion-page-2";
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
        return Response.json({
          results: [childDatabaseBlock(WELLNESS_DATABASE_ID)],
          has_more: false,
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_ID }],
        });
      }
      if (url.endsWith(`/v1/data_sources/${WELLNESS_DATA_SOURCE_ID}/query`)) {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        bodies.push(body);
        return Response.json(
          body.start_cursor
            ? { results: [wellnessPage()], has_more: false, next_cursor: null }
            : {
                results: [wellnessPage()],
                has_more: true,
                next_cursor: notionCursor,
              },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const first = await tool("wellness_notion_query", fetchImpl).execute("call", {
      max_records: 1,
    });
    const nextCursor = (first.details as { nextCursor: string }).nextCursor;
    expect(nextCursor).toBeTruthy();
    expect(nextCursor).not.toBe(notionCursor);

    const second = await tool("wellness_notion_query", fetchImpl).execute("call", {
      max_records: 1,
      start_cursor: nextCursor,
    });

    expect(second.details).toEqual(expect.objectContaining({ recordCount: 1, hasMore: false }));
    expect(bodies).toEqual([{ page_size: 1 }, { page_size: 1, start_cursor: notionCursor }]);
  });

  it("searches only discovered root-scoped data sources and never uses workspace search", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
        return Response.json({
          results: [childDatabaseBlock(WELLNESS_DATABASE_ID)],
          has_more: false,
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_ID }],
        });
      }
      if (url.endsWith(`/v1/data_sources/${WELLNESS_DATA_SOURCE_ID}/query`)) {
        return Response.json({ results: [wellnessPage()], has_more: false, next_cursor: null });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await tool("wellness_notion_search", fetchImpl).execute("call", {
      query: "cashflow",
      max_results: 5,
      max_records_scanned: 20,
    });

    expect(result.details).toEqual(expect.objectContaining({ scannedRecords: 1 }));
    expect(urls.some((url) => url.endsWith("/v1/search"))).toBe(false);
    expect(urls.every((url) => !url.includes("/v1/pages/"))).toBe(true);
  });

  it("does not return a record that escapes the discovered root-page scope", async () => {
    const urls: string[] = [];
    const foreignDataSourceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
        return Response.json({
          results: [childDatabaseBlock(WELLNESS_DATABASE_ID)],
          has_more: false,
        });
      }
      if (url.endsWith(`/v1/databases/${WELLNESS_DATABASE_ID}`)) {
        return Response.json({
          object: "database",
          id: WELLNESS_DATABASE_ID,
          data_sources: [{ id: WELLNESS_DATA_SOURCE_ID }],
        });
      }
      if (url.endsWith(`/v1/data_sources/${WELLNESS_DATA_SOURCE_ID}/query`)) {
        return Response.json({
          results: [wellnessPage(foreignDataSourceId)],
          has_more: false,
          next_cursor: null,
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      tool("wellness_notion_get_record", fetchImpl).execute("call", {
        record_id: WELLNESS_PAGE_ID,
      }),
    ).rejects.toThrow("outside the configured data source");
    expect(urls.some((url) => url.includes("/v1/pages/"))).toBe(false);
  });

  it("exposes no Wellness mutation path and rejects model-supplied targets", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    for (const name of [
      "wellness_notion_query",
      "wellness_notion_get_record",
      "wellness_notion_search",
    ]) {
      const wellnessTool = tool(name, fetchImpl);
      expect(wellnessTool.description).toContain("READ ONLY");
      expect(wellnessTool.description.toLowerCase()).toContain("cannot");
    }
    await expect(
      tool("wellness_notion_query", fetchImpl).execute("call", {
        database_id: CONSTRUCTION_DATABASE_ID,
      }),
    ).rejects.toThrow("Unsupported tool parameter");
    await expect(
      tool("wellness_notion_search", fetchImpl).execute("call", {
        query: "cashflow",
        page_id: WELLNESS_ROOT_PAGE_ID,
      }),
    ).rejects.toThrow("Unsupported tool parameter");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns safe Notion status, code, and message diagnostics without credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          object: "error",
          status: 400,
          code: "validation_error",
          message: `Invalid root ${WELLNESS_TEST_CREDENTIAL}; Bearer provider-secret`,
        },
        { status: 400 },
      ),
    ) as typeof fetch;

    let message = "";
    try {
      await tool("wellness_notion_query", fetchImpl).execute("call", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("status 400");
    expect(message).toContain("code validation_error");
    expect(message).toContain("Invalid root");
    expect(message).not.toContain(WELLNESS_TEST_CREDENTIAL);
    expect(message).not.toContain("provider-secret");
    expect(message).toContain("[REDACTED]");
  });

  it("creates only in the allowlisted Construction Upload Inbox with its own credential", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}`)) {
        return Response.json({
          id: CONSTRUCTION_DATA_SOURCE_ID,
          parent: { type: "database_id", database_id: CONSTRUCTION_DATABASE_ID },
          properties: constructionSchema(),
        });
      }
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}/query`)) {
        return Response.json({ results: [], has_more: false, next_cursor: null });
      }
      if (url.endsWith("/v1/pages")) {
        return Response.json(constructionPage());
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await tool("construction_upload_create", fetchImpl).execute(
      "call",
      validConstructionCreate(),
    );

    expect(result.details).toEqual({
      created: true,
      pageId: CONSTRUCTION_PAGE_ID,
      recordId: "line-message-001",
    });
    expect(
      requests.every(
        (request) => authorization(request.init) === `Bearer ${CONSTRUCTION_TEST_CREDENTIAL}`,
      ),
    ).toBe(true);
    expect(requests.every((request) => !request.url.includes(WELLNESS_ROOT_PAGE_ID))).toBe(true);
    const createRequest = requests.find((request) => request.url.endsWith("/v1/pages"));
    expect(JSON.parse(createRequest?.init?.body as string)).toEqual(
      expect.objectContaining({
        parent: {
          type: "data_source_id",
          data_source_id: CONSTRUCTION_DATA_SOURCE_ID,
        },
      }),
    );
  });

  it("rejects arbitrary Construction and Wellness targets before using the writer", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(
      tool("construction_upload_create", fetchImpl).execute("call", {
        ...validConstructionCreate(),
        database_id: WELLNESS_ROOT_PAGE_ID,
      }),
    ).rejects.toThrow("Unsupported tool parameter");
    await expect(
      tool("construction_upload_update", fetchImpl).execute("call", {
        record_id: "line-message-001",
        page_id: WELLNESS_PAGE_ID,
        message: "attempted redirect",
      }),
    ).rejects.toThrow("Unsupported tool parameter");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("updates only the page resolved by Record ID inside the allowlisted data source", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}`)) {
        return Response.json({
          id: CONSTRUCTION_DATA_SOURCE_ID,
          parent: { type: "database_id", database_id: CONSTRUCTION_DATABASE_ID },
          properties: constructionSchema(),
        });
      }
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}/query`)) {
        return Response.json({ results: [constructionPage()], has_more: false });
      }
      if (url.endsWith(`/v1/pages/${CONSTRUCTION_PAGE_ID}`)) {
        return Response.json(constructionPage());
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await tool("construction_upload_update", fetchImpl).execute("call", {
      record_id: "line-message-001",
      message: "Reviewed on site",
      status: "Reviewed",
    });

    expect(result.details).toEqual({
      updated: true,
      pageId: CONSTRUCTION_PAGE_ID,
      recordId: "line-message-001",
    });
    const patch = requests.find((request) => request.init?.method === "PATCH");
    expect(patch?.url).toBe(`https://api.notion.com/v1/pages/${CONSTRUCTION_PAGE_ID}`);
    expect(JSON.parse(patch?.init?.body as string)).toEqual({
      properties: {
        Message: { rich_text: [{ type: "text", text: { content: "Reviewed on site" } }] },
        Status: { status: { name: "Reviewed" } },
      },
    });
  });

  it("refuses unknown select options instead of mutating the Construction schema", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}`)) {
        return Response.json({
          id: CONSTRUCTION_DATA_SOURCE_ID,
          parent: { type: "database_id", database_id: CONSTRUCTION_DATABASE_ID },
          properties: constructionSchema(),
        });
      }
      if (url.endsWith(`/v1/data_sources/${CONSTRUCTION_DATA_SOURCE_ID}/query`)) {
        return Response.json({ results: [], has_more: false });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    await expect(
      tool("construction_upload_create", fetchImpl).execute("call", {
        ...validConstructionCreate(),
        status: "model-invented-status",
      }),
    ).rejects.toThrow("existing Notion option");
    expect(requests.some((request) => request.url.endsWith("/v1/pages"))).toBe(false);
    expect(requests.some((request) => request.init?.method === "PATCH")).toBe(false);
  });

  it("sanitizes provider failures and never returns credential material", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`${WELLNESS_TEST_CREDENTIAL}:${CONSTRUCTION_TEST_CREDENTIAL}`);
    }) as typeof fetch;

    let message = "";
    try {
      await tool("wellness_notion_query", fetchImpl).execute("call", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Notion service request failed");
    expect(message).not.toContain(WELLNESS_TEST_CREDENTIAL);
    expect(message).not.toContain(CONSTRUCTION_TEST_CREDENTIAL);
  });

  it("fails safely when either scoped connection is not configured", async () => {
    vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "");
    vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "");
    vi.stubEnv("OPENCLAW_NOTION_WRITE_TOKEN", "legacy-placeholder");
    vi.stubEnv("NOTION_CONSTRUCTION_WRITE_TOKEN", "legacy-placeholder");
    const fetchImpl = vi.fn() as typeof fetch;

    await expect(tool("wellness_notion_query", fetchImpl).execute("call", {})).rejects.toThrow(
      "Wellness Notion connection is not configured",
    );
    await expect(
      tool("construction_upload_create", fetchImpl).execute("call", validConstructionCreate()),
    ).rejects.toThrow("Construction Notion connection is not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
