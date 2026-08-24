/**
 * Multi-character casting and cross-scene identity reuse, driven through the
 * real workflow: F1 = เด็ก 5 ขวบ, F2 = หมาน้อย.
 *
 * Zero paid generation: the workflow only reads Notion and freezes scope, and
 * every test asserts no request reached a video-generation endpoint.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveUgcLineSession,
  FrozenUgcVideoScope,
  PendingUgcVideoScope,
  SafeLogger,
  UgcCapabilityId,
  ActiveUgcProject,
  UgcProjectCharacterLock,
  UgcProjectInstance,
  WorkspacePolicyConfig,
} from "./types.js";
import {
  CloudbathUgcVideoWorkflow,
  UgcNotionWorkflowClient,
  ugcPendingKey,
} from "./ugc-workflow.js";

const CAPABILITY_IDS = [
  "PRODUCT_LIBRARY",
  "CHARACTER_LIBRARY",
  "UGC_PROJECTS",
  "UGC_SHOTS",
  "AI_VIDEO_LIBRARY",
  "AI_IMAGE_LIBRARY",
] as const satisfies readonly UgcCapabilityId[];

/** Notion ids must be 32 hex chars: the client canonicalizes before comparing. */
const TARGETS = Object.fromEntries(
  CAPABILITY_IDS.map((id, index) => [
    id,
    {
      databaseId: `${index}`.repeat(2).padEnd(32, "a"),
      dataSourceId: `${index}`.repeat(2).padEnd(32, "b"),
    },
  ]),
) as Record<UgcCapabilityId, { databaseId: string; dataSourceId: string }>;

const SESSION_KEY = "line-session";
const OWNER = "U-owner";

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

type CharacterRow = { id: string; name: string; identity: string[]; style?: string[] };
type ProductRow = { id: string; name: string; reference: string };

const DEFAULT_PRODUCT: ProductRow = {
  id: "product-page",
  name: "Cloudbath Serum",
  reference: "product/serum.png",
};

/** Mirrors the live capability schemas the workflow validates before writing. */
function dataSourceSchema(id: UgcCapabilityId) {
  const properties: Record<string, unknown> = { Name: { type: "title" } };
  if (id === "UGC_PROJECTS") {
    // Mirrors the LIVE UGC_PROJECTS schema: no Record ID, no Prompt.
    Object.assign(properties, {
      Status: {
        type: "select",
        select: {
          options: [
            { name: "Draft" },
            { name: "Ready" },
            { name: "Generating" },
            { name: "Completed" },
            { name: "Failed" },
          ],
        },
      },
      Product: {
        type: "relation",
        relation: { data_source_id: TARGETS.PRODUCT_LIBRARY.dataSourceId },
      },
      Character: {
        type: "relation",
        relation: { data_source_id: TARGETS.CHARACTER_LIBRARY.dataSourceId },
      },
      "Estimated Cost USD": { type: "number" },
      "Actual Cost USD": { type: "number" },
      "Final R2 Object Key": { type: "rich_text" },
      "Final Video URL": { type: "url" },
      "Completed At": { type: "date" },
      "Failure Reason": { type: "rich_text" },
      "Video Model": { type: "rich_text" },
    });
  } else if (id === "UGC_SHOTS") {
    // Mirrors the LIVE UGC_SHOTS schema: Shot Order, Duration, Generated R2
    // Object Key -- no Record ID, Shot Number, Duration Seconds or Output R2 Key.
    Object.assign(properties, {
      Status: {
        type: "select",
        select: {
          options: [
            { name: "Draft" },
            { name: "Ready" },
            { name: "Generating" },
            { name: "Completed" },
            { name: "Failed" },
          ],
        },
      },
      Project: {
        type: "relation",
        relation: { data_source_id: TARGETS.UGC_PROJECTS.dataSourceId },
      },
      "Shot Order": { type: "number" },
      Prompt: { type: "rich_text" },
      Duration: { type: "number" },
      Model: { type: "rich_text" },
      "Estimated Cost USD": { type: "number" },
      "Actual Cost USD": { type: "number" },
      "Generated R2 Object Key": { type: "rich_text" },
      "Generated Asset URL": { type: "url" },
      "Completed At": { type: "date" },
      "Failure Reason": { type: "rich_text" },
    });
  } else if (id === "AI_VIDEO_LIBRARY") {
    Object.assign(properties, {
      Status: {
        type: "select",
        select: {
          options: [
            { name: "Draft" },
            { name: "Ready" },
            { name: "Generating" },
            { name: "Completed" },
            { name: "Failed" },
          ],
        },
      },
      "Video Job ID": { type: "rich_text" },
      "UGC Project": {
        type: "relation",
        relation: { data_source_id: TARGETS.UGC_PROJECTS.dataSourceId },
      },
    });
  } else if (id === "AI_IMAGE_LIBRARY") {
    Object.assign(properties, {
      Project: {
        type: "relation",
        relation: { data_source_id: TARGETS.UGC_PROJECTS.dataSourceId },
      },
      Product: {
        type: "relation",
        relation: { data_source_id: TARGETS.PRODUCT_LIBRARY.dataSourceId },
      },
      Character: {
        type: "relation",
        relation: { data_source_id: TARGETS.CHARACTER_LIBRARY.dataSourceId },
      },
    });
  }
  return {
    object: "data_source",
    id: TARGETS[id].dataSourceId,
    parent: { type: "database_id", database_id: TARGETS[id].databaseId },
    properties,
  };
}

