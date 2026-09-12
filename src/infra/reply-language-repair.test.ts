/**
 * One authoritative final text per turn.
 *
 * These pin the repair hierarchy (regenerate, then drop whole violating
 * segments, then an honest fallback), that repair never strips characters or
 * silently drops an exact span such as a confirmation code, and that every
 * surface reading the memo for one run gets byte-identical text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { TurnPresentationPolicy } from "./reply-language-policy.js";
import {
  finalizeReplyText,
  resetAuthoritativeReplyTextForTest,
  resolveAuthoritativeReplyText,
} from "./reply-language-repair.js";

const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const THAI: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: FALLBACK,
};

beforeEach(() => {
  resetAuthoritativeReplyTextForTest();
});

describe("nothing configured changes nothing", () => {
  it("returns the text untouched and says it was unchecked", () => {
    const result = finalizeReplyText({ text: "Привет", policy: undefined });

    expect(result).toMatchObject({ text: "Привет", outcome: "unchecked", repairKind: "none" });
  });

  it("leaves an intentionally multilingual turn alone", () => {
    const result = finalizeReplyText({
      text: 'แปลว่า "Привет" ครับ',
      policy: { ...THAI, allowIntentionalMultilingual: true },
    });

    expect(result).toMatchObject({ text: 'แปลว่า "Привет" ครับ', outcome: "unchecked" });
  });
});

describe("valid text is returned as-is", () => {
  it("does not touch a clean Thai reply that names products and links", () => {
    const text = "ส่งให้ทาง LINE แล้วครับ ดูได้ที่ https://example.com/a";
    const result = finalizeReplyText({ text, policy: THAI });

    expect(result).toMatchObject({ text, outcome: "valid", repairKind: "none" });
  });
});

describe("structured regeneration wins", () => {
  it("prefers a deterministic rebuild over any rewrite", () => {
    const result = finalizeReplyText({
      text: "สรุปคิวงานครับ\nฉากที่ 1 ใช่ไಮೈ",
      policy: THAI,
      regenerate: () => "สรุปคิวงานครับ ฉากที่ 1 พร้อมแล้ว",
    });

    expect(result).toMatchObject({
      text: "สรุปคิวงานครับ ฉากที่ 1 พร้อมแล้ว",
      outcome: "repaired",
      repairKind: "regenerated",
    });
  });

  it("ignores a rebuild that is itself invalid", () => {
    const result = finalizeReplyText({
      text: "Привет",
      policy: THAI,
      regenerate: () => "Привет снова",
    });

    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });
});

describe("the rewrite drops whole segments or refuses", () => {
  it("keeps the clean lines of a multi-line reply", () => {
    const result = finalizeReplyText({
      text: "เรียบร้อยแล้วครับ ทั้งหมดหกฉาก\nรอสักครู่นะครับ\nใช่ไಮೈ",
      policy: THAI,
    });

    expect(result).toMatchObject({ outcome: "repaired", repairKind: "rewritten" });
    expect(result.text).toBe("เรียบร้อยแล้วครับ ทั้งหมดหกฉาก รอสักครู่นะครับ");
    expect(result.validation.valid).toBe(true);
  });

  it("never strips characters out of a word", () => {
    // The old guard produced `ไม่มีตัวอักษร` by deleting the stray `p`. A word
    // is kept whole or its segment goes; half-words are not a repair.
    const result = finalizeReplyText({ text: "ไม่มีตัวอักษรp ในรูปนี้ครับ", policy: THAI });

    expect(result.text).not.toContain("ไม่มีตัวอักษร ");
    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });

  it("refuses to drop a segment that carries a confirmation code", () => {
    // Losing the code silently would leave a reply that looks complete and is not.
    const result = finalizeReplyText({
      text: "เรียบร้อยแล้วครับ ทุกอย่างพร้อม\nรหัสยืนยัน VIDEO 4821 ใช่ไಮೈ",
      policy: THAI,
    });

    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });

  it("refuses to drop a segment that carries a link", () => {
    const result = finalizeReplyText({
      text: "เรียบร้อยแล้วครับ ทุกอย่างพร้อม\nดูที่ https://example.com/x ใช่ไಮೈ",
      policy: THAI,
    });

    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });

  it("falls back rather than keep a fragment of the answer", () => {
    const result = finalizeReplyText({
      text: "ครับ\nเรื่องนี้ต้องอธิบายยาวหน่อยนะครับ ใช่ไಮೈ อันนี้สำคัญมาก",
      policy: THAI,
    });

    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });
});

describe("with no wording to fall back on, nothing is claimed", () => {
  it("returns the original text and reports it unrepaired", () => {
    const result = finalizeReplyText({
      text: "Привет",
      policy: { expectedReplyLanguage: "th", expectedReplyLanguageSource: "account" },
    });

    expect(result).toMatchObject({ text: "Привет", outcome: "unrepaired", repairKind: "none" });
  });
});

describe("every surface reads one decision", () => {
  it("returns byte-identical text for the same run and source", () => {
    const text = "เข้าใจครับ ใช่ไಮೈ";
    const first = resolveAuthoritativeReplyText({ runId: "run-1", text, policy: THAI });
    const second = resolveAuthoritativeReplyText({ runId: "run-1", text, policy: THAI });

    expect(second.text).toBe(first.text);
    expect(second).toBe(first);
  });

  it("does not hand a decision about one text to a surface holding another", () => {
    resolveAuthoritativeReplyText({ runId: "run-1", text: "เข้าใจครับ ใช่ไಮೈ", policy: THAI });
    const other = resolveAuthoritativeReplyText({
      runId: "run-1",
      text: "เรียบร้อยครับ",
      policy: THAI,
    });

    expect(other).toMatchObject({ text: "เรียบร้อยครับ", outcome: "valid" });
  });

  it("is deterministic without a run id, so unkeyed surfaces still converge", () => {
    const text = "เรียบร้อยแล้วครับ ทั้งหมดหกฉาก\nใช่ไಮೈ";
    const a = resolveAuthoritativeReplyText({ runId: undefined, text, policy: THAI });
    const b = resolveAuthoritativeReplyText({ runId: undefined, text, policy: THAI });

    expect(b.text).toBe(a.text);
  });
});
