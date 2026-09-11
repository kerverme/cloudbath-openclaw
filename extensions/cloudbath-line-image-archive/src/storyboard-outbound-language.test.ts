/**
 * The final outbound gate, shaped like the production incident.
 *
 * The storyboard document and the tool result were already clean after the
 * previous fix; the owner still saw "ไม่มีตัวอักษรp" because the visible reply
 * is composed by the agent AFTER the tool returns. These tests drive that
 * exact shape: a clean structured storyboard, then an agent attempting to emit
 * corrupted prose, and assert what LINE actually sends.
 */
import { describe, expect, it, vi } from "vitest";
import { storyboardAllowedTerms, thaiSummaryForVersion } from "./storyboard-language.js";
import {
  guardThaiOutboundText,
  STORYBOARD_SAFE_THAI_FALLBACK,
} from "./storyboard-outbound-language.js";
import { createStoryboardOutboundRelay } from "./storyboard-outbound-relay.js";

/** A clean six-scene Thai storyboard, as the document holds it after saving. */
const VERSION = {
  document: {
    cast: [{ displayName: "Twong" }],
    beats: Array.from({ length: 6 }, (_, index) => ({
      startSeconds: index,
      endSeconds: index + 1,
      kind: "action" as const,
      action: `นักดาบเดินเข้าป่าคริสตัล ช่วงที่ ${index + 1}`,
      caption: `ฉากที่ ${index + 1}`,
    })),
  },
  characterLocks: [{ code: "F99" }],
};

const SUMMARY = thaiSummaryForVersion(VERSION)!;
// Exactly what the plugin passes: product vocabulary plus this storyboard's
// own cast and codes. A narrower list would make these tests pass for the
// wrong reason — production would still rewrite the product's own copy.
const ALLOWED = storyboardAllowedTerms(VERSION);

/** The relay as the plugin wires it, over a conversation that owns a storyboard. */
function relay(options: { storyboard?: boolean } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const resolve = vi.fn(async () =>
    options.storyboard === false ? undefined : { summary: SUMMARY, allowedTerms: ALLOWED },
  );
  return {
    logger,
    resolve,
    relay: createStoryboardOutboundRelay({ resolve, logger }),
    ctx: {
      channelId: "line",
      accountId: "acct-1",
      conversationId: "C1234567890abcdef",
      sessionKey: "line:group:C1234567890abcdef",
    },
  };
}

describe("the agent cannot paraphrase the clean summary onto LINE", () => {
  it("replaces the production reply 'ไม่มีตัวอักษรp' on the reply-token path", async () => {
    const h = relay();

    const result = await h.relay.replyPayloadSending(
      { payload: { text: "ไม่มีตัวอักษรp" }, channel: "line" },
      h.ctx,
    );

    expect(result?.payload.text).toBe(SUMMARY);
    expect(result?.payload.text).not.toContain("ไม่มีตัวอักษรp");
  });

  it("replaces it on the durable/message-tool path too", async () => {
    const h = relay();

    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(result?.content).toBe(SUMMARY);
  });

  it("rebuilds rather than character-stripping into broken Thai", async () => {
    const h = relay();

    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    // Stripping the stray "p" would leave "ไม่มีตัวอักษร" — grammatical Thai
    // that still tells the owner nothing true about their storyboard.
    expect(result?.content).not.toBe("ไม่มีตัวอักษร");
    expect(result?.content).toContain("ฉาก 1");
    expect(result?.content).toContain("ฉาก 6");
  });

  it("leaves no mixed script in the text LINE finally sends", async () => {
    const h = relay();

    for (const corrupted of [
      "ไม่มีตัวอักษรp",
      "สร้าง storyboardเรียบร้อย xyzzy แล้ว",
      "เสร็จแล้วครับ привет",
      "ฉากทั้งหมด 6 ฉาก forest ครับ",
    ]) {
      const result = await h.relay.messageSending({ content: corrupted }, h.ctx);
      const sent = result?.content ?? corrupted;
      // Every Latin run that survives is a declared proper noun.
      for (const token of sent.split(/\s+/u)) {
        if (/[A-Za-z]/u.test(token) && /[฀-๿]/u.test(sent)) {
          expect(
            ALLOWED.some((term) => token.toLowerCase().includes(term.toLowerCase())) ||
              /\d/u.test(token),
          ).toBe(true);
        }
      }
    }
  });
});

