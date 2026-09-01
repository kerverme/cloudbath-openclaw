import { describe, expect, it } from "vitest";
import {
  CREATE_MESSAGE,
  expectNothingBillable,
  harness,
} from "./storyboard-router.test-support.js";

describe("A. natural video request creates a storyboard", () => {
  it("routes to storyboard before the model and preserves every requested dimension", async () => {
    const h = harness();
    const result = await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    expect(result.source).toBe("storyboard");
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Storyboard v1");

    const version = await h.latest();
    expect(version.document.durationSeconds).toBe(15);
    expect(version.document.aspectRatio).toBe("9:16");
    expect(version.document.environment).toContain("ร้านกาแฟ");
    expect(version.document.resolution).toBe("720p");

    // Canonical identity, never the display name.
    expect(version.document.cast.map((member) => member.characterId)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(version.document.cast.map((member) => member.displayName)).toEqual(["Twong", "Twong2"]);

    // Real UGC project and scene linkage, not a shadow project.
    expect(version.projectInstanceId).toBe("proj-instance-1");
    expect(version.projectPageId).toBe("page-project-1");
    expect(version.sceneId).toBe("SCENE-1");
    expect(version.scenePageId).toBe("page-scene-1");

    // No previs, no CozyClay render, nothing billable.
    expect((await h.previsVersions.entries()).length).toBe(0);
    expect(h.previsEngineCalls).not.toHaveBeenCalled();
    expect(h.previsArtifactCalls).not.toHaveBeenCalled();
    await expectNothingBillable(h);
  });

  it("covers the duration with ordered, non-overlapping beats", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const { beats, durationSeconds } = (await h.latest()).document;

    expect(beats.length).toBeGreaterThan(1);
    expect(beats[0]!.startSeconds).toBe(0);
    expect(beats.at(-1)!.endSeconds).toBe(durationSeconds);
    for (const [index, beat] of beats.entries()) {
      expect(beat.endSeconds).toBeGreaterThan(beat.startSeconds);
      expect(beat.endSeconds).toBeLessThanOrEqual(durationSeconds);
      if (index > 0) {
        expect(beat.startSeconds).toBe(beats[index - 1]!.endSeconds);
      }
    }
  });

  it("preserves the requested actions in the compiled beats", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const actions = (await h.latest()).document.beats.map((beat) => beat.action).join(" | ");
    expect(actions).toContain("เดินผ่าน");
    expect(actions).toContain("คุย");
  });

  it("leaves ordinary conversation to the model", async () => {
    const h = harness();
    expect((await h.dispatch("สวัสดีครับ วันนี้เป็นยังไงบ้าง")).source).toBe("model");
    expect((await h.dispatch("Twong น่ารักดีนะ")).source).toBe("model");
    expect((await h.dispatch("Twong ว่างช่วง 1-3 และ 4-6 ไหม")).source).not.toBe("storyboard");
  });
});

describe("B. storyboard edit appends a new version", () => {
  it("creates v2 and leaves v1 untouched", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const v1Before = structuredClone(await h.versionAt(1));

    const edited = await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", {
      messageId: "m2",
    });
    expect(edited.source).toBe("storyboard");
    expect(edited.text).toContain("Storyboard v2");

    const v2 = await h.versionAt(2);
    expect(v2?.versionNumber).toBe(2);
    expect(v2?.parentVersionNumber).toBe(1);
    // Same storyboard and same real project identity.
    expect(v2?.storyboardId).toBe(v1Before?.storyboardId);
    expect(v2?.projectInstanceId).toBe("proj-instance-1");
    expect(v2?.scenePageId).toBe("page-scene-1");

    // The edit is represented across exactly the requested window.
    const editedBeat = v2!.document.beats.find(
      (beat) => beat.startSeconds === 10 && beat.endSeconds === 14,
    );
    expect(editedBeat?.action).toContain("หันกลับมามอง");

    // v1 is byte-for-byte what it was before the edit.
    expect(await h.versionAt(1)).toEqual(v1Before);
    await expectNothingBillable(h);
  });

  it("accepts Thai and English time grammars", async () => {
    for (const message of [
      "วิ 8-11 ให้ Twong เดินต่อก่อนแล้วค่อยหัน",
      "วินาที 3-6 เปลี่ยนเป็น close-up Twong2",
      "ช่วง 3 ถึง 6 วิ เปลี่ยนเป็น close-up Twong2",
      "10-14 sec ให้ Twong หันกลับ",
      "seconds 10-14 ให้ Twong หันกลับ",
    ]) {
      const h = harness();
      await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
      const result = await h.dispatch(message, { messageId: "m2" });
      expect(result.source, message).toBe("storyboard");
      expect(result.text, message).toContain("Storyboard v2");
    }
  });
});

