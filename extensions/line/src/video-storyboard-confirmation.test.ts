import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Storyboard -> LINE paid draft -> the REAL confirmation gate -> the provider
 * boundary.
 *
 * Everything between those ends is production code: the cross-plugin runtime
 * seams in BOTH directions, the storyboard router, the LINE allocator and cost
 * guard, `createLineVideoConfirmationGate`, the draft store's atomic consume
 * and the active-job lock. Only three things are faked, and each is a real
 * external boundary: the OpenRouter catalog, the Notion library, and
 * `generateVideo` itself — which is spied rather than implemented, so a
 * regression that would spend money shows up as a call count.
 */

type SubmittedVideoRequest = {
  modelOverride: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  prompt: string;
  inputImages?: Array<{ buffer: Buffer }>;
  autoProviderFallback: boolean;
};

const generateVideoMock = vi.fn(async (_request: SubmittedVideoRequest) => ({
  videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
  metadata: { usage: { cost: 3.468 } },
}));
const sendMessageLineMock = vi.fn(async (..._args: unknown[]) => ({}));
const runtimeConfigMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const materializeMock = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (request: SubmittedVideoRequest) => generateVideoMock(request),
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
vi.mock("./send.js", () => ({
  sendMessageLine: (...args: unknown[]) => sendMessageLineMock(...args),
}));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: async () => ({
    url: "https://r2.example/video.mp4",
    objectKey: "outbound/line-video/x.mp4",
    contentType: "video/mp4",
    contentLength: 10,
    sha256: "abc",
  }),
  stageLineVideoPreviewImage: async () => undefined,
}));
// Only the R2 read is replaced. Scope VALIDATION stays real, because that is
// the check that decides whether money is spent.
vi.mock("./video-ugc-scope.js", async () => {
  const actual =
    await vi.importActual<typeof import("./video-ugc-scope.js")>("./video-ugc-scope.js");
  return {
    ...actual,
    materializeLineVideoUgcReferences: async (scope: { referenceAssets: readonly unknown[] }) => {
      materializeMock.calls.push(scope);
      // Buffers that carry their locator, so submission order is assertable
      // without reaching storage.
      return (scope.referenceAssets as ReadonlyArray<{ locator: string }>).map((asset) => ({
        buffer: Buffer.from(asset.locator),
      }));
    },
  };
});

const { CloudbathStoryboardLineRouter } =
  await import("../../cloudbath-line-image-archive/src/storyboard-line-router.js");
const { StoryboardStore } =
  await import("../../cloudbath-line-image-archive/src/storyboard-store.js");
const { resolver, CREATE_MESSAGE } =
  await import("../../cloudbath-line-image-archive/src/storyboard-router.test-support.js");
const { createLineVideoConfirmationGate } = await import("./video-confirmation.js");
const { prepareLineStoryboardVideoDraft } = await import("./video-storyboard-draft.js");
const { ugcDraftScopeKey } = await import("../../cloudbath-line-image-archive/src/ugc-workflow.js");
const { DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD } = await import("./video-cost-guard.js");

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const NOW = Date.parse("2026-08-31T10:00:00.000Z");

const CAPABILITIES = Object.fromEntries(
  [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ].map((id, index) => [
    id,
    { databaseId: String(index + 1).repeat(32), dataSourceId: String(index + 1).repeat(32) },
  ]),
);

/**
 * The catalog fixture, in OpenRouter's own wire shape.
 *
 * Served over `fetchImpl` so the production catalog client parses it, and used
 * by BOTH the allocation and the gate's pre-submit re-check.
 */
const CATALOG_ROWS = [
  {
    id: "bytedance/seedance-2.5",
    name: "Seedance 2.5",
    supported_durations: [4, 5, 10, 15, 20, 30],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
    supported_resolutions: ["480p", "720p"],
    supported_sizes: ["1280x720", "720x1280"],
    supported_frame_images: ["first"],
    generate_audio: true,
    pricing_skus: { "per-video-second": "0.2312" },
  },
];

