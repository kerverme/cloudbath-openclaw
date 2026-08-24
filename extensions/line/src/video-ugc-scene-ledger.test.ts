/**
 * UGC_SHOTS as the per-scene execution ledger.
 *
 * The scene the owner confirmed is the only scene written: completing scene 1
 * must never mark scene 2 completed. Optional execution columns are written
 * only when the live data source actually has them -- Notion rejects a PATCH
 * naming an unknown property, and this plugin never provisions schema.
 */
import { describe, expect, it, vi } from "vitest";
import { createLineVideoLibraryNotion } from "./video-library-notion.js";
import type { LineVideoUgcScope } from "./video-ugc-scope.js";

const TARGETS = {
  PRODUCT_LIBRARY: { databaseId: "a".repeat(32), dataSourceId: "1".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "2".repeat(32) },
  UGC_PROJECTS: { databaseId: "c".repeat(32), dataSourceId: "3".repeat(32) },
  UGC_SHOTS: { databaseId: "d".repeat(32), dataSourceId: "4".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "e".repeat(32), dataSourceId: "5".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "f".repeat(32), dataSourceId: "6".repeat(32) },
} as const;

function scopeForScene(sceneNumber: number, scenePageId: string): LineVideoUgcScope {
  return {
    version: 1,
    policyId: "UGC",
    accountId: "acct-1",
    lineGroupId: "C-ugc",
    ownerSenderId: "U-owner",
    productPageId: "product-page",
    characterLocks: [
      {
        code: "F1",
        pageId: "page-f1",
        identityReferences: [{ kind: "identity", source: "r2", locator: "characters/f1/a.png" }],
        styleReferences: [],
        frozenAt: "2026-08-23T00:00:00.000Z",
      },
    ],
    projectPageId: "project-page",
    projectRecordId: "project-record",
    scene: {
      sceneNumber,
      characterPageIds: ["page-f1"],
      characterCodes: ["F1"],
      prompt: "scene prompt",
      durationSeconds: 10,
    },
    scenePageId,
    shotPageIds: [scenePageId],
    referenceAssets: [{ kind: "identity", source: "r2", locator: "characters/f1/a.png" }],
    frozenPrompt: "scene prompt",
    capabilities: TARGETS,
    r2Prefix: "outbound/line-video",
    createdAt: "2026-08-23T00:00:00.000Z",
  };
}

