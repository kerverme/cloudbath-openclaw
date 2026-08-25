import { describe, expect, it, vi } from "vitest";
import {
  createLineVideoLibraryNotion,
  LINE_VIDEO_LIBRARY_SCHEMA,
  LineVideoLibraryNotionError,
} from "./video-library-notion.js";
import type { LineVideoUgcScope } from "./video-ugc-scope.js";

const DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const DATA_SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "unit-notion-token-never-log";
const TARGET = { databaseId: DATABASE_ID, dataSourceId: DATA_SOURCE_ID };
const UGC_PROJECT_DATA_SOURCE_ID = "27452a84-24c5-4651-93e4-8bdbf3772f53";

const ENV = {
  OPEN_CLAW_NOTION_WRITE_TOKEN: TOKEN,
};

function sourceResponse(overrides?: {
  statusOptions?: string[];
  removeProperty?: string;
  extraProperties?: Record<string, unknown>;
}) {
  const properties = Object.fromEntries(
    Object.entries(LINE_VIDEO_LIBRARY_SCHEMA.properties)
      .filter(([name]) => name !== overrides?.removeProperty)
      .map(([name, type]) => [
        name,
        type === "select"
          ? {
              type,
              select: {
                options: (overrides?.statusOptions ?? ["Processing", "Completed", "Failed"]).map(
                  (option) => ({ name: option }),
                ),
              },
            }
          : { type },
      ]),
  );
  return {
    object: "data_source",
    id: DATA_SOURCE_ID,
    parent: { type: "database_id", database_id: DATABASE_ID },
    properties: { ...properties, ...overrides?.extraProperties },
  };
}

const UGC_SCOPE: LineVideoUgcScope = {
  version: 1,
  policyId: "UGC",
  accountId: "line-account",
  lineGroupId: "line-group",
  ownerSenderId: "line-owner",
  productPageId: "product-page",
  characterLocks: [
    {
      code: "F1",
      pageId: "character-page",
      identityReferences: [{ kind: "identity", source: "r2", locator: "workspace/ugc/f1.png" }],
      styleReferences: [],
      frozenAt: "2026-08-23T00:00:00.000Z",
    },
  ],
  projectInstanceId: "project-instance",
  projectPageId: "ugc-project-page",
  projectRecordId: "ugc-project-record",
  scene: {
    sceneNumber: 1,
    characterPageIds: ["character-page"],
    characterCodes: ["F1"],
    prompt: "a cat sitting on water",
  },
  scenePageId: "shot-page-1",
  shotPageIds: ["shot-page-1"],
  referenceAssets: [{ kind: "identity", source: "r2", locator: "workspace/ugc/f1.png" }],
  frozenPrompt: "a cat sitting on water",
  capabilities: {
    PRODUCT_LIBRARY: { databaseId: "a".repeat(32), dataSourceId: "1".repeat(32) },
    CHARACTER_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "2".repeat(32) },
    UGC_PROJECTS: {
      databaseId: "c".repeat(32),
      dataSourceId: UGC_PROJECT_DATA_SOURCE_ID,
    },
    UGC_SHOTS: { databaseId: "d".repeat(32), dataSourceId: "4".repeat(32) },
    AI_VIDEO_LIBRARY: { databaseId: DATABASE_ID, dataSourceId: DATA_SOURCE_ID },
    AI_IMAGE_LIBRARY: { databaseId: "e".repeat(32), dataSourceId: "5".repeat(32) },
  },
  r2Prefix: "outbound/line-video",
  createdAt: "2026-08-23T00:00:00.000Z",
};

function pageResponse() {
  return {
    object: "page",
    id: PAGE_ID,
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new TypeError("Expected a JSON request body");
  }
  return body;
}

function job() {
  return {
    jobId: "job-1",
    accountId: "line-account",
    conversationId: "line-group",
    model: "bytedance/seedance-2.5",
    prompt: "a cat sitting on water",
    durationSeconds: 5,
    resolution: "720p",
    aspectRatio: "16:9",
    audio: false,
    estimatedCostUsd: 1.16,
    actualCostUsd: 1.12,
    createdAt: Date.UTC(2026, 7, 23, 1, 2, 3),
  };
}