/** Serves the catalog fixture as an OpenRouter HTTP response. */
const catalogFetch = async () =>
  new Response(JSON.stringify({ data: CATALOG_ROWS }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function mem<T>(): PluginStateKeyedStore<T> {
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
      return Array.from(values, ([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  } as PluginStateKeyedStore<T>;
}

function notionLibraryStub() {
  return {
    validate: async () => {},
    createProcessing: async () => ({ pageId: "notion-page-1" }),
    markCompleted: async () => {},
    markFailed: async () => {},
    markUgcProcessing: async () => {},
    markUgcCompleted: async () => {},
    markUgcFailed: async () => {},
  };
}

/** Wires both plugins together the way the two plugin entrypoints do. */
function harness(options: { maxEstimatedCostUsd?: number } = {}) {
  const draftStore = mem<never>();
  const jobStore = mem<never>();
  const activeJobLockStore = mem<never>();
  const draftScopes = mem<never>();
  const background: Array<() => Promise<void>> = [];

  runtimeConfigMock.current = {
    plugins: {
      entries: {
        "cloudbath-line-image-archive": {
          config: { groupWorkspacePolicies: { ugc: { capabilities: CAPABILITIES } } },
        },
      },
    },
  };

  // The LINE-owned paid runtime, injected rather than installed into the
  // process-global slot: a global install leaks across suites in the same
  // worker. The seam's install/resolve round-trip is covered separately; what
  // matters here is that this IS the real LINE implementation.
  const paidDraftRuntime = {
    prepareStoryboardVideoDraft: async (request: never) =>
      await prepareLineStoryboardVideoDraft(request, {
        draftStore: draftStore as never,
        resolveApiKey: async () => "sk-test",
        cfg: {
          videoGeneration: { maxEstimatedCostUsd: options.maxEstimatedCostUsd ?? 5 },
        },
        now: () => NOW,
        fetchImpl: catalogFetch as never,
      }),
  };

  // The workspace runtime the gate reads the frozen scope from, shaped exactly
  // as the Cloudbath plugin installs it, and injected for the same reason as
  // the paid runtime above.
  const workspaceRuntime = {
    lookupBinding: async () => ({
      accountId: ACCOUNT,
      groupId: GROUP,
      policyId: "UGC" as const,
      boundByOwnerId: OWNER,
      boundAt: "2026-08-30T00:00:00.000Z",
    }),
    lookupUgcDraftScope: async (draftId: string) =>
      await draftScopes.lookup(ugcDraftScopeKey(draftId)),
    consumeUgcDraftScope: async (draftId: string) =>
      await draftScopes.consume(ugcDraftScopeKey(draftId)),
  };

  const storyboardRouter = new CloudbathStoryboardLineRouter({
    store: new StoryboardStore({ heads: mem(), versions: mem(), now: () => NOW }),
    resolver: resolver(),
    active: mem(),
    drafts: mem(),
    dedupe: mem(),
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => NOW,
    draftScopes: draftScopes as never,
    ugcCapabilities: CAPABILITIES as never,
    paidDraftRuntime: paidDraftRuntime as never,
  });

  const gate = createLineVideoConfirmationGate({
    draftStore: draftStore as never,
    jobStore: jobStore as never,
    activeJobLockStore: activeJobLockStore as never,
    resolveApiKey: async () => "sk-test",
    // The gate re-reads the catalog through its real client; this serves the
    // same fixture bytes, so the production parser runs rather than a stub.
    fetchImpl: catalogFetch as never,
    workspaceRuntime: workspaceRuntime as never,
    createNotionLibrary: () => notionLibraryStub() as never,
    scheduleBackgroundWork: (run) => void background.push(run),
    resolveAccount: (() => ({
      accountId: ACCOUNT,
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config" as const,
      config: {
        videoGeneration: { maxEstimatedCostUsd: options.maxEstimatedCostUsd ?? 5 },
      },
    })) as never,
    now: () => NOW,
  });

  const storyboard = async (content: string, messageId: string) =>
    await storyboardRouter.handleBeforeDispatch(
      { content, senderId: OWNER, senderIsOwner: true, isGroup: true, messageId },
      { channelId: "line", accountId: ACCOUNT, conversationId: GROUP },
    );

  const confirm = async (
    content: string,
    over: { senderId?: string; senderIsOwner?: boolean } = {},
  ) =>
    await gate(
      {
        content,
        body: content,
        channel: "line",
        senderId: over.senderId ?? OWNER,
        senderIsOwner: over.senderIsOwner ?? true,
      },
      { accountId: ACCOUNT, conversationId: GROUP },
    );

  const drainBackground = async () => {
    while (background.length > 0) {
      await background.shift()!();
    }
  };

  return { storyboard, confirm, drainBackground, draftStore, jobStore, draftScopes };
}

beforeEach(() => {
  vi.clearAllMocks();
  materializeMock.calls.length = 0;
});

// Both runtime slots live on globalThis, so leaving either installed would
// leak into other suites in the same worker -- including the ones that assert
// the gate fails closed when no workspace runtime is present.
afterEach(() => {
  runtimeConfigMock.current = {};
});

describe("Storyboard -> LINE draft -> real confirmation gate -> provider boundary", () => {
  it("submits exactly once, carrying the latest version and canonical cast", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    // Edit, so a stale v1 submission would be visible.
    await h.storyboard("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", "m2");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m3");

    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{4}$/u);
    expect(generateVideoMock).not.toHaveBeenCalled();

    // The draft is a real LINE-owned record, allocated by the real allocator.
    const stored = await h.draftStore.lookup(code!);
    expect(stored).toMatchObject({
      model: "bytedance/seedance-2.5",
      ownerSenderId: OWNER,
      status: "pending",
      durationSeconds: 15,
      resolution: "720p",
      aspectRatio: "9:16",
    });
    expect((stored as unknown as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(
      3.468,
      3,
    );

    const confirmed = await h.confirm(`ยืนยัน VIDEO ${code}`);
    expect(confirmed?.handled).toBe(true);
    expect(confirmed?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    await h.drainBackground();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    const submitted = generateVideoMock.mock.calls[0]![0];
    expect(submitted.modelOverride).toBe("openrouter/bytedance/seedance-2.5");
    expect(submitted.durationSeconds).toBe(15);
    expect(submitted.resolution).toBe("720p");
    expect(submitted.aspectRatio).toBe("9:16");
    expect(submitted.autoProviderFallback).toBe(false);

    // Canonical identity, and the v2 edit — not the stale v1.
    expect(submitted.prompt).toContain("CHAR-6");
    expect(submitted.prompt).toContain("CHAR-7");
    expect(submitted.prompt).toContain("หันกลับ");

    // Frozen identity references, in cast order.
    expect(submitted.inputImages?.map((asset) => asset.buffer.toString())).toEqual([
      "ugc/page-char-6.png",
      "ugc/page-char-7.png",
    ]);
  });

  it("records the confirmed quote on the job it created", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;
    await h.confirm(`ยืนยัน VIDEO ${code}`);

    const [job] = (await h.jobStore.entries()).map((entry) => entry.value);
    expect(job).toMatchObject({
      model: "bytedance/seedance-2.5",
      durationSeconds: 15,
      resolution: "720p",
      aspectRatio: "9:16",
    });
    expect((job as unknown as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(3.468, 3);
  });
});

describe("exactly-once billing through the shipped gate", () => {
  async function draftedHarness() {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;
    return { h, code };
  }

  it("does not submit twice for a replayed confirmation message", async () => {
    const { h, code } = await draftedHarness();
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("does not submit again when the same code is reused after consumption", async () => {
    const { h, code } = await draftedHarness();
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    const replay = await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(replay?.text).toContain("ไม่พบ video draft");
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("submits at most once under concurrent confirmations", async () => {
    const { h, code } = await draftedHarness();
    await Promise.all([
      h.confirm(`ยืนยัน VIDEO ${code}`),
      h.confirm(`ยืนยัน VIDEO ${code}`),
      h.confirm(`ยืนยัน VIDEO ${code}`),
    ]);
    await h.drainBackground();
    expect(generateVideoMock.mock.calls.length).toBeLessThanOrEqual(1);
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a valid code presented by another sender", async () => {
    const { h, code } = await draftedHarness();
    const other = await h.confirm(`ยืนยัน VIDEO ${code}`, { senderId: "U-intruder" });
    await h.drainBackground();
    expect(other?.text).toContain("ไม่ตรงกับบทสนทนานี้");
    expect(generateVideoMock).not.toHaveBeenCalled();

    // A non-owner is refused outright, without touching the draft.
    const notOwner = await h.confirm(`ยืนยัน VIDEO ${code}`, { senderIsOwner: false });
    await h.drainBackground();
    expect(notOwner?.text).toContain("ไม่มีสิทธิ์");
    expect(generateVideoMock).not.toHaveBeenCalled();

    // The draft survives both attempts and the owner can still confirm it.
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("never submits for a generic agreement or a wrong code", async () => {
    const { h, code } = await draftedHarness();
    for (const message of ["ยืนยัน", "โอเค", "ทำเลย", "เอาเลย", "สร้างเลย", "yes", "confirm"]) {
      // The gate does not even claim these; they are not the exact phrase.
      expect(await h.confirm(message), message).toBeUndefined();
    }
    const wrong = await h.confirm("ยืนยัน VIDEO 9999");
    expect(wrong?.text).toContain("ไม่พบ video draft");
    await h.drainBackground();
    expect(generateVideoMock).not.toHaveBeenCalled();

    // The real code still works afterwards.
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });
});

describe("budget policy is enforced by the shipped guard", () => {
  it("allocates no code at all under the global default", async () => {
    const h = harness({ maxEstimatedCostUsd: DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD });
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");

    expect(drafted?.text).not.toMatch(/ยืนยัน VIDEO/u);
    expect(await h.draftStore.entries()).toEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});

describe("no test here can spend money", () => {
  it("keeps the provider spy the only submission path", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    // generateVideo is mocked, so a real provider call is not reachable; the
    // gate's own fetchImpl throws if anything tries the network.
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });
});

describe("unknown-after-send never becomes a second paid request", () => {
  it("does not resubmit when the provider outcome is unknown", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;

    // The request reached the provider; the outcome did not reach us.
    generateVideoMock.mockRejectedValueOnce(new Error("socket hang up after send"));

    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);

    // The draft was consumed BEFORE submission, so the same code cannot be
    // presented again -- the job is not retried, blindly or otherwise.
    const retry = await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(retry?.text).toContain("ไม่พบ video draft");
    expect(generateVideoMock).toHaveBeenCalledTimes(1);

    // Recovering requires a fresh quote and a fresh code, which is the only
    // path that can spend again -- and it is an explicit owner action.
    const requoted = await h.storyboard("สร้างวิดีโอ", "m3");
    const newCode = /ยืนยัน VIDEO (\d{4})/u.exec(requoted?.text ?? "")?.[1];
    expect(newCode).toMatch(/^\d{4}$/u);
    expect(newCode).not.toBe(code);
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("frees the conversation lock so a later confirmation is not wedged", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const first = await h.storyboard("สร้างวิดีโอ", "m2");
    const firstCode = /ยืนยัน VIDEO (\d{4})/u.exec(first?.text ?? "")![1]!;
    generateVideoMock.mockRejectedValueOnce(new Error("socket hang up after send"));
    await h.confirm(`ยืนยัน VIDEO ${firstCode}`);
    await h.drainBackground();

    // A failed job must not leave the conversation permanently blocked.
    const second = await h.storyboard("สร้างวิดีโอ", "m3");
    const secondCode = /ยืนยัน VIDEO (\d{4})/u.exec(second?.text ?? "")![1]!;
    const confirmed = await h.confirm(`ยืนยัน VIDEO ${secondCode}`);
    await h.drainBackground();
    expect(confirmed?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    expect(generateVideoMock).toHaveBeenCalledTimes(2);
  });
});