describe("C. an out-of-range edit fails closed", () => {
  it("creates no version, clamps nothing and calls nothing", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    const result = await h.dispatch("วิ 20-25 ให้ Twong หันกลับ", { messageId: "m2" });
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("20-25");
    expect(result.text).toContain("15");

    expect(await h.versionAt(2)).toBeUndefined();
    expect((await h.latest()).versionNumber).toBe(1);
    // Nothing was clamped into the valid range either.
    const beats = (await h.latest()).document.beats;
    expect(beats.every((beat) => beat.endSeconds <= 15)).toBe(true);
    await expectNothingBillable(h);
  });
});

describe("D. สร้างวิดีโอ prepares a Final Video Draft", () => {
  it("drafts from the latest version and calls no provider", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", { messageId: "m2" });

    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m3" });
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("Final Video Draft");
    expect(result.text).toContain("15 วิ");
    expect(result.text).toContain("9:16");
    expect(result.text).toContain("720p");
    expect(result.text).toContain("Seedance 2.5");
    // No paid phrase is emitted while provider binding is deferred: a code the
    // paid gate cannot resolve would either dead-end or hit somebody else's draft.
    expect(result.text).not.toMatch(/ยืนยัน\s+VIDEO/u);
    expect(result.text).toContain("ยังไม่เปิดใช้งาน");

    const drafts = await h.drafts.entries();
    expect(drafts.length).toBe(1);
    const draft = drafts[0]!.value;
    // The draft is built from the LATEST version, not the original.
    expect(draft.storyboardVersionNumber).toBe(2);
    expect(draft.durationSeconds).toBe(15);
    expect(draft.aspectRatio).toBe("9:16");
    expect(draft.resolution).toBe("720p");
    expect(draft.confirmation).toEqual({ kind: "deferred" });
    expect(draft.draftId).not.toMatch(/^\d{4}$/u);
    // Provider binding is deferred, so no api model id is invented.
    expect(draft.model).toEqual({ kind: "deferred", displayName: "Seedance 2.5" });
    expect(draft.estimatedCost).toEqual({
      kind: "unavailable",
      reason: "provider-binding-deferred",
    });
    expect(result.text).toContain("ยังไม่พร้อมใช้งาน");
    await expectNothingBillable(h);
  });

  it("carries the real project linkage and canonical cast into the plan", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });
    const draft = (await h.drafts.entries())[0]!.value;

    expect(draft.projectInstanceId).toBe("proj-instance-1");
    expect(draft.projectPageId).toBe("page-project-1");
    expect(draft.sceneId).toBe("SCENE-1");
    expect(draft.scenePageId).toBe("page-scene-1");
    expect(draft.plan.characters.map((character) => character.characterId)).toEqual([
      "CHAR-6",
      "CHAR-7",
    ]);
    expect(draft.plan.characters[0]!.identityReferences).toEqual(["ugc/page-char-6.png"]);
    expect(draft.plan.beats.at(-1)!.endSeconds).toBe(15);
  });

  it("is not claimed when the owner has no active storyboard", async () => {
    const h = harness();
    expect((await h.dispatch("สร้างวิดีโอ")).source).toBe("model");
  });
});