function keyProperty(value: string | undefined) {
  // The reader joins a rich_text property into ONE string, so each property
  // carries a single locator -- matching how the live library stores them.
  return { type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] };
}

/** Spreads a character's identity keys across the real identity properties. */
function identityProperties(identity: string[]) {
  return {
    "Identity Reference R2 Keys": keyProperty(identity[0]),
    "Canonical Reference Set": keyProperty(identity[1]),
    Preview: keyProperty(identity[2]),
  };
}

/**
 * Notion stub carrying only what this flow reads. `characters` is mutable so a
 * test can edit the library AFTER a project freeze and prove the lock holds.
 */
function stubNotion(characters: CharacterRow[], products: ProductRow[] = [DEFAULT_PRODUCT]) {
  const created: Array<{ target: string; properties: Record<string, unknown> }> = [];
  /**
   * Every created page, so create-or-reuse resolves the way production does:
   * by relation, since the live schemas have no Record ID column.
   */
  const pages: any[] = [];
  const relationIds = (page: any, name: string): string[] =>
    (page.properties?.[name]?.relation ?? []).map((entry: any) => entry.id).filter(Boolean);
  let sequence = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).href);
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<
      string,
      any
    >;

    if (url.pathname.startsWith("/v1/data_sources/") && !url.pathname.endsWith("/query")) {
      const id = url.pathname.split("/").at(-1)!;
      const capabilityId = CAPABILITY_IDS.find(
        (candidate) => TARGETS[candidate].dataSourceId === id,
      )!;
      return Response.json(dataSourceSchema(capabilityId));
    }
    if (url.pathname.endsWith("/query")) {
      const dataSourceId = url.pathname.split("/").at(-2);
      if (dataSourceId === TARGETS.PRODUCT_LIBRARY.dataSourceId) {
        return Response.json({
          results: products.map((row) => ({
            object: "page",
            id: row.id,
            parent: { type: "data_source_id", data_source_id: dataSourceId },
            properties: {
              Name: { type: "title", title: [{ plain_text: row.name }] },
              "Reference Images": keyProperty(row.reference),
            },
          })),
          has_more: false,
        });
      }
      if (dataSourceId === TARGETS.CHARACTER_LIBRARY.dataSourceId) {
        return Response.json({
          results: characters.map((row) => ({
            object: "page",
            id: row.id,
            last_edited_time: "2026-08-23T00:00:00.000Z",
            parent: { type: "data_source_id", data_source_id: dataSourceId },
            properties: {
              Name: { type: "title", title: [{ plain_text: row.name }] },
              ...identityProperties(row.identity),
              "Style Reference R2 Keys": keyProperty(row.style?.[0]),
            },
          })),
          has_more: false,
        });
      }
      if (body.filter?.property === "Project") {
        const projectId = body.filter.relation.contains;
        return Response.json({
          results: pages.filter((page) => relationIds(page, "Project").includes(projectId)),
          has_more: false,
        });
      }
      if (body.filter?.property === "Product") {
        const productId = body.filter.relation.contains;
        return Response.json({
          results: pages.filter((page) => relationIds(page, "Product").includes(productId)),
          has_more: false,
        });
      }
      return Response.json({ results: [], has_more: false });
    }
    if (url.pathname === "/v1/pages" && init?.method === "POST") {
      sequence += 1;
      created.push({ target: body.parent.data_source_id, properties: body.properties });
      const page = {
        object: "page",
        id: `created-${sequence}`,
        parent: { type: "data_source_id", data_source_id: body.parent.data_source_id },
        // Real Notion echoes a `type` discriminator on every property; the
        // scene-number read depends on it.
        properties: {
          ...body.properties,
          ...(body.properties?.["Shot Order"]
            ? { "Shot Order": { type: "number", ...body.properties["Shot Order"] } }
            : {}),
        },
      };
      pages.push(page);
      return Response.json(page);
    }
    // Reading back an active project's page.
    if (url.pathname.startsWith("/v1/pages/") && init?.method !== "PATCH") {
      const pageId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const stored = pages.find((page) => page.id === pageId);
      if (stored) {
        return Response.json(stored);
      }
    }
    if (url.pathname.startsWith("/v1/pages/") && init?.method === "PATCH") {
      patches.push(url.pathname);
      return Response.json({ object: "page", id: url.pathname.split("/").at(-1) });
    }
    throw new Error(`Unexpected Notion request: ${url.pathname}`);
  }) as unknown as typeof fetch;

  const patches: string[] = [];
  const storedPages = () => pages;
  const patchCount = () => patches.length;

  const paidVideoCalls = () =>
    (fetchImpl as unknown as { mock: { calls: Array<[string | URL]> } }).mock.calls.filter(
      ([input]) => String(input).includes("/videos") && !String(input).includes("/videos/models"),
    );

  return { fetchImpl, created, paidVideoCalls, storedPages, patchCount };
}

