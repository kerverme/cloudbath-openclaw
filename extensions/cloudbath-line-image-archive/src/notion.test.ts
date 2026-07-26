import { describe, expect, it, vi } from "vitest";
import { NOTION_VERSION, NotionArchiveClient, REQUIRED_PROPERTIES } from "./notion.js";
import { NOTION_STATUS_OPTIONS } from "./notion-schema.js";
import type { ArchiveMetadata, SafeLogger } from "./types.js";

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metadata(): ArchiveMetadata {
  return {
    receivedAt: "2026-07-25T01:02:03.000Z",
    lineMessageId: "message-1",
    lineGroupId: "C123",
    lineUserId: "U123",
    originalFilename: "message-1-original.png",
    mimeType: "image/png",
    fileSize: 42,
    sha256: "a".repeat(64),
    r2ObjectKey: "line/2026/07/25/C123/message-1-original.png",
    status: "PROCESSED",
  };
}

function schema() {
  return {
    properties: Object.fromEntries(
      REQUIRED_PROPERTIES.map(([name, type]) => [
        name,
        name === "Status"
          ? {
              type,
              select: {
                options: NOTION_STATUS_OPTIONS.map((optionName) => ({ name: optionName })),
              },
            }
          : { type },
      ]),
    ),
  };
}

describe("NotionArchiveClient", () => {
  it("resolves the database data source, checks duplicates, and creates metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/v1/databases/")) {
        return jsonResponse({ data_sources: [{ id: "source-1", name: "Archive" }] });
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse(schema());
      }
      if (url.endsWith("/v1/data_sources/source-1/query")) {
        return jsonResponse({ results: [] });
      }
      if (url.endsWith("/v1/pages")) {
        return jsonResponse({ id: "page-1" });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new NotionArchiveClient(
      { apiKey: "secret-placeholder", databaseId: "database-1" },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      fetchImpl,
    );

    await expect(client.createRecord(metadata())).resolves.toEqual({
      kind: "created",
      pageId: "page-1",
    });
    const create = requests.find((request) => request.url.endsWith("/v1/pages"));
    const body = JSON.parse(String(create?.init?.body)) as {
      parent: unknown;
      properties: Record<string, unknown>;
    };
    expect(create?.init?.headers).toMatchObject({ "Notion-Version": NOTION_VERSION });
    expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "source-1" });
    expect(body.properties.Status).toEqual({ select: { name: "PROCESSED" } });
    expect(body.properties["R2 Object Key"]).toBeTruthy();
  });

  it("does not create a duplicate Notion record", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/databases/")) {
        return jsonResponse({ data_sources: [{ id: "source-1" }] });
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse(schema());
      }
      if (url.endsWith("/query")) {
        return jsonResponse({ results: [{ id: "existing-page" }] });
      }
      throw new Error("page creation must not run");
    }) as typeof fetch;
    const client = new NotionArchiveClient(
      { apiKey: "secret-placeholder", databaseId: "database-1" },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      fetchImpl,
    );
    await expect(client.createRecord(metadata())).resolves.toEqual({
      kind: "duplicate",
      pageId: "existing-page",
    });
  });

  it("retries bounded transient Notion failures", async () => {
    let databaseAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/databases/")) {
        databaseAttempts += 1;
        if (databaseAttempts === 1) {
          return jsonResponse({ message: "rate limited" }, 429);
        }
        return jsonResponse({ data_sources: [{ id: "source-1" }] });
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return jsonResponse(schema());
      }
      if (url.endsWith("/query")) {
        return jsonResponse({ results: [{ id: "existing-page" }] });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new NotionArchiveClient(
      { apiKey: "secret-placeholder", databaseId: "database-1" },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      logger,
      fetchImpl,
    );
    await client.createRecord(metadata());
    expect(databaseAttempts).toBe(2);
  });
});
