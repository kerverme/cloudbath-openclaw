/**
 * General shape of a short conversational turn.
 *
 * This module answers "what KIND of move is this?" — a negation, an agreement,
 * a menu pick, a reference back to something already discussed, a request for
 * progress — and nothing about what it refers to. What it refers to is the
 * arbiter's job, and what it MEANS comes from the question that happens to be
 * open (see `ConversationChoice.role`).
 *
 * That separation is why there is no phrase table here. "ไม่เปลี่ยน" is not
 * wired to the default model; it is a negation, and a negation selects whatever
 * the open question declared as its negating choice. The same detector resolves
 * "ไม่มี" against the dialogue question and "ไม่เอา" against an audio question,
 * with no new code for either.
 *
 * The markers below are therefore linguistic classes, not features. Adding a
 * feature must not add a marker; adding a WAY OF SPEAKING may.
 */

import { normalizeStoryboardText } from "./storyboard-request.js";

/**
 * Progress inquiry: "is it done", "how far along", "what's happening".
 *
 * Tested before negation, because Thai forms this with "ยัง" — the same word
 * that carries "not yet" — so a negation-first order reads every progress
 * question as a refusal.
 */
const PROGRESS_INQUIRY =
  /เสร็จ(?:แล้ว)?\s*(?:หรือ)?ยัง|ถึงไหน|คืบหน้า|เป็น(?:ยัง)?ไง|^ยัง(?:ไง)?[?？]*$|\bstatus\b|\bprogress\b|\bdone\s+yet\b|\bhow(?:'s| is)\s+it\s+going\b/iu;

/**
 * Refusal / "not that".
 *
 * Deliberately broad on the Thai negators and anchored on the English ones,
 * where a bare `no` would otherwise match inside an unrelated word.
 */
const NEGATION = /ไม่|อย่า|ยกเลิก|\b(?:no|nope|not|don'?t|cancel|skip)\b/iu;

/** Agreement / "go ahead". */
const AFFIRMATION =
  /ใช่|เอา|ตกลง|โอเค|ได้เลย|ได้|ครับ|ค่ะ|คะ|จ้า|\b(?:yes|yep|yeah|ok|okay|sure|go\s+ahead)\b/iu;

/**
 * Reference back to something already in play.
 *
 * `same` keeps what is already chosen ("ตัวเดิม", "อันเดิม", "same one");
 * `previous` points at the most recent artifact ("อันเมื่อกี้", "ล่าสุด").
 * Both resolve to a referent, never to an action.
 */
const DEIXIS_SAME = /(?:ตัว|อัน|แบบ|ของ)?\s*เดิม|เหมือนเดิม|\bsame\b|\bas\s+before\b/iu;
const DEIXIS_PREVIOUS =
  /เมื่อกี้|เมื่อกี๊|ล่าสุด|ที่แล้ว|ก่อนหน้า|\b(?:last|latest|previous)\s+(?:one|version)?\b/iu;

/** A bare number: the one unambiguous way to pick from a numbered menu. */
const BARE_ORDINAL = /^(\d{1,2})$/u;

export type ConversationPolarity = "affirm" | "negate";
export type ConversationDeixis = "same" | "previous";

/**
 * What the turn is doing. Every field is independent: a turn can be a negation
 * that also refers back ("ไม่เอาอันเมื่อกี้"), and the arbiter decides which
 * reading the open question and the unresolved tasks support.
 */
export type ConversationUtterance = Readonly<{
  text: string;
  polarity?: ConversationPolarity;
  /** 1-based menu pick, when the turn is a bare number. */
  ordinal?: number;
  deixis?: ConversationDeixis;
  progressInquiry: boolean;
}>;

export function classifyConversationUtterance(content: string): ConversationUtterance | undefined {
  const text = normalizeStoryboardText(content);
  if (!text) {
    return undefined;
  }
  const progressInquiry = PROGRESS_INQUIRY.test(text);
  const ordinalMatch = BARE_ORDINAL.exec(text)?.[1];
  // Negation is tested before affirmation: Thai refusals are built by prefixing
  // an affirmative ("ไม่เอา" contains "เอา"), so the reverse order reads every
  // refusal as consent.
  const polarity: ConversationPolarity | undefined = progressInquiry
    ? undefined
    : NEGATION.test(text)
      ? "negate"
      : AFFIRMATION.test(text)
        ? "affirm"
        : undefined;
  const deixis: ConversationDeixis | undefined = DEIXIS_SAME.test(text)
    ? "same"
    : DEIXIS_PREVIOUS.test(text)
      ? "previous"
      : undefined;
  return Object.freeze({
    text,
    ...(polarity ? { polarity } : {}),
    ...(ordinalMatch ? { ordinal: Number(ordinalMatch) } : {}),
    ...(deixis ? { deixis } : {}),
    progressInquiry,
  });
}
