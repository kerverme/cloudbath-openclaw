/**
 * Semantic regression for referent arbitration.
 *
 * Every case here is about WHO a message is for, not about which words it
 * contains. The phrases are the ones production actually saw, but none of them
 * is wired to a handler: they are answered by utterance class ("this is a
 * refusal") resolved against whatever the open question declared, so a case
 * passes only if the general mechanism works.
 *
 * Nothing in this file can spend anything. The paid-draft runtime is a local
 * stub with no network call and a counter, the only paid trigger is asserted to
 * remain the exact typed phrase, and no fal client is constructed anywhere.
 */
import { describe, expect, it } from "vitest";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import {
  STORYBOARD_CONFIRMATION_TTL_MS,
  type StoryboardModelSelectionState,
} from "./storyboard-confirmation.js";
import { DIRECTOR_QUESTION } from "./storyboard-director.js";
import type {
  StoryboardPaidDraftRuntime,
  StoryboardVideoJobSnapshot,
} from "./storyboard-paid-draft-runtime.js";
import { harness } from "./storyboard-router.test-support.js";
import type { AsyncKeyedStore } from "./types.js";

/** A natural video request that pins nothing down, so the director opens. */
const NATURAL_REQUEST = "เอา Twong ทำวิดีโอ เดินอยู่ในสวน เจอขวดน้ำ แล้วเตะขวดน้ำ";

function mem<T>(): AsyncKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) =>
      values.has(key) ? false : (values.set(key, value), true),
    lookup: async (key) => values.get(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/**
 * The LINE seam, stubbed locally: it allocates a code and reports a job without
 * any network call, and counts every paid-draft allocation so a test can prove
 * none happened.
 */
function stubPaidRuntime(
  job?: StoryboardVideoJobSnapshot,
): StoryboardPaidDraftRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "minimax/h3/reference-to-video",
        displayName: "MiniMax H3 Reference-to-Video",
        familyId: "minimax",
        familyDisplayName: "MiniMax",
      },
      estimatedCostUsd: 1.95,
    }),
    readActiveVideoJob: async () => job,
    prepareStoryboardVideoDraft: async (request: { durationSeconds: number }) => {
      runtime.calls += 1;
      return {
        kind: "created" as const,
        draftId: "9566",
        modelId: "minimax/h3/reference-to-video",
        modelName: "MiniMax H3 Reference-to-Video",
        durationSeconds: request.durationSeconds,
        resolution: "2K",
        aspectRatio: "9:16",
        audio: true,
        estimatedCostUsd: 1.95,
        maxAllowedUsd: 50,
        pricingSource: "fal:minimax/h3/reference-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & { calls: number };
}

function runningJob(
  overrides: Partial<StoryboardVideoJobSnapshot> = {},
): StoryboardVideoJobSnapshot {
  return {
    jobId: "job-1",
    draftId: "9566",
    status: "running",
    stage: "provider_submission",
    submittedAt: Date.parse("2026-08-30T09:59:00.000Z"),
    ...overrides,
  };
}

/** Walks a fresh request to the point where the model question is open. */
async function upToModelQuestion(
  options: {
    job?: StoryboardVideoJobSnapshot;
    semanticResolver?: ConversationSemanticResolver;
  } = {},
) {
  const paid = stubPaidRuntime(options.job);
  const h = harness({
    paidDraftRuntime: paid,
    modelSelection: mem<StoryboardModelSelectionState>(),
    ...(options.semanticResolver ? { semanticResolver: options.semanticResolver } : {}),
  });
  await h.dispatch(NATURAL_REQUEST);
  await h.dispatch("15");
  await h.dispatch("ไม่มี");
  const confirmed = await h.dispatch("ยืนยัน Storyboard");
  expect(confirmed.text).toContain("MiniMax H3 Reference-to-Video");
  return { h, paid };
}

describe("A: an answer that repeats none of the offered wording", () => {
  it("reads 'ไม่เปลี่ยน' as the default, because the question's negating choice IS the default", async () => {
    const { h, paid } = await upToModelQuestion();

    const answered = await h.dispatch("ไม่เปลี่ยน");

    // Rewritten to the wording the model handler already parses, so a chip and
    // this typed refusal run one implementation.
    expect(answered.conversation).toEqual({ kind: "rewrite", canonicalText: "ใช้ Default" });
    expect(answered.text).toMatch(/ยืนยัน VIDEO 9566/u);
    expect(paid.calls).toBe(1);
  });

  it("reads 'เอาตัวเดิม' the same way, from the same declaration", async () => {
    const { h } = await upToModelQuestion();

    const answered = await h.dispatch("เอาตัวเดิม");

    expect(answered.conversation).toEqual({ kind: "rewrite", canonicalText: "ใช้ Default" });
  });

  it("reads a bare agreement as the AFFIRMING choice, which here is changing it", async () => {
    const { h } = await upToModelQuestion();

    // The same one-word agreement that means "yes, there is speech" against the
    // dialogue question means "yes, change it" here: the question declares
    // which of its choices agreement selects, not this word.
    const answered = await h.dispatch("เอา");

    expect(answered.conversation).toEqual({ kind: "rewrite", canonicalText: "เปลี่ยน Model" });
  });
});

describe("B: a bare progress question with a job running", () => {
  it("answers about the active video, naming the stage the record proves", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime(runningJob()) });

    const asked = await h.dispatch("เสร็จยัง");

    expect(asked.source).toBe("conversation");
    expect(asked.text).toBe("VIDEO 9566: ส่งงานให้ fal.ai แล้ว กำลังสร้างวิดีโอ");
  });

  it("answers 'ถึงไหนแล้ว' and 'เป็นไงบ้าง' from the same detector", async () => {
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(runningJob({ stage: "r2_archive" })),
    });

    expect((await h.dispatch("ถึงไหนแล้ว")).text).toBe("VIDEO 9566: กำลังส่งเข้า LINE");
    expect((await h.dispatch("เป็นไงบ้าง")).text).toBe("VIDEO 9566: กำลังส่งเข้า LINE");
  });

  it("never reports a queue position, which the job record cannot prove", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime(runningJob({ stage: undefined })) });

    const asked = await h.dispatch("เสร็จยัง");

    expect(asked.text).toBe("VIDEO 9566: กำลังเตรียมไฟล์อ้างอิง");
    expect(asked.text).not.toContain("คิว");
  });
});

