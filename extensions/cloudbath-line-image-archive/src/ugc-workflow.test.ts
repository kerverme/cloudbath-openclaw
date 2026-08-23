import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveUgcLineSession,
  FrozenUgcVideoScope,
  PendingUgcVideoScope,
  UgcProjectCharacterLock,
  SafeLogger,
  UgcCapabilityId,
  WorkspacePolicyConfig,
} from "./types.js";
import {
  CloudbathUgcVideoWorkflow,
  UgcNotionWorkflowClient,
  ugcDraftScopeKey,
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

const LIVE_TARGETS = {
  PRODUCT_LIBRARY: {
    databaseId: "3338128fbb6345a9b2a92389ad070ac2",
    dataSourceId: "7342057309e74999a5a3813afa27d396",
  },
  CHARACTER_LIBRARY: {
    databaseId: "c9b716a9a305425d89c25254d837ac79",
    dataSourceId: "e27e904b17bf4a349f11dd6eab57041c",
  },
  UGC_PROJECTS: {
    databaseId: "4a583619ec254b61acd4c2b87812f95b",
    dataSourceId: "27452a8424c5465193e48bdbf3772f53",
  },
  UGC_SHOTS: {
    databaseId: "42d421b1258942b5aa26ef3093ce635e",
    dataSourceId: "d35ccd4ba44b4ac798e9b3647b201b55",
  },
  AI_VIDEO_LIBRARY: {
    databaseId: "3d309900f0a2466480b2a98fbae3e206",
    dataSourceId: "9305e95bdc2d4ed9bd001cd661e3807d",
  },
  AI_IMAGE_LIBRARY: {
    databaseId: "82d3bf66801a48f79482a71d18dce4e8",
    dataSourceId: "5438e9ffd76f4d5e870df260a3940b3c",
  },
} as const;

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
      return Array.from(values, ([key, value]) => ({ key, value, createdAt: Date.now() }));
    },
    async clear() {
      values.clear();
    },
  };
}

function logger(): SafeLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

function schema(id: UgcCapabilityId) {
  const properties: Record<string, unknown> = { Name: { type: "title" } };
  if (id === "UGC_PROJECTS") {
    Object.assign(properties, {
      "Record ID": { type: "rich_text" },
      Status: { type: "select" },
      Product: {
        type: "relation",
        relation: { data_source_id: LIVE_TARGETS.PRODUCT_LIBRARY.dataSourceId },
      },
      Character: {
        type: "relation",
        relation: { data_source_id: LIVE_TARGETS.CHARACTER_LIBRARY.dataSourceId },
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
        relation: { data_source_id: LIVE_TARGETS.UGC_PROJECTS.dataSourceId },
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
        relation: { data_source_id: LIVE_TARGETS.UGC_PROJECTS.dataSourceId },
      },
      "Safe Extra Column": { type: "checkbox" },
    });
  } else if (id === "AI_IMAGE_LIBRARY") {
    Object.assign(properties, {
      Project: {
        type: "relation",
        relation: { data_source_id: LIVE_TARGETS.UGC_PROJECTS.dataSourceId },
      },
      Product: {
        type: "relation",
        relation: { data_source_id: LIVE_TARGETS.PRODUCT_LIBRARY.dataSourceId },
      },
      Character: {
        type: "relation",
        relation: { data_source_id: LIVE_TARGETS.CHARACTER_LIBRARY.dataSourceId },
      },
    });
  }
  return {
    object: "data_source",
    id: LIVE_TARGETS[id].dataSourceId,
    parent: { type: "database_id", database_id: LIVE_TARGETS[id].databaseId },
    properties,
  };
}

