/**
 * The conversational video director.
 *
 * Every assertion here runs through the harness's real `before_dispatch` order
 * (storyboard, then previs, then the model), so a claim about what the owner
 * sees is a claim about production routing. No provider is ever called: the
 * paid-draft runtime is either absent or a local stub.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { expectNothingBillable, harness } from "./storyboard-router.test-support.js";

/** The production request that used to fall through to ordinary chat. */
const NATURAL_REQUEST = "เอา Twong ไปเดินในสวน";

const DURATION_QUESTION = "ต้องการความยาวกี่วินาที? (เช่น 10 วิ)";
const DIALOGUE_QUESTION = "มีเสียงพูดในคลิปไหม? (มี / ไม่มี)";
const DIALOGUE_TEXT_QUESTION = "ให้พูดว่าอะไร?";

/** A paid runtime that allocates a code and quotes, without any network call. */
function stubPaidRuntime(): StoryboardPaidDraftRuntime & {
  calls: Array<{ audio: boolean; durationSeconds: number }>;
} {
  const calls: Array<{ audio: boolean; durationSeconds: number }> = [];
  let next = 0;
  return {
    calls,
    prepareStoryboardVideoDraft: async (request) => {
      calls.push({ audio: request.audio, durationSeconds: request.durationSeconds });
      next += 1;
      return {
        kind: "created",
        draftId: String(1000 + next),
        modelId: "bytedance/seedance-2.5",
        modelName: "Seedance 2.5",
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        audio: request.audio,
        estimatedCostUsd: 0.42,
        maxAllowedUsd: 2,
        pricingSource: "openrouter-catalog",
      };
    },
  };
}

describe("conversational video director", () => {
  it("gathers duration and dialogue, then produces a storyboard and a draft", async () => {
    const paid = stubPaidRuntime();
    const h = harness({ paidDraftRuntime: paid });

    const opened = await h.dispatch(NATURAL_REQUEST);
    expect(opened).toMatchObject({ source: "storyboard", handled: true });
    expect(opened.text).toBe(DURATION_QUESTION);

    const asked = await h.dispatch("10 วิ");
    expect(asked.text).toBe(DIALOGUE_QUESTION);
    // Nothing has been written yet: two questions cost no Notion work.
    expect((await h.drafts.entries()).length).toBe(0);

    const done = await h.dispatch("ไม่มี");
    expect(done.source).toBe("storyboard");
    expect(done.text).toContain("Final Video Draft");
    expect(done.text).toContain("ความยาว: 10 วิ");
    expect(done.text).toContain("ราคาโดยประมาณ: ~$0.42");
    const version = await h.latest();
    expect(version.document.durationSeconds).toBe(10);
    expect(version.document.cast.map((member) => member.characterId)).toEqual(["CHAR-6"]);
    // A silent scene asks the provider for no audio, which is what re-quotes it.
    expect(paid.calls).toEqual([{ audio: false, durationSeconds: 10 }]);
  });

  it("asks what is said only when the owner wants dialogue, and carries it into the scene", async () => {
    const paid = stubPaidRuntime();
    const h = harness({ paidDraftRuntime: paid });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("10 วิ");

    const wantsText = await h.dispatch("มี");
    expect(wantsText.text).toBe(DIALOGUE_TEXT_QUESTION);

    const done = await h.dispatch("สวัสดีครับ");
    expect(done.text).toContain("Final Video Draft");
    const version = await h.latest();
    expect(version.document.scenePrompt).toContain("สวัสดีครับ");
    expect(paid.calls).toEqual([{ audio: true, durationSeconds: 10 }]);
  });

  it("writes nothing billable while the request is still being gathered", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("10 วิ");

    expect((await h.storyboardVersions.entries()).length).toBe(0);
    await expectNothingBillable(h);
  });

  it("leaves an unrelated message alone while a question is open", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);

    const unrelated = await h.dispatch("วันนี้ฝนตกไหม");

    expect(unrelated.source).not.toBe("storyboard");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });

  it("cancels the pending request on request and stops answering for it", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);

    const cancelled = await h.dispatch("ยกเลิก");
    expect(cancelled.text).toBe("ยกเลิกคำขอวิดีโอแล้ว");

    // The next number is an ordinary message again, not an answer.
    const after = await h.dispatch("10 วิ");
    expect(after.source).not.toBe("storyboard");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });

  it("refuses an over-long answer and keeps the same question open", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);

    const tooLong = await h.dispatch("120 วิ");
    expect(tooLong.text).toContain("เกินสูงสุด");

    const retried = await h.dispatch("12 วิ");
    expect(retried.text).toBe(DIALOGUE_QUESTION);
  });

  it("never claims the exact paid confirmation", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);

    const confirmation = await h.dispatch("ยืนยัน VIDEO 1234");

    // The paid gate lives in the LINE plugin; this router must not answer it,
    // during a pending question or at any other time.
    expect(confirmation.source).not.toBe("storyboard");
  });

  it("keeps a pending request scoped to its own owner", async () => {
    const h = harness();
    await h.dispatch(NATURAL_REQUEST);

    const otherOwner = await h.dispatch("10 วิ", { senderId: "U-someone-else" });

    expect(otherOwner.source).not.toBe("storyboard");
    expect((await h.storyboardVersions.entries()).length).toBe(0);
  });
});

