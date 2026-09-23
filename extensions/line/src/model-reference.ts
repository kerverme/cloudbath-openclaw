/**
 * The model a LINE conversation just established, for its follow-ups.
 *
 * After "มี GPT-5.6 Luna ไหม" is answered, "เปลี่ยนให้หน่อย" names no model:
 * neither the model-state classifier nor the switch router can read one out
 * of it, so it went to the referent resolver and the agent, which guessed.
 * The answer now leaves a short-lived reference -- exact catalog ids and
 * names only, never model-written text -- and a follow-up made only of
 * switch/affirm/decline words and pointers ("ตัวนี้", "it") resolves against
 * it deterministically.
 */
import { catalogModelLabel } from "./model-catalog-lookup.js";

export const LINE_MODEL_REFERENCE_NAMESPACE = "model-reference-v1";
export const LINE_MODEL_REFERENCE_MAX_ENTRIES = 5_000;
/** How long an answer can be acted on by "เปลี่ยนให้หน่อย". */
export const LINE_MODEL_REFERENCE_TTL_MS = 5 * 60 * 1000;
/**
 * How long an expired reference is kept. A late follow-up is then asked
 * "which model?" instead of being handed to the agent to guess; after this
 * the conversation is no longer about models at all.
 */
export const LINE_MODEL_REFERENCE_RETENTION_MS = 30 * 60 * 1000;

export type LineReferencedModel = { id: string; name: string };

export type LineModelReference = {
  version: 1;
  scopeKey: string;
  /**
   * available: the question named exactly this catalog model.
   * suggested: the asked model is not in the catalog; this is a similar one.
   * offered: "switch to X?" was asked, so a plain "yes" may switch to X.
   * ambiguous: several models, or none, were established.
   */
  status: "available" | "suggested" | "offered" | "ambiguous";
  /** The owner's own wording that was looked up, for the confirmation question. */
  asked?: string;
  models: LineReferencedModel[];
  createdAt: number;
};

export type LineModelFollowUp = "switch" | "affirm" | "decline";

export type LineModelFollowUpDecision =
  | { kind: "switch"; model: LineReferencedModel }
  | { kind: "offer"; model: LineReferencedModel; asked?: string }
  | { kind: "clarify"; models: readonly LineReferencedModel[] }
  | { kind: "decline" };