describe("C: the same question with a Character named outright", () => {
  it("is not answered as video status, however recent the job is", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime(runningJob()) });

    const asked = await h.dispatch("Twong บันทึกเสร็จยัง");

    // The named entity outranks the running job, so arbitration declines and
    // the Character-owning handler (or the model) answers instead.
    expect(asked.conversation).toEqual({ kind: "pass" });
    expect(asked.source).not.toBe("conversation");
    expect(asked.text ?? "").not.toContain("VIDEO 9566");
  });
});

describe("D: two plausible unresolved things", () => {
  it("asks which one rather than picking the more recent", async () => {
    const paid = stubPaidRuntime(runningJob());
    const h = harness({ paidDraftRuntime: paid });
    // A director question is now open AND a paid job is running, and Thai
    // builds "not yet" from the same word as "is it done" — so a bare "ยัง" is
    // genuinely two things at once.
    await h.dispatch(NATURAL_REQUEST);

    const asked = await h.dispatch("ยัง");

    expect(asked.conversation?.kind).toBe("clarify");
    expect(asked.text).toContain("VIDEO 9566");
    expect(asked.text).toContain(DIRECTOR_QUESTION.duration);
    expect(paid.calls).toBe(0);
  });
});

describe("E: a postback chip", () => {
  it("resolves the duration with no interpretation at all", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime() });
    const opened = await h.dispatch(NATURAL_REQUEST);

    expect(opened.text).toBe(DIRECTOR_QUESTION.duration);
    const buttons = opened.presentation?.blocks[0];
    expect(buttons?.type).toBe("buttons");
    const chip =
      buttons?.type === "buttons" ? buttons.buttons.find((b) => b.label === "15 วิ") : undefined;
    expect(chip?.action).toEqual({ type: "callback", value: "cbq1:nonce10000:0" });

    const pressed = await h.dispatch(chip!.action!.type === "callback" ? chip!.action!.value : "");

    // The chip's own payload carries no wording to parse: it is looked up and
    // rewritten to the canonical answer the director already understands.
    expect(pressed.conversation).toEqual({ kind: "rewrite", canonicalText: "15 วิ" });
    expect(pressed.text).toBe(DIRECTOR_QUESTION.dialogue);
  });

  it("puts no paid confirmation on any chip, at any step", async () => {
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(),
      modelSelection: mem<StoryboardModelSelectionState>(),
    });
    const steps = [
      await h.dispatch(NATURAL_REQUEST),
      await h.dispatch("15"),
      await h.dispatch("ไม่มี"),
      await h.dispatch("ยืนยัน Storyboard"),
    ];

    for (const step of steps) {
      for (const block of step.presentation?.blocks ?? []) {
        if (block.type !== "buttons") {
          continue;
        }
        for (const button of block.buttons) {
          expect(button.label).not.toMatch(/ยืนยัน VIDEO/u);
        }
      }
    }
  });
});