function liveFetch() {
  const created: Array<{ target: string; properties: Record<string, unknown> }> = [];
  let pageSequence = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    const source = CAPABILITY_IDS.find((id) =>
      url.pathname.endsWith(LIVE_TARGETS[id].dataSourceId),
    );
    if (source && init?.method !== "POST") {
      return Response.json(schema(source));
    }
    if (url.pathname.endsWith("/query")) {
      const dataSourceId = url.pathname.split("/").at(-2);
      const body = JSON.parse(requestBody(init?.body)) as { filter?: { property?: string } };
      if (dataSourceId === LIVE_TARGETS.PRODUCT_LIBRARY.dataSourceId) {
        return Response.json({
          results: [
            {
              object: "page",
              id: "product-page",
              parent: { type: "data_source_id", data_source_id: dataSourceId },
              properties: {
                Name: { type: "title", title: [{ plain_text: "Cloudbath Serum" }] },
                "R2 Object Keys": {
                  type: "rich_text",
                  rich_text: [{ plain_text: "workspace/ugc/product/serum.png" }],
                },
              },
            },
          ],
          has_more: false,
        });
      }
      if (dataSourceId === LIVE_TARGETS.CHARACTER_LIBRARY.dataSourceId) {
        return Response.json({
          results: [
            {
              object: "page",
              id: "character-page",
              parent: { type: "data_source_id", data_source_id: dataSourceId },
              properties: {
                Name: { type: "title", title: [{ plain_text: "Mae Kampong Host" }] },
                "Identity Reference R2 Keys": {
                  type: "url",
                  url: "https://assets.example/identity.png",
                },
                "Style Reference R2 Keys": {
                  type: "url",
                  url: "https://assets.example/style.png",
                },
              },
            },
          ],
          has_more: false,
        });
      }
      if (
        body.filter?.property === "Record ID" &&
        (dataSourceId === LIVE_TARGETS.UGC_PROJECTS.dataSourceId ||
          dataSourceId === LIVE_TARGETS.UGC_SHOTS.dataSourceId)
      ) {
        return Response.json({ results: [], has_more: false });
      }
      // Scene-number lookup for a project with no scenes yet.
      if (
        body.filter?.property === "Project" &&
        dataSourceId === LIVE_TARGETS.UGC_SHOTS.dataSourceId
      ) {
        return Response.json({ results: [], has_more: false });
      }
    }
    if (url.pathname === "/v1/pages" && init?.method === "POST") {
      const body = JSON.parse(requestBody(init.body)) as {
        parent: { data_source_id: string };
        properties: Record<string, unknown>;
      };
      pageSequence += 1;
      created.push({ target: body.parent.data_source_id, properties: body.properties });
      return Response.json({
        object: "page",
        id: `created-page-${pageSequence}`,
        parent: { type: "data_source_id", data_source_id: body.parent.data_source_id },
        properties: body.properties,
      });
    }
    if (url.pathname.startsWith("/v1/pages/") && init?.method === "PATCH") {
      return Response.json({ object: "page", id: url.pathname.split("/").at(-1) });
    }
    throw new Error(`Unexpected Notion request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, created };
}

const CONFIG: NonNullable<WorkspacePolicyConfig["ugc"]> = {
  capabilities: LIVE_TARGETS,
};

describe("Cloudbath UGC workflow", () => {
  it("accepts all six live targets and safe extra relation-era columns", async () => {
    const { fetchImpl } = liveFetch();
    const client = new UgcNotionWorkflowClient(
      "unit-test-token",
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger(),
      fetchImpl,
    );
    await expect(client.validateCapabilities(LIVE_TARGETS)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("resolves Product and Character inside fixed capabilities and links Project and Shots", async () => {
    const { fetchImpl, created } = liveFetch();
    const pending = memoryStore<PendingUgcVideoScope>();
    const scopes = memoryStore<FrozenUgcVideoScope>();
    const activeSessions = memoryStore<ActiveUgcLineSession>();
    const client = new UgcNotionWorkflowClient(
      "unit-test-token",
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      logger(),
      fetchImpl,
    );
    const workflow = new CloudbathUgcVideoWorkflow(
      CONFIG,
      {
        lookup: vi.fn(async () => ({
          accountId: "primary",
          groupId: "C-ugc",
          policyId: "UGC" as const,
          boundByOwnerId: "U-owner",
          boundAt: "2026-08-23T00:00:00.000Z",
        })),
        requirePolicy: vi.fn(async () => ({
          accountId: "primary",
          groupId: "C-ugc",
          policyId: "UGC" as const,
          boundByOwnerId: "U-owner",
          boundAt: "2026-08-23T00:00:00.000Z",
        })),
      } as never,
      client,
      pending,
      scopes,
      activeSessions,
      memoryStore<UgcProjectCharacterLock>(),
      () => Date.UTC(2026, 7, 23),
    );
    await workflow.observeTurn({
      channelId: "line",
      accountId: "primary",
      conversationId: "C-ugc",
      sessionKey: "line-session",
      senderId: "U-owner",
      senderIsOwner: true,
    });
    const tool = workflow.createTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: "U-owner",
      sessionKey: "line-session",
      accountId: "primary",
      nativeConversationId: "C-ugc",
    });
    const result = await tool!.execute("call-1", {
      productName: "Cloudbath Serum",
      characterName: "Mae Kampong Host",
      prompt: "Review the serum in a calm wellness setting",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "1080p",
      audio: true,
    });
    expect(result.details).toMatchObject({
      resolution: "ugc_scope_prepared",
      nextTool: "line_video_draft",
      identityReferenceCount: 1,
      referenceCount: 3,
    });

    const project = created.find(
      (entry) => entry.target === LIVE_TARGETS.UGC_PROJECTS.dataSourceId,
    );
    expect(project?.properties).toMatchObject({
      Product: { relation: [{ id: "product-page" }] },
      Character: { relation: [{ id: "character-page" }] },
    });
    // One ledger row per scene: preparation creates Scene 1 only, and later
    // scenes are added on request rather than by a fixed three-shot plan.
    const shots = created.filter((entry) => entry.target === LIVE_TARGETS.UGC_SHOTS.dataSourceId);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.properties).toMatchObject({
      Project: { relation: [{ id: "created-page-1" }] },
      "Shot Number": { number: 1 },
    });

    const pendingScope = await pending.lookup(ugcPendingKey("line-session"));
    expect(pendingScope).toMatchObject({
      policyId: "UGC",
      projectPageId: "created-page-1",
      shotPageIds: ["created-page-2"],
      frozenPrompt: "Review the serum in a calm wellness setting",
    });
    await expect(
      workflow.beforeToolCall({
        toolName: "line_video_draft",
        sessionKey: "line-session",
        toolParams: {
          prompt: "tampered prompt",
          durationSeconds: 8,
          aspectRatio: "9:16",
          resolution: "1080p",
          audio: true,
        },
      }),
    ).resolves.toMatchObject({ block: true });
    await workflow.afterToolCall({
      toolName: "line_video_draft",
      sessionKey: "line-session",
      result: {
        details: { resolution: "draft_created", draftId: "4827", estimatedCostUsd: 1.16 },
      },
    });
    expect(await scopes.lookup(ugcDraftScopeKey("4827"))).toMatchObject({
      projectPageId: "created-page-1",
      capabilities: LIVE_TARGETS,
    });
    expect(await pending.lookup(ugcPendingKey("line-session"))).toBeUndefined();
  });

  it("blocks a direct video draft in a paired UGC owner session until scope is frozen", async () => {
    const { fetchImpl } = liveFetch();
    const workflow = new CloudbathUgcVideoWorkflow(
      CONFIG,
      {
        lookup: vi.fn(async () => ({
          accountId: "primary",
          groupId: "C-ugc",
          policyId: "UGC" as const,
          boundByOwnerId: "U-owner",
          boundAt: "2026-08-23T00:00:00.000Z",
        })),
      } as never,
      new UgcNotionWorkflowClient(
        "unit-test-token",
        { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        logger(),
        fetchImpl,
      ),
      memoryStore<PendingUgcVideoScope>(),
      memoryStore<FrozenUgcVideoScope>(),
      memoryStore<ActiveUgcLineSession>(),
      memoryStore<UgcProjectCharacterLock>(),
    );
    await workflow.observeTurn({
      channelId: "line",
      accountId: "primary",
      conversationId: "C-ugc",
      sessionKey: "line-session",
      senderId: "U-owner",
      senderIsOwner: true,
    });

    await expect(
      workflow.beforeToolCall({
        toolName: "line_video_draft",
        sessionKey: "line-session",
        toolParams: { prompt: "unscoped video" },
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not expose the paid preparation tool to a non-owner", () => {
    const { fetchImpl } = liveFetch();
    const workflow = new CloudbathUgcVideoWorkflow(
      CONFIG,
      {} as never,
      new UgcNotionWorkflowClient(
        "unit-test-token",
        { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        logger(),
        fetchImpl,
      ),
      memoryStore<PendingUgcVideoScope>(),
      memoryStore<FrozenUgcVideoScope>(),
      memoryStore<ActiveUgcLineSession>(),
      memoryStore<UgcProjectCharacterLock>(),
    );
    expect(
      workflow.createTool({
        messageChannel: "line",
        senderIsOwner: false,
        requesterSenderId: "U-member",
        sessionKey: "line-session",
        accountId: "primary",
        nativeConversationId: "C-ugc",
      }),
    ).toBeNull();
  });
});
