import { describe, expect, it, vi } from "vitest";
import {
  createNotionArchiveProperties,
  NOTION_STATUS_OPTIONS,
} from "../../extensions/cloudbath-line-image-archive/src/notion-schema.js";
import {
  NOTION_DATABASE_NAME,
  readNotionSetupConfig,
  runNotionSetup,
} from "./setup-notion-image-archive.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function retrievedProperties() {
  return Object.fromEntries(
    Object.entries(createNotionArchiveProperties()).map(([name, property]) => {
      const propertyType = Object.keys(property as Record<string, unknown>)[0];
      const retrieved = { type: propertyType, ...(property as Record<string, unknown>) };
      return [name, retrieved];
    }),
  );
}

function database(id = "database-1", dataSourceId = "source-1") {
  return { id, data_sources: [{ id: dataSourceId, name: NOTION_DATABASE_NAME }] };
}

describe("Cloudbath Notion image archive setup", () => {
  it("reads only the approved environment variables", () => {
    const reads: string[] = [];
    const env = new Proxy(
      {
        NOTION_API_KEY: "token-placeholder",
        NOTION_PARENT_PAGE_ID: "parent-1",
        NOTION_DATABASE_ID: undefined,
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(readNotionSetupConfig(env)).toEqual({
      apiKey: "token-placeholder",
      parentPageId: "parent-1",
      databaseId: undefined,
    });
    expect(reads).toEqual([
      "NOTION_API_KEY",
      "NOTION_PARENT_PAGE_ID",
      "NOTION_DATABASE_ID",
    ]);
  });

  it("validates an explicitly configured database without modifying it", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/databases/database-1")) {
        return jsonResponse(database());
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse({ id: "source-1", properties: retrievedProperties() });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const output = vi.fn();

    await expect(
      runNotionSetup(
        { apiKey: "token-placeholder", databaseId: "database-1" },
        { fetchImpl, output },
      ),
    ).resolves.toEqual({
      kind: "validated",
      databaseId: "database-1",
      dataSourceId: "source-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET")).toBe(true);
    expect(output).not.toHaveBeenCalledWith(expect.stringContaining("token-placeholder"));
  });

  it("reports every missing or incompatible property and exact Status options", async () => {
    const properties = retrievedProperties();
    delete properties["LINE User ID"];
    properties.Amount = { type: "rich_text", rich_text: {} };
    properties.Status = {
      type: "select",
      select: { options: [{ name: "PROCESSED" }, { name: "EXTRA" }] },
    };
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/databases/database-1")) {
          return jsonResponse(database());
        }
        return jsonResponse({ id: "source-1", properties });
      },
    ) as typeof fetch;

    await expect(
      runNotionSetup({ apiKey: "token-placeholder", databaseId: "database-1" }, { fetchImpl }),
    ).rejects.toThrow(
      /Missing property "LINE User ID"[\s\S]*Property "Amount" has type rich_text[\s\S]*Property "Status" must have exactly these select options/,
    );
    expect(fetchImpl.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET")).toBe(true);
  });

  it("reuses an exact-name child database instead of creating another", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/blocks/parent-1/children")) {
        return jsonResponse({
          results: [
            {
              id: "database-1",
              type: "child_database",
              child_database: { title: NOTION_DATABASE_NAME },
            },
          ],
          has_more: false,
        });
      }
      if (url.endsWith("/v1/databases/database-1")) {
        return jsonResponse(database());
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse({ id: "source-1", properties: retrievedProperties() });
      }
      throw new Error(`Unexpected URL ${url} (${init?.method ?? "GET"})`);
    }) as typeof fetch;

    await expect(
      runNotionSetup(
        { apiKey: "token-placeholder", parentPageId: "parent-1" },
        { fetchImpl, output: vi.fn() },
      ),
    ).resolves.toEqual({
      kind: "reused",
      databaseId: "database-1",
      dataSourceId: "source-1",
    });
    expect(fetchImpl.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET")).toBe(true);
  });

  it("creates one exact-schema database and validates its data source", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/v1/blocks/parent-1/children")) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (url.endsWith("/v1/databases") && init?.method === "POST") {
        return jsonResponse(database());
      }
      if (url.endsWith("/v1/databases/database-1")) {
        return jsonResponse(database());
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse({ id: "source-1", properties: retrievedProperties() });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const output = vi.fn();

    await expect(
      runNotionSetup(
        { apiKey: "token-placeholder", parentPageId: "parent-1" },
        { fetchImpl, output },
      ),
    ).resolves.toEqual({
      kind: "created",
      databaseId: "database-1",
      dataSourceId: "source-1",
    });

    const creates = requests.filter(
      (request) => request.url.endsWith("/v1/databases") && request.init?.method === "POST",
    );
    expect(creates).toHaveLength(1);
    const body = JSON.parse(String(creates[0]?.init?.body)) as {
      parent: { type: string; page_id: string };
      title: Array<{ text: { content: string } }>;
      initial_data_source: {
        title: Array<{ text: { content: string } }>;
        properties: Record<string, unknown>;
      };
    };
    expect(body.parent).toEqual({ type: "page_id", page_id: "parent-1" });
    expect(body.title[0]?.text.content).toBe(NOTION_DATABASE_NAME);
    expect(body.initial_data_source.title[0]?.text.content).toBe(NOTION_DATABASE_NAME);
    expect(body.initial_data_source.properties).toEqual(createNotionArchiveProperties());
    expect(
      (
        body.initial_data_source.properties.Status as {
          select: { options: Array<{ name: string }> };
        }
      ).select.options.map((option) => option.name),
    ).toEqual(NOTION_STATUS_OPTIONS);
    expect(output).toHaveBeenCalledWith("Notion database created: database-1");
    expect(output).toHaveBeenCalledWith("Notion data source ID: source-1");
  });

  it("fails safely when the parent has duplicate exact-name databases", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: ["database-1", "database-2"].map((id) => ({
          id,
          type: "child_database",
          child_database: { title: NOTION_DATABASE_NAME },
        })),
        has_more: false,
      }),
    ) as typeof fetch;

    await expect(
      runNotionSetup(
        { apiKey: "token-placeholder", parentPageId: "parent-1" },
        { fetchImpl },
      ),
    ).rejects.toThrow("Found 2 child databases");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
