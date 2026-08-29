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
const PUBLIC_BASE_URL = "https://cloudbath.example";
const STABLE_VIEW_URL = `${PUBLIC_BASE_URL}/c/CHAR-5/abcdefghijklmnop`;

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
  previewUrl?: string;
  primaryObjectKey?: string;
  legacyObjectKey?: string;
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
      "Identity Reference R2 Keys": richText(
        params.primaryObjectKey ?? params.objectKey ?? OBJECT_KEY,
      ),
      "Canonical Reference Set": richText(params.legacyObjectKey ?? "legacy/character.png"),
      Preview: {
        type: "files",
        files: params.previewUrl
          ? [{ type: "external", external: { url: params.previewUrl } }]
          : [],
      },
    },
  };
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return init.body;
}

function requestPathname(input: string | URL | Request): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).pathname;
}

describe("UGC Character Library live-schema writer", () => {
  it("creates Kerver without writing the generated Character ID or duplicate identity fields", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
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
      if (pathname === "/v1/pages/character-page" && init?.method === "PATCH") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        patches.push(body.properties);
        const preview = body.properties.Preview as {
          files: Array<{ external: { url: string } }>;
        };
        return Response.json(
          characterPage({ name: "Kerver", number: 5, previewUrl: preview.files[0]!.external.url }),
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
      publicAssetBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result).toEqual({
      name: "Kerver",
      characterId: "CHAR-5",
      status: "Active",
      pageId: "character-page",
      viewUrl: expect.stringMatching(
        /^https:\/\/cloudbath\.example\/c\/CHAR-5\/[A-Za-z0-9_-]{16}$/u,
      ),
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
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      Preview: {
        files: [
          {
            type: "external",
            name: "CHAR-5 private view",
            external: { url: result.viewUrl },
          },
        ],
      },
    });
    expect(result.viewUrl).not.toContain("X-Amz-");
    expect(result.viewUrl).not.toContain("cloudflarestorage.com");
  });

  it("accepts the live auto_increment_id shape and reads its generated value", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
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
      if (pathname === "/v1/pages/character-page" && init?.method === "PATCH") {
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
      publicAssetBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result.characterId).toBe("CHAR-5");
  });

  it("updates Kerver by exact Name and replaces only the primary canonical identity field", async () => {
    const patches: Array<Record<string, unknown>> = [];
    let createCount = 0;
    const existing = characterPage({
      name: "Kerver",
      number: 5,
      objectKey: "old/key.png",
      previewUrl: STABLE_VIEW_URL,
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
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
      publicAssetBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result.characterId).toBe("CHAR-5");
    expect(createCount).toBe(0);
    expect(patches).toEqual([
      {
        "Identity Reference R2 Keys": {
          rich_text: [{ type: "text", text: { content: OBJECT_KEY } }],
        },
        Preview: {
          files: [
            {
              type: "external",
              name: "CHAR-5 private view",
              external: { url: STABLE_VIEW_URL },
            },
          ],
        },
      },
    ]);
    expect(result.viewUrl).toBe(STABLE_VIEW_URL);
  });

  it("can resolve the existing Notion-generated Character ID without writing it", async () => {
    const filters: Array<Record<string, unknown> | undefined> = [];
    const existing = characterPage({ name: "Kerver", number: 5, previewUrl: STABLE_VIEW_URL });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
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
      publicAssetBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result).toMatchObject({ name: "Kerver", characterId: "CHAR-5" });
    expect(filters).toContainEqual({
      property: "Character ID",
      unique_id: { equals: 5 },
    });
  });

  it("resolves only an active character with the stored stable capability URL", async () => {
    const existing = characterPage({ name: "Kerver", number: 5, previewUrl: STABLE_VIEW_URL });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: { property?: string } };
        return Response.json({
          results: body.filter?.property === "Character ID" ? [existing] : [],
          has_more: false,
        });
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).resolveCharacterViewAsset({
        target: TARGETS.CHARACTER_LIBRARY,
        capabilities: TARGETS,
        characterId: "CHAR-5",
        token: "abcdefghijklmnop",
        publicAssetBaseUrl: PUBLIC_BASE_URL,
      }),
    ).resolves.toEqual({ objectKey: OBJECT_KEY });
    await expect(
      client(fetchImpl).resolveCharacterViewAsset({
        target: TARGETS.CHARACTER_LIBRARY,
        capabilities: TARGETS,
        characterId: "CHAR-5",
        token: "ponmlkjihgfedcba",
        publicAssetBaseUrl: PUBLIC_BASE_URL,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("resolves an active legacy object key without treating Preview as identity", async () => {
    const legacy = characterPage({
      name: "Twong",
      number: 6,
      primaryObjectKey: "",
      legacyObjectKey: "ugc/characters/twong/v1/main.webp",
      previewUrl: `${PUBLIC_BASE_URL}/c/CHAR-6/abcdefghijklmnop`,
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: { property?: string } };
        return Response.json({
          results: body.filter?.property === "Character ID" ? [legacy] : [],
          has_more: false,
        });
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).resolveCharacterViewAsset({
        target: TARGETS.CHARACTER_LIBRARY,
        capabilities: TARGETS,
        characterId: "CHAR-6",
        token: "abcdefghijklmnop",
        publicAssetBaseUrl: PUBLIC_BASE_URL,
      }),
    ).resolves.toEqual({ objectKey: "ugc/characters/twong/v1/main.webp" });
  });

  it("migrates Twong to a stable view URL without an R2 upload or identity rewrite", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const twong = characterPage({
      name: "Twong",
      number: 6,
      primaryObjectKey: OBJECT_KEY.replace("kerver", "twong"),
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: { property?: string } };
        return Response.json({
          results: body.filter?.property === "Character ID" ? [twong] : [],
          has_more: false,
        });
      }
      if (pathname === "/v1/pages/character-page" && init?.method === "PATCH") {
        const body = JSON.parse(requestBody(init)) as { properties: Record<string, unknown> };
        patches.push(body.properties);
        return Response.json(twong);
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).ensureCharacterViewUrl({
      target: TARGETS.CHARACTER_LIBRARY,
      capabilities: TARGETS,
      characterId: "CHAR-6",
      publicAssetBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result.objectKey).toBe(OBJECT_KEY.replace("kerver", "twong"));
    expect(result.viewUrl).toMatch(/^https:\/\/cloudbath\.example\/c\/CHAR-6\/[A-Za-z0-9_-]{16}$/u);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toHaveProperty("Preview");
    expect(patches[0]).not.toHaveProperty("Identity Reference R2 Keys");
  });

  it("fails closed for archived characters", async () => {
    const archived = characterPage({
      name: "Twong",
      number: 6,
      status: "Archived",
      primaryObjectKey: "",
      legacyObjectKey: "ugc/characters/twong/v1/main.webp",
      previewUrl: `${PUBLIC_BASE_URL}/c/CHAR-6/abcdefghijklmnop`,
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = requestPathname(input);
      if (pathname.startsWith("/v1/data_sources/") && !pathname.endsWith("/query")) {
        return Response.json(liveCharacterSource());
      }
      if (pathname.endsWith("/query")) {
        const body = JSON.parse(requestBody(init)) as { filter?: { property?: string } };
        return Response.json({
          results: body.filter?.property === "Character ID" ? [archived] : [],
          has_more: false,
        });
      }
      throw new Error(`Unexpected Notion request: ${pathname}`);
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).resolveCharacterViewAsset({
        target: TARGETS.CHARACTER_LIBRARY,
        capabilities: TARGETS,
        characterId: "CHAR-6",
        token: "abcdefghijklmnop",
        publicAssetBaseUrl: PUBLIC_BASE_URL,
      }),
    ).rejects.toThrow("unavailable");
  });
});