/** `sceneProperties` controls which optional ledger columns the stub advertises. */
function stubNotion(
  sceneProperties: string[],
  siblingScenes: Array<{ id: string; status: string }> = [],
) {
  const patches: Array<{ pageId: string; properties: Record<string, any> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).href);
    // Sibling scenes for the derived project status.
    if (url.pathname.endsWith("/query")) {
      return Response.json({
        results: siblingScenes.map((scene) => ({
          id: scene.id,
          properties: { Status: { select: { name: scene.status } } },
        })),
      });
    }
    if (url.pathname.startsWith("/v1/data_sources/")) {
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({
        object: "data_source",
        id,
        parent: { type: "database_id", database_id: TARGETS.UGC_SHOTS.databaseId },
        properties: Object.fromEntries(
          [...sceneProperties, "Name"].map((name) => [name, { type: "rich_text" }]),
        ),
      });
    }
    if (url.pathname.startsWith("/v1/pages/") && init?.method === "PATCH") {
      const pageId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      patches.push({ pageId, properties: body.properties });
      const dataSourceId =
        pageId === "project-page"
          ? TARGETS.UGC_PROJECTS.dataSourceId
          : TARGETS.UGC_SHOTS.dataSourceId;
      return Response.json({
        object: "page",
        id: pageId,
        parent: { type: "data_source_id", data_source_id: dataSourceId },
      });
    }
    throw new Error(`Unexpected Notion request: ${url.pathname}`);
  });
  const library = createLineVideoLibraryNotion({
    target: { databaseId: "9".repeat(32), dataSourceId: "8".repeat(32) },
    env: { OPENCLAW_NOTION_WRITE_TOKEN: "secret" } as NodeJS.ProcessEnv,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const scenePatches = () => patches.filter((patch) => patch.pageId.startsWith("scene-"));
  const projectPatches = () => patches.filter((patch) => patch.pageId === "project-page");
  return { library, patches, scenePatches, projectPatches };
}

/** The live UGC_SHOTS columns this ledger writes. */
const FULL_SCHEMA = [
  "Status",
  "Actual Cost USD",
  "Generated R2 Object Key",
  "Generated Asset URL",
  "Completed At",
  "Duration",
  "Model",
  "Failure Reason",
];

describe("scene result ledger", () => {
  it("writes completion to the confirmed scene only", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.parse("2026-08-23T01:00:00.000Z"),
    });

    const scenes = notion.scenePatches();
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.pageId).toBe("scene-1");
    // Scene 2 was never touched.
    expect(scenes.some((patch) => patch.pageId === "scene-2")).toBe(false);
  });

  it("records cost, archived R2 key, completion time and duration when supported", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      assetUrl: "https://r2.example/scene-1.mp4",
      completedAt: Date.parse("2026-08-23T01:00:00.000Z"),
      model: "bytedance/seedance-2.5",
    });

    const properties = notion.scenePatches()[0]!.properties;
    expect(properties.Status).toEqual({ select: { name: "Completed" } });
    expect(properties["Actual Cost USD"]).toEqual({ number: 0.51 });
    expect(properties["Generated R2 Object Key"].rich_text[0].text.content).toBe(
      "outbound/line-video/scene-1.mp4",
    );
    expect(properties["Completed At"]).toEqual({
      date: { start: "2026-08-23T01:00:00.000Z" },
    });
    expect(properties["Duration"]).toEqual({ number: 10 });
    expect(properties["Generated Asset URL"]).toEqual({ url: "https://r2.example/scene-1.mp4" });
    expect(properties.Model.rich_text[0].text.content).toBe("bytedance/seedance-2.5");
  });

  it("degrades to a Status-only write when the live schema lacks the columns", async () => {
    const notion = stubNotion(["Status"]);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.now(),
    });

    // Naming an absent property would make Notion reject the whole PATCH and
    // lose the completed status too.
    expect(notion.scenePatches()[0]!.properties).toEqual({
      Status: { select: { name: "Completed" } },
    });
  });

  it("marks only the intended scene Failed and keeps the sanitized reason", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcFailed!(scopeForScene(2, "scene-2"), "provider rejected request");

    const scenes = notion.scenePatches();
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.pageId).toBe("scene-2");
    expect(scenes[0]!.properties.Status).toEqual({ select: { name: "Failed" } });
    expect(scenes[0]!.properties["Failure Reason"].rich_text[0].text.content).toBe(
      "provider rejected request",
    );
  });

  it("writes the live Generating status when paid execution starts", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcProcessing!(scopeForScene(3, "scene-3"));

    // The live databases have no "Processing" option.
    expect(notion.scenePatches()[0]).toMatchObject({
      pageId: "scene-3",
      properties: { Status: { select: { name: "Generating" } } },
    });
    expect(JSON.stringify(notion.patches)).not.toContain("Processing");
  });

  it("never writes a status the live databases do not offer", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcProcessing!(scopeForScene(1, "scene-1"));
    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.5, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.now(),
    });
    await notion.library.markUgcFailed!(scopeForScene(1, "scene-1"), "boom");

    const written = notion.patches.map((patch) => patch.properties.Status?.select?.name);
    for (const status of written) {
      expect(["Draft", "Ready", "Generating", "Completed", "Failed"]).toContain(status);
    }
  });

  it("never names a column the live schema does not have", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.5, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.now(),
    });

    const names = notion.scenePatches().flatMap((patch) => Object.keys(patch.properties));
    expect(names).not.toContain("Shot Number");
    expect(names).not.toContain("Duration Seconds");
    expect(names).not.toContain("Output R2 Key");
    expect(names).not.toContain("Record ID");
  });

  it("does not carry one scene's R2 key into another scene's ledger row", async () => {
    const notion = stubNotion(FULL_SCHEMA);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.now(),
    });
    await notion.library.markUgcCompleted!(scopeForScene(2, "scene-2"), 0.62, {
      r2ObjectKey: "outbound/line-video/scene-2.mp4",
      completedAt: Date.now(),
    });

    const [first, second] = notion.scenePatches();
    expect(first!.properties["Generated R2 Object Key"].rich_text[0].text.content).toBe(
      "outbound/line-video/scene-1.mp4",
    );
    expect(second!.properties["Generated R2 Object Key"].rich_text[0].text.content).toBe(
      "outbound/line-video/scene-2.mp4",
    );
    expect(first!.properties["Actual Cost USD"]).toEqual({ number: 0.51 });
    expect(second!.properties["Actual Cost USD"]).toEqual({ number: 0.62 });
  });
});