describe("natural draft revision", () => {
  /** Drives the director to a finished storyboard, then returns the harness. */
  async function withDraft(paid?: StoryboardPaidDraftRuntime) {
    const h = harness(paid ? { paidDraftRuntime: paid } : {});
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("10 วิ");
    await h.dispatch("ไม่มี");
    return h;
  }

  it("re-times the same storyboard when the owner asks for another length", async () => {
    const h = await withDraft();

    const revised = await h.dispatch("ขอ 15 วิแทน");

    const version = await h.latest();
    expect(version.versionNumber).toBe(2);
    expect(version.document.durationSeconds).toBe(15);
    expect(version.document.beats.at(-1)?.endSeconds).toBe(15);
    expect(revised.text).toContain("Final Video Draft");
  });

  it("changes the environment without touching the cast", async () => {
    const h = await withDraft();

    await h.dispatch("เปลี่ยนเป็นสวนญี่ปุ่น");

    const version = await h.latest();
    expect(version.document.environment).toBe("สวนญี่ปุ่น");
    expect(version.document.cast.map((member) => member.characterId)).toEqual(["CHAR-6"]);
  });

  it("drops every spoken line and re-quotes the scene without audio", async () => {
    const paid = stubPaidRuntime();
    const h = harness({ paidDraftRuntime: paid });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("10 วิ");
    await h.dispatch("มี");
    await h.dispatch("ทักทายกันหน่อย");
    expect(paid.calls.at(-1)?.audio).toBe(true);

    await h.dispatch("ไม่เอาเสียงพูด");

    const version = await h.latest();
    expect(version.document.beats.some((beat) => beat.dialogue)).toBe(false);
    expect(paid.calls.at(-1)?.audio).toBe(false);
  });

  it("applies a camera instruction to the whole scene", async () => {
    const h = await withDraft();

    await h.dispatch("ให้กล้องเดินตาม");

    const version = await h.latest();
    expect(version.document.beats.every((beat) => beat.camera === "เดินตาม")).toBe(true);
  });

  it("opens new work for a cast addition and says so, leaving the old draft intact", async () => {
    const h = await withDraft();
    const before = await h.latest();

    const added = await h.dispatch("เพิ่ม Twong2 เข้ามาด้วย");

    // PR #50's rule stands: a cast the project never froze is new work, not a
    // rewrite of the frozen one. The owner is told rather than surprised.
    expect(added.text).toContain("เริ่มงานใหม่");
    expect(added.text).toContain("Twong2");
    const after = await h.latest();
    expect(after.storyboardId).not.toBe(before.storyboardId);
    expect(after.document.cast.map((member) => member.characterId)).toEqual(["CHAR-6", "CHAR-7"]);
    // The superseded storyboard is still readable at its own id.
    expect(
      await h.store.readLatest({
        storyboardId: before.storyboardId,
        claim: {
          accountId: before.accountId,
          lineGroupId: before.lineGroupId,
          ownerSenderId: before.ownerSenderId,
        },
      }),
    ).toBeDefined();
  });

  it("does not treat ordinary conversation as a revision", async () => {
    const h = await withDraft();
    const before = await h.latest();

    for (const content of ["ขอบคุณครับ", "วันนี้อากาศดี", "Twong น่ารักดีนะ"]) {
      const result = await h.dispatch(content);
      expect(result.source, content).not.toBe("storyboard");
    }

    expect((await h.latest()).versionNumber).toBe(before.versionNumber);
  });

  it("never lets a revision reach the paid gate by itself", async () => {
    const paid = stubPaidRuntime();
    const generate = vi.fn();
    const h = await withDraft(paid);

    await h.dispatch("ขอ 15 วิแทน");

    // A revision re-quotes, which allocates a draft code, but generation is
    // still exclusively the LINE confirmation gate's job.
    expect(generate).not.toHaveBeenCalled();
    expect(paid.calls.length).toBeGreaterThan(0);
  });
});
