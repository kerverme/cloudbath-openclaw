import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { LineVideoDraft } from "./video-draft-store.js";
import { createLineVideoDraftTool, createLineVideoGenerationGuard } from "./video-draft-tool.js";
import { claimLineVideoActiveJobLock, type LineVideoActiveJobLock } from "./video-job-store.js";
import type { LineVideoModelPreferenceState } from "./video-model-preference.js";

/**
 * Account config in the shape `resolveLineAccount` reads.
 *
 * fal rates are declared per endpoint; an endpoint with none is not payable,
 * so without this no draft can be created at all.
 */
const FAL_CFG = {
  channels: {
    line: {
      videoGeneration: {
        // Seedance 2.5 at 720p costs ~$0.46/second on fal's published token
        // price, so the default $2 ceiling would refuse an 8-second clip.
        maxEstimatedCostUsd: 10,
        falPricing: {
          models: { "bytedance/seedance-2.0/reference-to-video": { usdPerSecond: 0.1 } },
        },
      },
    },
  },
} as never;

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

function seedanceCatalogResponse() {
  return {
    data: [
      {
        id: "bytedance/seedance-2.5",
        name: "Seedance 2.5",
        supported_durations: [4, 6, 8],
        supported_aspect_ratios: ["16:9", "9:16"],
        supported_resolutions: ["720p", "1080p"],
        supported_frame_images: ["first_frame"],
        pricing_skus: { "per-video-second": "0.10" },
      },
    ],
  };
}

function toolFixture(params?: {
  models?: unknown;
  fileExists?: () => Promise<boolean>;
  cfg?: never;
}) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const preferenceStore = createMemoryStore<LineVideoModelPreferenceState>();
  const activeJobLockStore = createMemoryStore<LineVideoActiveJobLock>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify(params?.models ?? seedanceCatalogResponse()), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const tool = createLineVideoDraftTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: "U-owner",
    // Physical session generations are deliberately unrelated to the stable
    // native LINE group identity.
    sessionId: "ephemeral-session-uuid",
    nativeConversationId: "grp-a",
    accountId: "acct-1",
    deliveryTo: "line:group:grp-a",
    cfg: params?.cfg ?? FAL_CFG,
    draftStore,
    preferenceStore,
    activeJobLockStore,
    resolveApiKey: async () => "sk-test",
    fetchImpl,
    fileExists: params?.fileExists ?? (async () => true),
  });
  return { tool, draftStore, preferenceStore, activeJobLockStore, requestedUrls };
}

