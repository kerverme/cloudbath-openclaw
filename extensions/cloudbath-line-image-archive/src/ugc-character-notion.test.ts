import { describe, expect, it, vi } from "vitest";
import type { SafeLogger, UgcCapabilityId } from "./types.js";
import { UgcNotionWorkflowClient } from "./ugc-workflow.js";

const TARGETS = {
  PRODUCT_LIBRARY: { databaseId: "1".repeat(32), dataSourceId: "2".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "3".repeat(32), dataSourceId: "4".repeat(32) },
  UGC_PROJECTS: { databaseId: "5".repeat(32), dataSourceId: "6".repeat(32) },
  UGC_SHOTS: { databaseId: "7".repeat(32), dataSourceId: "8".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "9".repeat(32), dataSourceId: "a".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "c".repeat(32) },
} as const satisfies Readonly<Record<UgcCapabilityId, object>>;

const CANONICAL_URL =
  "https://account.r2.cloudflarestorage.com/cloudbath/ugc/characters/kerver/main.png";
const OBJECT_KEY = "ugc/characters/kerver/main.png";

function logger(): SafeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function client(fetchImpl: typeof fetch): UgcNotionWorkflowClient {
  return new UgcNotionWorkflowClient(
    "unit-test-token",
    { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    logger(),
    fetchImpl,
  );
}

function titleText(value: string) {
  return { type: "title", title: [{ plain_text: value }] };
}

function richText(value: string) {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function source(properties: Record<string, unknown>) {
  return {
    object: "data_source",
    id: TARGETS.CHARACTER_LIBRARY.dataSourceId,
    parent: { type: "database_id", database_id: TARGETS.CHARACTER_LIBRARY.databaseId },
    properties: { Name: { type: "title" }, ...properties },
  };
}

function createdPage(properties: Record<string, unknown>, id = "character-page") {
  return {
    object: "page",
    id,
    parent: { type: "data_source_id", data_source_id: TARGETS.CHARACTER_LIBRARY.dataSourceId },
    properties,
  };
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return init.body;
}

describe("UGC Character Library single-asset writer", () => {
  it("creates one row using only Identity Asset URL and mirrors it to display-only Preview", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path.startsWith("/v1/data_sources/") && !path.endsWith("/query")) {
        return Response.json(
          source({
            "Character ID": { type: "rich_text" },
            Status: { type: "select", select: { options: [{ name: "Active" }] } },
            "Identity Asset URL": { type: "url" },
            "Identity Reference R2 Keys": { type: "rich_text" },
            "Canonical Reference Set": { type: "rich_text" },
            Preview: { type: "url" },
          }),
        );
      }
      if (path.endsWith("/query")) {
        return Response.json({ results: [], has_more: false });
      }
      if (path === "/v1/pages" && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        writes.push(body.properties);
        return Response.json(createdPage(body.properties));
      }
      throw new Error(`Unexpected Notion request: ${path}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "Kerver",
      canonicalUrl: CANONICAL_URL,
      objectKey: OBJECT_KEY,
      mode: "upsert",
    });

    const properties = writes[0] ?? {};
    expect(result).toMatchObject({ name: "Kerver", status: "Active", pageId: "character-page" });
    expect(properties["Identity Asset URL"]).toEqual({ url: CANONICAL_URL });
    expect(properties.Preview).toEqual({ url: CANONICAL_URL });
    expect(properties).not.toHaveProperty("Identity Reference R2 Keys");
    expect(properties).not.toHaveProperty("Canonical Reference Set");
  });

  it("updates an existing row resolved by Character ID without creating another row", async () => {
    const patches: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path.startsWith("/v1/data_sources/") && !path.endsWith("/query")) {
        return Response.json(
          source({
            "Character ID": { type: "rich_text" },
            Status: { type: "select", select: { options: [{ name: "Active" }] } },
            "Identity Asset URL": { type: "url" },
          }),
        );
      }
      if (path.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: { property?: string } };
        return Response.json({
          results:
            body.filter?.property === "Character ID"
              ? [
                  createdPage({
                    Name: titleText("Kerver"),
                    "Character ID": richText("CHAR-5"),
                  }),
                ]
              : [],
          has_more: false,
        });
      }
      if (path === "/v1/pages/character-page" && init?.method === "PATCH") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        patches.push(body.properties);
        return Response.json(createdPage(body.properties));
      }
      throw new Error(`Unexpected Notion request: ${path}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "CHAR-5",
      canonicalUrl: CANONICAL_URL,
      objectKey: OBJECT_KEY,
      mode: "update",
    });

    expect(result).toMatchObject({ name: "Kerver", characterId: "CHAR-5" });
    expect(patches).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.some(
        ([, init]) => init?.method === "POST" && requestBody(init).includes("parent"),
      ),
    ).toBe(false);
  });

  it("uses only the first supported legacy primary field and leaves files Preview untouched", async () => {
    let created: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path.startsWith("/v1/data_sources/") && !path.endsWith("/query")) {
        return Response.json(
          source({
            "Character ID": { type: "rich_text" },
            Status: { type: "select", select: { options: [{ name: "Active" }] } },
            "Identity Reference R2 Keys": { type: "rich_text" },
            "Canonical Reference Set": { type: "rich_text" },
            Preview: { type: "files" },
          }),
        );
      }
      if (path.endsWith("/query")) {
        return Response.json({ results: [], has_more: false });
      }
      if (path === "/v1/pages" && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        created = body.properties;
        return Response.json(createdPage(body.properties));
      }
      throw new Error(`Unexpected Notion request: ${path}`);
    }) as unknown as typeof fetch;

    await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "Kerver",
      canonicalUrl: CANONICAL_URL,
      objectKey: OBJECT_KEY,
      mode: "upsert",
    });

    expect(created?.["Identity Reference R2 Keys"]).toEqual({
      rich_text: [{ type: "text", text: { content: OBJECT_KEY } }],
    });
    expect(created).not.toHaveProperty("Canonical Reference Set");
    expect(created).not.toHaveProperty("Preview");
  });
});