describe("clean and unrelated replies are passed through untouched", () => {
  it("does not touch a clean Thai reply", async () => {
    const h = relay();

    expect(
      await h.relay.messageSending({ content: "สร้าง Storyboard เรียบร้อยแล้ว 6 ฉาก" }, h.ctx),
    ).toBeUndefined();
  });

  it("does not touch the product's own Thai copy carrying Latin nouns", async () => {
    const h = relay();

    for (const shipped of [
      "ทำวิดีโอจาก Storyboard นี้",
      "draft นี้ถูกแทนที่แล้ว กรุณาใช้รหัส VIDEO ล่าสุด",
      "ใช้ Default Model หรือเปลี่ยน Model?",
      "ส่วนนี้ต้องใช้ Character Library ก่อน",
      "กำลังส่งเข้า LINE",
    ]) {
      expect(await h.relay.messageSending({ content: shipped }, h.ctx)).toBeUndefined();
    }
  });

  it("does not touch a non-LINE channel", async () => {
    const h = relay();

    expect(
      await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, { ...h.ctx, channelId: "slack" }),
    ).toBeUndefined();
  });

  it("does not touch a conversation that owns no storyboard", async () => {
    const h = relay({ storyboard: false });

    // With nothing structured to rebuild from, contaminated text still must not
    // be silently mangled: it falls back to safe deterministic Thai.
    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(result?.content).toBe(STORYBOARD_SAFE_THAI_FALLBACK);
  });

  it("does not judge an English reply", async () => {
    const h = relay();

    expect(
      await h.relay.messageSending({ content: "Storyboard updated with 6 shots" }, h.ctx),
    ).toBeUndefined();
  });
});

describe("paid video confirmation is never rewritten", () => {
  it("passes a VIDEO code through even when the surrounding text is contaminated", () => {
    const decision = guardThaiOutboundText({
      text: "ยืนยัน VIDEO 4821 เพื่อสร้างวิดีโอ forest",
      allowedTerms: ALLOWED,
      rebuild: () => SUMMARY,
    });

    // Replacing this message would drop the owner's only authorisation code.
    expect(decision.kind).toBe("skipped_paid_confirmation");
  });

  it("leaves the confirmation text byte-identical on the wire", async () => {
    const h = relay();
    const confirmation = "ยืนยัน VIDEO 4821 เพื่อสร้างวิดีโอ forest";

    expect(await h.relay.messageSending({ content: confirmation }, h.ctx)).toBeUndefined();
  });
});

describe("the fallback is used only when a rebuild cannot be trusted", () => {
  it("falls back when there is no structured summary", () => {
    const decision = guardThaiOutboundText({ text: "ไม่มีตัวอักษรp", allowedTerms: ALLOWED });

    expect(decision).toMatchObject({ kind: "fallback", text: STORYBOARD_SAFE_THAI_FALLBACK });
  });

  it("falls back when the rebuild itself would be contaminated", () => {
    const decision = guardThaiOutboundText({
      text: "ไม่มีตัวอักษรp",
      allowedTerms: ALLOWED,
      rebuild: () => "สรุป zzz ฉาก",
    });

    expect(decision).toMatchObject({ kind: "fallback" });
  });

  it("reports every repair so the paraphrase is visible in logs", async () => {
    const h = relay();

    await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(h.logger.warn).toHaveBeenCalledWith(
      "storyboard_outbound_language_repaired",
      expect.objectContaining({ outcome: "rebuilt", conversationId: "C1234567890abcdef" }),
    );
  });

  it("resolves the storyboard only after the cheap gates, never for other channels", async () => {
    const h = relay();

    await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, { ...h.ctx, channelId: "slack" });
    await h.relay.messageSending({ content: "" }, h.ctx);

    expect(h.resolve).not.toHaveBeenCalled();
  });
});

describe("the visual delivery is unaffected by the language gate", () => {
  it("passes six shot images and one sheet through untouched", async () => {
    const h = relay();
    // Image sends carry no text body; the gate must not invent one or cancel
    // the send. Six shots plus the contact sheet is the normal delivery shape.
    for (let shotIndex = 1; shotIndex <= 6; shotIndex += 1) {
      expect(await h.relay.messageSending({ content: "" }, h.ctx)).toBeUndefined();
    }
    expect(await h.relay.messageSending({ content: undefined }, h.ctx)).toBeUndefined();

    // And the clean Thai caption that accompanies them still goes out as written.
    expect(
      await h.relay.messageSending({ content: "Visual Storyboard v1 พร้อมแล้ว (6 ช็อต)" }, h.ctx),
    ).toBeUndefined();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("never cancels a send, only replaces text", async () => {
    const h = relay();

    const replaced = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(replaced).toMatchObject({ content: expect.any(String) });
    expect(replaced).not.toHaveProperty("cancel");
  });
});
