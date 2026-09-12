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
import { guardLineOutboundText, LINE_SAFE_THAI_FALLBACK } from "./line-language.js";
import { createLineOutboundRelay } from "./line-outbound-relay.js";
import {
  isStoryboardSummaryText,
  storyboardAllowedTerms,
  thaiSummaryForVersion,
} from "./storyboard-language.js";

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
    relay: createLineOutboundRelay({ resolve, isRebuildTarget: isStoryboardSummaryText, logger }),
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

    expect(result?.payload.text).toBe(LINE_SAFE_THAI_FALLBACK);
    expect(result?.payload.text).not.toContain("ไม่มีตัวอักษรp");
  });

  it("replaces it on the durable/message-tool path too", async () => {
    const h = relay();

    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(result?.content).toBe(LINE_SAFE_THAI_FALLBACK);
  });

  it("never character-strips into grammatical Thai that says something else", async () => {
    const h = relay();

    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    // Stripping the stray "p" would leave "ไม่มีตัวอักษร" — grammatical Thai
    // that still tells the owner nothing true about their storyboard.
    expect(result?.content).not.toBe("ไม่มีตัวอักษร");
    expect(result?.content).not.toContain("ไม่มีตัวอักษร");
  });

  it("does not answer an arbitrary broken message with the shot list", async () => {
    // A rebuild is faithful only for the operation it describes. This message is
    // not the summary, so the conversation owning a storyboard does not make a
    // shot list the right answer to it.
    const h = relay();

    const result = await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(result?.content).not.toContain("ฉาก 1");
    expect(result?.content).not.toBe(SUMMARY);
  });

  it("leaves no foreign script in the text LINE finally sends", async () => {
    const h = relay();

    for (const corrupted of [
      "ไม่มีตัวอักษรp",
      "สร้าง storyboardเรียบร้อย แล้ว",
      "เสร็จแล้วครับ привет",
      "ฉากทั้งหมด 6 ฉาก ใช่ไಮೈ ครับ",
      "เรียบร้อยครับ नमस्ते",
    ]) {
      const result = await h.relay.messageSending({ content: corrupted }, h.ctx);
      const sent = result?.content ?? corrupted;

      // Cyrillic, Kannada, Devanagari and CJK never survive into Thai copy.
      expect(
        /[\p{Script=Cyrillic}\p{Script=Kannada}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hangul}]/u.test(
          sent,
        ),
        sent,
      ).toBe(false);
      // Thai must not be glued to Latin inside one word.
      for (const token of sent.split(/\s+/u)) {
        expect(/\p{Script=Thai}/u.test(token) && /\p{Script=Latin}/u.test(token), token).toBe(
          false,
        );
      }
    }
  });

  it("accepts a Latin word inside Thai copy rather than demanding an allowlist entry", async () => {
    // Thai prose carries proper nouns, product names and model refs in Latin by
    // convention. Treating every unlisted English word as contamination rejected
    // correct replies, and caught nothing the intra-word rule does not.
    const h = relay();

    for (const clean of [
      "ส่งให้ทาง LINE แล้วครับ",
      "ใช้ GPT รุ่น gpt-5.6-luna ครับ",
      "ดูได้ที่ https://example.com/a?b=1 ครับ",
      "เปิดใน Railway ให้แล้วครับ",
    ]) {
      expect(await h.relay.messageSending({ content: clean }, h.ctx), clean).toBeUndefined();
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

    expect(result?.content).toBe(LINE_SAFE_THAI_FALLBACK);
  });

  it("does not overrule an English reply from here", async () => {
    // Whether a wholly non-Thai reply is wrong depends on the turn — the user may
    // have asked for English — so that rule lives on the agent run where the
    // multilingual override is known, not in this outbound hook.
    const h = relay();

    expect(
      await h.relay.messageSending({ content: "Storyboard updated with 6 shots" }, h.ctx),
    ).toBeUndefined();
  });
});

describe("paid video confirmation is never rewritten", () => {
  it("passes a VIDEO code through even when the surrounding text is contaminated", () => {
    const decision = guardLineOutboundText({
      text: "ยืนยัน VIDEO 4821 เพื่อสร้างวิดีโอ ใช่ไಮೈ",
      allowedTerms: ALLOWED,
      rebuild: () => SUMMARY,
    });

    // Replacing this message would drop the owner's only authorisation code.
    expect(decision.kind).toBe("skipped_exact");
  });

  it("leaves the confirmation text byte-identical on the wire", async () => {
    const h = relay();
    const confirmation = "ยืนยัน VIDEO 4821 เพื่อสร้างวิดีโอ ใช่ไಮೈ";

    expect(await h.relay.messageSending({ content: confirmation }, h.ctx)).toBeUndefined();
  });
});

