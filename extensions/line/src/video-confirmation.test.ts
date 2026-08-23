import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();
const sendMessageLineMock = vi.fn(async (..._args: unknown[]) => ({}));
const resolveLineAccountMock = vi.fn((..._args: unknown[]) => ({
  accountId: "acct-1",
  enabled: true,
  channelAccessToken: "token",
  channelSecret: "secret",
  tokenSource: "config" as const,
  config: {},
}));
const stageLineOutboundVideoMock = vi.fn(async (..._args: unknown[]) => ({
  url: "https://r2.example/video.mp4",
  objectKey: "outbound/line-video/x.mp4",
  contentType: "video/mp4",
  contentLength: 10,
  sha256: "abc",
}));
const stageLineVideoPreviewImageMock = vi.fn(async (..._args: unknown[]) => ({
  url: "https://r2.example/preview.jpg",
  objectKey: "outbound/line/preview.jpg",
  contentType: "image/jpeg",
  contentLength: 10,
  sha256: "def",
}));
const notionValidateMock = vi.fn(async () => {});
const notionCreateProcessingMock = vi.fn(async () => ({ pageId: "notion-page-1" }));
const notionMarkCompletedMock = vi.fn(async () => {});
const notionMarkFailedMock = vi.fn(async () => {});
const notionMarkUgcProcessingMock = vi.fn(async () => {});
const notionMarkUgcCompletedMock = vi.fn(async () => {});
const notionMarkUgcFailedMock = vi.fn(async () => {});
const runtimeConfigMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

function createNotionLibraryMock() {
  return {
    validate: notionValidateMock,
    createProcessing: notionCreateProcessingMock,
    markCompleted: notionMarkCompletedMock,
    markFailed: notionMarkFailedMock,
    markUgcProcessing: notionMarkUgcProcessingMock,
    markUgcCompleted: notionMarkUgcCompletedMock,
    markUgcFailed: notionMarkUgcFailedMock,
  };
}

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
  resolveLineAccount: (...args: unknown[]) => resolveLineAccountMock(...args),
}));
vi.mock("./send.js", () => ({
  sendMessageLine: (...args: unknown[]) => sendMessageLineMock(...args),
}));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: (...args: unknown[]) => stageLineOutboundVideoMock(...args),
  stageLineVideoPreviewImage: (...args: unknown[]) => stageLineVideoPreviewImageMock(...args),
}));

const { createLineVideoConfirmationGate, parseLineVideoConfirmationCode } =
  await import("./video-confirmation.js");
const { createLineVideoDraft } = await import("./video-draft-store.js");
const { lineGroupPolicyBindingKey, lineVideoUgcDraftScopeKey } =
  await import("./video-ugc-scope.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock, LineVideoJob } from "./video-job-store.js";
import type { LineGroupPolicyBinding, LineVideoUgcScope } from "./video-ugc-scope.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
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
      const current = values.get(key);
      const next = updateValue(current);
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

function catalogFetch(
  overrides?: Partial<{
    pricingSkus: Record<string, string>;
    aspectRatios: string[];
    resolutions: string[];
    durations: number[];
  }>,
) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "bytedance/seedance-2.5",
              name: "Seedance 2.5",
              supported_durations: overrides?.durations ?? [4, 6, 8],
              supported_aspect_ratios: overrides?.aspectRatios ?? ["16:9", "9:16"],
              supported_resolutions: overrides?.resolutions ?? ["720p", "1080p"],
              pricing_skus: overrides?.pricingSkus ?? { "per-video-second": "0.10" },
            },
          ],
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
}

const OWNER_ID = "U-owner";
const MEMBER_ID = "U-member";
const UGC_CAPABILITIES = {
  PRODUCT_LIBRARY: { databaseId: "a".repeat(32), dataSourceId: "1".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "2".repeat(32) },
  UGC_PROJECTS: { databaseId: "c".repeat(32), dataSourceId: "3".repeat(32) },
  UGC_SHOTS: { databaseId: "d".repeat(32), dataSourceId: "4".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "e".repeat(32), dataSourceId: "5".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "f".repeat(32), dataSourceId: "6".repeat(32) },
} as const;

