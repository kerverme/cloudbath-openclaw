/**
 * The referent model is consulted only when its answer could change the turn.
 *
 * Production: every owner turn on LINE paid one `cloudbath_conversation_referent`
 * call before anything else ran, ordinary chat included ("วันนี้ฝนตกไหม" cost a
 * referent call plus the main agent), and a news question naming "last week"
 * was answered with "which work do you mean?". The model's answer only matters
 * when a Cloudbath question is waiting, when a Cloudbath handler would claim
 * the turn, or when the turn points back at Cloudbath work that exists.
 */
import { describe, expect, it } from "vitest";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import { classifyConversationUtterance } from "./conversation-utterance.js";
import { openDirectorSession, storyboardDirectorKey } from "./storyboard-director.js";
import { CREATE_MESSAGE, harness, OTHER_MEMBER } from "./storyboard-router.test-support.js";

function countingResolver(): ConversationSemanticResolver & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    resolve: async ({ message }) => {
      messages.push(message);
      return {
        intent: "unrelated",
        referentType: "none",
        confidence: 0.95,
        needsClarification: false,
      };
    },
  };
}

function fresh() {
  const semantic = countingResolver();
  return {
    semantic,
    h: harness({ semanticResolver: semantic, resolverNames: ["Twong", "Twong2"] }),
  };
}

/** A storyboard the owner made earlier and has since stopped talking about. */
async function withStaleStoryboard() {
  const g = fresh();
  await g.h.dispatch(CREATE_MESSAGE);
  expect(await g.h.active.entries()).toHaveLength(1);
  g.semantic.messages.length = 0;
  return g;
}

const ORDINARY_CHAT = [
  "วันนี้ฝนตกไหม",
  "วันนี้ฝนตกไหมครับ",
  "กรุงเทพฝนหยุดกี่โมง",
  "ช่วยเขียนอีเมล",
  "สวัสดี",
  "กี่โมงแล้ว",
  "แนะนำร้านอาหาร",
  "อธิบายเรื่อง quantum",
  "ใช้โมเดลไรอยู่",
  "what model are you using",
];

const DATED_CHAT = [
  "สรุปข่าวอาทิตย์ที่แล้ว",
  "ข่าวสัปดาห์ที่แล้ว",
  "ข่าวเดือนที่แล้ว",
  "สรุปเมื่อวาน",
  "ข่าวล่าสุด",
  "รอบล่าสุดของข่าว",
  "ปีที่แล้วเกิดอะไรขึ้น",
  "what happened last week",
];

describe("ordinary chat never reaches the referent model", () => {
  it.each(ORDINARY_CHAT)("fresh conversation: %s", async (text) => {
    const { h, semantic } = fresh();

    expect((await h.dispatch(text)).conversation).toEqual({ kind: "pass" });
    expect(semantic.messages).toEqual([]);
  });

  it.each(ORDINARY_CHAT)("stale storyboard: %s", async (text) => {
    const { h, semantic } = await withStaleStoryboard();

    expect((await h.dispatch(text)).conversation).toEqual({ kind: "pass" });
    expect(semantic.messages).toEqual([]);
  });

  // An active storyboard alone is not evidence: a polite or yes/no word is in
  // most Thai sentences, and a standing offer is answered by its buttons.
  it.each(["ไม่เอาแบบนี้", "โอเคครับ", "ได้ครับ"])(
    "stale storyboard, no question waiting: %s",
    async (text) => {
      const { h, semantic } = await withStaleStoryboard();

      expect((await h.dispatch(text)).conversation).toEqual({ kind: "pass" });
      expect(semantic.messages).toEqual([]);
    },
  );
});

describe("dated and news wording is not a reference back", () => {
  it.each(DATED_CHAT)(
    "fresh conversation: %s reaches the agent, not a clarification",
    async (text) => {
      const { h, semantic } = fresh();

      const outcome = await h.dispatch(text);

      expect(outcome.conversation).toEqual({ kind: "pass" });
      expect(outcome.source).toBe("model");
      expect(semantic.messages).toEqual([]);
    },
  );

  it.each(DATED_CHAT)("stale storyboard: %s", async (text) => {
    const { h, semantic } = await withStaleStoryboard();

    expect((await h.dispatch(text)).conversation).toEqual({ kind: "pass" });
    expect(semantic.messages).toEqual([]);
  });

  it.each(DATED_CHAT)("%s carries no deixis", (text) => {
    expect(classifyConversationUtterance(text)?.deixis).toBeUndefined();
  });

  it.each([
    ["อันที่แล้ว", "previous"],
    ["ฉากเมื่อกี้", "previous"],
    ["ตัวล่าสุด", "previous"],
    ["อันล่าสุด", "previous"],
    ["รูปเดิม", "same"],
    ["ตัวเดิม", "same"],
    ["the last one", "previous"],
  ])("workflow deixis %s is still %s", (text, deixis) => {
    expect(classifyConversationUtterance(text)?.deixis).toBe(deixis);
  });
});

describe("genuine workflow turns still reach it", () => {
  it.each([
    "แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น",
    "เอาอันล่าสุด",
    "ตัวเดิม",
    // No literal "storyboard": the utterance classes and parsers carry these.
    "สร้างภาพแต่ละฉาก",
    "ทำต่อเลย",
    "ไม่เอาเสียงพูด",
    "ขอ 30 วิ",
    "Twong ล่ะ",
    "VIDEO 1234 ล่ะ",
  ])("stale storyboard: %s", async (text) => {
    const { h, semantic } = await withStaleStoryboard();

    await h.dispatch(text);

    expect(semantic.messages).toEqual([text]);
  });

  it.each(["เอา Twong ไปเดินในสวน", "สร้างภาพแต่ละฉาก", "VIDEO 1234 เสร็จยัง", "<media:image>"])(
    "fresh conversation: %s",
    async (text) => {
      const { h, semantic } = fresh();

      await h.dispatch(text);

      expect(semantic.messages).toEqual([text]);
    },
  );

  it("a bare refusal while a director question is waiting", async () => {
    const { h, semantic } = fresh();
    await h.director.register(
      storyboardDirectorKey(h.claim),
      openDirectorSession({
        claim: h.claim,
        scenePrompt: "Twong เดินในสวน",
        characterNames: ["Twong"],
        environment: "สวน",
        updatedAt: "2026-08-30T10:00:00.000Z",
      }),
    );

    await h.dispatch("ไม่เอาแบบนี้");

    expect(semantic.messages).toEqual(["ไม่เอาแบบนี้"]);
  });

  it("a back-reference with no Cloudbath work is asked about without the model", async () => {
    const { h, semantic } = fresh();

    const outcome = await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(outcome.conversation?.kind).toBe("clarify");
    expect(semantic.messages).toEqual([]);
  });

  it("another member of the group never reaches it", async () => {
    const { h, semantic } = await withStaleStoryboard();

    await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น", { senderId: OTHER_MEMBER });

    expect(semantic.messages).toEqual([]);
  });
});