describe("the fallback is used only when a rebuild cannot be trusted", () => {
  it("falls back when there is no structured summary", () => {
    const decision = guardLineOutboundText({ text: "ไม่มีตัวอักษรp", allowedTerms: ALLOWED });

    expect(decision).toMatchObject({ kind: "fallback", text: LINE_SAFE_THAI_FALLBACK });
  });

  it("falls back when the rebuild itself would be contaminated", () => {
    const decision = guardLineOutboundText({
      text: "ไม่มีตัวอักษรp",
      allowedTerms: ALLOWED,
      rebuild: () => "สรุป привет ฉาก",
    });

    expect(decision).toMatchObject({ kind: "fallback" });
  });

  it("reports every repair so the paraphrase is visible in logs", async () => {
    const h = relay();

    await h.relay.messageSending({ content: "ไม่มีตัวอักษรp" }, h.ctx);

    expect(h.logger.warn).toHaveBeenCalledWith(
      "line_outbound_language_repaired",
      expect.objectContaining({ outcome: "fallback", conversationId: "C1234567890abcdef" }),
    );
  });

  it("rebuilds when the broken message IS the summary's own text", async () => {
    // The faithful case for a rebuild: the text carries the summary's own scene
    // headers, so regenerating it from the document says the same thing again.
    const h = relay();

    const result = await h.relay.messageSending(
      { content: "ฉาก 1 · 0-1 วิ · แอ็กชัน ใช่ไಮೈ\nฉากที่ 1" },
      h.ctx,
    );

    expect(result?.content).toBe(SUMMARY);
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

describe("the guard protects ordinary LINE chat, not only storyboard replies", () => {
  /** A group with no storyboard at all — the ordinary conversational case. */
  const chat = () => relay({ storyboard: false });

  it("repairs Cyrillic contamination in a generic Thai reply", async () => {
    const h = chat();

    const result = await h.relay.messageSending(
      { content: "แมวเป็นสัตว์เลี้ยงที่น่ารักครับ. привет และชอบนอนกลางวัน." },
      h.ctx,
    );

    expect(result?.content).not.toContain("привет");
    expect(result?.content).toContain("แมวเป็นสัตว์เลี้ยงที่น่ารักครับ.");
  });

  it("keeps the clean sentences rather than stripping the bad word out of one", async () => {
    const h = chat();

    const result = await h.relay.messageSending(
      { content: "วันนี้อากาศดีครับ. ผมกำลังทำงาน привет อยู่. พรุ่งนี้ค่อยคุยกันนะครับ." },
      h.ctx,
    );

    // The contaminated sentence goes whole; the others survive verbatim.
    expect(result?.content).toBe("วันนี้อากาศดีครับ. พรุ่งนี้ค่อยคุยกันนะครับ.");
    expect(result?.content).not.toContain("ผมกำลังทำงาน อยู่");
  });

  it("falls back to generic Thai, never to storyboard wording, for a chat turn", async () => {
    const h = chat();

    // A single contaminated sentence has nothing clean to keep.
    const result = await h.relay.messageSending({ content: "แมวลูกพี่ ใช่ไಮೈ" }, h.ctx);

    expect(result?.content).toBe(LINE_SAFE_THAI_FALLBACK);
    expect(result?.content).not.toContain("Storyboard");
  });

  it("leaves a clean Thai chat reply untouched", async () => {
    const h = chat();

    for (const clean of [
      "แมวเป็นสัตว์เลี้ยงที่น่ารักครับ",
      "อยากให้ผมจดอะไรไว้ครับ",
      "หมายถึงโดเมนไหนครับ",
      "เล่าเรื่องที่อยากทำเป็น Storyboard ให้ฟังหน่อยครับ",
    ]) {
      expect(await h.relay.messageSending({ content: clean }, h.ctx)).toBeUndefined();
    }
  });

  it("leaves legitimate product and model names Latin", async () => {
    const h = chat();

    for (const clean of [
      "ส่งผ่าน LINE แล้วครับ",
      "ตอนนี้ใช้ GPT อยู่ครับ",
      "โมเดลปัจจุบันคือ gpt-5.6-luna ครับ",
      "เปลี่ยนเป็น sonnet-4.6 ให้แล้วครับ",
    ]) {
      expect(await h.relay.messageSending({ content: clean }, h.ctx)).toBeUndefined();
    }
  });

  it("leaves URLs byte-identical inside Thai prose", async () => {
    const h = chat();

    for (const clean of [
      "ดูได้ที่ https://docs.openclaw.ai/plugins/codex-harness ครับ",
      "เปิดลิงก์นี้ครับ http://example.com/a/b?c=1",
      "เว็บไซต์ www.example.com ครับ",
    ]) {
      expect(await h.relay.messageSending({ content: clean }, h.ctx)).toBeUndefined();
    }
  });

  it("keeps a URL even when the same message needs repair elsewhere", async () => {
    const h = chat();

    const result = await h.relay.messageSending(
      {
        content: "ลิงก์อยู่ที่ https://example.com/x ครับ. ส่วนนี้พร้อมแล้วครับ. ส่วนนี้ ใช่ไಮೈ เสียครับ.",
      },
      h.ctx,
    );

    // The repaired message still carries the link exactly as written.
    expect(result?.content).toContain("https://example.com/x");
    expect(result?.content).not.toContain("ಮ");
  });

  it("never rewrites a paid VIDEO confirmation, storyboard or not", async () => {
    const h = chat();
    const confirmation = "ยืนยัน VIDEO 4821 เพื่อสร้างวิดีโอ ใช่ไಮೈ";

    expect(await h.relay.messageSending({ content: confirmation }, h.ctx)).toBeUndefined();
  });
});

describe("repair order is most faithful first", () => {
  it("prefers a structured rebuild over dropping sentences", () => {
    const decision = guardLineOutboundText({
      text: "ฉากแรกสวยครับ. แต่ ใช่ไಮೈ พังครับ.",
      allowedTerms: ALLOWED,
      rebuild: () => SUMMARY,
    });

    expect(decision).toMatchObject({ kind: "rebuilt", text: SUMMARY });
  });

  it("drops sentences only when no structured rebuild exists", () => {
    const decision = guardLineOutboundText({
      text: "ฉากแรกสวยครับ. แต่อันนี้ดีครับ. แต่ ใช่ไಮೈ พังครับ.",
      allowedTerms: ALLOWED,
    });

    expect(decision).toMatchObject({
      kind: "rewritten",
      text: "ฉากแรกสวยครับ. แต่อันนี้ดีครับ.",
    });
  });

  it("reports the rewrite outcome so the corruption stays visible in logs", async () => {
    const h = relay({ storyboard: false });

    await h.relay.messageSending({ content: "ดีครับ. ทุกอย่างพร้อมครับ. ใช่ไಮೈ ครับ." }, h.ctx);

    expect(h.logger.warn).toHaveBeenCalledWith(
      "line_outbound_language_repaired",
      expect.objectContaining({ outcome: "rewritten" }),
    );
  });
});

describe("an active storyboard does not leak into an unrelated chat turn", () => {
  /** The storyboard conversation, but the turn is ordinary chat about something else. */
  const generic = () => relay();

  it("keeps a clean generic reply untouched even with a storyboard in the conversation", async () => {
    const h = generic();

    for (const clean of [
      "แมวชอบนอนกลางวันครับ",
      "วันนี้อากาศดีครับ พรุ่งนี้ค่อยคุยกันนะครับ",
      "ส่งผ่าน LINE ได้เลยครับ",
    ]) {
      expect(await h.relay.messageSending({ content: clean }, h.ctx), clean).toBeUndefined();
    }
    // A clean reply must not even read the storyboard store.
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("does not substitute the storyboard summary into a contaminated chat turn", async () => {
    // The rebuild is only faithful for the operation it describes. Answering
    // "do cats nap?" with a six-scene storyboard summary would be a confident
    // non-answer, which is worse than saying the reply failed.
    const h = generic();

    const result = await h.relay.messageSending({ content: "แมวลูกพี่ ใช่ไಮೈ" }, h.ctx);

    expect(result?.content).toBe(LINE_SAFE_THAI_FALLBACK);
    expect(result?.content).not.toContain("ฉาก 1");
    expect(result?.content).not.toContain("Storyboard");
    expect(result?.content).not.toBe(SUMMARY);
  });

  it("still prefers the rebuild when the turn IS the storyboard summary", async () => {
    // Same conversation, same store: the difference is that this text is the
    // summary's own operation, so regenerating it is faithful.
    const decision = guardLineOutboundText({
      text: "ฉาก 1 · 0-1 วิ · แอ็กชัน ใช่ไಮೈ",
      allowedTerms: ALLOWED,
      rebuild: () => SUMMARY,
    });

    expect(decision).toMatchObject({ kind: "rebuilt", text: SUMMARY });
  });
});

describe("the guard is pure text work", () => {
  it("makes no network or provider call", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const h = relay();
      await h.relay.messageSending({ content: "แมวลูกพี่ ใช่ไಮೈ" }, h.ctx);
      await h.relay.replyPayloadSending(
        { payload: { text: "ไม่มีตัวอักษรp" }, channel: "line" },
        h.ctx,
      );
      guardLineOutboundText({ text: "เรียบร้อยครับ привет", allowedTerms: ALLOWED });
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