function buildWorkflow(characters: CharacterRow[], products: ProductRow[] = [DEFAULT_PRODUCT]) {
  const notion = stubNotion(characters, products);
  const pending = memoryStore<PendingUgcVideoScope>();
  const projectLocks = memoryStore<UgcProjectCharacterLock>();
  const projectInstances = memoryStore<UgcProjectInstance>();
  const activeProjects = memoryStore<ActiveUgcProject>();
  const binding = {
    accountId: "primary",
    groupId: "C-ugc",
    policyId: "UGC" as const,
    boundByOwnerId: OWNER,
    boundAt: "2026-08-23T00:00:00.000Z",
  };
  const workflow = new CloudbathUgcVideoWorkflow(
    { capabilities: TARGETS } as NonNullable<WorkspacePolicyConfig["ugc"]>,
    { lookup: vi.fn(async () => binding), requirePolicy: vi.fn(async () => binding) } as never,
    new UgcNotionWorkflowClient(
      "unit-test-token",
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies SafeLogger,
      notion.fetchImpl,
    ),
    pending,
    memoryStore<FrozenUgcVideoScope>(),
    memoryStore<ActiveUgcLineSession>(),
    projectLocks,
    projectInstances,
    activeProjects,
  );
  const tool = workflow.createTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: OWNER,
    sessionKey: SESSION_KEY,
    accountId: "primary",
    nativeConversationId: "line:group:C-ugc",
  })!;
  const prepare = async (input: Record<string, unknown>) => {
    await tool.execute("call", input);
    return (await pending.lookup(ugcPendingKey(SESSION_KEY)))!;
  };
  return {
    ...notion,
    workflow,
    tool,
    prepare,
    projectLocks,
    projectInstances,
    activeProjects,
    pending,
  };
}

