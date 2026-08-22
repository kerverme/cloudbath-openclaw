import { describe, expect, it } from "vitest";
import {
  createLineVideoDraftReplyRelay,
  LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES,
  LINE_VIDEO_REPLY_RELAY_TTL_MS,
} from "./video-draft-reply-relay.js";

const PREVIEW = "🎬 Video draft\n\nEstimated cost: $0.51\n\nยืนยัน VIDEO 5343";
const LINE_EVENT = { channel: "line", kind: "final", sessionKey: "line:u1", runId: "run-1" };

describe("line video draft preview relay", () => {
  it("replaces the model's outbound text with the tool-owned preview", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    const result = relay.replyPayloadSending(
      { ...LINE_EVENT, payload: { text: "สร้าง draft แล้วนะครับ ยืนยัน VIDEO 5343" } },
      {},
    );

    expect(result?.payload?.text).toBe(PREVIEW);
    expect(result?.cancel).toBeUndefined();
  });

  it("preserves other payload fields while replacing text", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    const result = relay.replyPayloadSending(
      { ...LINE_EVENT, payload: { text: "paraphrased", replyToId: "m-9" } },
      {},
    );

    expect(result?.payload).toMatchObject({ text: PREVIEW, replyToId: "m-9" });
  });

  it("cancels a second payload from the same turn so exactly one message ships", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    const first = relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "a" } }, {});
    const second = relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "b" } }, {});

    expect(first?.payload?.text).toBe(PREVIEW);
    expect(second?.cancel).toBe(true);
    expect(second?.payload).toBeUndefined();
  });

  it("releases a later turn untouched instead of hijacking it", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });
    relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "a" } }, {});

    const laterTurn = relay.replyPayloadSending(
      { ...LINE_EVENT, runId: "run-2", payload: { text: "สวัสดีครับ" } },
      {},
    );
    const afterThat = relay.replyPayloadSending(
      { ...LINE_EVENT, runId: "run-3", payload: { text: "ok" } },
      {},
    );

    expect(laterTurn).toBeUndefined();
    expect(afterThat).toBeUndefined();
  });

  it("leaves other channels alone", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    expect(
      relay.replyPayloadSending({ ...LINE_EVENT, channel: "telegram", payload: { text: "x" } }, {}),
    ).toBeUndefined();
  });

  it("leaves other sessions alone", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    expect(
      relay.replyPayloadSending(
        { ...LINE_EVENT, sessionKey: "line:u2", payload: { text: "x" } },
        {},
      ),
    ).toBeUndefined();
  });

  it("falls back to the context channel and session key", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    const result = relay.replyPayloadSending(
      { kind: "final", runId: "run-1", payload: { text: "x" } },
      { channelId: "line", sessionKey: "line:u1" },
    );

    expect(result?.payload?.text).toBe(PREVIEW);
  });

  it("does not arm without a session key, since nothing could match it", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ text: PREVIEW });

    expect(
      relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "untouched" } }, {}),
    ).toBeUndefined();
  });

  it("expires an unclaimed preview instead of pinning it to a much later message", () => {
    let clock = 1_000;
    const relay = createLineVideoDraftReplyRelay({ now: () => clock });
    relay.record({ sessionKey: "line:u1", text: PREVIEW });

    clock += LINE_VIDEO_REPLY_RELAY_TTL_MS + 1;

    expect(
      relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "much later" } }, {}),
    ).toBeUndefined();
  });

  it("supersedes a redraft in the same session with the newer preview", () => {
    const relay = createLineVideoDraftReplyRelay();
    relay.record({ sessionKey: "line:u1", text: PREVIEW });
    relay.record({ sessionKey: "line:u1", text: "🎬 newer 7788" });

    const result = relay.replyPayloadSending({ ...LINE_EVENT, payload: { text: "x" } }, {});

    expect(result?.payload?.text).toBe("🎬 newer 7788");
  });

  it("stays bounded under many concurrent conversations", () => {
    const relay = createLineVideoDraftReplyRelay();
    const overflow = LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES + 50;
    for (let i = 0; i < overflow; i += 1) {
      relay.record({ sessionKey: `line:u${i}`, text: `p${i}` });
    }

    // Newest survives; the oldest was evicted rather than retained forever.
    const newest = relay.replyPayloadSending(
      { ...LINE_EVENT, sessionKey: `line:u${overflow - 1}`, payload: { text: "x" } },
      {},
    );
    const oldest = relay.replyPayloadSending(
      { ...LINE_EVENT, sessionKey: "line:u0", payload: { text: "x" } },
      {},
    );

    expect(newest?.payload?.text).toBe(`p${overflow - 1}`);
    expect(oldest).toBeUndefined();
  });
});
