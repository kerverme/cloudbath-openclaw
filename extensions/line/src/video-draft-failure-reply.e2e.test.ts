/**
 * The deterministic FAILURE texts owned by `line_video_draft` reach LINE
 * verbatim, exactly like the success preview.
 *
 * These branches matter as much as the preview: in production the model
 * narrated a failed `unknown_cost` result as "สร้างคำขอวิดีโอไว้แล้ว..." — it
 * claimed a draft existed when the cost guard had refused before
 * createLineVideoDraft ever ran. Each case below drives the real tool and the
 * real relay, models the model's turn as a plausible paraphrase, and asserts
 * on the payload LINE would receive.
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

const { createLineVideoDraftTool } = await import("./video-draft-tool.js");
const { createLineVideoDraftReplyRelay } = await import("./video-draft-reply-relay.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock } from "./video-job-store.js";
import type { LineVideoModelPreferenceState } from "./video-model-preference.js";

const OWNER_ID = "U-owner";
const SESSION_KEY = "line:group:grp-a";
const RUN_ID = "run-fail-1";

/** The shape of paraphrase the production model produced over a failed branch. */
const MODEL_PARAPHRASE = "สร้างคำขอวิดีโอไว้แล้วครับ รอสักครู่นะครับ";

/** Seedance 2.5 with its token pricing stripped: the live unknown_cost trigger. */
const SEEDANCE_NO_PRICING = {
  id: "bytedance/seedance-2.5",
  name: "ByteDance: Seedance 2.5",
  supported_resolutions: ["480p", "720p"],
  supported_aspect_ratios: ["16:9"],
  supported_sizes: ["854x480", "1280x720"],
  supported_durations: [4, 5, 6, 7, 8],
  generate_audio: true,
  pricing_skus: { some_unrecognized_unit: "0.5" },
};

const SEEDANCE_PRICED = {
  ...SEEDANCE_NO_PRICING,
  pricing_skus: { video_tokens: "0.0000107" },
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

type FlowOverrides = {
  catalogEntry?: unknown;
  catalogThrows?: boolean;
  apiKey?: string | undefined;
  omitStores?: boolean;
  preferredModelId?: string;
};

function buildFlow(overrides: FlowOverrides = {}) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const preferenceStore = createMemoryStore<LineVideoModelPreferenceState>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    if (overrides.catalogThrows) {
      throw new Error("network down");
    }
    return new Response(JSON.stringify({ data: [overrides.catalogEntry ?? SEEDANCE_PRICED] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const relay = createLineVideoDraftReplyRelay();
  relay.beginTurn(
    { channel: "line", sessionKey: SESSION_KEY },
    { channelId: "line", sessionKey: SESSION_KEY },
  );
  /** Async arming, mirroring the entrypoint's lazily-imported relay. */
  const recordDeterministicText = async (entry: { sessionKey?: string; text: string }) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    relay.record(entry);
  };
  const tool = createLineVideoDraftTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: OWNER_ID,
    sessionId: "grp-a",
    sessionKey: SESSION_KEY,
    recordDeterministicText,
    accountId: "acct-1",
    deliveryTo: SESSION_KEY,
    cfg: {},
    ...(overrides.omitStores ? {} : { draftStore, preferenceStore }),
    ...(overrides.omitStores
      ? {}
      : { activeJobLockStore: createMemoryStore<LineVideoActiveJobLock>() }),
    resolveApiKey: async () => ("apiKey" in overrides ? overrides.apiKey : "sk-openrouter-test"),
    fetchImpl,
  });

  let activeRunId = RUN_ID;
  const deliver = (modelTexts: string[], runId = RUN_ID): string[] => {
    if (runId !== activeRunId) {
      relay.beginTurn(
        { channel: "line", sessionKey: SESSION_KEY },
        { channelId: "line", sessionKey: SESSION_KEY },
      );
      activeRunId = runId;
    }
    const visible: string[] = [];
    for (const text of modelTexts) {
      const result = relay.messageSending(
        { content: text, metadata: { channel: "line" } },
        { channelId: "line", sessionKey: SESSION_KEY },
      );
      if (result?.cancel) {
        continue;
      }
      visible.push(result?.content ?? text);
    }
    return visible;
  };

  const paidVideoPosts = () =>
    requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models"));

  return { tool, relay, deliver, draftStore, preferenceStore, paidVideoPosts };
}

