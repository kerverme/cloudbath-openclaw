/**
 * The gate between "here is your storyboard" and "here is a payable code".
 *
 * Two confirmations exist in this product and they are deliberately different
 * shapes. This one — "ยืนยัน Storyboard" — freezes CONTENT and costs nothing.
 * The paid one — the exact `ยืนยัน VIDEO ####` in LINE's own gate — spends
 * money. Keeping them apart is what lets the owner iterate on the scene as
 * many times as they like without any model being chosen or billed, and it is
 * why no VIDEO code exists until a storyboard version is frozen.
 *
 * Once frozen, content is immutable for this draft: model selection may append
 * reference bindings to the provider prompt, but it can never edit the scene.
 * A story change after freezing is a NEW storyboard version, which starts this
 * cycle again.
 */
import { normalizeStoryboardText } from "./storyboard-request.js";
import type { AsyncKeyedStore } from "./types.js";

export const STORYBOARD_CONFIRMATION_NAMESPACE = "storyboard-confirmation-v1";
/**
 * Long enough to think about a scene, short enough that an abandoned selection
 * does not answer a message sent hours later.
 */
const MINUTE_MS = 60_000;
export const STORYBOARD_CONFIRMATION_TTL_MS = 30 * MINUTE_MS;

/**
 * "ยืนยัน Storyboard" — freezes the scene. Deliberately NOT the paid phrase.
 *
 * The paid trigger is `ยืนยัน VIDEO ####` and nothing here may match it: a
 * pattern that accepted both would let a content confirmation spend money.
 */
const STORYBOARD_CONFIRMATION = /^ยืนยัน\s*(?:storyboard|สตอรี่บอร์ด|สตอรีบอร์ด)\s*$/iu;
/** Guard: the paid phrase is never handled here, whatever else matches. */
const PAID_CONFIRMATION = /^ยืนยัน\s+VIDEO\s+\d{4}$/iu;

export function isStoryboardConfirmation(content: string): boolean {
  const text = normalizeStoryboardText(content);
  return !PAID_CONFIRMATION.test(text) && STORYBOARD_CONFIRMATION.test(text);
}

/**
 * "ใช้ Default" and its plain agreements.
 *
 * The Thai alternatives are deliberately NOT wrapped in `\b`: it is ASCII-only
 * and never fires between two Thai letters, so a trailing word boundary would
 * silently reject "ตกลง". Only the Latin alternatives take one, where it stops
 * "ok" matching inside an unrelated English word.
 */
const USE_DEFAULT =
  /^(?:ใช้\s*)?(?:ค่าเริ่มต้น|ตัวเดิม|อันเดิม|ใช้เลย|ตกลง|เอาเลย)|^(?:ใช้\s*)?(?:default|ok|okay|yes)\b/iu;
const CHANGE_MODEL =
  /เปลี่ยน\s*(?:model|โมเดล|โมเดิล)|เลือก\s*(?:model|โมเดล)\s*(?:อื่น|ใหม่)|\bchange\s+model\b|\bother\s+model\b/iu;

export type StoryboardModelAnswer =
  | Readonly<{ kind: "use_default" }>
  | Readonly<{ kind: "change_model" }>
  | Readonly<{ kind: "choice"; index: number }>
  | Readonly<{ kind: "query"; text: string }>;

/**
 * Reads the owner's reply while a model question is open.
 *
 * A bare number is a menu pick, which is why the menus are numbered: it is the
 * one unambiguous way to choose in a chat. Everything else is handed on as a
 * free-text query for the picker to rank, and the picker — not this parser —
 * decides whether that query was confident enough to apply.
 */
export function parseStoryboardModelAnswer(content: string): StoryboardModelAnswer | undefined {
  const text = normalizeStoryboardText(content);
  if (!text || PAID_CONFIRMATION.test(text)) {
    return undefined;
  }
  // Change-model is tested before use-default: "เปลี่ยนโมเดล" carries none of
  // default's markers, but "ok เปลี่ยนโมเดล" carries both.
  if (CHANGE_MODEL.test(text)) {
    return { kind: "change_model" };
  }
  const bare = /^(\d{1,2})$/u.exec(text)?.[1];
  if (bare) {
    return { kind: "choice", index: Number(bare) - 1 };
  }
  if (USE_DEFAULT.test(text)) {
    return { kind: "use_default" };
  }
  return { kind: "query", text };
}

/**
 * Where the owner is in the post-freeze model conversation.
 *
 * `frozenVersionNumber` is carried so a selection can never be applied to a
 * storyboard version other than the one that was confirmed — a revision
 * between freezing and choosing invalidates the selection rather than silently
 * re-pointing it at newer content.
 */
export type StoryboardModelSelectionState = Readonly<{
  version: 1;
  storyboardId: string;
  frozenVersionNumber: number;
  /** "default" while the default is on offer, "family"/"version" in the picker. */
  step: "default" | "family" | "version";
  /** Family the owner narrowed to, on the version step. */
  familyId?: string;
  /** Endpoint ids currently on screen, in the order they were numbered. */
  offeredModelIds?: readonly string[];
  updatedAt: string;
}>;

export function storyboardModelSelectionKey(params: {
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
}): string {
  return `storyboard-model:${params.accountId}:${params.lineGroupId}:${params.ownerSenderId}`;
}

export type StoryboardModelSelectionStore = AsyncKeyedStore<StoryboardModelSelectionState>;

/** Prompt shown right after a storyboard is rendered. Costs nothing to answer. */
export const STORYBOARD_CONFIRMATION_PROMPT = "ยืนยัน Storyboard หรือบอกจุดที่ต้องการแก้";