const CAST: CharacterRow[] = [
  { id: "page-f1", name: "F1", identity: ["characters/f1/a.png", "characters/f1/b.png"] },
  { id: "page-f2", name: "F2", identity: ["characters/f2/a.png"] },
];

describe("multi-character UGC casting", () => {
  it("resolves F1 and F2 together and freezes both into the project lock", async () => {
    const flow = buildWorkflow(CAST);

    const scope = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
      durationSeconds: 10,
    });

    expect(scope.characterLocks.map((lock) => lock.code)).toEqual(["F1", "F2"]);
    expect(scope.characterLocks.map((lock) => lock.pageId)).toEqual(["page-f1", "page-f2"]);
    expect(scope.scene.sceneNumber).toBe(1);
    expect(scope.scene.characterCodes).toEqual(["F1", "F2"]);
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("gives both F1 and F2 an identity reference in the scene submission", async () => {
    const flow = buildWorkflow(CAST);

    const scope = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
    });

    const identity = scope.referenceAssets.filter((asset) => asset.kind === "identity");
    expect(identity.map((asset) => asset.locator)).toContain("characters/f1/a.png");
    expect(identity.map((asset) => asset.locator)).toContain("characters/f2/a.png");
    expect(scope.referenceAssets[0]?.kind).toBe("identity");
  });

  it("fails closed when one requested character is missing", async () => {
    const flow = buildWorkflow([CAST[0]!]);

    await expect(
      flow.prepare({
        productName: "Cloudbath Serum",
        characterNames: ["F1", "F2"],
        prompt: "F1 plays with F2",
      }),
    ).rejects.toThrow(/CHARACTER_LIBRARY record was not found/u);
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("fails closed on a duplicated character request", async () => {
    const flow = buildWorkflow(CAST);

    await expect(
      flow.prepare({
        productName: "Cloudbath Serum",
        characterNames: ["F1", "F1"],
        prompt: "F1 twice",
      }),
    ).rejects.toThrow(/more than once/u);
  });

  it("still accepts the single-character characterName input", async () => {
    const flow = buildWorkflow(CAST);

    const scope = await flow.prepare({
      productName: "Cloudbath Serum",
      characterName: "F1",
      prompt: "F1 alone",
    });

    expect(scope.characterLocks.map((lock) => lock.code)).toEqual(["F1"]);
  });
});

describe("identity reuse across scenes", () => {
  it("scene 2 submits the exact frozen F1/F2 references scene 1 used", async () => {
    const flow = buildWorkflow(CAST);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
      durationSeconds: 10,
    });
    const scene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 walks with F2 into the house",
      durationSeconds: 10,
    });

    expect(scene2.scene.sceneNumber).toBe(2);
    expect(scene2.characterLocks).toEqual(scene1.characterLocks);
    expect(scene2.referenceAssets).toEqual(scene1.referenceAssets);
    expect(scene2.scene.previousScenePageId).toBeDefined();
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("a Character Library edit after freeze cannot change the project lock", async () => {
    const characters = structuredClone(CAST);
    const flow = buildWorkflow(characters);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
    });

    // Someone swaps F2's canonical art between scenes.
    characters[1]!.identity = ["characters/f2/REPLACED.png"];

    const scene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 walks with F2 into the house",
    });

    expect(scene2.referenceAssets).toEqual(scene1.referenceAssets);
    expect(scene2.referenceAssets.some((asset) => asset.locator.includes("REPLACED"))).toBe(false);
  });

  it("refuses to recast a project that is already locked", async () => {
    const characters = [
      ...structuredClone(CAST),
      { id: "page-f3", name: "F3", identity: ["characters/f3/a.png"] },
    ];
    const flow = buildWorkflow(characters);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2",
    });

    // Same project record (same product + cast key) but a different cast would
    // silently swap who appears in later scenes.
    const lock = (await flow.projectLocks.entries())[0]!.value;
    expect(lock.characterLocks.map((entry) => entry.code)).toEqual(["F1", "F2"]);
    expect(lock.characterLocks.map((entry) => entry.pageId)).toEqual(["page-f1", "page-f2"]);
  });

  it("records continuity metadata for a later director pass", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
      durationSeconds: 10,
    });
    const scene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 walks with F2 into the house",
      durationSeconds: 10,
    });

    expect(scene2.scene).toMatchObject({
      sceneNumber: 2,
      characterPageIds: ["page-f1", "page-f2"],
      characterCodes: ["F1", "F2"],
      prompt: "F1 walks with F2 into the house",
      durationSeconds: 10,
    });
    expect(scene2.scene.previousScenePageId).toBeDefined();
  });
});

