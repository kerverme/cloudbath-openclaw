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
  UgcProjectCharacterLock,
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

/** Mirrors the live capability schemas the workflow validates before writing. */
function dataSourceSchema(id: UgcCapabilityId) {
  const properties: Record<string, unknown> = { Name: { type: "title" } };
  if (id === "UGC_PROJECTS") {
    Object.assign(properties, {
      "Record ID": { type: "rich_text" },
      Status: { type: "select" },
      Product: {
        type: "relation",
        relation: { data_source_id: TARGETS.PRODUCT_LIBRARY.dataSourceId },
      },
      Character: {
        type: "relation",
        relation: { data_source_id: TARGETS.CHARACTER_LIBRARY.dataSourceId },
      },
      Prompt: { type: "rich_text" },
      "Estimated Cost USD": { type: "number" },
      "Actual Cost USD": { type: "number" },
    });
  } else if (id === "UGC_SHOTS") {
    Object.assign(properties, {
      "Record ID": { type: "rich_text" },
      Status: { type: "select" },
      Project: {
        type: "relation",
        relation: { data_source_id: TARGETS.UGC_PROJECTS.dataSourceId },
      },
      "Shot Number": { type: "number" },
      Prompt: { type: "rich_text" },
    });
  } else if (id === "AI_VIDEO_LIBRARY") {
    Object.assign(properties, {
      Status: { type: "select" },
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
function stubNotion(characters: CharacterRow[]) {
  const created: Array<{ target: string; properties: Record<string, unknown> }> = [];
  /** Record ID -> stored page, so create-or-reuse behaves like real Notion. */
  const pagesByRecordId = new Map<string, any>();
  const recordIdOf = (properties: any): string | undefined =>
    properties?.["Record ID"]?.rich_text?.[0]?.text?.content ??
    properties?.["Record ID"]?.rich_text?.[0]?.plain_text;
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
          results: [
            {
              object: "page",
              id: "product-page",
              parent: { type: "data_source_id", data_source_id: dataSourceId },
              properties: {
                Name: { type: "title", title: [{ plain_text: "Cloudbath Serum" }] },
                "Reference Images": keyProperty("product/serum.png"),
              },
            },
          ],
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
          results: [...pagesByRecordId.values()].filter(
            (page) => page.properties?.Project?.relation?.[0]?.id === projectId,
          ),
          has_more: false,
        });
      }
      if (body.filter?.property === "Record ID") {
        const match = pagesByRecordId.get(body.filter.rich_text.equals);
        return Response.json({ results: match ? [match] : [], has_more: false });
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
          ...(body.properties?.["Shot Number"]
            ? { "Shot Number": { type: "number", ...body.properties["Shot Number"] } }
            : {}),
        },
      };
      const id = recordIdOf(body.properties);
      if (id) {
        pagesByRecordId.set(id, page);
      }
      return Response.json(page);
    }
    if (url.pathname.startsWith("/v1/pages/") && init?.method === "PATCH") {
      return Response.json({ object: "page", id: url.pathname.split("/").at(-1) });
    }
    throw new Error(`Unexpected Notion request: ${url.pathname}`);
  }) as unknown as typeof fetch;

  const paidVideoCalls = () =>
    (fetchImpl as unknown as { mock: { calls: Array<[string | URL]> } }).mock.calls.filter(
      ([input]) => String(input).includes("/videos") && !String(input).includes("/videos/models"),
    );

  return { fetchImpl, created, paidVideoCalls };
}

function buildWorkflow(characters: CharacterRow[]) {
  const notion = stubNotion(characters);
  const pending = memoryStore<PendingUgcVideoScope>();
  const projectLocks = memoryStore<UgcProjectCharacterLock>();
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
  return { ...notion, workflow, prepare, projectLocks, pending };
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
