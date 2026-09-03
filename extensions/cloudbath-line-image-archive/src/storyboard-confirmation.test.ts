/**
 * The confirmation boundary between content and money.
 *
 * "ยืนยัน Storyboard" freezes the scene and costs nothing; the exact
 * `ยืนยัน VIDEO ####` is the only paid trigger and lives in the LINE plugin.
 * Nothing here reaches a provider.
 */
import { describe, expect, it } from "vitest";
import {
  isStoryboardConfirmation,
  parseStoryboardModelAnswer,
  storyboardModelSelectionKey,
} from "./storyboard-confirmation.js";
import {
  formatStoryboardModelCandidates,
  formatStoryboardModelDefault,
  formatStoryboardModelFamilies,
  formatStoryboardModelVersions,
} from "./storyboard-model-reply.js";

describe("D. the storyboard confirmation phrase", () => {
  it("recognises ยืนยัน Storyboard", () => {
    expect(isStoryboardConfirmation("ยืนยัน Storyboard")).toBe(true);
    expect(isStoryboardConfirmation("ยืนยัน storyboard")).toBe(true);
    expect(isStoryboardConfirmation("ยืนยันสตอรี่บอร์ด")).toBe(true);
  });

  it("NEVER matches the paid phrase, whose only handler is the LINE gate", () => {
    expect(isStoryboardConfirmation("ยืนยัน VIDEO 4821")).toBe(false);
    expect(parseStoryboardModelAnswer("ยืนยัน VIDEO 4821")).toBeUndefined();
  });

  it("does not fire on ordinary agreement", () => {
    for (const text of ["โอเค", "ยืนยัน", "เอาเลย", "ยืนยันนะ"]) {
      expect(isStoryboardConfirmation(text)).toBe(false);
    }
  });
});

describe("the post-freeze model answer", () => {
  it("reads 'ใช้ Default'", () => {
    expect(parseStoryboardModelAnswer("ใช้ Default")).toEqual({ kind: "use_default" });
    expect(parseStoryboardModelAnswer("ตกลง")).toEqual({ kind: "use_default" });
  });

  it("reads 'เปลี่ยนโมเดล' even alongside an agreement word", () => {
    expect(parseStoryboardModelAnswer("เปลี่ยนโมเดล")).toEqual({ kind: "change_model" });
    expect(parseStoryboardModelAnswer("ok เปลี่ยนโมเดล")).toEqual({ kind: "change_model" });
    expect(parseStoryboardModelAnswer("เลือกโมเดลอื่น")).toEqual({ kind: "change_model" });
  });

  it("reads a numbered menu pick as a zero-based choice", () => {
    expect(parseStoryboardModelAnswer("1")).toEqual({ kind: "choice", index: 0 });
    expect(parseStoryboardModelAnswer("2")).toEqual({ kind: "choice", index: 1 });
  });

  it("hands anything else on as a query for the picker to rank", () => {
    expect(parseStoryboardModelAnswer("seedance 2.5")).toEqual({
      kind: "query",
      text: "seedance 2.5",
    });
  });

  it("scopes the conversation to one account, group and owner", () => {
    const key = storyboardModelSelectionKey({
      accountId: "acct-1",
      lineGroupId: "C1",
      ownerSenderId: "U1",
    });
    expect(key).toBe("storyboard-model:acct-1:C1:U1");
    expect(key).not.toBe(
      storyboardModelSelectionKey({
        accountId: "acct-1",
        lineGroupId: "C2",
        ownerSenderId: "U1",
      }),
    );
  });
});

describe("what the owner is shown", () => {
  const H3 = {
    modelId: "minimax/h3/reference-to-video",
    displayName: "MiniMax H3 Reference-to-Video",
    familyId: "minimax",
    familyDisplayName: "MiniMax",
  };

  it("names the default and asks the default-or-change question", () => {
    const text = formatStoryboardModelDefault({ model: H3, estimatedCostUsd: 1.5 });
    expect(text).toContain("Default Model: MiniMax H3 Reference-to-Video");
    expect(text).toContain("~$1.50");
    expect(text).toContain("ใช้ Default Model หรือเปลี่ยน Model?");
  });

  it("explains a displaced default in the owner's own terms", () => {
    const text = formatStoryboardModelDefault({
      model: H3,
      displacedReason: "งานนี้มีความยาว 30 วินาที ซึ่ง MiniMax H3 รองรับไม่ได้",
    });
    expect(text.startsWith("งานนี้มีความยาว 30 วินาที")).toBe(true);
  });

  it("numbers the family menu", () => {
    const text = formatStoryboardModelFamilies([
      { id: "minimax", displayName: "MiniMax" },
      { id: "bytedance", displayName: "ByteDance / Seedance" },
    ]);
    expect(text).toContain("1. MiniMax");
    expect(text).toContain("2. ByteDance / Seedance");
  });

  it("numbers the version menu inside one family", () => {
    const text = formatStoryboardModelVersions({
      familyName: "ByteDance / Seedance",
      models: [
        {
          modelId: "bytedance/seedance-2.0/reference-to-video",
          displayName: "Seedance 2.0 Reference-to-Video",
          familyId: "bytedance",
          familyDisplayName: "ByteDance / Seedance",
        },
      ],
    });
    expect(text).toContain("ByteDance / Seedance:");
    expect(text).toContain("1. Seedance 2.0 Reference-to-Video");
  });

  it("shows numbered candidates for an ambiguous query", () => {
    expect(formatStoryboardModelCandidates([H3])).toContain("1. MiniMax H3 Reference-to-Video");
  });
});
