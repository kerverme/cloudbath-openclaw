/**
 * End-to-end owner video flow for the LINE channel, asserted against the real
 * stores rather than any model-authored prose:
 *
 *   owner natural-language request
 *     -> reaches line_video_draft (no before_dispatch router claims it)
 *     -> DRAFT persisted, zero paid provider POSTs
 *     -> exact owner confirmation
 *     -> job running + active-job lock held
 *     -> terminal outcome releases the lock
 *     -> a new draft is immediately allowed
 *
 * Pins the production regressions from the deployed build: the undeclared
 * line_video_draft contract, the fail-open video_generate guard, and PR #23's
 * active-job lock lifecycle.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();
const sendMessageLineMock = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => ({}) }));
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
    config: {},
  }),
}));
vi.mock("./send.js", () => ({
  sendMessageLine: (...args: unknown[]) => sendMessageLineMock(...args),
}));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: async () => ({ url: "https://r2.example/video.mp4" }),
  stageLineVideoPreviewImage: async () => ({ url: "https://r2.example/preview.jpg" }),
}));

const { createLineVideoDraftTool, createLineVideoGenerationGuard } =
  await import("./video-draft-tool.js");
const { createLineVideoConfirmationGate } = await import("./video-confirmation.js");
const { createLineVideoModelControlRouter } = await import("./video-model-control.js");
const { createLineModelSwitchIntentRouter } = await import("./model-switch-router.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock, LineVideoJob } from "./video-job-store.js";
import type { LinePendingVideoModelSelection } from "./video-model-control.js";
import type { LineVideoModelPreferenceState } from "./video-model-preference.js";

/** The owner's real production phrasing: "please make me a video of a cat sitting on water, 5s". */
const OWNER_REQUEST = "ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ";
const OWNER_ID = "U-owner";
const CTX = { accountId: "acct-1", conversationId: "grp-a" };
/**
 * The chat model-switch router keys off the session, not the LINE conversation
 * scope, so it takes a different before_dispatch context shape than the video
 * routers (model-switch-router.ts LineBeforeDispatchContext).
 */
const CHAT_ROUTER_CTX = { sessionKey: "line:grp-a", agentId: "main" };

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
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

const SEEDANCE_CATALOG = {
  data: [
    {
      id: "bytedance/seedance-2.5",
      name: "ByteDance: Seedance 2.5",
      supported_durations: [4, 6, 8],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_resolutions: ["720p", "1080p"],
      supported_frame_images: ["first_frame"],
      pricing_skus: { "per-video-second": "0.10" },
    },
  ],
};

function buildFlow() {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const preferenceStore = createMemoryStore<LineVideoModelPreferenceState>();
  const jobStore = createMemoryStore<LineVideoJob>();
  const activeJobLockStore = createMemoryStore<LineVideoActiveJobLock>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify(SEEDANCE_CATALOG), { status: 200 });
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
    preferenceStore,
    activeJobLockStore,
    resolveApiKey: async () => "sk-test",
    fetchImpl,
  });

  const scheduled: Array<() => Promise<void>> = [];
  const gate = createLineVideoConfirmationGate({
    draftStore,
    jobStore,
    activeJobLockStore,
    resolveApiKey: async () => "sk-test",
    fetchImpl,
    scheduleBackgroundWork: (run) => {
      scheduled.push(run);
    },
  });

  /** True when a paid `POST /videos` submit endpoint was contacted. */
  const paidVideoPosts = () =>
    requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models"));

  return {
    tool,
    gate,
    scheduled,
    draftStore,
    jobStore,
    activeJobLockStore,
    preferenceStore,
    requestedUrls,
    paidVideoPosts,
  };
}