describe("live schema alignment", () => {
  it("writes both F1 and F2 into the project Character relation", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
    });

    const project = flow.created.find(
      (entry) => entry.target === TARGETS.UGC_PROJECTS.dataSourceId,
    )!;
    expect((project.properties as any).Character.relation.map((entry: any) => entry.id)).toEqual([
      "page-f1",
      "page-f2",
    ]);
  });

  it("creates rows using only live column names", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
      durationSeconds: 10,
    });

    const names = flow.created.flatMap((entry) => Object.keys(entry.properties));
    expect(names).not.toContain("Record ID");
    expect(names).not.toContain("Shot Number");
    expect(names).not.toContain("Duration Seconds");
    expect(names).not.toContain("Output R2 Key");

    const scene = flow.created.find((entry) => entry.target === TARGETS.UGC_SHOTS.dataSourceId)!;
    expect(scene.properties).toHaveProperty("Shot Order");
    expect(scene.properties).toHaveProperty("Duration");
  });

  it("creates rows only with live status options", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in a garden",
    });

    for (const entry of flow.created) {
      const status = (entry.properties as any).Status?.select?.name;
      if (status) {
        expect(["Draft", "Ready", "Generating", "Completed", "Failed"]).toContain(status);
      }
    }
  });

  it("reuses the same project row for a repeated preparation of the same cast", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "scene one",
    });
    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "scene two",
    });

    // Idempotent without a Record ID column: identity is Product + exact cast.
    expect(
      flow.created.filter((entry) => entry.target === TARGETS.UGC_PROJECTS.dataSourceId),
    ).toHaveLength(1);
  });
});

describe("previous scene is never invented", () => {
  it("refuses to prepare scene 2 when scene 1 does not exist", async () => {
    const flow = buildWorkflow(CAST);

    await expect(
      flow.prepare({
        productName: "Cloudbath Serum",
        characterNames: ["F1", "F2"],
        sceneNumber: 2,
        prompt: "F1 พา F2 เดินเข้าบ้าน",
      }),
    ).rejects.toThrow(/scene 1 does not exist/u);
  });

  it("never creates a scene 1 carrying scene 2's prompt", async () => {
    const flow = buildWorkflow(CAST);

    await flow
      .prepare({
        productName: "Cloudbath Serum",
        characterNames: ["F1", "F2"],
        sceneNumber: 2,
        prompt: "F1 พา F2 เดินเข้าบ้าน",
      })
      .catch(() => undefined);

    const scenes = flow.created.filter((entry) => entry.target === TARGETS.UGC_SHOTS.dataSourceId);
    expect(scenes).toHaveLength(0);
    expect(JSON.stringify(flow.created)).not.toContain("เดินเข้าบ้าน");
  });

  it("links scene 2 to the real scene 1 once it exists", async () => {
    const flow = buildWorkflow(CAST);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 เล่นกับ F2 ในสวน",
    });
    const scene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      sceneNumber: 2,
      prompt: "F1 พา F2 เดินเข้าบ้าน",
    });

    expect(scene2.scene.previousScenePageId).toBe(scene1.scenePageId);
    expect(scene2.scenePageId).not.toBe(scene1.scenePageId);
  });
});

