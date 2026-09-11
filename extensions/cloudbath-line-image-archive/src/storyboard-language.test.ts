/**
 * Script-consistency validation for Thai storyboard output.
 *
 * The production defect was Thai prose carrying stray Latin and other-script
 * fragments. These tests pin the GENERAL rule rather than any observed phrase:
 * a foreign-script run inside Thai is contamination unless the storyboard
 * itself declares it (a cast name) or it reads as a technical identifier.
 */
import { describe, expect, it } from "vitest";
import {
  buildThaiStoryboardSummary,
  repairThaiFragment,
  stripForeignFragments,
  validateThaiText,
} from "./storyboard-language.js";

describe("Thai output rejects accidental mixed-script contamination", () => {
  it("accepts ordinary Thai with numerals and punctuation", () => {
    expect(validateThaiText("ฉาก 1 นักดาบเดินเข้าป่าคริสตัล 3 วินาที")).toEqual({ kind: "clean" });
  });

  it("flags an arbitrary Latin word dropped inside a Thai sentence", () => {
    const result = validateThaiText("นักดาบเดินเข้าป่า forest แล้วหยุด");

    expect(result.kind).toBe("contaminated");
    expect(result.kind === "contaminated" && result.fragments).toContain("forest");
  });

  it("flags other scripts, not just Latin", () => {
    for (const contaminated of ["นักดาบเดินเข้าป่า привет", "นักดาบเดินเข้าป่า 森林", "นักดาบเดินเข้าป่า 숲"]) {
      expect(validateThaiText(contaminated).kind).toBe("contaminated");
    }
  });

  it("is not a phrase list: an unseen fragment is caught the same way", () => {
    // Nothing about this word is known to the implementation.
    const result = validateThaiText("นักดาบเดินเข้าป่า zyzzyva แล้วหยุด");

    expect(result.kind).toBe("contaminated");
  });
});

describe("legitimate proper nouns and model names stay valid", () => {
  it("keeps a cast display name the storyboard itself declares", () => {
    expect(validateThaiText("Manju เดินเข้าป่าคริสตัล", { allowedTerms: ["Manju"] })).toEqual({
      kind: "clean",
    });
  });

  it("keeps technical product and model identifiers", () => {
    for (const text of [
      "เรนเดอร์ด้วย gpt-5.6-luna แล้วส่งกลับ",
      "ส่งภาพเข้า R2 เรียบร้อย",
      "ใช้โมเดล sonnet-4.6 สำหรับฉากนี้",
      "ส่งผ่าน LINE แล้ว",
    ]) {
      expect(validateThaiText(text)).toEqual({ kind: "clean" });
    }
  });

  it("does not judge text that is not Thai at all", () => {
    expect(validateThaiText("gpt-5.6-luna")).toEqual({ kind: "clean" });
    expect(validateThaiText("A wide establishing shot")).toEqual({ kind: "clean" });
  });
});

describe("repair keeps meaning and never transliterates", () => {
  it("removes the foreign fragment and leaves the Thai sentence intact", () => {
    const repaired = repairThaiFragment("นักดาบเดินเข้าป่า forest แล้วหยุด");

    expect(repaired).toBe("นักดาบเดินเข้าป่า แล้วหยุด");
    expect(validateThaiText(repaired)).toEqual({ kind: "clean" });
  });

  it("keeps Thai as Thai rather than romanising it", () => {
    const repaired = repairThaiFragment("นักดาบ walker เดินเข้าป่า");

    expect(repaired).toContain("นักดาบ");
    expect(repaired).not.toMatch(/nak|dab|walker/iu);
  });

  it("preserves declared cast names while stripping the rest", () => {
    expect(stripForeignFragments("Manju เดินเข้าป่า forest", { allowedTerms: ["Manju"] })).toBe(
      "Manju เดินเข้าป่า",
    );
  });

  it("leaves clean text byte-identical", () => {
    const clean = "นักดาบเดินเข้าป่าคริสตัล";

    expect(repairThaiFragment(clean)).toBe(clean);
  });
});

describe("the owner-facing summary is built from structured fields", () => {
  const beats = [
    {
      shotIndex: 1,
      startSeconds: 0,
      endSeconds: 2,
      kind: "establishing" as const,
      action: "นักดาบเดินเข้าป่าคริสตัล",
      characterNames: ["Manju"],
    },
    {
      shotIndex: 2,
      startSeconds: 2,
      endSeconds: 4,
      kind: "action" as const,
      action: "เงาบางอย่างขยับ forest หลังก้อนหิน",
    },
  ];

  it("renders scene numbers, timings and kinds as fixed Thai, not model prose", () => {
    const summary = buildThaiStoryboardSummary(beats, { allowedTerms: ["Manju"] });

    expect(summary).toContain("ฉาก 1 · 0-2 วิ · ปูฉาก (Manju)");
    expect(summary).toContain("ฉาก 2 · 2-4 วิ · แอ็กชัน");
  });

  it("repairs a contaminated scene description inside the summary", () => {
    const summary = buildThaiStoryboardSummary(beats, { allowedTerms: ["Manju"] });

    expect(summary).not.toContain("forest");
    expect(summary).toContain("เงาบางอย่างขยับ หลังก้อนหิน");
  });

  it("does not renumber scenes or rename cast while repairing", () => {
    const summary = buildThaiStoryboardSummary(beats, { allowedTerms: ["Manju"] });

    expect(summary).toContain("ฉาก 1");
    expect(summary).toContain("ฉาก 2");
    expect(summary).toContain("Manju");
  });
});
