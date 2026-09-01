import { describe, expect, it, vi } from "vitest";
import { parseStoryboardIntent } from "./storyboard-intent.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness } from "./storyboard-router.test-support.js";
import type { StoryboardCastMember } from "./storyboard-types.js";

const CAST: readonly StoryboardCastMember[] = [
  { characterId: "CHAR-6", characterPageId: "page-6", displayName: "Twong" },
  { characterId: "CHAR-12", characterPageId: "page-12", displayName: "Manju" },
];

function completeJson(...values: unknown[]) {
  const complete = vi.fn();
  for (const value of values) {
    complete.mockResolvedValueOnce({
      text: typeof value === "string" ? value : JSON.stringify(value),
    });
  }
  return complete;
}

const specificPlan = {
  beats: [
    {
      startSeconds: 1,
      endSeconds: 3,
      kind: "locomotion",
      framing: "Medium tracking shot",
      action: "Twong picks up club 1",
      camera: "Track with Twong",
      characterNames: ["Twong"],
    },
    {
      startSeconds: 4,
      endSeconds: 6,
      kind: "action",
      framing: "Medium shot",
      action: "Twong swings club 1 at the intended target",
      camera: "Pan with the swing",
      characterNames: ["Twong"],
    },
    {
      startSeconds: 6,
      endSeconds: 15,
      kind: "action",
      framing: "Close two-shot",
      action: "Twong misses the intended target and accidentally hits Manju",
      camera: "Whip pan to Manju",
      characterNames: ["Twong", "Manju"],
    },
  ],
} as const;

function planWithTwong2(options: { omitTimings?: boolean } = {}) {
  const plan = structuredClone(specificPlan) as unknown as {
    beats: Array<{
      startSeconds?: number;
      endSeconds?: number;
      characterNames: string[];
    }>;
  };
  for (const beat of plan.beats) {
    beat.characterNames = beat.characterNames.map((name) => (name === "Manju" ? "Twong2" : name));
    if (options.omitTimings) {
      delete beat.startSeconds;
      delete beat.endSeconds;
    }
  }
  return plan;
}

describe("LLM-assisted storyboard planning", () => {
  it("recognizes a specific English multi-action story without timeline syntax", () => {
    const intent = parseStoryboardIntent({
      content: "Twong picks up club 1, swings, misses, and accidentally hits Manju",
      knownCharacterNames: ["Twong", "Manju"],
    });
    expect(intent).toMatchObject({
      kind: "create",
      characterNames: ["Twong", "Manju"],
      unknownNames: [],
    });
  });

  it("repairs malformed guidance into one continuous 15-second timeline", async () => {
    const planner = new StoryboardLlmPlanner(completeJson(specificPlan));
    const plan = await planner.planCreate({
      request: "1-3 pick up club; 4-6 swing; 6-15 miss and hit Manju",
      durationSeconds: 15,
      cast: CAST,
    });

    expect(plan.beats.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds])).toEqual([
      [0, 2],
      [2, 5],
      [5, 15],
    ]);
    expect(plan.beats.map((beat) => beat.action).join(" | ")).toContain("picks up club 1");
    expect(plan.beats.map((beat) => beat.action).join(" | ")).toContain("swings club 1");
    expect(plan.beats.map((beat) => beat.action).join(" | ")).toContain("misses");
    expect(plan.beats.map((beat) => beat.action).join(" | ")).toContain("hits Manju");
  });

  it("maps names to canonical ids and rejects an invented cast member", async () => {
    const valid = new StoryboardLlmPlanner(completeJson(specificPlan));
    const plan = await valid.planCreate({ request: "story", durationSeconds: 15, cast: CAST });
    expect(plan.beats.at(-1)?.characterIds).toEqual(["CHAR-6", "CHAR-12"]);
    expect(JSON.stringify(plan)).not.toContain("page-12");

    const invented = structuredClone(specificPlan) as {
      beats: Array<{ characterNames: string[] }>;
    };
    invented.beats[0]!.characterNames = ["Nobody"];
    const correctedOutput = completeJson(invented, specificPlan);
    const corrected = new StoryboardLlmPlanner(correctedOutput);
    const correctedPlan = await corrected.planCreate({
      request: "story",
      durationSeconds: 15,
      cast: CAST,
    });
    expect(correctedOutput).toHaveBeenCalledTimes(2);
    expect(correctedPlan.beats[0]?.characterIds).toEqual(["CHAR-6"]);
  });

  it("retries invalid structured output once and fails without persistence", async () => {
    const complete = completeJson("not-json", { beats: [] });
    const planner = new StoryboardLlmPlanner(complete);
    const h = harness({ planner });
    const result = await h.dispatch("จากนั้น Twong เดินไปหยิบไม้ แล้ว Twong ตีพลาดไปโดน Twong2", {
      messageId: "planner-invalid",
    });
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("สร้าง Storyboard ไม่สำเร็จ");
    expect(await h.storyboardVersions.entries()).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an unknown named character before consulting the planner", async () => {
    const complete = completeJson(specificPlan);
    const h = harness({ planner: new StoryboardLlmPlanner(complete) });
    const result = await h.dispatch(
      "Then Twong picks up club 1, swings, misses, and accidentally hits Nobody",
      { messageId: "unknown-cast" },
    );
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain('ไม่พบตัวละคร "Nobody"');
    expect(complete).not.toHaveBeenCalled();
    expect(await h.storyboardVersions.entries()).toHaveLength(0);
  });

  it("creates a natural no-timing multi-beat storyboard without generic filler", async () => {
    const plan = planWithTwong2({ omitTimings: true });
    const h = harness({ planner: new StoryboardLlmPlanner(completeJson(plan)) });
    const result = await h.dispatch(
      "จากนั้น Twong เดินไปหยิบหัวไม้ 1 แล้วลองตี แต่ตีพลาดไปโดนหัว Twong2 แทน",
      { messageId: "natural-create" },
    );
    expect(result.source).toBe("storyboard");
    const document = (await h.latest()).document;
    expect(document.beats).toHaveLength(3);
    expect(document.beats[0]?.startSeconds).toBe(0);
    expect(document.beats.at(-1)?.endSeconds).toBe(15);
    expect(document.beats.map((beat) => beat.action).join(" ")).not.toContain("อยู่ในฉาก");
  });

  it("uses the planner for a natural edit while exact range editing remains deterministic", async () => {
    const createPlan = planWithTwong2();
    const complete = completeJson(createPlan, {
      fromSeconds: 4,
      toSeconds: 15,
      action: "Twong misses and accidentally hits Twong2 in close-up",
    });
    const h = harness({ planner: new StoryboardLlmPlanner(complete) });
    await h.dispatch("จากนั้น Twong เดินไปหยิบหัวไม้ 1 แล้วลองตี แต่ตีพลาดไปโดนหัว Twong2 แทน", {
      messageId: "create",
    });
    const natural = await h.dispatch("เปลี่ยนตอนที่ Twong ตีพลาดให้เป็น close-up", {
      messageId: "natural-edit",
    });
    expect(natural.text).toContain("Storyboard v2");
    expect((await h.latest()).document.beats.some((beat) => beat.action.includes("close-up"))).toBe(
      true,
    );

    const exact = await h.dispatch("ช่วง 1-3 วิ ให้ Twong หันกลับ", { messageId: "exact-edit" });
    expect(exact.text).toContain("Storyboard v3");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
