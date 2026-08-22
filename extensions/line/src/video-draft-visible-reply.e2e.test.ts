/**
 * Acceptance test for the LINE-VISIBLE reply to the exact production request:
 *
 *   "ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ"
 *
 * PR #26 made the draft succeed; the owner still saw only the confirmation
 * code, because the preview was tool-result content and the model rewrote it
 * on the next turn. These tests drive the real draft tool and the real
 * outbound relay together, with the model's turn modelled as the paraphrase
 * actually observed in production, and assert on the payload that would reach
 * LINE rather than on the tool result.
 *
 * generateVideo is mocked and the paid POST count is asserted zero.
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
const RUN_ID = "run-draft-1";

/** The paraphrase the production owner actually received instead of the preview. */
const PRODUCTION_PARAPHRASE = "กรุณาส่งข้อความยืนยันนี้เพื่อเริ่มสร้างวิดีโอ:\nยืนยัน VIDEO 5343";

/** Verbatim live catalog entry for bytedance/seedance-2.5 (fetched 2026-08-22). */
const SEEDANCE_25_LIVE = {
  id: "bytedance/seedance-2.5",
  name: "ByteDance: Seedance 2.5",
  supported_resolutions: ["480p", "720p"],
  supported_aspect_ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  supported_sizes: ["854x480", "640x640", "480x854", "1280x720", "720x1280"],
  supported_durations: [4, 5, 6, 7, 8, 9, 10],
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

function buildFlow() {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    return new Response(JSON.stringify({ data: [SEEDANCE_25_LIVE] }), { status: 200 });
  }) as unknown as typeof fetch;

  const relay = createLineVideoDraftReplyRelay();
  /**
   * Mirrors the plugin entrypoint, where the relay is lazily imported and so
   * arming resolves a tick later than the tool's own code. The tool must await
   * it; if it does not, the model's reply reaches the outbound hook first.
   */
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
    draftStore,
    preferenceStore: createMemoryStore<LineVideoModelPreferenceState>(),
    activeJobLockStore: createMemoryStore<LineVideoActiveJobLock>(),
    fetchImpl,
  });

  /**
   * Runs the model's turn through the outbound relay and returns the messages
   * LINE would actually receive, in order.
   */
  const deliver = (modelTexts: string[], runId = RUN_ID): string[] => {
    const visible: string[] = [];
    for (const text of modelTexts) {
      const result = relay.replyPayloadSending(
        { channel: "line", kind: "final", sessionKey: SESSION_KEY, runId, payload: { text } },
        {},
      );
      if (result?.cancel) {
        continue;
      }
      visible.push((result?.payload?.text as string | undefined) ?? text);
    }
    return visible;
  };

  const paidVideoPosts = () =>
    requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models"));

  return { tool, relay, deliver, draftStore, paidVideoPosts };
}

beforeEach(() => {
  generateVideoMock.mockReset();
});

describe("LINE-visible reply for 'ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ'", () => {
  it("shows the full tool-owned preview even when the model paraphrases it away", async () => {
    const flow = buildFlow();
    expect(flow.tool).not.toBeNull();

    const result = await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
      resolution: "480p",
      aspectRatio: "16:9",
    });
    const details = (result as { details?: Record<string, unknown> }).details;
    expect(details?.resolution).toBe("draft_created");

    const visible = flow.deliver([PRODUCTION_PARAPHRASE]);

    expect(visible).toHaveLength(1);
    const reply = visible[0] ?? "";

    expect(reply).toContain("🎬 Video draft");
    expect(reply).toContain("Model: ByteDance: Seedance 2.5");
    expect(reply).toContain("Duration: 5 sec");
    expect(reply).toContain("Resolution: 480p");
    expect(reply).toContain("Aspect: 16:9");
    expect(reply).toMatch(/Audio: (On|Off)/u);
    expect(reply).toContain("Estimated cost: $0.51");
    expect(reply).toContain("a cat sitting on water");
    expect(reply).toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(reply).toContain("เพื่อเริ่มสร้าง");

    // The model's own wording is gone entirely, not appended to.
    expect(reply).not.toContain("กรุณาส่งข้อความยืนยันนี้เพื่อเริ่มสร้างวิดีโอ");

    expect(flow.paidVideoPosts()).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("shows the confirmation code that the persisted draft will accept", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
      resolution: "480p",
    });

    const reply = flow.deliver([PRODUCTION_PARAPHRASE])[0] ?? "";
    const shownCode = /ยืนยัน VIDEO (\d{4})/u.exec(reply)?.[1];
    const stored = await flow.draftStore.entries();

    expect(stored).toHaveLength(1);
    expect(shownCode).toBe(stored[0]?.key);
  });

  it("shows values that match the persisted draft, not re-derived ones", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
      resolution: "480p",
      aspectRatio: "16:9",
    });

    const reply = flow.deliver([PRODUCTION_PARAPHRASE])[0] ?? "";
    const draft = (await flow.draftStore.entries())[0]?.value as LineVideoDraft;

    expect(reply).toContain(`Duration: ${draft.durationSeconds} sec`);
    expect(reply).toContain(`Resolution: ${draft.resolution}`);
    expect(reply).toContain(`Aspect: ${draft.aspectRatio}`);
    expect(reply).toContain(draft.prompt);
    expect(reply).toContain(`Estimated cost: $${draft.estimatedCostUsd.toFixed(2)}`);
  });

  it("delivers exactly one message when the model emits several", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });

    const visible = flow.deliver([
      "สร้าง draft ให้แล้วนะครับ",
      PRODUCTION_PARAPHRASE,
      "ถ้าต้องการแก้ไขบอกได้เลยครับ",
    ]);

    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain("🎬 Video draft");
    expect(visible[0]).toContain("Estimated cost: $");
  });

  it("creates exactly one draft and one confirmation code per request", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });

    const visible = flow.deliver([PRODUCTION_PARAPHRASE]);
    const codes = [...(visible[0] ?? "").matchAll(/ยืนยัน VIDEO (\d{4})/gu)];

    expect(await flow.draftStore.entries()).toHaveLength(1);
    expect(codes).toHaveLength(1);
  });

  it("leaves the owner's next unrelated turn untouched", async () => {
    const flow = buildFlow();
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });
    flow.deliver([PRODUCTION_PARAPHRASE]);

    expect(flow.deliver(["สวัสดีครับ วันนี้อากาศดี"], "run-later")).toEqual(["สวัสดีครับ วันนี้อากาศดี"]);
  });

  it("does not touch replies for a run that created no draft", () => {
    const flow = buildFlow();
    expect(flow.deliver(["ปกติครับ"])).toEqual(["ปกติครับ"]);
  });

  it("arms the lazily-loaded relay before execute resolves, leaving no race", async () => {
    const flow = buildFlow();

    // The instant execute() settles, the relay must already hold the preview:
    // this is the earliest point the model can emit a reply, so anything
    // still pending here would ship the paraphrase instead.
    await flow.tool!.execute("call-1", {
      prompt: "a cat sitting on water",
      durationSeconds: 5,
    });

    expect(flow.deliver([PRODUCTION_PARAPHRASE])[0]).toContain("🎬 Video draft");
  });
});
