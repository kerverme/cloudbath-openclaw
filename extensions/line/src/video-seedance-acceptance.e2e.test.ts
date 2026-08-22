/**
 * Acceptance test for the exact production request that produced
 * `resolution=unknown_cost`:
 *
 *   "ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ"
 *
 * Driven end-to-end through the real draft tool and confirmation gate against
 * the VERBATIM live OpenRouter catalog entry for bytedance/seedance-2.5
 * (https://openrouter.ai/api/v1/videos/models, fetched 2026-08-22), including
 * its real token-based pricing_skus and supported_sizes.
 *
 * No paid generation happens: generateVideo is mocked and the paid POST count
 * is asserted to be zero before confirmation.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async (..._args: unknown[]) => ({ apiKey: "sk-openrouter-test" }),
}));
vi.mock("./accounts.js", () => ({
  resolveLineAccount: () => ({
    accountId: "acct-1",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config" as const,
    config: {},
  }),
}));
vi.mock("./send.js", () => ({ sendMessageLine: async (..._args: unknown[]) => ({}) }));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: async () => ({ url: "https://r2.example/video.mp4" }),
  stageLineVideoPreviewImage: async () => ({ url: "https://r2.example/preview.jpg" }),
}));

const { createLineVideoDraftTool } = await import("./video-draft-tool.js");
const { createLineVideoConfirmationGate } = await import("./video-confirmation.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock, LineVideoJob } from "./video-job-store.js";
import type { LineVideoModelPreferenceState } from "./video-model-preference.js";

const OWNER_ID = "U-owner";
const CTX = { accountId: "acct-1", conversationId: "grp-a" };

/** Verbatim live catalog entry for bytedance/seedance-2.5. */
const SEEDANCE_25_LIVE = {
  id: "bytedance/seedance-2.5",
  name: "ByteDance: Seedance 2.5",
  supported_resolutions: ["480p", "720p"],
  supported_aspect_ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  supported_sizes: [
    "854x480",
    "752x560",
    "640x640",
    "560x752",
    "480x854",
    "992x432",
    "1280x720",
    "1112x834",
    "960x960",
    "834x1112",
    "720x1280",
    "1470x630",
  ],
  supported_durations: [
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    29, 30,
  ],
  supported_frame_images: ["first_frame", "last_frame"],
  generate_audio: true,
  pricing_skus: {
    video_tokens: "0.0000107",
    video_tokens_without_audio: "0.0000107",
    video_tokens_with_video_input: "0.0000064",
  },
};

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
  };
}

function buildFlow(catalogEntry: unknown = SEEDANCE_25_LIVE) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const jobStore = createMemoryStore<LineVideoJob>();
  const activeJobLockStore = createMemoryStore<LineVideoActiveJobLock>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify({ data: [catalogEntry] }), { status: 200 });
  }) as unknown as typeof fetch;

  const tool = createLineVideoDraftTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: OWNER_ID,
    sessionId: "grp-a",
    accountId: "acct-1",
    deliveryTo: "line:group:grp-a",
    cfg: {},
    draftStore,
    preferenceStore: createMemoryStore<LineVideoModelPreferenceState>(),
    activeJobLockStore,
    fetchImpl,
  });

  const scheduled: Array<() => Promise<void>> = [];
  const gate = createLineVideoConfirmationGate({
    draftStore,
    jobStore,
    activeJobLockStore,
    resolveApiKey: async () => "sk-openrouter-test",
    fetchImpl,
    scheduleBackgroundWork: (run) => {
      scheduled.push(run);
    },
  });

  const paidVideoPosts = () =>
    requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models"));

  return { tool, gate, scheduled, draftStore, jobStore, activeJobLockStore, paidVideoPosts };
}

