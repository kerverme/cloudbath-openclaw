import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();
const sendMessageLineMock = vi.fn(async () => ({}));
const resolveLineAccountMock = vi.fn(() => ({
  accountId: "acct-1",
  enabled: true,
  channelAccessToken: "token",
  channelSecret: "secret",
  tokenSource: "config" as const,
  config: {},
}));
const stageLineOutboundVideoMock = vi.fn(async () => ({
  url: "https://r2.example/video.mp4",
  objectKey: "outbound/line-video/x.mp4",
  contentType: "video/mp4",
  contentLength: 10,
  sha256: "abc",
}));
const stageLineVideoPreviewImageMock = vi.fn(async () => ({
  url: "https://r2.example/preview.jpg",
  objectKey: "outbound/line/preview.jpg",
  contentType: "image/jpeg",
  contentLength: 10,
  sha256: "def",
}));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => ({}),
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
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoJob } from "./video-job-store.js";

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

async function fixture(params?: { fetchImpl?: typeof fetch; now?: () => number }) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const jobStore = createMemoryStore<LineVideoJob>();
  const scheduled: Array<() => Promise<void>> = [];
  const gate = createLineVideoConfirmationGate({
    draftStore,
    jobStore,
    resolveApiKey: async () => "sk-test",
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
  return { gate, draftStore, jobStore, draft, scheduled };
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
    const { gate, draft, scheduled, jobStore } = await fixture();
    const result = await gate(confirmEvent(draft.draftId), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    expect(scheduled.length).toBe(1);

    await scheduled[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(generateVideoMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "a cat riding a skateboard",
      modelOverride: "openrouter/bytedance/seedance-2.5",
      autoProviderFallback: false,
    });
    expect(sendMessageLineMock).toHaveBeenCalledWith(
      "line:group:grp-a",
      expect.stringContaining("วิดีโอเสร็จแล้ว"),
      expect.objectContaining({ mediaKind: "video", mediaUrl: "https://r2.example/video.mp4" }),
    );
    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("completed");
    expect(job?.value.actualCostUsd).toBe(0.79);
  });

  it("2: non-owner confirmation never submits, even with a valid code", async () => {
    const { gate, draft, draftStore, scheduled } = await fixture();
    const result = await gate(
      confirmEvent(draft.draftId, { senderId: MEMBER_ID, senderIsOwner: false }),
      CTX,
    );

    expect(result).toBeUndefined();
    expect(scheduled.length).toBe(0);
    // The draft must still be usable by the real owner afterward.
    expect(await draftStore.lookup(draft.draftId)).toMatchObject({ draftId: draft.draftId });
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
    generateVideoMock.mockRejectedValueOnce(new Error("OpenRouter video generation failed"));
    const { gate, draft, scheduled, jobStore } = await fixture();
    await gate(confirmEvent(draft.draftId), CTX);
    await scheduled[0]?.();

    const [job] = await jobStore.entries();
    expect(job?.value.status).toBe("failed");
    expect(job?.value.error).toContain("failed");
    expect(sendMessageLineMock).toHaveBeenCalledWith(
      "line:group:grp-a",
      expect.stringContaining("ไม่สำเร็จ"),
      expect.anything(),
    );
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