describe("LINE video library Notion writer", () => {
  it("validates the one configured database/data-source schema without mutating it", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(sourceResponse()),
    );
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await library.validate();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID.replaceAll("-", "")}`,
    );
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("creates one Processing record before later updates and never creates a database", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.includes("/v1/data_sources/") && !url.endsWith("/query")) {
        return jsonResponse(sourceResponse());
      }
      if (url.endsWith("/query")) {
        return jsonResponse({ results: [], has_more: false });
      }
      return jsonResponse(pageResponse());
    });
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const record = await library.createProcessing(job());

    expect(record).toEqual({ pageId: PAGE_ID });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/data_sources/${DATA_SOURCE_ID.replaceAll("-", "")}`,
      `/v1/data_sources/${DATA_SOURCE_ID.replaceAll("-", "")}/query`,
      "/v1/pages",
    ]);
    const createBody = JSON.parse(requestBody(requests[2]?.init?.body)) as {
      parent: { data_source_id: string };
      properties: Record<string, unknown>;
    };
    expect(createBody.parent.data_source_id).toBe(DATA_SOURCE_ID.replaceAll("-", ""));
    expect(createBody.properties).toMatchObject({
      Status: { select: { name: "Processing" } },
      "Video Job ID": {
        rich_text: [{ type: "text", text: { content: "job-1" } }],
      },
      "LINE Account": {
        rich_text: [{ type: "text", text: { content: "line-account" } }],
      },
      "LINE Conversation ID": {
        rich_text: [{ type: "text", text: { content: "line-group" } }],
      },
    });
    expect(requests.some((request) => request.url.endsWith("/v1/databases"))).toBe(false);
  });

  it("accepts safe extra columns and links a UGC video to its configured Project relation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith("/query")) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (url.includes("/v1/data_sources/")) {
        return jsonResponse(
          sourceResponse({
            extraProperties: {
              "UGC Project": {
                type: "relation",
                relation: { data_source_id: UGC_PROJECT_DATA_SOURCE_ID },
              },
              "Safe Extra Column": { type: "checkbox" },
            },
          }),
        );
      }
      return jsonResponse(pageResponse());
    });
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await library.createProcessing({ ...job(), ugcScope: UGC_SCOPE });

    const createRequest = requests.find((request) => request.url.endsWith("/v1/pages"));
    const createBody = JSON.parse(requestBody(createRequest?.init?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(createBody.properties).toMatchObject({
      "UGC Project": { relation: [{ id: "ugc-project-page" }] },
    });
  });

  it("reuses the existing page for an immutable Video Job ID instead of creating a duplicate", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      return url.endsWith("/query")
        ? jsonResponse({ results: [pageResponse()], has_more: false })
        : jsonResponse(sourceResponse());
    });
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(library.createProcessing(job())).resolves.toEqual({ pageId: PAGE_ID });
    expect(fetchImpl.mock.calls.some(([url]) => requestUrl(url).endsWith("/v1/pages"))).toBe(false);
  });

  it("updates the same record Completed and strips signed query credentials from the stored URL", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/v1/data_sources/")) {
        return jsonResponse(sourceResponse());
      }
      bodies.push(JSON.parse(requestBody(init?.body)));
      return jsonResponse(pageResponse());
    });
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await library.markCompleted(
      { pageId: PAGE_ID },
      {
        r2Url: "https://r2.example/video.mp4?X-Amz-Credential=never-store&X-Amz-Signature=secret",
        r2ObjectKey: "outbound/line-video/sha256/ab/abc.mp4",
        actualCostUsd: 1.12,
        completedAt: Date.UTC(2026, 7, 23, 1, 4, 5),
      },
    );

    expect(bodies[0]).toMatchObject({
      properties: {
        Status: { select: { name: "Completed" } },
        "R2 URL": { url: "https://r2.example/video.mp4" },
        "R2 Object Key": {
          rich_text: [
            {
              type: "text",
              text: { content: "outbound/line-video/sha256/ab/abc.mp4" },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(bodies)).not.toContain("never-store");
    expect(JSON.stringify(bodies)).not.toContain("Signature=secret");
  });

  it("updates the same record Failed with only the supplied sanitized reason", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/v1/data_sources/")) {
        return jsonResponse(sourceResponse());
      }
      bodies.push(JSON.parse(requestBody(init?.body)));
      return jsonResponse(pageResponse());
    });
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await library.markFailed({ pageId: PAGE_ID }, "R2 upload failed");

    expect(bodies[0]).toMatchObject({
      properties: {
        Status: { select: { name: "Failed" } },
        "Failure Reason": {
          rich_text: [{ type: "text", text: { content: "R2 upload failed" } }],
        },
      },
    });
  });

  it("fails safely when configuration is missing or schema is incompatible", async () => {
    expect(() => createLineVideoLibraryNotion({ target: TARGET, env: {} })).toThrow(
      LineVideoLibraryNotionError,
    );
    expect(() =>
      createLineVideoLibraryNotion({
        target: TARGET,
        env: {
          OPENCLAW_NOTION_WRITE_TOKEN: TOKEN,
          NOTION_CONSTRUCTION_WRITE_TOKEN: TOKEN,
        },
      }),
    ).toThrow(LineVideoLibraryNotionError);

    const fetchImpl = vi.fn(async () =>
      jsonResponse(sourceResponse({ removeProperty: "R2 Object Key" })),
    );
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(library.validate()).rejects.toMatchObject({ code: "schema_incompatible" });
  });

  it("never includes the Notion token or response body in errors", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: `Authorization Bearer ${TOKEN}` }, 403),
    );
    const library = createLineVideoLibraryNotion({
      target: TARGET,
      env: ENV,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await library.validate().catch((caught: unknown) => caught);
    expect(String(error)).toContain("http_403");
    expect(String(error)).not.toContain(TOKEN);
  });
});