describe("a standing offer versus a question the assistant is waiting on", () => {
  it("does not let a refusal on screen become 'แก้ Storyboard'", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime() });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("15");
    await h.dispatch("มี");
    await h.dispatch("ทักทายกันหน่อย");

    // The storyboard is on screen with its two controls, but nothing was ASKED,
    // so this refusal is the revision itself rather than an answer.
    const revised = await h.dispatch("ไม่เอาเสียงพูด");

    expect(revised.conversation).toEqual({ kind: "pass" });
    expect((await h.latest()).document.audio).toBe("off");
  });

  it("still resolves that offer's own chip exactly", async () => {
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(),
      modelSelection: mem<StoryboardModelSelectionState>(),
    });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("15");
    const storyboard = await h.dispatch("ไม่มี");
    const block = storyboard.presentation?.blocks[0];
    const confirm =
      block?.type === "buttons"
        ? block.buttons.find((button) => button.label === "ยืนยัน Storyboard")
        : undefined;

    const pressed = await h.dispatch(
      confirm?.action?.type === "callback" ? confirm.action.value : "",
    );

    expect(pressed.conversation).toEqual({
      kind: "rewrite",
      canonicalText: "ยืนยัน Storyboard",
    });
    expect(pressed.text).toContain("MiniMax H3 Reference-to-Video");
  });
});

describe("F: a chip from an earlier step", () => {
  it("is refused rather than applied to whatever is open now", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime() });
    const opened = await h.dispatch(NATURAL_REQUEST);
    const durationBlock = opened.presentation?.blocks[0];
    const staleChip =
      durationBlock?.type === "buttons" ? durationBlock.buttons[0]!.action : undefined;
    // Move the flow on, which mints a new question and a new nonce.
    await h.dispatch("15");

    const pressed = await h.dispatch(staleChip?.type === "callback" ? staleChip.value : "");

    expect(pressed.source).toBe("conversation");
    expect(pressed.text).toContain("ใช้ไม่ได้แล้ว");
    // The dialogue question is still open: the stale chip changed nothing.
    expect((await h.dispatch("ไม่มี")).text).toContain("Storyboard v1");
  });
});

describe("G: typing instead of tapping", () => {
  it("reaches the same place through every natural form of the answer", async () => {
    for (const typed of ["15 วิ", "เอา 15", "1"]) {
      const h = harness({ paidDraftRuntime: stubPaidRuntime() });
      await h.dispatch(NATURAL_REQUEST);

      expect((await h.dispatch(typed)).text).toBe(DIRECTOR_QUESTION.dialogue);
    }
  });
});

