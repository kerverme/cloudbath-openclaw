/**
 * The fal reference-to-video path, end to end from an exact confirmation to a
 * LINE-delivered video, with no real provider call.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();
const sendMessageLineMock = vi.fn(async (..._args: unknown[]) => ({}));
const stageLineOutboundVideoMock = vi.fn(async (..._args: unknown[]) => ({
  url: "https://r2.example/archived.mp4?X-Amz-Signature=sig",
  objectKey: "outbound/line-video/sha256/ab/abcd.mp4",
  contentType: "video/mp4",
  contentLength: 10,
  sha256: "abcd",
}));
const signArchivedLineVideoUrlMock = vi.fn(
  async (key: string) => `https://r2.example/${key}?X-Amz-Signature=resigned`,
);
const resolveReferenceUrlsMock = vi.fn(async () => [
  {
    index: 0,
    url: "https://r2.example/ref-char-6.png?X-Amz-Signature=a",
    mimeType: "image/png",
    characterCode: "CHAR-6",
  },
  {
    index: 1,
    url: "https://r2.example/ref-char-10.jpg?X-Amz-Signature=b",
    mimeType: "image/jpeg",
    characterCode: "CHAR-10",
  },
]);
const runtimeConfigMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

const notion = {
  validate: vi.fn(async () => {}),
  createProcessing: vi.fn(async () => ({ pageId: "notion-page-1" })),
  markCompleted: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  markUgcProcessing: vi.fn(async () => {}),
  markUgcCompleted: vi.fn(async () => {}),
  markUgcFailed: vi.fn(async () => {}),
};

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => runtimeConfigMock.current,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "sk-test" }),
}));
vi.mock("./accounts.js", () => ({
  resolveLineAccount: () => ({
    accountId: "acct-1",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config" as const,
    config: {
      videoGeneration: {
        maxEstimatedCostUsd: 5,
        falPricing: {
          models: { "bytedance/seedance-2.0/reference-to-video": { usdPerSecond: 0.1 } },
        },
      },
    },
  }),
}));
vi.mock("./send.js", () => ({
  sendMessageLine: (...args: unknown[]) => sendMessageLineMock(...args),
}));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: (...args: unknown[]) => stageLineOutboundVideoMock(...args),
  stageLineVideoPreviewImage: async () => ({
    url: "https://r2.example/preview.jpg",
    objectKey: "outbound/line/preview.jpg",
    contentType: "image/jpeg",
    contentLength: 10,
    sha256: "def",
  }),
  signArchivedLineVideoUrl: (key: string) => signArchivedLineVideoUrlMock(key),
}));
vi.mock("./video-reference-urls.js", () => ({
  resolveLineVideoReferenceUrls: () => resolveReferenceUrlsMock(),
}));

const { createLineVideoConfirmationGate } = await import("./video-confirmation.js");
const { createLineVideoDraft } = await import("./video-draft-store.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock, LineVideoJob } from "./video-job-store.js";
import type { LineVideoUgcScope } from "./video-ugc-scope.js";
import type { LineVideoWorkspaceRuntime } from "./video-workspace-runtime.js";

const FAL_ROUTE = {
  provider: "fal" as const,
  modelId: "bytedance/seedance-2.0/reference-to-video",
};
const OWNER_ID = "U-owner";
const TRANSIENT_FAL_URL = "https://v3.fal.media/files/rabbit/out.mp4?token=transient";

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
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
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

const UGC_CAPABILITIES = {
  PRODUCT_LIBRARY: { databaseId: "a".repeat(32), dataSourceId: "1".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "2".repeat(32) },
  UGC_PROJECTS: { databaseId: "c".repeat(32), dataSourceId: "3".repeat(32) },
  UGC_SHOTS: { databaseId: "d".repeat(32), dataSourceId: "4".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "e".repeat(32), dataSourceId: "5".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "f".repeat(32), dataSourceId: "6".repeat(32) },
} as const;
const FROZEN_PROMPT = "Twong walks in the garden\nAudio timeline:\n0-10s | sound: ambience";

function ugcScope(): LineVideoUgcScope {
  return {
    version: 1,
    policyId: "UGC",
    accountId: "acct-1",
    lineGroupId: "grp-a",
    ownerSenderId: OWNER_ID,
    productPageId: "product-page",
    characterPageId: "char-6-page",
    characterLocks: [
      {
        code: "CHAR-6",
        pageId: "char-6-page",
        identityReferences: [
          { kind: "identity", source: "r2", locator: "ugc/characters/char-6.png" },
        ],
        styleReferences: [],
        frozenAt: "2026-08-23T00:00:00.000Z",
      },
    ],
    projectInstanceId: "project-instance",
    projectPageId: "project-page",
    projectRecordId: "project-record",
    scene: {
      sceneNumber: 1,
      characterPageIds: ["char-6-page"],
      characterCodes: ["CHAR-6"],
      prompt: FROZEN_PROMPT,
    },
    scenePageId: "shot-1",
    shotPageIds: ["shot-1"],
    referenceAssets: [{ kind: "identity", source: "r2", locator: "ugc/characters/char-6.png" }],
    frozenPrompt: FROZEN_PROMPT,
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: true,
    capabilities: UGC_CAPABILITIES,
    r2Prefix: "outbound/line-video",
    createdAt: "2026-08-23T00:00:00.000Z",
  } as LineVideoUgcScope;
}

function workspaceRuntime(scopeStore: PluginStateKeyedStore<LineVideoUgcScope>) {
  return {
    async lookupBinding(accountId: string, groupId: string) {
      return accountId === "acct-1" && groupId === "grp-a"
        ? {
            accountId: "acct-1",
            groupId: "grp-a",
            policyId: "UGC",
            boundByOwnerId: OWNER_ID,
            boundAt: "2026-08-23T00:00:00.000Z",
          }
        : undefined;
    },
    async lookupUgcDraftScope(draftId: string) {
      return await scopeStore.lookup(draftId);
    },
    async consumeUgcDraftScope(draftId: string) {
      return await scopeStore.consume(draftId);
    },
    async requoteActiveStoryboardDraft() {
      throw new Error("confirmation gate must never re-quote a storyboard draft");
    },
  } as unknown as LineVideoWorkspaceRuntime;
}

async function fixture(options: { withScope?: boolean } = {}) {
  const draftStore = memoryStore<LineVideoDraft>();
  const jobStore = memoryStore<LineVideoJob>();
  const activeJobLockStore = memoryStore<LineVideoActiveJobLock>();
  const scopeStore = memoryStore<LineVideoUgcScope>();
  const scheduled: Array<() => Promise<void>> = [];
  const gate = createLineVideoConfirmationGate({
    draftStore,
    jobStore,
    activeJobLockStore,
    resolveFalAuth: async () => true,
    createNotionLibrary: () => notion as never,
    workspaceRuntime: workspaceRuntime(scopeStore),
    // A fal-routed draft must never need the OpenRouter catalog. Any call here
    // is the bug this fetch double exists to catch.
    scheduleBackgroundWork: (run) => {
      scheduled.push(run);
    },
  });
  const draft = await createLineVideoDraft({
    store: draftStore,
    accountId: "acct-1",
    conversationKey: "acct-1|grp-a",
    ownerSenderId: OWNER_ID,
    model: "bytedance/seedance-2.5",
    providerRoute: FAL_ROUTE,
    prompt: FROZEN_PROMPT,
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: true,
    estimatedCostUsd: 1,
    deliveryTo: "line:group:grp-a",
  });
  if (options.withScope !== false) {
    await scopeStore.register(draft.draftId, ugcScope());
  }
  return { gate, draftStore, jobStore, draft, scheduled };
}

function confirmEvent(draftId: string) {
  return {
    content: "",
    channel: "line",
    body: `ยืนยัน VIDEO ${draftId}`,
    senderId: OWNER_ID,
    senderIsOwner: true,
  };
}

const CTX = { accountId: "acct-1", conversationId: "grp-a" };

beforeEach(() => {
  generateVideoMock.mockReset().mockResolvedValue({
    videos: [{ url: TRANSIENT_FAL_URL, mimeType: "video/mp4" }],
    provider: "fal",
    model: "bytedance/seedance-2.0/reference-to-video",
    attempts: [],
    ignoredOverrides: [],
    metadata: {},
  });
  sendMessageLineMock.mockReset().mockResolvedValue({});
  stageLineOutboundVideoMock.mockClear();
  signArchivedLineVideoUrlMock.mockClear();
  resolveReferenceUrlsMock.mockClear();
  for (const mock of Object.values(notion)) {
    mock.mockClear();
  }
  runtimeConfigMock.current = {
    plugins: {
      entries: {
        "cloudbath-line-image-archive": {
          config: { groupWorkspacePolicies: { ugc: { capabilities: UGC_CAPABILITIES } } },
        },
      },
    },
  };
});

describe("fal reference-to-video submission", () => {
  it("submits to the fal provider the draft was locked to, with signed reference URLs", async () => {
    const { gate, draft, scheduled } = await fixture();

    const reply = await gate(confirmEvent(draft.draftId), CTX);
    expect(reply?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    await scheduled[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    const request = generateVideoMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.modelOverride).toBe("fal/bytedance/seedance-2.0/reference-to-video");
    // Never a silent substitution to another provider or model.
    expect(request.autoProviderFallback).toBe(false);
    expect(request.durationSeconds).toBe(10);
    expect(request.resolution).toBe("720p");
    expect(request.aspectRatio).toBe("9:16");
    expect(request.audio).toBe(true);
    expect(request.inputImages).toEqual([
      {
        url: "https://r2.example/ref-char-6.png?X-Amz-Signature=a",
        mimeType: "image/png",
        role: "reference_image",
      },
      {
        url: "https://r2.example/ref-char-10.jpg?X-Amz-Signature=b",
        mimeType: "image/jpeg",
        role: "reference_image",
      },
    ]);
  });

  it("submits the confirmed prompt verbatim, audio timeline included", async () => {
    const { gate, draft, scheduled } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    const request = generateVideoMock.mock.calls[0]?.[0] as { prompt: string };
    expect(request.prompt).toBe(draft.prompt);
    expect(request.prompt).toContain("Audio timeline:");
  });

  it("archives the transient fal artifact in R2 and sends LINE the R2 URL only", async () => {
    const { gate, draft, scheduled, jobStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(stageLineOutboundVideoMock).toHaveBeenCalledWith(TRANSIENT_FAL_URL);
    const send = sendMessageLineMock.mock.calls.at(-1) as unknown[] | undefined;
    expect((send?.[2] as { mediaUrl?: string } | undefined)?.mediaUrl).toBe(
      "https://r2.example/archived.mp4?X-Amz-Signature=sig",
    );
    // The transient provider URL never reaches LINE, in any argument.
    expect(JSON.stringify(sendMessageLineMock.mock.calls)).not.toContain("v3.fal.media");

    const [job] = await jobStore.entries();
    expect(job?.value).toMatchObject({
      status: "completed",
      provider: "fal",
      stage: "line_delivery",
      r2ObjectKey: "outbound/line-video/sha256/ab/abcd.mp4",
    });
  });

  it("consumes the draft exactly once: a replayed confirmation submits nothing", async () => {
    const { gate, draft, scheduled } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    const replay = await gate(confirmEvent(draft.draftId), CTX);

    expect(replay).toEqual({
      handled: true,
      text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว",
    });
    expect(scheduled.length).toBe(1);
  });

  it("never falls back to OpenRouter when the fal submission fails", async () => {
    generateVideoMock.mockRejectedValueOnce(new Error("fal generation failed"));
    const { gate, draft, scheduled } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(stageLineOutboundVideoMock).not.toHaveBeenCalled();
  });

  it("refuses without the frozen reference scope, before any job or paid call", async () => {
    const { gate, draft, scheduled, jobStore } = await fixture({ withScope: false });
    const reply = await gate(confirmEvent(draft.draftId), CTX);

    expect(reply?.text).toContain("workspace scope");
    // Nothing was scheduled, so nothing was billed and no job row exists.
    expect(scheduled).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(await jobStore.entries()).toEqual([]);
  });

  it("does not re-call fal when only the LINE delivery fails", async () => {
    sendMessageLineMock.mockRejectedValueOnce(new Error("LINE push failed"));
    const { gate, draft, scheduled, jobStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("delivery_failed");
    expect(job?.value.r2ObjectKey).toBe("outbound/line-video/sha256/ab/abcd.mp4");
    // The Notion record stays Completed: the video was generated and paid for.
    expect(notion.markCompleted).toHaveBeenCalledTimes(1);
    expect(notion.markFailed).not.toHaveBeenCalled();
  });
});