beforeEach(() => {
  generateVideoMock.mockReset();
});

const CASES: Array<{
  resolution: string;
  overrides: FlowOverrides;
  expectedText: string;
}> = [
  {
    resolution: "context_unavailable",
    overrides: { omitStores: true },
    expectedText: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: LINE runtime context ไม่ครบ",
  },
  {
    resolution: "provider_auth_unavailable",
    overrides: { apiKey: undefined },
    expectedText: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ระบบไม่พบการเชื่อมต่อ OpenRouter สำหรับ Video",
  },
  {
    resolution: "catalog_unavailable",
    overrides: { catalogThrows: true },
    expectedText:
      "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: โหลดรายการ Video Model จาก OpenRouter ไม่สำเร็จ",
  },
  {
    // Catalog loads, but the conversation's model (default seedance-2.5) is
    // absent from it.
    resolution: "model_unavailable",
    overrides: { catalogEntry: { ...SEEDANCE_PRICED, id: "bytedance/some-other-model" } },
    expectedText: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ไม่พบ Video Model ที่เลือกไว้ใน OpenRouter",
  },
  {
    resolution: "unknown_cost",
    overrides: { catalogEntry: SEEDANCE_NO_PRICING },
    expectedText:
      "❌ ยังไม่ได้สร้าง Video Draft\nสาเหตุ: ระบบยังคำนวณค่าใช้จ่ายของ Video Model นี้ไม่ได้\nยังไม่มีการส่งคำขอสร้างวิดีโอและยังไม่มีค่าใช้จ่าย",
  },
];

describe("deterministic LINE video-draft failure texts reach the owner verbatim", () => {
  for (const testCase of CASES) {
    it(`${testCase.resolution}: exactly one message, exact tool text, no draft, no paid post`, async () => {
      const flow = buildFlow(testCase.overrides);
      expect(flow.tool).not.toBeNull();

      const result = await flow.tool!.execute("call-1", {
        prompt: "a cat sitting on water",
        durationSeconds: 5,
      });
      const details = (result as { details?: Record<string, unknown> }).details;
      expect(details?.resolution).toBe(testCase.resolution);

      const visible = flow.deliver([MODEL_PARAPHRASE]);

      // VISIBLE_REPLY_COUNT = 1, EXACT_TOOL_TEXT_VISIBLE = YES
      expect(visible).toHaveLength(1);
      expect(visible[0]).toBe(testCase.expectedText);

      // LLM_PARAPHRASE = NO
      expect(visible[0]).not.toContain("สร้างคำขอวิดีโอไว้แล้ว");

      // DRAFT_CREATED = false, and no confirmation code was offered.
      expect(await flow.draftStore.entries()).toHaveLength(0);
      expect(visible[0]).not.toMatch(/ยืนยัน VIDEO/u);

      // PAID_VIDEO_POST = ZERO
      expect(flow.paidVideoPosts()).toHaveLength(0);
      expect(generateVideoMock).not.toHaveBeenCalled();
    });

    it(`${testCase.resolution}: a chatty model still yields one message`, async () => {
      const flow = buildFlow(testCase.overrides);

      await flow.tool!.execute("call-1", {
        prompt: "a cat sitting on water",
        durationSeconds: 5,
      });
      const visible = flow.deliver([MODEL_PARAPHRASE, "ขอโทษครับ ลองใหม่อีกครั้งนะครับ"]);

      expect(visible).toEqual([testCase.expectedText]);
    });
  }

  it("leaves non-deterministic outcomes to the model", async () => {
    const flow = buildFlow();
    const result = await flow.tool!.execute("call-1", { prompt: "   " });

    expect((result as { details?: Record<string, unknown> }).details?.resolution).toBe(
      "invalid_input",
    );
    // invalid_input has no tool-owned user-facing text, so nothing is pinned
    // and the model keeps ownership of how it asks for a usable prompt.
    expect(flow.deliver(["ขอ prompt เพิ่มเติมหน่อยครับ"])).toEqual(["ขอ prompt เพิ่มเติมหน่อยครับ"]);
  });
});