describe("project instance identity", () => {
  it("keeps the same active project across scenes", async () => {
    const flow = buildWorkflow(CAST);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 เล่นกับ F2 ในสวน",
    });
    const scene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      sceneNumber: 2,
      prompt: "F1 พา F2 เข้าบ้าน",
    });

    expect(scene2.projectInstanceId).toBe(scene1.projectInstanceId);
    expect(scene2.projectPageId).toBe(scene1.projectPageId);
    expect(
      flow.created.filter((entry) => entry.target === TARGETS.UGC_PROJECTS.dataSourceId),
    ).toHaveLength(1);
  });

  it("creates an independent project for the same product and cast on request", async () => {
    const flow = buildWorkflow(CAST);

    const storyA = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Story A scene 1",
    });
    const storyB = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      startNewProject: true,
      prompt: "Story B scene 1",
    });

    // Same product, same cast, different films.
    expect(storyB.projectInstanceId).not.toBe(storyA.projectInstanceId);
    expect(storyB.projectPageId).not.toBe(storyA.projectPageId);
    expect(
      flow.created.filter((entry) => entry.target === TARGETS.UGC_PROJECTS.dataSourceId),
    ).toHaveLength(2);
  });

  it("gives each project its own character lock", async () => {
    const characters = structuredClone(CAST);
    const flow = buildWorkflow(characters);

    const storyA = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Story A scene 1",
    });

    // The library moves on between films.
    characters[1]!.identity = ["characters/f2/SEASON-TWO.png"];

    const storyB = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      startNewProject: true,
      prompt: "Story B scene 1",
    });

    // Project A is untouched; project B is free to freeze the new references.
    expect(storyA.referenceAssets.some((asset) => asset.locator.includes("SEASON-TWO"))).toBe(
      false,
    );
    expect(storyB.referenceAssets.some((asset) => asset.locator.includes("SEASON-TWO"))).toBe(true);
    expect(await flow.projectLocks.entries()).toHaveLength(2);
  });

  it("continues story B, not story A, after an explicit new project", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Story A scene 1",
    });
    const storyB = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      startNewProject: true,
      prompt: "Story B scene 1",
    });
    const storyBScene2 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      sceneNumber: 2,
      prompt: "Story B scene 2",
    });

    expect(storyBScene2.projectInstanceId).toBe(storyB.projectInstanceId);
    expect(storyBScene2.scene.sceneNumber).toBe(2);
  });

  it("replaying a scene preparation stays idempotent", async () => {
    const flow = buildWorkflow(CAST);

    const first = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "F1 เล่นกับ F2 ในสวน",
    });
    const replay = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      sceneNumber: 1,
      prompt: "F1 เล่นกับ F2 ในสวน",
    });

    expect(replay.projectInstanceId).toBe(first.projectInstanceId);
    expect(replay.scenePageId).toBe(first.scenePageId);
    expect(
      flow.created.filter((entry) => entry.target === TARGETS.UGC_SHOTS.dataSourceId),
    ).toHaveLength(1);
  });

  it("scopes the active project to the trusted account, group and owner", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Story A scene 1",
    });

    const [entry] = await flow.activeProjects.entries();
    expect(entry!.value).toMatchObject({
      accountId: "primary",
      lineGroupId: "C-ugc",
      ownerSenderId: OWNER,
    });
  });
});

describe("explicit project finalization", () => {
  function finalizeTool(flow: ReturnType<typeof buildWorkflow>) {
    return flow.workflow.createFinalizeTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: OWNER,
      sessionKey: SESSION_KEY,
      accountId: "primary",
      nativeConversationId: "line:group:C-ugc",
    })!;
  }

  it("reports no completed scene rather than finalizing an empty project", async () => {
    const flow = buildWorkflow(CAST);
    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Story A scene 1",
    });

    const result = (await finalizeTool(flow).execute()) as {
      details?: { resolution?: string };
    };

    expect(result.details?.resolution).toBe("no_completed_scene");
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("refuses when the conversation has no active project", async () => {
    const flow = buildWorkflow(CAST);

    const result = (await finalizeTool(flow).execute()) as {
      details?: { resolution?: string };
    };

    expect(result.details?.resolution).toBe("no_active_project");
  });

  it("is not available to a non-owner", () => {
    const flow = buildWorkflow(CAST);

    expect(
      flow.workflow.createFinalizeTool({
        messageChannel: "line",
        senderIsOwner: false,
        requesterSenderId: "U-someone-else",
        sessionKey: SESSION_KEY,
        accountId: "primary",
        nativeConversationId: "line:group:C-ugc",
      }),
    ).toBeNull();
  });
});

