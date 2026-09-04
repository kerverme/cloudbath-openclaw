/**
 * The production incident: a revision asked for AFTER a Final Video Draft was
 * shown but BEFORE it was paid for.
 *
 * An 8-second draft was on screen with code VIDEO 2571 unpaid. The owner asked
 * for 15 seconds twice and got silence both times — no exception, no timeout,
 * just a turn that ended with nothing queued.
 *
 * Two independent faults produced that, and both are asserted here:
 *
 *  1. Arbitration REWROTE the turn. "เอาเป็น 15 วิ" carries an agreement
 *     ("เอา"), and a model question was open whose affirming choice is
 *     "เปลี่ยน Model", so the whole message was replaced by that. The owner's
 *     length was gone before any handler saw it, and when the model step it
 *     was aimed at turned out to be stale the substituted text matched no
 *     intent at all — an unclaimed turn, and silence.
 *  2. Even on the path that DID run, the revision only re-planned beats. A new
 *     length is not a beat instruction, so the scene stayed 8 seconds.
 *
 * These assert BOTH halves of the failure: the state that must change, and the
 * reply that must actually reach the delivery seam. A test that only proves
 * `naturalEdit()` returns a string would have passed throughout the incident.
 *
 * Nothing here can spend anything: the paid runtime is a local stub with a
 * counter, the planner answers from a table, and neither makes a network call.
 */
import { describe, expect, it } from "vitest";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness } from "./storyboard-router.test-support.js";
import type { AsyncKeyedStore } from "./types.js";

/** The scene the incident started from. */
const SCENE = "เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ";
/** The owner's two production messages, verbatim. */
const ASK_15 = "เอาเป็น 15 วิ";
const ASK_15_QUESTION = "สามารถทำเป็น 15 วิได้ไหม";
/** A third wording of the same request, so nothing here is a phrase table. */
const ASK_15_PLAIN = "เปลี่ยนความยาวเป็น 15 วินาที";

function mem<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    lookup: async (key) => rows.get(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/** Allocates the incident's code and records every supersede, without network. */
function paidRuntime() {
  const runtime = {
    prepareCalls: 0,
    superseded: [] as string[],
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "minimax/h3/reference-to-video",
        displayName: "MiniMax H3 Reference-to-Video",
        familyId: "minimax",
        familyDisplayName: "MiniMax",
      },
      estimatedCostUsd: 1.04,
    }),
    listCompatibleVideoModels: async () => [
      {
        modelId: "minimax/h3/reference-to-video",
        displayName: "MiniMax H3 Reference-to-Video",
        familyId: "minimax",
        familyDisplayName: "MiniMax",
      },
    ],
    readActiveVideoJob: async () => undefined,
    supersedeStoryboardDrafts: async ({ storyboardId }: { storyboardId: string }) => {
      runtime.superseded.push(storyboardId);
      return ["2571"];
    },
    prepareStoryboardVideoDraft: async (request: { durationSeconds: number }) => {
      runtime.prepareCalls += 1;
      return {
        kind: "created" as const,
        draftId: "2571",
        modelId: "minimax/h3/reference-to-video",
        modelName: "MiniMax H3 Reference-to-Video",
        durationSeconds: request.durationSeconds,
        resolution: "2K",
        aspectRatio: "9:16",
        audio: true,
        estimatedCostUsd: 1.04,
        maxAllowedUsd: 50,
        pricingSource: "fal:minimax/h3/reference-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & {
    prepareCalls: number;
    superseded: string[];
  };
}

function planner() {
  const editRequests: string[] = [];
  const built = new StoryboardLlmPlanner(async ({ purpose, messages }) => {
    if (purpose === "cloudbath-storyboard-edit") {
      editRequests.push(messages[0]!.content);
      return { text: JSON.stringify({ fromSeconds: 1, toSeconds: 8, action: "BEAT-EDIT" }) };
    }
    return {
      text: JSON.stringify({
        beats: [
          {
            startSeconds: 1,
            endSeconds: 8,
            kind: "action",
            framing: "Medium",
            action: "Twong walks",
            camera: "Static",
            characterNames: ["Twong"],
          },
        ],
      }),
    };
  });
  return Object.assign(built, { editRequests });
}