beforeEach(() => {
  generateVideoMock.mockReset();
  sendMessageLineMock.mockClear();
  generateVideoMock.mockResolvedValue({
    videos: [{ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4" }],
    provider: "openrouter",
    model: "bytedance/seedance-2.5",
    attempts: [],
    ignoredOverrides: [],
    metadata: { usage: { cost: 0.48 } },
  });
});

describe("owner natural-language video request routing", () => {
  it("1: no before_dispatch router claims the request, so it reaches the agent and its tools", async () => {
    const { gate, preferenceStore } = buildFlow();
    const event = {
      content: OWNER_REQUEST,
      body: OWNER_REQUEST,
      channel: "line",
      senderId: OWNER_ID,
      senderIsOwner: true,
    };

    // The confirmation gate only claims the exact "ยืนยัน VIDEO ####" form.
    expect(await gate(event, CTX)).toBeUndefined();

    // The video-model control router only claims "video model"-scoped wording.
    const videoModelRouter = createLineVideoModelControlRouter({
      preferenceStore,
      pendingStore: createMemoryStore<LinePendingVideoModelSelection>(),
      resolveApiKey: async () => "sk-test",
    });
    expect(await videoModelRouter(event, CTX)).toBeUndefined();

    // The chat model-switch router must not claim it either.
    const chatRouter = createLineModelSwitchIntentRouter({
      pendingStore: createMemoryStore<never>() as never,
    });
    expect(await chatRouter(event, CHAT_ROUTER_CTX)).toBeUndefined();
  });

  it("2: line_video_draft is available to an owner LINE session", () => {
    const { tool } = buildFlow();
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("line_video_draft");
  });

  it("3: the draft returns the expected preview and makes ZERO paid provider POSTs", async () => {
    const { tool, draftStore, paidVideoPosts } = buildFlow();
    const result = await tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 4,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect(text).toContain("🎬 Video draft");
    expect(text).toContain("ByteDance: Seedance 2.5");
    expect(text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    // The explicit supported duration is preserved exactly.
    expect(text).toContain("Duration: 4 sec");

    expect(paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
    expect((await draftStore.entries()).length).toBe(1);
  });
});

describe("owner confirmation -> job lifecycle (direct store assertions)", () => {
  it("4: no paid submission and no job/lock exist until the exact confirmation arrives", async () => {
    const { tool, jobStore, activeJobLockStore, paidVideoPosts } = buildFlow();
    await tool!.execute("call-1", { prompt: "a cat sitting on water" });

    expect(await jobStore.entries()).toStrictEqual([]);
    expect(await activeJobLockStore.entries()).toStrictEqual([]);
    expect(paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("5: confirmation creates a running job and holds the lock; success releases it", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water" });
    const [draftEntry] = await flow.draftStore.entries();
    const draftId = draftEntry!.value.draftId;

    const confirmed = await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${draftId}`,
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
    expect((await flow.activeJobLockStore.entries())[0]?.value.jobId).toBe(runningJob?.value.jobId);

    await flow.scheduled[0]?.();

    const [doneJob] = await flow.jobStore.entries();
    expect(doneJob?.value.status).toBe("completed");
    expect(doneJob?.value.actualCostUsd).toBe(0.48);
    expect(await flow.activeJobLockStore.entries()).toStrictEqual([]);
  });

  it("6: a provider failure marks the job failed, releases the lock, and allows a new draft", async () => {
    generateVideoMock.mockRejectedValueOnce(new Error("OpenRouter rejected the request"));
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water" });
    const [firstDraft] = await flow.draftStore.entries();

    await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${firstDraft!.value.draftId}`,
        channel: "line",
        senderId: OWNER_ID,
        senderIsOwner: true,
      },
      CTX,
    );
    expect((await flow.activeJobLockStore.entries()).length).toBe(1);

    await flow.scheduled[0]?.();

    const [failedJob] = await flow.jobStore.entries();
    expect(failedJob?.value.status).toBe("failed");
    expect(failedJob?.value.error).toContain("OpenRouter rejected the request");
    // Terminal failure must not leave an active blocker behind.
    expect(await flow.activeJobLockStore.entries()).toStrictEqual([]);

    const retry = await flow.tool!.execute("call-2", { prompt: "second attempt" });
    expect((retry as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
  });

  it("7: the consumed confirmation code cannot be replayed; a retry needs a new code", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water" });
    const [draftEntry] = await flow.draftStore.entries();
    const draftId = draftEntry!.value.draftId;
    const confirmEvent = {
      content: "",
      body: `ยืนยัน VIDEO ${draftId}`,
      channel: "line",
      senderId: OWNER_ID,
      senderIsOwner: true,
    };

    await flow.gate(confirmEvent, CTX);
    const replay = await flow.gate(confirmEvent, CTX);

    expect(replay).toStrictEqual({
      handled: true,
      text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว",
    });
    expect((await flow.jobStore.entries()).length).toBe(1);
    expect(flow.scheduled.length).toBe(1);
  });

  it("8: a non-owner cannot confirm, and no paid submission happens", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", { prompt: "a cat sitting on water" });
    const [draftEntry] = await flow.draftStore.entries();

    const result = await flow.gate(
      {
        content: "",
        body: `ยืนยัน VIDEO ${draftEntry!.value.draftId}`,
        channel: "line",
        senderId: "U-member",
        senderIsOwner: false,
      },
      CTX,
    );

    expect(result).toEqual({ handled: true, text: "ไม่มีสิทธิ์ยืนยันการสร้างวิดีโอ" });
    expect(await flow.jobStore.entries()).toStrictEqual([]);
    expect(await flow.activeJobLockStore.entries()).toStrictEqual([]);
    expect(flow.paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});

describe("unauthorized LINE video operations fail closed", () => {
  it("denies draft, video-model, confirmation, and generic generation paths without paid work", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-owner", { prompt: "a cat sitting on water" });
    const [draftEntry] = await flow.draftStore.entries();

    expect(
      createLineVideoDraftTool({
        messageChannel: "line",
        senderIsOwner: false,
        requesterSenderId: "U-member",
      }),
    ).toBeNull();

    const videoModelRouter = createLineVideoModelControlRouter({
      preferenceStore: flow.preferenceStore,
      pendingStore: createMemoryStore<LinePendingVideoModelSelection>(),
      resolveApiKey: async () => "sk-test",
    });
    expect(
      await videoModelRouter(
        {
          content: "เปลี่ยน video model เป็น seedance",
          body: "เปลี่ยน video model เป็น seedance",
          channel: "line",
          senderId: "U-member",
          senderIsOwner: false,
        },
        CTX,
      ),
    ).toBeUndefined();
    expect(await flow.preferenceStore.entries()).toStrictEqual([]);

    expect(
      await flow.gate(
        {
          content: "",
          body: `ยืนยัน VIDEO ${draftEntry!.value.draftId}`,
          channel: "line",
          senderId: "U-member",
          senderIsOwner: false,
        },
        CTX,
      ),
    ).toEqual({ handled: true, text: "ไม่มีสิทธิ์ยืนยันการสร้างวิดีโอ" });

    const generationGuard = createLineVideoGenerationGuard();
    generationGuard.beforeAgentRun({}, { channel: "line", runId: "run-member" });
    expect(
      generationGuard.beforeToolCall({ toolName: "video_generate" }, { runId: "run-member" }),
    ).toMatchObject({ block: true });
    generationGuard.agentEnd({}, { runId: "run-member" });

    expect(await flow.draftStore.lookup(draftEntry!.value.draftId)).toBeDefined();
    expect(await flow.jobStore.entries()).toStrictEqual([]);
    expect(flow.scheduled).toHaveLength(0);
    expect(flow.paidVideoPosts()).toStrictEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});