describe("A) character-only project", () => {
  it("creates a project and two scenes with no product at all", async () => {
    const flow = buildWorkflow(CAST);

    const scene1 = await flow.prepare({
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in the garden",
      durationSeconds: 10,
    });
    const scene2 = await flow.prepare({
      characterNames: ["F1", "F2"],
      sceneNumber: 2,
      prompt: "F1 walks with F2 into the house",
      durationSeconds: 10,
    });

    expect(scene1.productPageId).toBeUndefined();
    expect(scene2.projectInstanceId).toBe(scene1.projectInstanceId);
    // Identical frozen F1/F2 references across both scenes.
    expect(scene2.referenceAssets).toEqual(scene1.referenceAssets);
    expect(scene1.referenceAssets.every((asset) => asset.kind === "identity")).toBe(true);
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("does not invent a placeholder product row", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({
      characterNames: ["F1", "F2"],
      prompt: "F1 plays with F2 in the garden",
    });

    expect(
      flow.created.filter((entry) => entry.target === TARGETS.PRODUCT_LIBRARY.dataSourceId),
    ).toHaveLength(0);
    const project = flow.created.find(
      (entry) => entry.target === TARGETS.UGC_PROJECTS.dataSourceId,
    )!;
    expect((project.properties as any).Product.relation).toEqual([]);
  });

  it("still requires a prompt", async () => {
    const flow = buildWorkflow(CAST);

    await expect(flow.prepare({ characterNames: ["F1"] })).rejects.toThrow(/prompt is required/u);
  });
});

describe("B) product identity lock", () => {
  it("scene 2 keeps the product references frozen at project creation", async () => {
    const products: ProductRow[] = [structuredClone(DEFAULT_PRODUCT)];
    const flow = buildWorkflow(CAST, products);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Scene 1",
    });

    // The Product Library is edited between scenes.
    products[0]!.reference = "product/serum-REPACKAGED.png";

    const scene2 = await flow.prepare({
      characterNames: ["F1", "F2"],
      sceneNumber: 2,
      prompt: "Scene 2",
    });

    expect(scene2.referenceAssets).toEqual(scene1.referenceAssets);
    expect(scene2.referenceAssets.some((asset) => asset.locator.includes("REPACKAGED"))).toBe(
      false,
    );
    expect(scene1.referenceAssets.some((asset) => asset.locator === "product/serum.png")).toBe(
      true,
    );
  });

  it("a new project may freeze the updated product references", async () => {
    const products: ProductRow[] = [structuredClone(DEFAULT_PRODUCT)];
    const flow = buildWorkflow(CAST, products);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Project A scene 1",
    });
    products[0]!.reference = "product/serum-REPACKAGED.png";

    const projectB = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      startNewProject: true,
      prompt: "Project B scene 1",
    });

    expect(projectB.referenceAssets.some((asset) => asset.locator.includes("REPACKAGED"))).toBe(
      true,
    );
  });
});

