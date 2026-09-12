/**
 * Both LINE delivery paths must send the turn's authoritative text unchanged.
 *
 * LINE's reply-token delivery reaches `reply_payload_sending` without reaching
 * `message_sending`, and durable/message-tool delivery reaches
 * `message_sending`. The relay guards both. Now that the agent run finalizes the
 * reply before delivery, this layer must not repair it a second time with its
 * own rules — a second opinion here is how the UI and LINE ended up showing
 * different wordings of the same turn.
 */
import { describe, expect, it, vi } from "vitest";
import { createLineOutboundRelay } from "./line-outbound-relay.js";

/** The wording the LINE channel supplies to core as its last-resort fallback. */
const AUTHORITATIVE_FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const AUTHORITATIVE_REPLY = "เรียบร้อยแล้วครับ ส่งทาง LINE ให้แล้ว ดูได้ที่ https://example.com/a";

const CTX = { channelId: "line", conversationId: "line:group:C1", sessionKey: "s1" } as const;

function createRelay() {
  const resolve = vi.fn(async () => undefined);
  const warn = vi.fn();
  return {
    relay: createLineOutboundRelay({ resolve, isRebuildTarget: () => false, logger: { warn } }),
    resolve,
    warn,
  };
}

describe("authoritative text passes through both LINE paths untouched", () => {
  for (const [label, text] of [
    ["the fallback wording", AUTHORITATIVE_FALLBACK],
    ["a clean reply naming products and links", AUTHORITATIVE_REPLY],
  ] as const) {
    it(`leaves ${label} alone on the durable path`, async () => {
      const { relay, resolve } = createRelay();

      await expect(
        relay.messageSending({ content: text, to: "line:U1" }, CTX),
      ).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });

    it(`leaves ${label} alone on the reply-token path`, async () => {
      const { relay, resolve } = createRelay();

      await expect(
        relay.replyPayloadSending({ payload: { text }, channel: "line" }, CTX),
      ).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });
  }

  it("sends byte-identical text on both paths for the same turn", async () => {
    const { relay } = createRelay();
    const durable = await relay.messageSending({ content: AUTHORITATIVE_FALLBACK }, CTX);
    const replyToken = await relay.replyPayloadSending(
      { payload: { text: AUTHORITATIVE_FALLBACK }, channel: "line" },
      CTX,
    );

    // Undefined from both means neither rewrote it, so both send the same bytes.
    expect(durable).toBeUndefined();
    expect(replyToken).toBeUndefined();
  });

  it("still guards text that never went through finalization", async () => {
    // The relay remains the last line for any path that bypasses the run, so a
    // contaminated string is still not delivered as-is.
    const { relay } = createRelay();
    const result = await relay.messageSending({ content: "เข้าใจครับ ใช่ไಮೈ" }, CTX);

    expect(result?.content).toBeDefined();
    expect(result?.content).not.toContain("ಮ");
  });
});
