import { describe, expect, it } from "vitest";
import {
  createLineVideoDraftReplyRelay,
  LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES,
  LINE_VIDEO_REPLY_RELAY_TTL_MS,
} from "./video-draft-reply-relay.js";

const PREVIEW = "🎬 Video draft\n\nEstimated cost: $0.51\n\nยืนยัน VIDEO 5343";
const SESSION_KEY = "agent:main:line:group:g1";

function begin(relay: ReturnType<typeof createLineVideoDraftReplyRelay>, key = SESSION_KEY) {
  relay.beginTurn({ channel: "line", sessionKey: key }, { channelId: "line", sessionKey: key });
}

function send(
  relay: ReturnType<typeof createLineVideoDraftReplyRelay>,
  content: string,
  key = SESSION_KEY,
) {
  return relay.messageSending(
    { content, metadata: { channel: "line" } },
    { channelId: "line", sessionKey: key },
  );
}

describe("line video draft preview relay", () => {
  it("replaces the actual outbound content with the tool-owned preview", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });

    expect(send(relay, "สร้าง draft แล้วนะครับ ยืนยัน VIDEO 5343")?.content).toBe(PREVIEW);
  });

  it("cancels later messages in the same turn so exactly one is visible", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });

    expect(send(relay, "first")?.content).toBe(PREVIEW);
    expect(send(relay, "second")).toMatchObject({
      cancel: true,
      cancelReason: "line_video_draft_reply_already_sent",
    });
  });

  it("resets completed relay state at the next inbound turn", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });
    send(relay, "first");

    begin(relay);

    expect(send(relay, "สวัสดีครับ")).toBeUndefined();
  });

  it("shares state across separate plugin lifecycle facades", () => {
    const toolLifecycleRelay = createLineVideoDraftReplyRelay();
    const liveHookRelay = createLineVideoDraftReplyRelay();
    begin(toolLifecycleRelay);
    toolLifecycleRelay.record({ sessionKey: SESSION_KEY, text: PREVIEW });

    expect(send(liveHookRelay, "model paraphrase")?.content).toBe(PREVIEW);
  });

  it("is idempotent when composed registries dispatch the same hook event twice", () => {
    const firstRegistryRelay = createLineVideoDraftReplyRelay();
    const secondRegistryRelay = createLineVideoDraftReplyRelay();
    begin(firstRegistryRelay);
    firstRegistryRelay.record({ sessionKey: SESSION_KEY, text: PREVIEW });
    const event = { content: "model paraphrase", metadata: { channel: "line" } };
    const ctx = { channelId: "line", sessionKey: SESSION_KEY };

    expect(firstRegistryRelay.messageSending(event, ctx)?.content).toBe(PREVIEW);
    expect(secondRegistryRelay.messageSending(event, ctx)?.content).toBe(PREVIEW);
  });

  it("leaves other channels and sessions alone", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });

    expect(
      relay.messageSending(
        { content: "telegram", metadata: { channel: "telegram" } },
        { channelId: "telegram", sessionKey: SESSION_KEY },
      ),
    ).toBeUndefined();
    expect(send(relay, "other session", "agent:main:line:group:g2")).toBeUndefined();
  });

  it("does not arm without a session key", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ text: PREVIEW });

    expect(send(relay, "untouched")).toBeUndefined();
  });

  it("expires an unclaimed preview", () => {
    let clock = 1_000;
    const relay = createLineVideoDraftReplyRelay({ now: () => clock });
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });

    clock += LINE_VIDEO_REPLY_RELAY_TTL_MS + 1;

    expect(send(relay, "much later")).toBeUndefined();
  });

  it("supersedes a redraft in the same session", () => {
    const relay = createLineVideoDraftReplyRelay();
    begin(relay);
    relay.record({ sessionKey: SESSION_KEY, text: PREVIEW });
    relay.record({ sessionKey: SESSION_KEY, text: "🎬 newer 7788" });

    expect(send(relay, "model text")?.content).toBe("🎬 newer 7788");
  });

  it("stays bounded under many concurrent conversations", () => {
    const relay = createLineVideoDraftReplyRelay();
    const overflow = LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES + 50;
    for (let i = 0; i < overflow; i += 1) {
      const key = `agent:main:line:group:g${i}`;
      begin(relay, key);
      relay.record({ sessionKey: key, text: `p${i}` });
    }

    expect(send(relay, "newest", `agent:main:line:group:g${overflow - 1}`)?.content).toBe(
      `p${overflow - 1}`,
    );
    expect(send(relay, "oldest", "agent:main:line:group:g0")).toBeUndefined();
  });
});