async function fixture(params?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ugcScopeStore?: PluginStateKeyedStore<LineVideoUgcScope>;
  groupBindingStore?: PluginStateKeyedStore<LineGroupPolicyBinding>;
}) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const jobStore = createMemoryStore<LineVideoJob>();
  const activeJobLockStore = createMemoryStore<LineVideoActiveJobLock>();
  const scheduled: Array<() => Promise<void>> = [];
  const gate = createLineVideoConfirmationGate({
    draftStore,
    jobStore,
    activeJobLockStore,
    resolveApiKey: async () => "sk-test",
    createNotionLibrary: createNotionLibraryMock,
    ...(params?.ugcScopeStore ? { ugcScopeStore: params.ugcScopeStore } : {}),
    ...(params?.groupBindingStore ? { groupBindingStore: params.groupBindingStore } : {}),
    fetchImpl: params?.fetchImpl ?? catalogFetch(),
    scheduleBackgroundWork: (run) => {
      scheduled.push(run);
    },
    ...(params?.now ? { now: params.now } : {}),
  });
  const draft = await createLineVideoDraft({
    store: draftStore,
    accountId: "acct-1",
    conversationKey: "acct-1|grp-a",
    ownerSenderId: OWNER_ID,
    model: "bytedance/seedance-2.5",
    prompt: "a cat riding a skateboard",
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "1080p",
    audio: false,
    estimatedCostUsd: 0.8,
    deliveryTo: "line:group:grp-a",
    ...(params?.now ? { now: params.now } : {}),
  });
  return { gate, draftStore, jobStore, activeJobLockStore, draft, scheduled };
}

const CTX = { accountId: "acct-1", conversationId: "grp-a" };

function confirmEvent(draftId: string, overrides?: { senderId?: string; senderIsOwner?: boolean }) {
  return {
    content: "",
    channel: "line",
    body: `ยืนยัน VIDEO ${draftId}`,
    senderId: overrides?.senderId ?? OWNER_ID,
    senderIsOwner: overrides?.senderIsOwner ?? true,
  };
}

beforeEach(() => {
  generateVideoMock.mockReset();
  sendMessageLineMock.mockClear();
  stageLineOutboundVideoMock.mockClear();
  stageLineVideoPreviewImageMock.mockClear();
  notionValidateMock.mockReset().mockResolvedValue(undefined);
  notionCreateProcessingMock.mockReset().mockResolvedValue({ pageId: "notion-page-1" });
  notionMarkCompletedMock.mockReset().mockResolvedValue(undefined);
  notionMarkFailedMock.mockReset().mockResolvedValue(undefined);
  notionMarkUgcProcessingMock.mockReset().mockResolvedValue(undefined);
  notionMarkUgcCompletedMock.mockReset().mockResolvedValue(undefined);
  notionMarkUgcFailedMock.mockReset().mockResolvedValue(undefined);
  runtimeConfigMock.current = {};
  generateVideoMock.mockResolvedValue({
    videos: [{ buffer: Buffer.from("fake-video-bytes"), mimeType: "video/mp4" }],
    provider: "openrouter",
    model: "bytedance/seedance-2.5",
    attempts: [],
    ignoredOverrides: [],
    metadata: { usage: { cost: 0.79 } },
  });
});

describe("parseLineVideoConfirmationCode", () => {
  it("parses the exact confirmation format", () => {
    expect(parseLineVideoConfirmationCode("ยืนยัน VIDEO 4827")).toBe("4827");
  });

  it("returns null for unrelated text", () => {
    expect(parseLineVideoConfirmationCode("hello")).toBeNull();
    expect(parseLineVideoConfirmationCode("ยืนยัน VIDEO abcd")).toBeNull();
  });
});

