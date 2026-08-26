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

const OBJECT_KEY =
  "ugc/characters/kerver/sha256/ab/abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd.png";

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

function liveCharacterSource(idType: "unique_id" | "auto_increment_id" = "unique_id") {
  return {
    object: "data_source",
    id: TARGETS.CHARACTER_LIBRARY.dataSourceId,
    parent: { type: "database_id", database_id: TARGETS.CHARACTER_LIBRARY.databaseId },
    properties: {
      Name: { type: "title" },
      "Character ID":
        idType === "unique_id"
          ? { type: "unique_id", unique_id: { prefix: "CHAR" } }
          : { type: "auto_increment_id", auto_increment_id: { prefix: "CHAR" } },
      Status: {
        type: "select",
        select: { options: [{ name: "Active" }, { name: "Archived" }] },
      },
      "Identity Reference R2 Keys": { type: "rich_text" },
      "Canonical Reference Set": { type: "rich_text" },
      Preview: { type: "files" },
      "Look Description": { type: "rich_text" },
      "Style Tags": { type: "rich_text" },
      "Reference Notes": { type: "rich_text" },
      "Created At": { type: "created_time" },
      "UGC Projects": { type: "relation", relation: { data_source_id: "f".repeat(32) } },
    },
  };
}

function titleText(value: string) {
  return { type: "title", title: [{ plain_text: value }] };
}

function richText(value: string) {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function characterPage(params: {
  name: string;
  number: number;
  status?: "Active" | "Archived";
  objectKey?: string;
  id?: string;
  idType?: "unique_id" | "auto_increment_id";
}) {
  const idType = params.idType ?? "unique_id";
  return {
    object: "page",
    id: params.id ?? "character-page",
    parent: { type: "data_source_id", data_source_id: TARGETS.CHARACTER_LIBRARY.dataSourceId },
    properties: {
      Name: titleText(params.name),
      "Character ID":
        idType === "unique_id"
          ? {
              type: "unique_id",
              unique_id: { prefix: "CHAR", number: params.number },
            }
          : {
              type: "auto_increment_id",
              auto_increment_id: { prefix: "CHAR", number: params.number },
            },
      Status: { type: "select", select: { name: params.status ?? "Active" } },
      "Identity Reference R2 Keys": richText(params.objectKey ?? OBJECT_KEY),
      "Canonical Reference Set": richText("legacy/character.png"),
      Preview: { type: "files", files: [] },
    },
  };
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return init.body;
}

describe("UGC Character Library live-schema writer", () => {
  it("creates Kerver without writing the generated Character ID or duplicate identity fields", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.url).pathname;
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        return Response.json({ results: [], has_more: false });
      }
      if (pathname === "/v1/pages" && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        writes.push(body.properties);
        return Response.json(characterPage({ name: "Kerver", number: 5 }));
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "Kerver",
      objectKey: OBJECT_KEY,
      mode: "upsert",
    });

    expect(result).toEqual({
      name: "Kerver",
      characterId: "CHAR-5",
      status: "Active",
      pageId: "character-page",
    });
    expect(writes).toEqual([
      {
        Name: { title: [{ type: "text", text: { content: "Kerver" } }] },
        Status: { select: { name: "Active" } },
        "Identity Reference R2 Keys": {
          rich_text: [{ type: "text", text: { content: OBJECT_KEY } }],
        },
      },
    ]);
    expect(writes[0]).not.toHaveProperty("Character ID");
    expect(writes[0]).not.toHaveProperty("Identity Asset URL");
    expect(writes[0]).not.toHaveProperty("Canonical Reference Set");
    expect(writes[0]).not.toHaveProperty("Preview");
  });

  it("accepts the live auto_increment_id shape and reads its generated value", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.url).pathname;
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource("auto_increment_id"));
      }
      if (pathname.endsWith("/query")) {
        return Response.json({ results: [], has_more: false });
      }
      if (pathname === "/v1/pages" && init?.method === "POST") {
        return Response.json(
          characterPage({ name: "Kerver", number: 5, idType: "auto_increment_id" }),
        );
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "Kerver",
      objectKey: OBJECT_KEY,
      mode: "upsert",
    });

    expect(result.characterId).toBe("CHAR-5");
  });

  it("updates Kerver by exact Name and replaces only the primary canonical identity field", async () => {
    const patches: Array<Record<string, unknown>> = [];
    let createCount = 0;
    const existing = characterPage({ name: "Kerver", number: 5, objectKey: "old/key.png" });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.url).pathname;
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        return Response.json({ results: [existing], has_more: false });
      }
      if (pathname === "/v1/pages/character-page" && init?.method === "PATCH") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        patches.push(body.properties);
        return Response.json(characterPage({ name: "Kerver", number: 5 }));
      }
      if (pathname === "/v1/pages" && init?.method === "POST") {
        createCount += 1;
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "Kerver",
      objectKey: OBJECT_KEY,
      mode: "update",
    });

    expect(result.characterId).toBe("CHAR-5");
    expect(createCount).toBe(0);
    expect(patches).toEqual([
      {
        "Identity Reference R2 Keys": {
          rich_text: [{ type: "text", text: { content: OBJECT_KEY } }],
        },
      },
    ]);
  });

  it("can resolve the existing Notion-generated Character ID without writing it", async () => {
    const filters: Array<Record<string, unknown> | undefined> = [];
    const existing = characterPage({ name: "Kerver", number: 5 });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(typeof input === "string" ? input : input.url).pathname;
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: Record<string, unknown> };
        filters.push(body.filter);
        return Response.json({
          results: body.filter?.property === "Character ID" ? [existing] : [],
          has_more: false,
        });
      }
      if (pathname === "/v1/pages/character-page" && init?.method === "PATCH") {
        return Response.json(existing);
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).saveCharacterAsset({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      nameOrCode: "CHAR-5",
      objectKey: OBJECT_KEY,
      mode: "update",
    });

    expect(result).toMatchObject({ name: "Kerver", characterId: "CHAR-5" });
    expect(filters).toContainEqual({
      property: "Character ID",
      unique_id: { equals: 5 },
    });
  });
});