const REVISE: Awaited<ReturnType<ConversationSemanticResolver["resolve"]>> = {
  intent: "revise_active_storyboard",
  referentType: "storyboard",
  confidence: 0.95,
  needsClarification: false,
};

function semanticStub(): ConversationSemanticResolver & { calls: number } {
  const stub = {
    calls: 0,
    resolve: async () => {
      stub.calls += 1;
      return REVISE;
    },
  };
  return stub;
}

/**
 * Rebuilds the exact production state: an 8-second storyboard, confirmed, model
 * chosen, and an unpaid Final Video Draft carrying code 2571.
 */
async function withUnpaidFinalDraft(options: { advanceVersion?: boolean } = {}) {
  const paid = paidRuntime();
  const built = planner();
  const semantic = semanticStub();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const h = harness({
    paidDraftRuntime: paid,
    planner: built,
    semanticResolver: semantic,
    modelSelection: mem<StoryboardModelSelectionState>(),
    logger: { warn: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }) },
  });
  await h.dispatch(SCENE);
  await h.dispatch("8 วิ");
  await h.dispatch("ไม่มี");
  await h.dispatch("ยืนยัน Storyboard");
  const draft = await h.dispatch("ใช้ Default");

  expect(draft.text).toContain("Final Video Draft");
  expect(draft.text).toMatch(/ยืนยัน VIDEO 2571/u);
  expect((await h.latest()).document.durationSeconds).toBe(8);
  if (options.advanceVersion) {
    // Reproduces the second half of the incident: the storyboard moves on, so
    // the frozen model step is stale by the time the next message lands.
    await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");
  }
  return { h, paid, planner: built, semantic, logs };
}

describe("the incident: 15 seconds asked for after an unpaid 8-second draft", () => {
  for (const message of [ASK_15, ASK_15_QUESTION, ASK_15_PLAIN]) {
    it(`answers and re-times the scene for "${message}"`, async () => {
      const { h, paid } = await withUnpaidFinalDraft();
      const before = await h.latest();

      const revised = await h.dispatch(message);

      // DELIVERY: the turn is claimed AND carries text. Both halves matter —
      // the incident was `handled` with nothing to say.
      expect(revised.handled).toBe(true);
      expect(revised.text ?? "").not.toBe("");
      expect(revised.source).not.toBe("model");
      expect(revised.text).toContain("Storyboard");

      // STATE: a new version, actually 15 seconds.
      const after = await h.latest();
      expect(after.versionNumber).toBe(before.versionNumber + 1);
      expect(after.document.durationSeconds).toBe(15);
      expect(after.storyboardId).toBe(before.storyboardId);
      // Still free: a revision costs nothing and mints no code.
      expect(paid.prepareCalls).toBe(1);
      expect(revised.text ?? "").not.toMatch(/ยืนยัน VIDEO/u);
    });
  }

  it("never lets the request be replaced by an answer to the open model question", async () => {
    const { h } = await withUnpaidFinalDraft();

    const revised = await h.dispatch(ASK_15);

    // The message carries a length the model question has no choice for, so it
    // is not an answer to it. Rewriting it to "เปลี่ยน Model" is what destroyed
    // the owner's request in production.
    expect(revised.conversation?.kind).not.toBe("rewrite");
    expect((await h.latest()).document.durationSeconds).toBe(15);
  });

  it("still answers when the frozen model step has gone stale", async () => {
    // The exact second-message shape: the storyboard advanced, so the model
    // step frozen at the older version no longer resolves. This turn ended in
    // silence in production.
    const { h } = await withUnpaidFinalDraft({ advanceVersion: true });

    const revised = await h.dispatch(ASK_15);

    expect(revised.source).not.toBe("model");
    expect(revised.handled).toBe(true);
    expect(revised.text ?? "").not.toBe("");
    expect((await h.latest()).document.durationSeconds).toBe(15);
  });
});