describe("createLineVideoConfirmationGate", () => {
  it("1: owner confirmation submits exactly once and pushes the finished video", async () => {
    const { gate, draft, scheduled, jobStore, activeJobLockStore } = await fixture();
    const result = await gate(confirmEvent(draft.draftId), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    expect(scheduled.length).toBe(1);
    // Required lifecycle: the job is "running" and the conversation's
    // active-job lock is held the instant confirmation returns, before the
    // background work has even started.
    const [runningJob] = await jobStore.entries();
    expect(runningJob?.value.status).toBe("running");
    expect((await activeJobLockStore.entries()).length).toBe(1);

    await scheduled[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(generateVideoMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "a cat riding a skateboard",
      modelOverride: "openrouter/bytedance/seedance-2.5",
      autoProviderFallback: false,
    });
    expect(stageLineOutboundVideoMock).toHaveBeenCalledWith(expect.any(Buffer));
    expect(notionCreateProcessingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.any(String),
        accountId: "acct-1",
        conversationId: "grp-a",
        model: "bytedance/seedance-2.5",
        prompt: "a cat riding a skateboard",
        actualCostUsd: 0.79,
      }),
    );
    expect(generateVideoMock.mock.invocationCallOrder[0]).toBeLessThan(
      notionCreateProcessingMock.mock.invocationCallOrder[0]!,
    );
    expect(notionCreateProcessingMock.mock.invocationCallOrder[0]).toBeLessThan(
      stageLineOutboundVideoMock.mock.invocationCallOrder[0]!,
    );
    expect(notionMarkCompletedMock).toHaveBeenCalledWith(
      { pageId: "notion-page-1" },
      expect.objectContaining({
        r2Url: "https://r2.example/video.mp4",
        r2ObjectKey: "outbound/line-video/x.mp4",
        actualCostUsd: 0.79,
      }),
    );
    expect(notionMarkCompletedMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageLineMock.mock.invocationCallOrder[0]!,
    );
    expect(sendMessageLineMock).toHaveBeenCalledWith(
      "line:group:grp-a",
      expect.stringContaining("วิดีโอเสร็จแล้ว"),
      expect.objectContaining({ mediaKind: "video", mediaUrl: "https://r2.example/video.mp4" }),
    );
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("completed");
    expect(job?.value.actualCostUsd).toBe(0.79);
    expect(job?.value.notionPageId).toBe("notion-page-1");
    expect(job?.value.r2ObjectKey).toBe("outbound/line-video/x.mp4");
    // running -> completed released the lock: a new draft is immediately allowed.
    expect((await activeJobLockStore.entries()).length).toBe(0);
  });

  it("archives a provider URL to R2 and delivers only the staged R2 URL to LINE", async () => {
    const providerUrl = "https://provider.example/transient-output.mp4";
    generateVideoMock.mockResolvedValueOnce({
      videos: [{ url: providerUrl, mimeType: "video/mp4" }],
      provider: "openrouter",
      model: "bytedance/seedance-2.5",
      attempts: [],
      ignoredOverrides: [],
      metadata: { usage: { cost: 0.79 } },
    });
    const { gate, draft, scheduled, jobStore } = await fixture();

    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(stageLineOutboundVideoMock).toHaveBeenCalledWith(providerUrl);
    expect(sendMessageLineMock).toHaveBeenCalledWith(
      "line:group:grp-a",
      expect.stringContaining("วิดีโอเสร็จแล้ว"),
      expect.objectContaining({
        mediaKind: "video",
        mediaUrl: "https://r2.example/video.mp4",
      }),
    );
    const [job] = await jobStore.entries();
    expect(job?.value.videoUrl).toBe("https://r2.example/video.mp4");
    expect(job?.value.videoUrl).not.toBe(providerUrl);
  });

  it("2: non-owner confirmation never submits, even with a valid code", async () => {
    const { gate, draft, draftStore, scheduled } = await fixture();
    const result = await gate(
      confirmEvent(draft.draftId, { senderId: MEMBER_ID, senderIsOwner: false }),
      CTX,
    );

    expect(result).toEqual({ handled: true, text: "ไม่มีสิทธิ์ยืนยันการสร้างวิดีโอ" });
    expect(scheduled.length).toBe(0);
    // The draft must still be usable by the real owner afterward.
    expect(await draftStore.lookup(draft.draftId)).toMatchObject({ draftId: draft.draftId });
  });

  it("requires a frozen UGC scope for a group paired to UGC", async () => {
    const groupBindingStore = createMemoryStore<LineGroupPolicyBinding>();
    await groupBindingStore.register(lineGroupPolicyBindingKey("acct-1", "grp-a"), {
      accountId: "acct-1",
      groupId: "grp-a",
      policyId: "UGC",
      boundByOwnerId: OWNER_ID,
      boundAt: "2026-08-23T00:00:00.000Z",
    });
    const { gate, draft, scheduled, draftStore } = await fixture({ groupBindingStore });

    await expect(gate(confirmEvent(draft.draftId), CTX)).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("workspace scope"),
    });
    expect(await draftStore.lookup(draft.draftId)).toMatchObject({ draftId: draft.draftId });
    expect(scheduled).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("links a validated UGC scope through confirmation, Notion, R2, and completion", async () => {
    runtimeConfigMock.current = {
      plugins: {
        entries: {
          "cloudbath-line-image-archive": {
            config: { groupWorkspacePolicies: { ugc: { capabilities: UGC_CAPABILITIES } } },
          },
        },
      },
    };
    const groupBindingStore = createMemoryStore<LineGroupPolicyBinding>();
    const ugcScopeStore = createMemoryStore<LineVideoUgcScope>();
    await groupBindingStore.register(lineGroupPolicyBindingKey("acct-1", "grp-a"), {
      accountId: "acct-1",
      groupId: "grp-a",
      policyId: "UGC",
      boundByOwnerId: OWNER_ID,
      boundAt: "2026-08-23T00:00:00.000Z",
    });
    const { gate, draft, scheduled } = await fixture({
      groupBindingStore,
      ugcScopeStore,
    });
    const scope: LineVideoUgcScope = {
      version: 1,
      policyId: "UGC",
      accountId: "acct-1",
      lineGroupId: "grp-a",
      ownerSenderId: OWNER_ID,
      productPageId: "product-page",
      characterPageId: "character-page",
      projectPageId: "project-page",
      shotPageIds: ["shot-1", "shot-2", "shot-3"],
      referenceAssets: [],
      frozenPrompt: draft.prompt,
      durationSeconds: draft.durationSeconds,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      audio: draft.audio,
      capabilities: UGC_CAPABILITIES,
      r2Prefix: "outbound/line-video",
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    await ugcScopeStore.register(lineVideoUgcDraftScopeKey(draft.draftId), scope);

    expect((await gate(confirmEvent(draft.draftId), CTX))?.handled).toBe(true);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();

    expect(notionCreateProcessingMock).toHaveBeenCalledWith(
      expect.objectContaining({ ugcScope: scope }),
    );
    expect(notionMarkUgcProcessingMock).toHaveBeenCalledWith(scope);
    expect(notionMarkUgcCompletedMock).toHaveBeenCalledWith(scope, 0.79);
    expect(stageLineOutboundVideoMock).toHaveBeenCalledTimes(1);
    expect(sendMessageLineMock).toHaveBeenCalledTimes(1);
  });

  it("keeps KEEP_WATCHING groups outside every paid video confirmation path", async () => {
    const groupBindingStore = createMemoryStore<LineGroupPolicyBinding>();
    await groupBindingStore.register(lineGroupPolicyBindingKey("acct-1", "grp-a"), {
      accountId: "acct-1",
      groupId: "grp-a",
      policyId: "KEEP_WATCHING",
      boundByOwnerId: OWNER_ID,
      boundAt: "2026-08-23T00:00:00.000Z",
    });
    const { gate, draft, scheduled } = await fixture({ groupBindingStore });

    await expect(gate(confirmEvent(draft.draftId), CTX)).resolves.toMatchObject({
      handled: true,
      text: expect.stringContaining("ไม่อนุญาต"),
    });
    expect(scheduled).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("binds a confirmation code to the owner that created it", async () => {
    const { gate, draft, draftStore, scheduled } = await fixture();

    const transferred = await gate(
      confirmEvent(draft.draftId, { senderId: MEMBER_ID, senderIsOwner: true }),
      CTX,
    );

    expect(transferred).toEqual({
      handled: true,
      text: "video draft นี้ไม่ตรงกับบทสนทนานี้",
    });
    expect(await draftStore.lookup(draft.draftId)).toMatchObject({ draftId: draft.draftId });
    expect(scheduled).toHaveLength(0);

    expect((await gate(confirmEvent(draft.draftId), CTX))?.handled).toBe(true);
    expect(scheduled).toHaveLength(1);
  });

  it("3: duplicate/replayed confirmation cannot double-submit", async () => {
    const { gate, draft } = await fixture();
    const first = await gate(confirmEvent(draft.draftId), CTX);
    const second = await gate(confirmEvent(draft.draftId), CTX);

    expect(first?.handled).toBe(true);
    expect(second).toEqual({ handled: true, text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว" });
  });

  it("4: an expired draft cannot submit", async () => {
    // fixture() passes the same `now` closure to both draft creation and the
    // gate's confirmation-time expiry check, so advancing it here simulates
    // real elapsed time between the two without relying on Date.now/fake timers.
    let now = 1_000_000;
    const { gate, draft } = await fixture({ now: () => now });
    now += 20 * 60 * 1000; // past the 15-minute draft TTL

    const result = await gate(confirmEvent(draft.draftId), CTX);
    expect(result?.text).toContain("หมดอายุ");
  });

  it("5: an over-cost draft is refused at confirmation time even if it passed the draft-time check", async () => {
    const { gate, draft } = await fixture({
      fetchImpl: catalogFetch({ pricingSkus: { "per-video-second": "10" } }),
    });
    const result = await gate(confirmEvent(draft.draftId), CTX);

    expect(result?.text).toContain("เกินวงเงิน");
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("rejects a changed estimate even when the fresh cost remains below the ceiling", async () => {
    const { gate, draft, draftStore, scheduled } = await fixture({
      fetchImpl: catalogFetch({ pricingSkus: { "per-video-second": "0.11" } }),
    });

    const result = await gate(confirmEvent(draft.draftId), CTX);

    expect(result?.text).toContain("ค่าใช้จ่ายของ video draft เปลี่ยนไป");
    expect(await draftStore.lookup(draft.draftId)).toMatchObject({ draftId: draft.draftId });
    expect(scheduled).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("6: settings no longer supported by the live model are revalidated and refused", async () => {
    const { gate, draft } = await fixture({
      fetchImpl: catalogFetch({ resolutions: ["720p"] }), // draft was created for 1080p
    });
    const result = await gate(confirmEvent(draft.draftId), CTX);

    expect(result?.text).toContain("ไม่รองรับแล้ว");
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("7: the confirmed prompt/settings are frozen exactly as drafted — no second LLM rewrite", async () => {
    const { gate, draft, scheduled } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(generateVideoMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: draft.prompt,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      durationSeconds: draft.durationSeconds,
      audio: draft.audio,
    });
  });

  it("8: a failed background submission reports the error instead of losing the job silently", async () => {
    generateVideoMock.mockRejectedValueOnce(
      new Error(
        "OpenRouter video request has conflicting settings: resolution 720p disagrees with size 1920x1080; refusing to submit",
      ),
    );
    const { gate, draft, scheduled, jobStore, activeJobLockStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
    expect(job?.value.error).toContain("conflicting settings");
    // Deterministic, code-only failure acknowledgement -- exact template,
    // never LLM-composed, and never promises the job "will clear" on its own.
    expect(sendMessageLineMock).toHaveBeenCalledWith(
      "line:group:grp-a",
      [
        "❌ สร้างวิดีโอไม่สำเร็จ",
        "สาเหตุ: OpenRouter video request has conflicting settings: resolution 720p disagrees with size 1920x1080; refusing to submit",
        "",
        "งานนี้ถูกปิดสถานะเป็น Failed แล้ว",
        "สามารถสร้าง Draft ใหม่ได้",
      ].join("\n"),
      expect.anything(),
    );
    // running -> failed is terminal and releases the active-job lock, so it
    // never remains an active blocker for the conversation.
    expect((await activeJobLockStore.entries()).length).toBe(0);
    expect(notionCreateProcessingMock).not.toHaveBeenCalled();
  });

  it("marks the same Notion record Failed when R2 archival fails", async () => {
    stageLineOutboundVideoMock.mockRejectedValueOnce(new Error("R2_ACCESS_KEY_ID=secret-value"));
    const { gate, draft, scheduled, jobStore } = await fixture();

    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(notionCreateProcessingMock).toHaveBeenCalledTimes(1);
    expect(notionMarkCompletedMock).not.toHaveBeenCalled();
    expect(notionMarkFailedMock).toHaveBeenCalledWith(
      { pageId: "notion-page-1" },
      expect.not.stringContaining("secret-value"),
    );
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
    expect(sendMessageLineMock).toHaveBeenCalledTimes(1);
  });

  it("changes the same Notion record from Completed to Failed when LINE delivery fails", async () => {
    sendMessageLineMock.mockRejectedValueOnce(new Error("LINE delivery failed"));
    const { gate, draft, scheduled, jobStore } = await fixture();

    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(notionMarkCompletedMock).toHaveBeenCalledTimes(1);
    expect(notionMarkFailedMock).toHaveBeenCalledWith(
      { pageId: "notion-page-1" },
      "LINE delivery failed",
    );
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
  });

  it("validates Notion before the paid provider call and fails closed when unavailable", async () => {
    notionValidateMock.mockRejectedValueOnce(new Error("Notion not configured"));
    const { gate, draft, scheduled, jobStore } = await fixture();

    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(stageLineOutboundVideoMock).not.toHaveBeenCalled();
    expect(notionCreateProcessingMock).not.toHaveBeenCalled();
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
  });

  it("9: a polling/timeout failure is equally terminal and releases the lock", async () => {
    generateVideoMock.mockRejectedValueOnce(
      new Error("OpenRouter video generation did not finish in time"),
    );
    const { gate, draft, scheduled, jobStore, activeJobLockStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
    expect(job?.value.error).toContain("did not finish in time");
    expect((await activeJobLockStore.entries()).length).toBe(0);
  });

  it("10: redacts anything that looks like an API key/bearer token from the failure reason", async () => {
    generateVideoMock.mockRejectedValueOnce(
      new Error("upstream rejected Authorization: Bearer sk-or-v1-abcdef0123456789"),
    );
    const { gate, draft, scheduled, jobStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    const [job] = await jobStore.entries();
    expect(job?.value.error).not.toContain("sk-or-v1-abcdef0123456789");
    expect(job?.value.error).toContain("[redacted]");
  });

  it("11: a new confirmation is refused while a previous job for the same conversation is still running", async () => {
    const { gate, draftStore, jobStore, scheduled } = await fixture();
    const first = await createLineVideoDraft({
      store: draftStore,
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: OWNER_ID,
      model: "bytedance/seedance-2.5",
      prompt: "first video",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      audio: false,
      estimatedCostUsd: 0.8,
      deliveryTo: "line:group:grp-a",
    });
    const second = await createLineVideoDraft({
      store: draftStore,
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: OWNER_ID,
      model: "bytedance/seedance-2.5",
      prompt: "second video",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      audio: false,
      estimatedCostUsd: 0.8,
      deliveryTo: "line:group:grp-a",
    });

    await gate(confirmEvent(first.draftId), CTX);
    // First job is "running" (its background work is queued but not yet
    // executed) -- confirming the second draft must never start a second
    // concurrent paid job for the same conversation (cost safety: no double
    // submit), even though the draft/consume layer would otherwise allow it.
    const secondResult = await gate(confirmEvent(second.draftId), CTX);

    expect(secondResult?.text).toContain("กำลังทำงานอยู่");
    expect(scheduled.length).toBe(1);
    const jobs = await jobStore.entries();
    expect(jobs.length).toBe(1);
  });

  it("does not fire for ordinary chat text", async () => {
    const { gate } = await fixture();
    const result = await gate(
      { content: "hello", channel: "line", senderId: OWNER_ID, senderIsOwner: true },
      CTX,
    );
    expect(result).toBeUndefined();
  });
});
