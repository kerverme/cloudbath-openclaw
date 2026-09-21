/**
 * Repair must not treat the reply's own numbers as things it cannot touch.
 *
 * Production, LINE: a long, useful Thai training plan reached the Control UI,
 * and LINE received the honest fallback with the plan's numbers dumped after it:
 *
 *   ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง
 *   1-2: 5-7 1-3: 70% 30% 2-4: 2-3 3-6: 100-300
 *
 * Repair asked the validator's `isTechnicalToken` whether a token was a
 * critical exact span. That predicate exists to decide what counts as prose for
 * the language expectation, where a bare `5` is deliberately not a word — so
 * every count, range and percentage in the reply answered yes. One contaminated
 * line could then neither be dropped (a segment holding `1-2` looked like it
 * held a confirmation code) nor survive, and the fallback trailed the numbers it
 * had "rescued".
 *
 * The fixtures below are synthetic, not the production text.
 */
import { describe, expect, it } from "vitest";
import type { TurnPresentationPolicy } from "./reply-language-policy.js";
import { finalizeReplyText } from "./reply-language-repair.js";

const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const THAI: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: FALLBACK,
};

/** Kannada and Cyrillic stand in for the contamination seen in production. */
const KANNADA_LINE = "ಪ್ರತಿದಿನ ಓಡಲು ಪ್ರಯತ್ನಿಸಿ ಮತ್ತು ವಿಶ್ರಾಂತಿ ಪಡೆಯಿರಿ";
const CYRILLIC_LINE = "Бегайте каждый день и не забывайте про отдых";

const PLAN_LINES = [
  "ถ้าอยากวิ่ง เพจ 5 ใน 6 เดือน ต้องวางแผนเป็นช่วง ๆ ครับ",
  "เดือน 1-2: วิ่งสบาย ๆ 5-7 กิโลเมตร สัปดาห์ละ 3-4 ครั้ง",
  "เดือน 1-3: แบ่งเป็น easy run 70% และ speed work 30%",
  "เดือน 2-4: วิ่งยาว 2-3 ครั้งต่อสัปดาห์",
  "เดือน 3-6: เพิ่มระยะเป็น 100-300 กิโลเมตรต่อเดือน",
] as const;

/** The plan's ordinary numbers, exactly as the production dump listed them. */
const ORDINARY_NUMBERS = ["1-2", "5-7", "1-3", "70%", "30%", "2-4", "2-3", "3-6", "100-300"];

function plan(contaminated?: string): string {
  const lines: string[] = [...PLAN_LINES];
  if (contaminated) {
    lines[1] = `${lines[1]} ${contaminated}`;
  }
  return lines.join("\n");
}

describe("a Thai answer that names products and counts is left alone", () => {
  it("keeps a long plan with English terms and numeric ranges", () => {
    const text = `${plan()}\nถ้าจะทำคอนเทนต์ด้วย ลอง Reels สั้น ๆ แล้วดู insights กับ engagement ครับ`;

    const result = finalizeReplyText({ text, policy: THAI });

    // Latin carries product and platform vocabulary inside Thai prose; it is
    // not a reason to repair anything.
    expect(result).toMatchObject({ text, outcome: "valid", repairKind: "none" });
  });

  it.each(["Reels", "niche", "insights", "engagement"])(
    "does not reject Thai prose containing %s",
    (term) => {
      const text = `ช่วงแรกให้โฟกัสที่ ${term} ก่อนครับ แล้วค่อยขยายทีหลัง`;

      expect(finalizeReplyText({ text, policy: THAI }).outcome).toBe("valid");
    },
  );
});

describe("one contaminated line is dropped and the answer survives", () => {
  it.each([
    ["Kannada", KANNADA_LINE],
    ["Cyrillic", CYRILLIC_LINE],
  ])("repairs a plan carrying a %s segment", (_script, contamination) => {
    const result = finalizeReplyText({ text: plan(contamination), policy: THAI });

    expect(result).toMatchObject({ outcome: "repaired", repairKind: "rewritten" });
    expect(result.text).not.toContain(contamination);
    // The surviving lines keep their own numbers, unchanged and unreflowed.
    expect(result.text).toBe([PLAN_LINES[0], ...PLAN_LINES.slice(2)].join("\n"));
    expect(result.validation.valid).toBe(true);
  });

  it("leaves no label behind promising content it dropped", () => {
    // `เดือน 1-2:` introduces the text that was removed. Keeping the label
    // alone is malformed Thai, not a repair.
    const result = finalizeReplyText({ text: plan(KANNADA_LINE), policy: THAI });

    expect(result.text.split("\n")).not.toContain("เดือน 1-2:");
  });

  it("prefers the repaired answer while most of the reply survives", () => {
    const result = finalizeReplyText({ text: plan(KANNADA_LINE), policy: THAI });

    expect(result.outcome).toBe("repaired");
    expect(result.text.length / plan(KANNADA_LINE).trim().length).toBeGreaterThan(0.5);
  });
});

describe("ordinary numbers are not exact spans", () => {
  it("does not append the reply's numbers to the fallback", () => {
    // Contamination on every line, so no safe rewrite remains and the fallback
    // is honest — but the fallback is the whole reply, not a number dump.
    const text = PLAN_LINES.map((line) => `${line} ${KANNADA_LINE}`).join("\n");

    const result = finalizeReplyText({ text, policy: THAI });

    expect(result).toMatchObject({ text: FALLBACK, repairKind: "fallback" });
  });

  it.each(ORDINARY_NUMBERS)("does not rescue %s into the fallback", (number) => {
    const text = `ตัวเลข ${number} ${KANNADA_LINE}`;

    expect(finalizeReplyText({ text, policy: THAI }).text).toBe(FALLBACK);
  });
});

describe("spans whose loss changes the operation still survive", () => {
  it.each([
    ["a video code", "รหัสยืนยัน VIDEO 4821", "VIDEO 4821"],
    ["a link", "ดูที่ https://example.com/a/b", "https://example.com/a/b"],
    ["an action id", "อ้างอิง order_9f2a-77", "order_9f2a-77"],
    ["a confirmation id", "ยืนยันด้วย CONF-9F2A77K3", "CONF-9F2A77K3"],
  ])("carries %s into the fallback", (_label, line, span) => {
    const text = `${line} ${KANNADA_LINE}\n${KANNADA_LINE}`;

    const result = finalizeReplyText({ text, policy: THAI });

    expect(result).toMatchObject({ text: `${FALLBACK}\n${span}`, repairKind: "fallback" });
  });

  it("refuses to drop a segment that is carrying one", () => {
    // Removing the line would leave a reply that looks complete and is missing
    // the code the user needs, so the honest fallback wins instead.
    const text = `${PLAN_LINES[0]}\nรหัสยืนยัน VIDEO 4821 ${KANNADA_LINE}`;

    expect(finalizeReplyText({ text, policy: THAI })).toMatchObject({
      text: `${FALLBACK}\nVIDEO 4821`,
      repairKind: "fallback",
    });
  });
});