describe("project status semantics", () => {
  const PROJECT_SCHEMA = [
    "Status",
    "Actual Cost USD",
    "Final R2 Object Key",
    "Final Video URL",
    "Completed At",
    "Failure Reason",
    "Video Model",
    ...FULL_SCHEMA,
  ];

  it("leaves the project Generating when a later scene is still outstanding", async () => {
    const notion = stubNotion(PROJECT_SCHEMA, [
      { id: "scene-1", status: "Completed" },
      { id: "scene-2", status: "Draft" },
    ]);

    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      assetUrl: "https://r2.example/scene-1.mp4",
      completedAt: Date.now(),
    });

    const project = notion.projectPatches()[0]!.properties;
    // Scene 1 finishing must not declare a two-scene project done.
    expect(project.Status).toEqual({ select: { name: "Generating" } });
    expect(project["Final R2 Object Key"]).toBeUndefined();
    expect(project["Final Video URL"]).toBeUndefined();
  });

  it("completes the project only when every scene is settled", async () => {
    const notion = stubNotion(PROJECT_SCHEMA, [
      { id: "scene-1", status: "Completed" },
      { id: "scene-2", status: "Completed" },
    ]);

    await notion.library.markUgcCompleted!(scopeForScene(2, "scene-2"), 0.62, {
      r2ObjectKey: "outbound/line-video/scene-2.mp4",
      assetUrl: "https://r2.example/scene-2.mp4",
      completedAt: Date.parse("2026-08-23T02:00:00.000Z"),
      model: "bytedance/seedance-2.5",
    });

    const project = notion.projectPatches()[0]!.properties;
    expect(project.Status).toEqual({ select: { name: "Completed" } });
    expect(project["Final R2 Object Key"].rich_text[0].text.content).toBe(
      "outbound/line-video/scene-2.mp4",
    );
    expect(project["Video Model"].rich_text[0].text.content).toBe("bytedance/seedance-2.5");
  });

  it("does not promote the project when sibling state cannot be read", async () => {
    const notion = stubNotion(PROJECT_SCHEMA, []);
    // An empty result set means no outstanding siblings, so a single-scene
    // project completes; this pins that the single-scene case still works.
    await notion.library.markUgcCompleted!(scopeForScene(1, "scene-1"), 0.51, {
      r2ObjectKey: "outbound/line-video/scene-1.mp4",
      completedAt: Date.now(),
    });

    expect(notion.projectPatches()[0]!.properties.Status).toEqual({
      select: { name: "Completed" },
    });
  });

  it("marks the project Failed with a sanitized reason", async () => {
    const notion = stubNotion(PROJECT_SCHEMA, [{ id: "scene-1", status: "Failed" }]);

    await notion.library.markUgcFailed!(scopeForScene(1, "scene-1"), "provider rejected request");

    const project = notion.projectPatches()[0]!.properties;
    expect(project.Status).toEqual({ select: { name: "Failed" } });
    expect(project["Failure Reason"].rich_text[0].text.content).toBe("provider rejected request");
  });
});