describe("H: the paid trigger", () => {
  it("is still the exact typed phrase, and no chip or near-miss reaches it", async () => {
    const { h, paid } = await upToModelQuestion();
    const drafted = await h.dispatch("ใช้ Default");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO 9566/u);
    expect(paid.calls).toBe(1);

    // Arbitration must not turn an agreement into the paid phrase: the code is
    // typed in full or nothing happens.
    const agreed = await h.dispatch("ตกลง");

    expect(agreed.conversation?.kind).not.toBe("answer");
    expect(agreed.text ?? "").not.toMatch(/เริ่มสร้างวิดีโอ/u);
    expect(paid.calls).toBe(1);
  });
});

describe("I: the model, when the deterministic steps cannot decide", () => {
  it("may only pick a choice the open question already offered", async () => {
    const asked: string[] = [];
    const resolver: ConversationSemanticResolver = {
      resolve: async (input) => {
        asked.push(input.message);
        // A well-formed answer naming something never offered.
        return {
          intent: "answer_question",
          referentType: "storyboard",
          requestedAction: "ยืนยัน VIDEO 9566",
          confidence: 0.99,
          needsClarification: false,
        };
      },
    };
    const { h, paid } = await upToModelQuestion({ semanticResolver: resolver });

    const answered = await h.dispatch("อันล่าสุดแหละ");

    expect(asked).toHaveLength(1);
    // Discarded: not one of the offered choices, so it resolves to nothing and
    // the turn continues untouched.
    expect(answered.conversation).toEqual({ kind: "pass" });
    expect(paid.calls).toBe(0);
  });

  it("asks rather than acting when it is not confident", async () => {
    const resolver: ConversationSemanticResolver = {
      resolve: async () => ({
        intent: "answer_question",
        referentType: "storyboard",
        requestedAction: "ใช้ Default",
        confidence: 0.2,
        needsClarification: false,
      }),
    };
    const { h, paid } = await upToModelQuestion({ semanticResolver: resolver });

    const answered = await h.dispatch("อันล่าสุดแหละ");

    expect(answered.conversation?.kind).toBe("clarify");
    expect(paid.calls).toBe(0);
  });

  it("is never consulted for a message that is plainly new work", async () => {
    let calls = 0;
    const resolver: ConversationSemanticResolver = {
      resolve: async () => {
        calls += 1;
        return undefined;
      },
    };
    const h = harness({ paidDraftRuntime: stubPaidRuntime(), semanticResolver: resolver });

    await h.dispatch(NATURAL_REQUEST);

    // Classifying new work belongs to the storyboard router; arbitration only
    // disambiguates referents, so it must not reach for the model here.
    expect(calls).toBe(0);
  });
});

describe("what arbitration refuses to take", () => {
  it("leaves a turn that carries more than an answer to the handler's own parser", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime() });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("15");

    // A refusal AND an instruction. Rewriting to "ไม่มี" would silently drop
    // the second half, so the turn is passed through whole.
    const answered = await h.dispatch("ไม่เอาเสียงพูด แต่เปลี่ยนเป็นตอนกลางคืนด้วยนะ");

    expect(answered.conversation).toEqual({ kind: "pass" });
  });

  it("is unreachable in a conversation the workspace policy does not bind", async () => {
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(runningJob()),
      binding: null,
    });

    const asked = await h.dispatch("เสร็จยัง");

    expect(asked.conversation).toEqual({ kind: "pass" });
    expect(asked.source).not.toBe("conversation");
  });
});

describe("the context this all reads from", () => {
  it("keeps references, not copies, of what the owning stores hold", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime(runningJob()) });
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("15");
    await h.dispatch("ไม่มี");
    await h.dispatch("เสร็จยัง");

    const [entry] = await h.conversationContext.entries();
    const context = entry!.value;
    expect(context.activeStoryboardId).toBeTruthy();
    expect(context.activeProjectId).toBe("proj-instance-1");
    expect(context.tasks.map((task) => task.taskType)).toContain("video_generation");
    // The storyboard body, the job's prompt and its cost all live in their own
    // stores; nothing here duplicates them.
    expect(JSON.stringify(context)).not.toContain("ขวดน้ำ");
    expect(STORYBOARD_CONFIRMATION_TTL_MS).toBeGreaterThan(0);
  });
});