describe("createLineVideoDraftTool", () => {
  it("1: returns null (not registered) for non-owner senders", () => {
    const tool = createLineVideoDraftTool({ messageChannel: "line", senderIsOwner: false });
    expect(tool).toBeNull();
  });

  it("2: returns null on channels other than LINE", () => {
    const tool = createLineVideoDraftTool({ messageChannel: "telegram", senderIsOwner: true });
    expect(tool).toBeNull();
  });

  it("3: 'ทำ video...' creates a draft only — makes zero calls to the paid /videos submit endpoint", async () => {
    const { tool, draftStore, requestedUrls } = toolFixture();
    const result = await tool!.execute("call-1", { prompt: "a cat riding a skateboard" });

    expect((await draftStore.entries()).length).toBe(1);
    expect(requestedUrls.every((url) => url.includes("/videos/models"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/videos") && !url.includes("/models"))).toBe(
      false,
    );
    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
  });

  it("4: draft preview text displays model, settings, and estimated cost", async () => {
    const { tool } = toolFixture();
    const result = await tool!.execute("call-1", {
      prompt: "a cat riding a skateboard",
      durationSeconds: 8,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect(text).toContain("Seedance 2.5 Reference-to-Video");
    expect(text).toContain("8 sec");
    // fal's published Seedance 2.5 token price: 1280x720 x 8s x 24fps / 1024
    // tokens at $0.0214/1000.
    expect(text).toContain("Estimated cost: $3.70");
    expect(text).toMatch(/ยืนยัน VIDEO \d{4}/u);
  });

  it("preserves an explicitly requested supported duration exactly", async () => {
    const { tool, draftStore } = toolFixture();
    const result = await tool!.execute("call-supported-duration", {
      prompt: "a cat riding a skateboard",
      durationSeconds: 6,
    });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
    const [entry] = await draftStore.entries();
    expect(entry?.value.durationSeconds).toBe(6);
  });

  it("rejects a duration no fal endpoint accepts, instead of rounding or drafting", async () => {
    const { tool, draftStore, requestedUrls } = toolFixture();
    // 60s: Seedance 2.5 reaches 30 and every other endpoint stops sooner, so
    // nothing on fal accepts this length.
    const result = await tool!.execute("call-unsupported-duration", {
      prompt: "a cat riding a skateboard",
      durationSeconds: 60,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "unsupported_duration",
    );
    expect(text).toContain("ความยาว 60 วินาที");
    expect(text).toContain("30");
    expect((await draftStore.entries()).length).toBe(0);
    expect(requestedUrls.some((url) => url.endsWith("/videos"))).toBe(false);
  });

  it("5: preserves the exact inbound image path for image-to-video, never substituting another image", async () => {
    const { tool, draftStore } = toolFixture();
    await tool!.execute("call-1", {
      prompt: "camera pushes in slowly",
      image: "/media/inbound/room.jpg",
    });

    const [entry] = await draftStore.entries();
    expect(entry?.value.sourceImagePath).toBe("/media/inbound/room.jpg");
  });

  it("6: refuses to create a draft when the referenced image does not exist", async () => {
    const { tool, draftStore } = toolFixture({ fileExists: async () => false });
    const result = await tool!.execute("call-1", {
      prompt: "camera pushes in slowly",
      image: "/media/inbound/missing.jpg",
    });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "image_unavailable",
    );
    expect((await draftStore.entries()).length).toBe(0);
  });

  it("7: refuses when the estimated cost exceeds the configured limit (cost guard, not the LLM, decides)", async () => {
    const { tool, draftStore } = toolFixture({
      cfg: {
        channels: {
          line: {
            videoGeneration: {
              maxEstimatedCostUsd: 1,
              falPricing: {
                models: { "bytedance/seedance-2.5/reference-to-video": { usdPerSecond: 5 } },
              },
            },
          },
        },
      } as never,
    });
    const result = await tool!.execute("call-1", { prompt: "a very expensive video" });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "over_limit",
    );
    expect((await draftStore.entries()).length).toBe(0);
  });

  it("8: binds the fal endpoint the registry selects, and records it on the draft", async () => {
    // Model selection for a paid request comes from the fal registry, not from
    // the OpenRouter catalog: fal is the only provider this flow generates on,
    // so binding anything else would quote one provider and bill another.
    const { tool, draftStore } = toolFixture();

    await tool!.execute("call-1", { prompt: "a cat riding a skateboard" });

    const [entry] = await draftStore.entries();
    // Seedance 2.5 is the capability-aware default here: the tool asks for no
    // audio, which rules out H3's always-on native audio.
    expect(entry?.value.model).toBe("bytedance/seedance-2.5/reference-to-video");
    expect(entry?.value.providerRoute).toEqual({
      provider: "fal",
      modelId: "bytedance/seedance-2.5/reference-to-video",
    });
  });

  it("9: refuses a new draft while a job is already running for this conversation", async () => {
    const { tool, draftStore, activeJobLockStore } = toolFixture();
    await claimLineVideoActiveJobLock({
      store: activeJobLockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
    });

    const result = await tool!.execute("call-1", { prompt: "a cat riding a skateboard" });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "already_running",
    );
    expect((await draftStore.entries()).length).toBe(0);
  });

  it("10: allows a new draft once the previous job's lock is released", async () => {
    const { tool, draftStore, activeJobLockStore } = toolFixture();
    await claimLineVideoActiveJobLock({
      store: activeJobLockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
    });
    await activeJobLockStore.delete((await activeJobLockStore.entries())[0]?.key ?? "");

    const result = await tool!.execute("call-1", { prompt: "a cat riding a skateboard" });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
    expect((await draftStore.entries()).length).toBe(1);
  });

  it("11: a stale (abandoned) lock is treated as released, allowing a new draft", async () => {
    const { tool, draftStore, activeJobLockStore } = toolFixture();
    const now = Date.now();
    await claimLineVideoActiveJobLock({
      store: activeJobLockStore,
      conversationKey: "acct-1|grp-a",
      jobId: "job-1",
      // 20 minutes ago -- past LINE_VIDEO_JOB_STALE_RUNNING_MS (15 min), so
      // this simulates a background worker killed by a process/gateway
      // restart before it ever reached its own terminal update.
      now: () => now - 20 * 60 * 1000,
    });

    const result = await tool!.execute("call-1", { prompt: "a cat riding a skateboard" });

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
    expect((await draftStore.entries()).length).toBe(1);
  });
});

describe("createLineVideoGenerationGuard", () => {
  const LINE_RUN = { channel: "line", runId: "run-1", sessionId: "sess-1" };

  it("blocks video_generate inside a LINE agent run", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, LINE_RUN);

    expect(guard.beforeToolCall({ toolName: "video_generate" }, LINE_RUN)).toMatchObject({
      block: true,
    });
  });

  // The production regression: the observed paid run logged
  // "[agents/agent-command] [agent] run video_generate:...:error", which only
  // the background completion-wake path emits -- i.e. the call executed rather
  // than being blocked. The old guard tested `ctx.channelId !== "line"` and
  // channelId is absent on this path (agent-tools.ts only sets it from
  // hookChannelId ?? currentChannelId, and hookChannelId is never assigned),
  // so it failed open. Keying off the recorded run fails closed here.
  it("blocks video_generate when the tool-call context carries no channelId at all", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, LINE_RUN);

    const productionToolCallContext = { runId: "run-1", sessionId: "sess-1" };
    expect(
      guard.beforeToolCall({ toolName: "video_generate" }, productionToolCallContext),
    ).toMatchObject({ block: true });
  });

  it("blocks when only the runId matches and blocks when only the sessionId matches", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, LINE_RUN);

    expect(guard.beforeToolCall({ toolName: "video_generate" }, { runId: "run-1" })).toMatchObject({
      block: true,
    });
    expect(
      guard.beforeToolCall({ toolName: "video_generate" }, { sessionId: "sess-1" }),
    ).toMatchObject({ block: true });
  });

  it("leaves non-LINE video_generate untouched", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, { channel: "telegram", runId: "run-2", sessionId: "sess-2" });

    expect(
      guard.beforeToolCall({ toolName: "video_generate" }, { runId: "run-2", sessionId: "sess-2" }),
    ).toBeUndefined();
  });

  it("does not block video_generate for a run that was never recorded as LINE", () => {
    const guard = createLineVideoGenerationGuard();
    expect(
      guard.beforeToolCall({ toolName: "video_generate" }, { runId: "run-3", sessionId: "sess-3" }),
    ).toBeUndefined();
  });

  it("does not block unrelated tools inside a LINE run", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, LINE_RUN);

    expect(guard.beforeToolCall({ toolName: "image_generate" }, LINE_RUN)).toBeUndefined();
    expect(guard.beforeToolCall({ toolName: "line_video_draft" }, LINE_RUN)).toBeUndefined();
  });

  it("stops blocking once the LINE run ends, without leaking across runs", () => {
    const guard = createLineVideoGenerationGuard();
    guard.beforeAgentRun({}, LINE_RUN);
    guard.agentEnd({}, LINE_RUN);

    expect(guard.beforeToolCall({ toolName: "video_generate" }, LINE_RUN)).toBeUndefined();
  });

  it("keeps concurrent LINE and non-LINE runs independent", () => {
    const guard = createLineVideoGenerationGuard();
    const lineRun = { channel: "line", runId: "run-line", sessionId: "sess-line" };
    const otherRun = { channel: "discord", runId: "run-other", sessionId: "sess-other" };
    guard.beforeAgentRun({}, lineRun);
    guard.beforeAgentRun({}, otherRun);

    expect(guard.beforeToolCall({ toolName: "video_generate" }, lineRun)).toMatchObject({
      block: true,
    });
    expect(guard.beforeToolCall({ toolName: "video_generate" }, otherRun)).toBeUndefined();
  });
});