describe("what the revision does to the paid state", () => {
  it("retires the unpaid code and the frozen model step", async () => {
    const { h, paid } = await withUnpaidFinalDraft();
    const active = await h.latest();

    await h.dispatch(ASK_15);

    // The owner was quoted for 8 seconds; that code may not execute 15.
    expect(paid.superseded).toEqual([active.storyboardId]);
    // The model was chosen against the old length. The shared store offers no
    // delete, so the step is reset in place and left pointing at the version it
    // was frozen for — inert twice over: it offers nothing, and it no longer
    // matches the scene, so it can neither pick nor price a model.
    const step = (await h.modelSelection?.entries())?.[0]?.value;
    expect(step?.offeredModelIds ?? []).toEqual([]);
    expect(step?.frozenVersionNumber).not.toBe((await h.latest()).versionNumber);
  });

  it("requires the storyboard to be confirmed again before a new code exists", async () => {
    const { h, paid } = await withUnpaidFinalDraft();

    const revised = await h.dispatch(ASK_15);
    // The revision itself offers no model and no code.
    expect(revised.text ?? "").not.toContain("Final Video Draft");
    expect(paid.prepareCalls).toBe(1);

    // Only the existing free confirmation gate re-opens the paid path, and the
    // new code is minted against the 15-second scene.
    const confirmed = await h.dispatch("ยืนยัน Storyboard");
    expect(confirmed.text).toContain("MiniMax H3 Reference-to-Video");
    expect(paid.prepareCalls).toBe(1);

    const redrafted = await h.dispatch("ใช้ Default");
    expect(redrafted.text).toContain("Final Video Draft");
    expect(redrafted.text).toContain("15 วิ");
    expect(paid.prepareCalls).toBe(2);
  });

  it("leaves the code alone when the revision changes nothing", async () => {
    const { h, paid } = await withUnpaidFinalDraft();

    // Not a revision at all: nothing to apply, so nothing is retired.
    await h.dispatch("ขอบคุณ");

    expect(paid.superseded).toEqual([]);
  });
});

describe("observability the incident lacked", () => {
  it("records what the contextual route produced, without echoing content", async () => {
    const { h, logs } = await withUnpaidFinalDraft();

    await h.dispatch(ASK_15);

    const routed = logs.find((entry) => entry.event === "storyboard_contextual_route_handled");
    expect(routed?.fields).toMatchObject({
      routeKind: "revise_active_storyboard",
      handled: true,
      replyTextPresent: true,
      storyboardVersion: 2,
      durationSeconds: 15,
    });
    expect((routed?.fields?.replyTextLength as number) ?? 0).toBeGreaterThan(0);
    // The scene prompt is owner content: measured, never logged.
    expect(JSON.stringify(logs)).not.toContain("เตะขวดน้ำ");
  });
});

describe("the paid guarantees this must not weaken", () => {
  it("keeps the exact typed phrase as the only paid trigger", async () => {
    const { h, paid } = await withUnpaidFinalDraft();
    await h.dispatch(ASK_15);
    await h.dispatch("ยืนยัน Storyboard");
    await h.dispatch("ใช้ Default");

    // Everything above is free; agreeing in words is still not paying.
    for (const near of ["ตกลง", "เอาเลย", "ยืนยัน", "ยืนยัน VIDEO"]) {
      const answered = await h.dispatch(near);
      expect(answered.text ?? "").not.toMatch(/เริ่มสร้างวิดีโอ/u);
    }
    expect(paid.prepareCalls).toBe(2);
  });
});
