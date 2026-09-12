/**
 * The generic script validator.
 *
 * The cases here are the production ones: a reply wholly in the wrong language
 * passed the old guard because the old guard inferred the expectation from the
 * output. These pin that the expectation is data, that legitimate Latin product
 * names and links survive, and that Thai's combining marks are not mistaken for
 * foreign script.
 */
import { describe, expect, it } from "vitest";
import {
  createReplyLanguageScanner,
  expectedScriptsFor,
  validateReplyLanguage,
  type TurnPresentationPolicy,
} from "./reply-language-policy.js";

const THAI: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
};

describe("no expectation means no judgement", () => {
  it("passes anything when no language is configured", () => {
    const result = validateReplyLanguage("Привет мир", undefined);

    expect(result).toMatchObject({ valid: true, reason: "no_expectation" });
  });

  it("passes anything when the configured subtag maps to no script", () => {
    expect(expectedScriptsFor("zz")).toBeUndefined();
    expect(validateReplyLanguage("Привет", { expectedReplyLanguage: "zz" })).toMatchObject({
      valid: true,
      reason: "no_expectation",
    });
  });
});

describe("a wholly foreign reply fails", () => {
  it("fails a reply written entirely in Russian when Thai is expected", () => {
    const result = validateReplyLanguage("Привет, я могу помочь вам с этим.", THAI);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("foreign_script");
    expect(result.detectedScripts).toEqual(["Cyrillic"]);
    expect(result.violatingScripts).toEqual(["Cyrillic"]);
  });

  it("fails a reply written entirely in English when Thai is expected", () => {
    // Latin is auxiliary inside Thai prose, never a substitute for it.
    const result = validateReplyLanguage("Sure, I can help you with that.", THAI);

    expect(result).toMatchObject({ valid: false, reason: "expected_script_absent" });
  });

  it("fails Thai when the expectation is English", () => {
    // Symmetric: Thai is not auxiliary inside English, so the word rule fires first.
    const result = validateReplyLanguage("สวัสดีครับ", { expectedReplyLanguage: "en" });

    expect(result).toMatchObject({ valid: false, reason: "foreign_script" });
  });
});

describe("mixed-script contamination fails", () => {
  it("fails the observed Kannada fragment inside a Thai word", () => {
    const result = validateReplyLanguage('เข้าใจครับ — "จัดไว้ อันนี้" ใช่ไಮೈ? 🐱', THAI);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("foreign_script");
    expect(result.violatingScripts).toEqual(["Kannada"]);
    expect(result.violatingTokens).toEqual(["ใช่ไಮೈ?"]);
  });

  it("fails a stray Latin letter fused onto a Thai word", () => {
    const result = validateReplyLanguage("ไม่มีตัวอักษรp ในรูปนี้ครับ", THAI);

    expect(result).toMatchObject({ valid: false, reason: "foreign_script" });
    expect(result.violatingTokens).toEqual(["ไม่มีตัวอักษรp"]);
  });

  it("fails a whole Cyrillic word among Thai", () => {
    const result = validateReplyLanguage("ผมจัดให้แล้วครับ Привет นะครับ", THAI);

    expect(result.violatingScripts).toEqual(["Cyrillic"]);
    expect(result.valid).toBe(false);
  });
});

describe("legitimate Thai replies pass", () => {
  it("allows Latin product names, a model ref and a link", () => {
    const result = validateReplyLanguage(
      "ส่งให้ทาง LINE แล้วครับ ใช้ GPT รุ่น gpt-5.6-luna ดูได้ที่ https://example.com/a?b=1",
      THAI,
    );

    expect(result).toMatchObject({ valid: true, reason: "ok" });
    expect(result.detectedScripts).toEqual(["Latin", "Thai"]);
  });

  it("does not flag Thai combining marks, punctuation or emoji", () => {
    // Thai vowel signs and tone marks carry Script=Thai; emoji and dashes are Common.
    const result = validateReplyLanguage("เรียบร้อยครับ — ดูได้เลย 🙏 (ชุดที่ 2)", THAI);

    expect(result).toMatchObject({ valid: true, detectedScripts: ["Thai"] });
  });

  it("does not fail text that carries no letters at all", () => {
    expect(validateReplyLanguage("https://example.com/x 🙏 2/3", THAI)).toMatchObject({
      valid: true,
    });
  });

  it("keeps a confirmation code intact and valid", () => {
    expect(validateReplyLanguage("ยืนยันแล้วครับ VIDEO 4821", THAI)).toMatchObject({ valid: true });
  });
});