beforeEach(() => {
  generateVideoMock.mockReset();
  generateVideoMock.mockResolvedValue({
    videos: [{ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4" }],
    provider: "openrouter",
    model: "bytedance/seedance-2.5",
    attempts: [],
    ignoredOverrides: [],
    metadata: { usage: { cost: 0.51 } },
  });
});

describe("Seedance 2.5 owner request: 'ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ'", () => {
  it("1: creates a draft with a numeric catalog-derived cost and a confirmation code", async () => {
    const flow = buildFlow();
    expect(flow.tool).not.toBeNull();

    const result = await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });
    const details = (result as { details?: Record<string, unknown> }).details;
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect(details?.resolution).toBe("draft_created");
    expect(details?.model).toBe("bytedance/seedance-2.5");

    // 854x480 * 5s * 24fps / 1024 * 0.0000107 = $0.514
    expect(details?.estimatedCostUsd).toBeCloseTo(0.514, 3);
    expect(typeof details?.estimatedCostUsd).toBe("number");

    expect(text).toContain("🎬 Video draft");
    expect(text).toContain("ByteDance: Seedance 2.5");
    expect(text).toContain("Duration: 5 sec");
    expect(text).toContain("Estimated cost: $0.51");
    expect(text).toMatch(/ยืนยัน VIDEO \d{4}/u);

    expect((await flow.draftStore.entries()).length).toBe(1);
    expect(flow.paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("2: no paid submission until the exact owner confirmation, then exactly one", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water", durationSeconds: 5 });
    const [draft] = await flow.draftStore.entries();

    expect(await flow.jobStore.entries()).toStrictEqual([]);
    expect(flow.paidVideoPosts()).toStrictEqual([]);

    const confirmed = await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${draft!.value.draftId}`,
        channel: "line",
        senderId: OWNER_ID,
        senderIsOwner: true,
      },
      CTX,
    );
    expect(confirmed?.handled).toBe(true);

    const [runningJob] = await flow.jobStore.entries();
    expect(runningJob?.value.status).toBe("running");
    expect((await flow.activeJobLockStore.entries()).length).toBe(1);

    await flow.scheduled[0]?.();
    expect(generateVideoMock).toHaveBeenCalledOnce();
    expect(await flow.activeJobLockStore.entries()).toStrictEqual([]);
  });

  it("3: the frozen draft passes the confirmation-time cost re-check", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water", durationSeconds: 5 });
    const [draft] = await flow.draftStore.entries();

    const confirmed = await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${draft!.value.draftId}`,
        channel: "line",
        senderId: OWNER_ID,
        senderIsOwner: true,
      },
      CTX,
    );

    // A cost-guard rejection at confirmation returns the estimate-failure text.
    expect(confirmed?.text ?? "").not.toContain("ไม่สามารถประเมินค่าใช้จ่ายได้");
    expect((await flow.jobStore.entries()).length).toBe(1);
  });
});

describe("unknown pricing still fails closed, and says no draft exists", () => {
  it("4: an unrecognized pricing shape blocks the draft with deterministic wording", async () => {
    const flow = buildFlow({
      ...SEEDANCE_25_LIVE,
      pricing_skus: { some_future_unit: "1.00" },
    });

    const result = await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "unknown_cost",
    );
    // Must NOT imply a draft was created -- the cost guard runs first.
    expect(text).toContain("❌ ยังไม่ได้สร้าง Video Draft");
    expect(text).toContain("ยังไม่มีการส่งคำขอสร้างวิดีโอและยังไม่มีค่าใช้จ่าย");
    expect(text).not.toContain("🎬");

    // And genuinely no draft, no job, no paid call.
    expect(await flow.draftStore.entries()).toStrictEqual([]);
    expect(await flow.jobStore.entries()).toStrictEqual([]);
    expect(flow.paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("5: a model declaring no output sizes cannot be token-priced and fails closed", async () => {
    const flow = buildFlow({ ...SEEDANCE_25_LIVE, supported_sizes: [] });

    const result = await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "unknown_cost",
    );
    expect(await flow.draftStore.entries()).toStrictEqual([]);
  });

  it("6: an over-limit request is blocked and reports the estimate", async () => {
    const flow = buildFlow();
    // 30s at 720p far exceeds the $2 default ceiling.
    const result = await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 30,
      resolution: "720p",
    });
    const details = (result as { details?: Record<string, unknown> }).details;

    expect(details?.resolution).toBe("over_limit");
    expect(typeof details?.estimatedCostUsd).toBe("number");
    expect(await flow.draftStore.entries()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});

describe("PR #24/#25 invariants still hold", () => {
  it("7: a non-owner gets no tool", () => {
    expect(createLineVideoDraftTool({ messageChannel: "line", senderIsOwner: false })).toBeNull();
  });

  it("8: a non-owner cannot confirm someone else's draft", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water", durationSeconds: 5 });
    const [draft] = await flow.draftStore.entries();

    const result = await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${draft!.value.draftId}`,
        channel: "line",
        senderId: "U-member",
        senderIsOwner: false,
      },
      CTX,
    );

    expect(result).toBeUndefined();
    expect(await flow.jobStore.entries()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});
