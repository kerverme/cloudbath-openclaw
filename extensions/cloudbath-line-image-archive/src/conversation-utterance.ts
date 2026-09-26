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

/**
 * The same markers dating ordinary talk rather than pointing back at work.
 *
 * "อาทิตย์ที่แล้ว", "ข่าวล่าสุด" and "last week" are when, not which: after a
 * unit of time the marker is part of a date, and a message about the news is
 * not about anything this flow made. Left in, they read as a reference back
 * and ordinary chat was answered with "which work do you mean?".
 */
const DATED_RECENCY =
  /(?:วัน|อาทิตย์|สัปดาห์|เดือน|ปี|ชั่วโมง|นาที|เทอม|ไตรมาส)\s*(?:ที่แล้ว|ก่อนหน้า(?:นี้)?|ล่าสุด)|เดิมที|\b(?:last|previous|past)\s+(?:week|weekend|month|year|night|day|hour)s?\b/giu;
const NEWS_TOPIC = /ข่าว|\b(?:news|headlines?)\b/iu;

/**
 * Recency of RECORDS rather than of work: "รายจ่ายล่าสุด", "ยอดล่าสุด",
 * "latest invoice". Production answered "รายจ่ายล่าสุดคืออะไร" with "which
 * Character or VIDEO do you mean?". The noun, not the marker, decides: "อันล่าสุด",
 * "รูปล่าสุด" and "storyboard ล่าสุด" still point back at work.
 */
const DATA_RECENCY =
  /(?:รายจ่าย|รายรับ|ค่าใช้จ่าย|ยอด(?:เงิน|รวม)?|รายการ|ธุรกรรม|ใบแจ้งหนี้|ใบเสร็จ|บิล|cash\s*flow|invoices?|expenses?|transactions?|payments?)\s*(?:ที่)?\s*(?:ล่าสุด|ก่อนหน้า(?:นี้)?|ที่แล้ว)|\b(?:last|latest|most\s+recent|previous)\s+(?:expenses?|transactions?|invoices?|payments?|records?|entries|rows?|cash\s*flow)\b/giu;

/** A bare number: the one unambiguous way to pick from a numbered menu. */
const BARE_ORDINAL = /^(\d{1,2})$/u;

/**
 * Asking to SEE the work rendered, rather than to read it.
 *
 * A class, not a feature list: an image noun plus any request verb. "ทำภาพ
 * แต่ละช็อต", "เอาภาพมาดูก่อน" and "show me the pictures" are one way of
 * speaking, and the arbiter — not this module — decides which work it is about.
 */
const IMAGE_NOUN = /ภาพ|รูป|\bimages?\b|\bpictures?\b|\bvisuals?\b|\bshots?\b/iu;
const REQUEST_VERB =
  /ทำ|สร้าง|ขอ|เอา|วาด|ดู|โชว์|อยาก|ต้องการ|\b(?:make|create|generate|draw|show|see|render|want|need|would\s+like)\b/iu;

/**
 * "Carry on with what we are already doing."
 *
 * Carries no object of its own, which is exactly why it needs the conversation
 * context to mean anything — and why it must never be read as consent to spend.
 */
/**
 * Asking for a video to be made, without yet saying enough to make one.
 *
 * The class exists so the storyboard flow can CLAIM such a turn: an owner video
 * request is storyboard-first work in every conversation, and letting it fall
 * through is how it reached a single-shot legacy draft instead.
 */
const VIDEO_NOUN = /วิดีโอ|วีดีโอ|คลิป|หนัง|\bvideos?\b|\bclips?\b|\bmovies?\b/iu;

const CONTINUATION =
  /ทำต่อ|ต่อเลย|ไปต่อ|เอาต่อ|ต่อได้เลย|\b(?:continue|carry\s+on|go\s+on|keep\s+going|next\s+step)\b/iu;

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
  /** Asking to see the current work as images. */
  visualRequest: boolean;
  /** Asking to proceed with the current work, naming nothing. */
  continuation: boolean;
  /** Asking for a video to be made. */
  videoRequest: boolean;
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
  const deicticText = text.replace(DATED_RECENCY, " ").replace(DATA_RECENCY, " ");
  const deixis: ConversationDeixis | undefined = DEIXIS_SAME.test(deicticText)
    ? "same"
    : DEIXIS_PREVIOUS.test(deicticText) && !NEWS_TOPIC.test(text)
      ? "previous"
      : undefined;
  // A negation is never a request to render or to proceed: "ไม่เอาภาพ" asks for
  // the opposite of both, and reading it either way would act against the owner.
  const affirmative = polarity !== "negate" && !progressInquiry;
  return Object.freeze({
    text,
    ...(polarity ? { polarity } : {}),
    ...(ordinalMatch ? { ordinal: Number(ordinalMatch) } : {}),
    ...(deixis ? { deixis } : {}),
    progressInquiry,
    visualRequest: affirmative && IMAGE_NOUN.test(text) && REQUEST_VERB.test(text),
    continuation: affirmative && CONTINUATION.test(text),
    videoRequest: affirmative && VIDEO_NOUN.test(text) && REQUEST_VERB.test(text),
  });
}