describe("policy data, not core knowledge", () => {
  it("allows a proper noun in another script when the policy lists it", () => {
    const withTerm: TurnPresentationPolicy = { ...THAI, allowedTerms: ["ライン"] };

    expect(validateReplyLanguage("ส่งทาง ライン แล้วครับ", THAI).valid).toBe(false);
    expect(validateReplyLanguage("ส่งทาง ライン แล้วครับ", withTerm).valid).toBe(true);
  });

  it("allows an intentionally multilingual turn", () => {
    const multilingual: TurnPresentationPolicy = { ...THAI, allowIntentionalMultilingual: true };

    expect(validateReplyLanguage('แปลว่า "Привет" ครับ', THAI).valid).toBe(false);
    expect(validateReplyLanguage('แปลว่า "Привет" ครับ', multilingual)).toMatchObject({
      valid: true,
      reason: "multilingual_allowed",
    });
  });

  it("knows scripts for other expectations without special-casing Thai", () => {
    expect(
      validateReplyLanguage("こんにちは、承知しました。", { expectedReplyLanguage: "ja" }),
    ).toMatchObject({
      valid: true,
    });
    expect(validateReplyLanguage("Привет", { expectedReplyLanguage: "ru" })).toMatchObject({
      valid: true,
    });
  });
});

describe("the incremental scanner matches a full scan", () => {
  const chunksOf = (text: string, size: number): string[] => {
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += size) {
      chunks.push(text.slice(index, index + size));
    }
    return chunks;
  };

  const cumulative = (text: string, size: number): string[] => {
    let seen = "";
    return chunksOf(text, size).map((chunk) => {
      seen += chunk;
      return seen;
    });
  };

  it("finds the same contamination as a full scan, at every prefix and chunk size", () => {
    const text = "เข้าใจครับ ส่งทาง LINE แล้ว ใช่ไಮೈ? 🐱";
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const scanner = createReplyLanguageScanner(THAI);
      for (const prefix of cumulative(text, size)) {
        const streamed = scanner.push(prefix);
        const whole = validateReplyLanguage(prefix, THAI);

        expect(streamed.violatingTokens.length > 0, `size=${size} prefix=${prefix.length}`).toBe(
          whole.violatingTokens.length > 0,
        );
      }
    }
  });

  it("waits before judging a missing script, because a Thai reply may open in Latin", () => {
    const scanner = createReplyLanguageScanner(THAI);

    // A complete text this short is already wrong; a growing one is not yet.
    expect(validateReplyLanguage("LINE", THAI).reason).toBe("expected_script_absent");
    expect(scanner.push("LINE").valid).toBe(true);
    expect(scanner.push("LINE ส่งแล้วครับ").valid).toBe(true);
  });

  it("catches a non-Latin foreign stream on its first word", () => {
    const scanner = createReplyLanguageScanner(THAI);

    expect(scanner.push("Привет ")).toMatchObject({ valid: false, reason: "foreign_script" });
  });

  it("catches a Latin-prose stream once it is clearly not a slow start", () => {
    const scanner = createReplyLanguageScanner(THAI);
    let seen = "";
    const results = "Sure I can help you".split(" ").map((word) => {
      seen += seen ? ` ${word}` : word;
      return scanner.push(seen);
    });

    expect(results[0]).toMatchObject({ valid: true });
    expect(results.at(-1)).toMatchObject({ valid: false, reason: "expected_script_absent" });
  });

  it("does not false-positive when a multi-byte character is split across chunks", () => {
    // Surrogate pairs and Thai clusters must never be judged half-arrived.
    const scanner = createReplyLanguageScanner(THAI);
    const text = "เรียบร้อยครับ 🙏 ดูได้เลย";
    for (const prefix of cumulative(text, 1)) {
      expect(scanner.push(prefix).valid).toBe(true);
    }
  });

  it("rescans in full when the buffer is rewritten rather than appended to", () => {
    const scanner = createReplyLanguageScanner(THAI);

    expect(scanner.push("เข้าใจครับ ").valid).toBe(true);
    expect(scanner.push("ทั้งหมดนี้ Привет ครับ").valid).toBe(false);
    expect(scanner.push("เรียบร้อยครับ ").valid).toBe(true);
  });

  it("stays inert when the policy states no expectation", () => {
    const scanner = createReplyLanguageScanner(undefined);

    expect(scanner.push("Привет").reason).toBe("no_expectation");
  });
});