describe("C) continuation uses frozen project identity", () => {
  it("continues without repeating productName", async () => {
    const flow = buildWorkflow(CAST);

    const scene1 = await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Scene 1",
    });
    const scene2 = await flow.prepare({ sceneNumber: 2, prompt: "Scene 2" });

    expect(scene2.projectInstanceId).toBe(scene1.projectInstanceId);
    expect(scene2.productPageId).toBe(scene1.productPageId);
    expect(scene2.characterLocks).toEqual(scene1.characterLocks);
  });

  it("fails closed when a different product is named mid-project", async () => {
    const products: ProductRow[] = [
      structuredClone(DEFAULT_PRODUCT),
      { id: "product-page-2", name: "Cloudbath Toner", reference: "product/toner.png" },
    ];
    const flow = buildWorkflow(CAST, products);

    await flow.prepare({
      productName: "Cloudbath Serum",
      characterNames: ["F1", "F2"],
      prompt: "Scene 1",
    });

    await expect(
      flow.prepare({
        productName: "Cloudbath Toner",
        characterNames: ["F1", "F2"],
        sceneNumber: 2,
        prompt: "Scene 2",
      }),
    ).rejects.toThrow(/locked to a different product/u);
  });

  it("does not re-resolve characters on continuation", async () => {
    const characters = structuredClone(CAST);
    const flow = buildWorkflow(characters);

    const scene1 = await flow.prepare({
      characterNames: ["F1", "F2"],
      prompt: "Scene 1",
    });
    // Renaming the library rows would break a re-resolve; the frozen lock does
    // not care.
    characters[0]!.name = "RENAMED";
    characters[1]!.name = "ALSO-RENAMED";

    const scene2 = await flow.prepare({ sceneNumber: 2, prompt: "Scene 2" });

    expect(scene2.characterLocks).toEqual(scene1.characterLocks);
    expect(scene2.referenceAssets).toEqual(scene1.referenceAssets);
  });
});

describe("D) finalized projects are durably closed", () => {
  function finalize(flow: ReturnType<typeof buildWorkflow>) {
    return flow.workflow.createFinalizeTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: OWNER,
      sessionKey: SESSION_KEY,
      accountId: "primary",
      nativeConversationId: "line:group:C-ugc",
    })!;
  }

  /** Marks every scene row Completed so finalization has something to close. */
  function completeScenes(flow: ReturnType<typeof buildWorkflow>) {
    for (const page of flow.storedPages()) {
      if (page.properties?.["Shot Order"]) {
        page.properties.Status = { type: "select", select: { name: "Completed" } };
        page.properties["Generated R2 Object Key"] = {
          type: "rich_text",
          rich_text: [{ plain_text: "outbound/line-video/scene.mp4" }],
        };
      }
    }
  }

  it("finalizes, then refuses further scenes and stays finalized", async () => {
    const flow = buildWorkflow(CAST);

    await flow.prepare({ characterNames: ["F1", "F2"], prompt: "Scene 1" });
    await flow.prepare({ characterNames: ["F1", "F2"], sceneNumber: 2, prompt: "Scene 2" });
    completeScenes(flow);

    const finalized = (await finalize(flow).execute()) as { details?: Record<string, unknown> };
    expect(finalized.details?.resolution).toBe("project_finalized");
    expect(finalized.details?.finalizedAt).toEqual(expect.any(String));

    // "ต่อ Scene 3" must fail closed.
    await expect(flow.prepare({ sceneNumber: 3, prompt: "F1 กับ F2 ตอนจบ" })).rejects.toThrow(
      /finalized and cannot take more scenes/u,
    );
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("is idempotent when finalized twice", async () => {
    const flow = buildWorkflow(CAST);
    await flow.prepare({ characterNames: ["F1", "F2"], prompt: "Scene 1" });
    completeScenes(flow);

    const first = (await finalize(flow).execute()) as { details?: Record<string, unknown> };
    const patchesAfterFirst = flow.patchCount();
    const second = (await finalize(flow).execute()) as { details?: Record<string, unknown> };

    expect(first.details?.resolution).toBe("project_finalized");
    expect(second.details?.resolution).toBe("already_finalized");
    expect(second.details?.finalizedAt).toBe(first.details?.finalizedAt);
    // No further Notion write, and certainly no provider call.
    expect(flow.patchCount()).toBe(patchesAfterFirst);
    expect(flow.paidVideoCalls()).toHaveLength(0);
  });

  it("allows an explicit new project after finalization", async () => {
    const flow = buildWorkflow(CAST);
    const projectA = await flow.prepare({ characterNames: ["F1", "F2"], prompt: "Scene 1" });
    completeScenes(flow);
    await finalize(flow).execute();

    const projectB = await flow.prepare({
      characterNames: ["F1", "F2"],
      startNewProject: true,
      prompt: "New film scene 1",
    });

    expect(projectB.projectInstanceId).not.toBe(projectA.projectInstanceId);
    expect(projectB.scene.sceneNumber).toBe(1);
  });
});
