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
  metadata: {},
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

// fal's endpoint takes reference URLs, not bytes. Only the R2 publish is
// replaced; the ORDERING comes from the real resolver, because that ordering is
// what binds each @Image marker to the right character.
vi.mock("./video-reference-urls.js", async () => {
  const scopeModule =
    await vi.importActual<typeof import("./video-ugc-scope.js")>("./video-ugc-scope.js");
  return {
    resolveLineVideoReferenceUrls: async (
      scope: Parameters<typeof scopeModule.orderLineVideoUgcReferences>[0],
    ) => {
      materializeMock.calls.push(scope);
      return scopeModule.orderLineVideoUgcReferences(scope).map((reference, index) => ({
        index,
        // The locator travels in the URL so submission order stays assertable
        // without reaching storage.
        url: `https://r2.example/${encodeURIComponent(reference.locator)}?X-Amz-Signature=sig`,
        mimeType: "image/png",
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
const { listFalStoryboardModels, matchFalStoryboardQuery, offerFalStoryboardDefault } =
  await import("./fal-storyboard-seam.js");
const { prepareLineStoryboardVideoDraft } = await import("./video-storyboard-draft.js");
const { ugcDraftScopeKey } = await import("../../cloudbath-line-image-archive/src/ugc-workflow.js");

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
/** The two fal endpoints these cases exercise. */
const H3_MODEL = "minimax/h3/reference-to-video";
const SEEDANCE_MODEL = "bytedance/seedance-2.0/reference-to-video";

/**
 * One fal configuration, shared by the allocation and the gate.
 *
 * Rates are per endpoint because fal does not bill one blended rate; H3's
 * duration and audio are declared because fal's schema states neither.
 */
function falVideoGeneration(maxEstimatedCostUsd: number) {
  return {
    maxEstimatedCostUsd,
    falPricing: {
      models: {
        [SEEDANCE_MODEL]: { usdPerSecond: 0.2312 },
        [H3_MODEL]: { usdPerSecond: 0.1 },
      },
    },
    falModels: {
      [H3_MODEL]: { durationSeconds: [6, 10, 15], audio: "always_on" as const },
    },
  };
}

/** Serves the catalog fixture as an OpenRouter HTTP response. */

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
function harness(
  options: {
    maxEstimatedCostUsd?: number;
    draftCodes?: readonly number[];
    /** The conversation's chosen video model, as the picker would have saved it. */
    preferredModel?: string;
  } = {},
) {
  // Deterministic codes so a supersede assertion can name the exact code that
  // died, rather than matching whatever the allocator happened to pick.
  const codes = [...(options.draftCodes ?? [])];
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
    // The SAME fal seam production installs, so the model the picker offers
    // and the model the draft allocates come from one registry.
    offerDefaultVideoModel: async (accountId: string, requirements: never) =>
      offerFalStoryboardDefault(
        { videoGeneration: falVideoGeneration(options.maxEstimatedCostUsd ?? 5) },
        requirements,
      ),
    listCompatibleVideoModels: async (accountId: string, requirements: never) =>
      listFalStoryboardModels(
        { videoGeneration: falVideoGeneration(options.maxEstimatedCostUsd ?? 5) },
        requirements,
      ),
    matchVideoModelQuery: async (accountId: string, requirements: never, text: string) =>
      matchFalStoryboardQuery(
        { videoGeneration: falVideoGeneration(options.maxEstimatedCostUsd ?? 5) },
        requirements,
        text,
      ),
    prepareStoryboardVideoDraft: async (request: never) =>
      await prepareLineStoryboardVideoDraft(
        {
          ...(request as object),
          // The owner's chosen endpoint, when this case exercises selection.
          ...(options.preferredModel ? { requestedModelId: options.preferredModel } : {}),
        } as never,
        {
          draftStore: draftStore as never,
          resolveFalAuth: async () => true,
          cfg: {
            videoGeneration: {
              maxEstimatedCostUsd: options.maxEstimatedCostUsd ?? 5,
              // Rates are per endpoint; an unpriced endpoint is not payable.
              falPricing: {
                models: {
                  "bytedance/seedance-2.0/reference-to-video": { usdPerSecond: 0.2312 },
                  "minimax/h3/reference-to-video": { usdPerSecond: 0.1 },
                },
              },
              // MiniMax H3's duration and audio are not stated by fal's schema,
              // so the operator declares them, exactly as production requires.
              falModels: {
                "minimax/h3/reference-to-video": {
                  durationSeconds: [6, 10, 15],
                  audio: "always_on" as const,
                },
              },
            },
          },
          now: () => NOW,
          ...(options.draftCodes ? { randomDraftCode: () => codes.shift() ?? 9999 } : {}),
        },
      ),
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
    resolveFalAuth: async () => true,
    // The gate re-reads the catalog through its real client; this serves the
    // same fixture bytes, so the production parser runs rather than a stub.
    workspaceRuntime: workspaceRuntime as never,
    createNotionLibrary: () => notionLibraryStub() as never,
    scheduleBackgroundWork: (run) => void background.push(run),
    resolveAccount: (() => ({
      accountId: ACCOUNT,
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config" as const,
      // The SAME fal configuration the allocation used: the gate re-quotes
      // against the operator's live config, so a rate or capability that has
      // moved since the draft was minted is what refuses it.
      config: { videoGeneration: falVideoGeneration(options.maxEstimatedCostUsd ?? 5) },
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
    // The edit introduces an action v1 CANNOT contain. "หันกลับ" would not
    // work here: the compiler already generates a connective turn beat for v1,
    // so asserting on it would pass against a stale version too.
    await h.storyboard("วิ 10-14 ให้ Twong2 นั่งลงบนเก้าอี้", "m2");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m3");

    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{4}$/u);
    expect(generateVideoMock).not.toHaveBeenCalled();

    // The draft is a real LINE-owned record, allocated by the real allocator.
    const stored = await h.draftStore.lookup(code!);
    expect(stored).toMatchObject({
      model: H3_MODEL,
      ownerSenderId: OWNER,
      status: "pending",
      durationSeconds: 15,
      resolution: "2K",
      aspectRatio: "9:16",
    });
    expect((stored as unknown as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(
      1.5,
      3,
    );

    const confirmed = await h.confirm(`ยืนยัน VIDEO ${code}`);
    expect(confirmed?.handled).toBe(true);
    expect(confirmed?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    await h.drainBackground();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    const submitted = generateVideoMock.mock.calls[0]![0];
    expect(submitted.modelOverride).toBe(`fal/${H3_MODEL}`);
    expect(submitted.durationSeconds).toBe(15);
    expect(submitted.resolution).toBe("2K");
    expect(submitted.aspectRatio).toBe("9:16");
    expect(submitted.autoProviderFallback).toBe(false);

    // Canonical identity, and the v2 edit — not the stale v1.
    expect(submitted.prompt).toContain("CHAR-6");
    expect(submitted.prompt).toContain("CHAR-7");
    expect(submitted.prompt).toContain("นั่งลง");

    // Frozen identity references, in cast order, as the signed R2 URLs fal's
    // endpoint takes. The ORDER is what binds each @Image marker to a subject.
    const submittedUrls = (
      submitted.inputImages as ReadonlyArray<{ url?: string }> | undefined
    )?.map((asset) => asset.url);
    expect(submittedUrls).toEqual([
      "https://r2.example/ugc%2Fpage-char-6.png?X-Amz-Signature=sig",
      "https://r2.example/ugc%2Fpage-char-7.png?X-Amz-Signature=sig",
    ]);
    // Reference bindings are written in the SELECTED model's own dialect and
    // in the same order, so marker N and image N cannot drift apart.
    expect(submitted.prompt).toContain("Image 1 = ");
    expect(submitted.prompt).toContain("Image 2 = ");
  });

  it("records the confirmed quote on the job it created", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;
    await h.confirm(`ยืนยัน VIDEO ${code}`);

    const [job] = (await h.jobStore.entries()).map((entry) => entry.value);
    expect(job).toMatchObject({
      model: H3_MODEL,
      durationSeconds: 15,
      resolution: "2K",
      aspectRatio: "9:16",
    });
    expect((job as unknown as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(1.5, 3);
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
  it("allocates no code at all when the quote exceeds the ceiling", async () => {
    // 15s at the H3 rate is $1.50, so the ceiling is set below it: the guard,
    // not the arithmetic, is what this case is about.
    const h = harness({ maxEstimatedCostUsd: 0.5 });
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

/**
 * A re-quote of the SAME storyboard retires the code it replaces.
 *
 * Everything below runs through the real allocator and the real shipped gate,
 * so "rejected" means the production confirmation path rejected it, and the
 * provider spy is the only way money could be spent.
 */
describe("superseded VIDEO codes", () => {
  /** Single-cast storyboard, so a later cast addition is a genuine addition. */
  const SOLO_CREATE = "ใช้ Twong ให้ Twong เดินเข้ามา 15 วิ ในสวน";

  async function revisedHarness() {
    const h = harness({ draftCodes: [1111, 2222] });
    await h.storyboard(SOLO_CREATE, "m1");
    const first = await h.storyboard("สร้างวิดีโอ", "m2");
    expect(first?.text).toContain("ยืนยัน VIDEO 1111");

    // Same storyboard, revised. A revision alone mints nothing now: the scene
    // has changed, so it must be confirmed again before any model is quoted.
    const revised = await h.storyboard("ขอ 10 วิแทน", "m3");
    expect(revised?.text).not.toMatch(/ยืนยัน VIDEO/u);
    // Re-quoting is what allocates 2222 and retires 1111.
    const requoted = await h.storyboard("สร้างวิดีโอ", "m4");
    expect(requoted?.text).toContain("ยืนยัน VIDEO 2222");
    return h;
  }

  it("retires the old code and keeps the new one pending", async () => {
    const h = await revisedHarness();

    expect(await h.draftStore.lookup("1111")).toMatchObject({
      status: "superseded",
      supersededByDraftId: "2222",
    });
    expect(await h.draftStore.lookup("2222")).toMatchObject({ status: "pending" });
  });

  it("rejects the superseded code, names its replacement, and bills nothing", async () => {
    const h = await revisedHarness();

    const stale = await h.confirm("ยืนยัน VIDEO 1111");
    await h.drainBackground();

    expect(stale?.handled).toBe(true);
    expect(stale?.text).toContain("ถูกแทนที่แล้ว");
    expect(stale?.text).toContain("ยืนยัน VIDEO 2222");
    expect(generateVideoMock).not.toHaveBeenCalled();
    // Read, never consumed: a second attempt still points at the new code.
    const again = await h.confirm("ยืนยัน VIDEO 1111");
    expect(again?.text).toContain("ยืนยัน VIDEO 2222");
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("submits exactly once for the newest code, and never twice", async () => {
    const h = await revisedHarness();

    const confirmed = await h.confirm("ยืนยัน VIDEO 2222");
    await h.drainBackground();
    expect(confirmed?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    // The revision is what got submitted, not the length it replaced.
    expect(generateVideoMock.mock.calls[0]![0].durationSeconds).toBe(10);

    const replay = await h.confirm("ยืนยัน VIDEO 2222");
    await h.drainBackground();
    expect(replay?.text).toContain("ไม่พบ video draft");
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });

  it("never reveals the replacement code to anyone but the code's own owner", async () => {
    const h = await revisedHarness();

    const nonOwner = await h.confirm("ยืนยัน VIDEO 1111", { senderIsOwner: false });
    // Another AUTHORIZED owner: passes the owner flag, fails the binding check.
    const otherOwner = await h.confirm("ยืนยัน VIDEO 1111", { senderId: "U-someone-else" });

    expect(nonOwner?.text).toBe("ไม่มีสิทธิ์ยืนยันการสร้างวิดีโอ");
    expect(otherOwner?.text).toBe("video draft นี้ไม่ตรงกับบทสนทนานี้");
    for (const reply of [nonOwner, otherOwner]) {
      expect(reply?.text).not.toContain("2222");
    }
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("keeps the previous project's code alive when a cast addition opens new work", async () => {
    const h = harness({ draftCodes: [1111, 3333] });
    await h.storyboard(SOLO_CREATE, "m1");
    expect((await h.storyboard("สร้างวิดีโอ", "m2"))?.text).toContain("ยืนยัน VIDEO 1111");

    // PR #50: adding someone the project never froze starts a NEW project, so
    // a new storyboard id -- which must NOT retire the old project's code.
    const added = await h.storyboard("เพิ่ม Twong2 เข้ามาด้วย", "m3");
    expect(added?.text).toContain("เริ่มงานใหม่");
    expect((await h.storyboard("สร้างวิดีโอ", "m4"))?.text).toContain("ยืนยัน VIDEO 3333");

    expect(await h.draftStore.lookup("1111")).toMatchObject({ status: "pending" });
    expect(await h.draftStore.lookup("3333")).toMatchObject({ status: "pending" });

    // And the old project's code still really works.
    await h.confirm("ยืนยัน VIDEO 1111");
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(generateVideoMock.mock.calls[0]![0].durationSeconds).toBe(15);
  });
});

describe("storyboard drafts bind the conversation's selected video model", () => {
  it("F: a selected model is what the Final Video Draft quotes, not the default", async () => {
    const h = harness({ preferredModel: SEEDANCE_MODEL });
    await h.storyboard(CREATE_MESSAGE, "m1");

    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");

    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{4}$/u);
    const stored = await h.draftStore.lookup(code!);
    // The real allocator wrote the SELECTED model, and priced it at that
    // model's live rate rather than the default's.
    expect(stored).toMatchObject({ model: SEEDANCE_MODEL, status: "pending" });
    // Seedance's own $0.2312/s over 15s, not the H3 default's $0.10/s.
    expect((stored as unknown as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo(
      3.468,
      3,
    );
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("falls back to the default model when no preference has been selected", async () => {
    const h = harness();
    await h.storyboard(CREATE_MESSAGE, "m1");

    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");

    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;
    expect(await h.draftStore.lookup(code)).toMatchObject({ model: H3_MODEL });
  });

  it("M/N: the exact confirmation still submits the selected model exactly once", async () => {
    const h = harness({ preferredModel: SEEDANCE_MODEL });
    await h.storyboard(CREATE_MESSAGE, "m1");
    const drafted = await h.storyboard("สร้างวิดีโอ", "m2");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")![1]!;

    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(generateVideoMock.mock.calls[0]![0].modelOverride).toBe(`fal/${SEEDANCE_MODEL}`);
    // Replay is still refused by the unchanged exactly-once consume.
    await h.confirm(`ยืนยัน VIDEO ${code}`);
    await h.drainBackground();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });
});