// A follow-up is made only of these. Removing them must leave nothing:
// "เปลี่ยนเพลงให้หน่อย" leaves "เพลง" behind, so it is about a song, not a model.
const THAI_SWITCH = ["เปลี่ยน", "สลับ", "ใช้", "เอา"];
const THAI_AFFIRM = ["ใช่", "โอเค", "ตกลง", "จัดไป", "ได้"];
const THAI_DECLINE = ["ไม่เป็นไร", "ไม่เอา", "ไม่ต้อง", "ยกเลิก", "ไม่"];
const THAI_FILLER = [
  "ให้หน่อย",
  "หน่อย",
  "ให้",
  "เลย",
  "ด้วย",
  "นะ",
  "ครับ",
  "ค่ะ",
  "คะ",
  "จ้า",
  "จ้ะ",
  "เป็น",
  "งั้น",
  "ก็",
  "แล้ว",
  "ตามนั้น",
  "ตัวนี้",
  "ตัวนั้น",
  "ตัวที่ว่า",
  "อันนี้",
  "อันนั้น",
  "อันที่ว่า",
  "รุ่นนี้",
  "รุ่นนั้น",
  "รุ่นที่ว่า",
  "โมเดลนี้",
  "โมเดลนั้น",
  // "ทำไมเปลี่ยนเองไม่ได้ ใช้ผ่าน openrouter" asks for the same switch.
  "ทำไม",
  "เอง",
  "ไม่ได้",
  "ได้ไหม",
  "ได้มั้ย",
  "ไหม",
  "มั้ย",
  "ผ่าน",
];
const THAI_WORDS = [...THAI_SWITCH, ...THAI_AFFIRM, ...THAI_DECLINE, ...THAI_FILLER].toSorted(
  (left, right) => right.length - left.length,
);
const ENGLISH_SWITCH = new Set(["switch", "change", "use", "take", "pick", "want"]);
const ENGLISH_AFFIRM = new Set(["yes", "yeah", "yep", "sure", "ok", "okay"]);
const ENGLISH_WORDS = new Set([
  ...ENGLISH_SWITCH,
  ...ENGLISH_AFFIRM,
  "no",
  "nope",
  "cancel",
  "don't",
  "dont",
  "not",
  "never",
  "mind",
  "to",
  "it",
  "this",
  "that",
  "one",
  "the",
  "model",
  "please",
  "then",
  "now",
  "just",
  "do",
  "can",
  "could",
  "you",
  "i",
  "me",
  "for",
  "go",
  "with",
  "let's",
  "lets",
  "why",
  "can't",
  "cant",
  "cannot",
  "via",
  "through",
  "on",
  "openrouter",
]);
const DECLINE =
  /^(?:ไม่|ยกเลิก|no\b|nope\b|cancel\b|don'?t\b|not\b|never\s+mind)|ไม่ใช่|ไม่(?:ต้อง)?(?:เปลี่ยน|สลับ|ใช้|เอา)/iu;
// "ได้" and "ใช่" are a yes only when not negated ("ไม่ได้", "ไม่ใช่") or asked.
const THAI_AFFIRMATION = /(?<!ไม่)ใช่|โอเค|ตกลง|จัดไป|(?<!ไม่)ได้(?!ไหม|มั้ย)/u;
const QUESTION = /ไหม|มั้ย|\?/u;

/**
 * Deterministically classifies a message as a follow-up to the model just
 * discussed. Only a message with nothing left over after removing the
 * follow-up vocabulary counts, so it never names a model or anything else.
 */
export function classifyLineModelFollowUp(rawText: string): LineModelFollowUp | undefined {
  const text = rawText.trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  let rest = text;
  for (const word of THAI_WORDS) {
    rest = rest.split(word).join(" ");
  }
  const tokens = rest.split(/[\s.,!?"~…]+/u).filter(Boolean);
  if (tokens.some((token) => !ENGLISH_WORDS.has(token))) {
    return undefined;
  }
  const englishTokens = text.split(/[\s.,!?"~…]+/u);
  if (DECLINE.test(text)) {
    return "decline";
  }
  if (
    THAI_SWITCH.some((word) => text.includes(word)) ||
    englishTokens.some((token) => ENGLISH_SWITCH.has(token))
  ) {
    return "switch";
  }
  const affirms =
    THAI_AFFIRMATION.test(text) || englishTokens.some((token) => ENGLISH_AFFIRM.has(token));
  return affirms && !QUESTION.test(text) ? "affirm" : undefined;
}

/**
 * What a follow-up does with the stored reference. Only an exact AVAILABLE
 * model on a switch request, or a model the owner was explicitly asked about,
 * is switched; a mere suggestion is first offered as a question.
 */
export function decideLineModelFollowUp(params: {
  reference: LineModelReference;
  followUp: LineModelFollowUp;
  now: number;
}): LineModelFollowUpDecision {
  const { reference, followUp } = params;
  if (followUp === "decline") {
    return { kind: "decline" };
  }
  if (reference.createdAt + LINE_MODEL_REFERENCE_TTL_MS <= params.now) {
    return { kind: "clarify", models: [] };
  }
  const [model] = reference.models;
  if (!model || reference.models.length > 1 || reference.status === "ambiguous") {
    return { kind: "clarify", models: reference.models };
  }
  if (
    reference.status === "offered" ||
    (reference.status === "available" && followUp === "switch")
  ) {
    return { kind: "switch", model };
  }
  return reference.status === "suggested" && reference.asked
    ? { kind: "offer", model, asked: reference.asked }
    : { kind: "offer", model };
}

function bullets(models: readonly LineReferencedModel[]): string {
  return models.map((model) => `• ${catalogModelLabel(model)}`).join("\n");
}

/** The deterministic reply for every follow-up outcome except a performed switch. */
export function formatLineModelFollowUpReply(
  decision: Exclude<LineModelFollowUpDecision, { kind: "switch" }>,
  thai: boolean,
): string {
  if (decision.kind === "offer") {
    const label = catalogModelLabel(decision.model);
    if (thai) {
      return decision.asked
        ? `ไม่มี "${decision.asked}" ในแคตตาล็อก OpenRouter ของบัญชีนี้ แต่มี ${label}\nต้องการเปลี่ยนเป็น ${decision.model.name} ไหมครับ?`
        : `ต้องการเปลี่ยนเป็น ${label} ไหมครับ?`;
    }
    return decision.asked
      ? `"${decision.asked}" is not in this account's OpenRouter catalog, but ${label} is.\nSwitch to ${decision.model.name}?`
      : `Switch to ${label}?`;
  }
  if (decision.kind === "clarify") {
    const choices = decision.models.length > 0 ? `\n${bullets(decision.models)}` : "";
    if (thai) {
      return `ต้องการเปลี่ยนเป็นโมเดลไหนครับ?${choices}${choices ? '\nพิมพ์ "เปลี่ยนเป็น <ชื่อรุ่น>" ได้เลย' : ""}`;
    }
    return `Which model should I switch to?${choices}${choices ? '\nSend "switch to <model name>".' : ""}`;
  }
  return thai ? "โอเคครับ ไม่เปลี่ยนโมเดล" : "OK, the model stays as it is.";
}
