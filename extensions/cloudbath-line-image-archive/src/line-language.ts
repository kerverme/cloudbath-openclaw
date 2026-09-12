/**
 * LINE's Thai output policy, expressed as DATA over the shared validator.
 *
 * The script machinery that used to live here is gone: it duplicated core's
 * validator and the two drifted. Core's version catches a reply written wholly
 * in another language, which this one structurally could not — it asked the
 * output what language it was, so text containing no Thai had no Thai to be
 * inconsistent with. Repair is core's too, so the Control UI, the transcript
 * and LINE cannot each repair the same turn differently.
 *
 * What stays here is what core must never know: which language this product
 * answers in, which Latin words are its own vocabulary, the Thai wording it
 * falls back to, and that a paid confirmation code must reach the owner byte
 * for byte.
 */
import {
  finalizeReplyText,
  foreignScriptRuns,
  validateReplyLanguage,
  type TurnPresentationPolicy,
} from "openclaw/plugin-sdk/reply-language";

/**
 * Latin words this product legitimately uses inside Thai copy.
 *
 * Derived from the shipped reply strings themselves ("ทำวิดีโอจาก Storyboard
 * นี้", "draft นี้ถูกแทนที่แล้ว", "ใช้ Default Model หรือเปลี่ยน Model?"), not
 * invented. This is an allowlist of proper nouns, which is the opposite of a
 * blacklist of bad phrases: it can only ever permit MORE text through.
 */
export const LINE_PRODUCT_TERMS: readonly string[] = Object.freeze([
  "Storyboard",
  "storyboard",
  "Visual",
  "visual",
  "Model",
  "model",
  "Default",
  "default",
  "Character",
  "character",
  "Library",
  "library",
  "draft",
  "Draft",
  "VIDEO",
  "LINE",
  "GPT",
  "Cloudbath",
  "cloudbath",
  "fal.ai",
  "R2",
  "URL",
]);

/**
 * Minimal, deterministic Thai sent when no trustworthy text can be produced.
 *
 * It says only what the system can always know — that the reply did not come
 * out intact — and claims nothing about storyboards, jobs, images or state.
 */
export const LINE_SAFE_THAI_FALLBACK = "ขออภัยครับ ระบบตอบกลับไม่สมบูรณ์ กรุณาลองถามใหม่อีกครั้ง";

export type ThaiValidationOptions = Readonly<{
  /**
   * Proper nouns that may legitimately stay Latin — cast display names and
   * product/model identifiers. Supplied by the caller from the conversation's
   * OWN structured data, never accumulated here.
   */
  allowedTerms?: readonly string[];
}>;

export type ThaiTextValidation =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "contaminated"; fragments: readonly string[] }>;

/** The LINE turn policy for Thai output, with the caller's terms merged in. */
export function thaiReplyPolicy(options: ThaiValidationOptions = {}): TurnPresentationPolicy {
  return {
    expectedReplyLanguage: "th",
    expectedReplyLanguageSource: "account",
    allowedTerms: [...LINE_PRODUCT_TERMS, ...(options.allowedTerms ?? [])],
    fallbackText: LINE_SAFE_THAI_FALLBACK,
  };
}

/**
 * One structured FIELD, such as a storyboard scene description.
 *
 * Strict: a Thai caption should be Thai throughout, so a stray English word is
 * a defect there even though the same word is legitimate in a whole reply. Text
 * carrying no Thai at all is not judged, because an all-Latin field value can be
 * a declared cast name.
 */
export function validateThaiText(
  text: string,
  options: ThaiValidationOptions = {},
): ThaiTextValidation {
  const value = text.trim();
  // A field with no Thai at all is a legitimate shape — a declared cast name,
  // an identifier, an English caption — and this helper judges consistency
  // WITHIN a field, not whether the field chose the right language.
  if (!value || !isThaiText(value)) {
    return { kind: "clean" };
  }
  return judge(value, options, { requireExpectedScript: false, strictAuxiliaryScripts: true });
}

/**
 * A whole outbound REPLY, as this last-line guard can judge it.
 *
 * Accepts Latin proper nouns, product names, model refs and links inside Thai
 * prose — the convention this product's own copy follows.
 *
 * Deliberately does NOT enforce "the reply must contain Thai". Whether a wholly
 * non-Thai reply is wrong depends on the turn: a user who asked for English or a
 * translation has declared it correct, and that context lives on the agent run,
 * not in an outbound hook. Core enforces that rule where the turn policy and its
 * multilingual override are known; replacing an English answer to an English
 * request from here would be a guard overruling the user.
 */
export function validateOutboundThai(
  text: string,
  options: ThaiValidationOptions = {},
): ThaiTextValidation {
  return judge(text, options, { requireExpectedScript: false });
}

function judge(
  text: string,
  options: ThaiValidationOptions,
  mode: Parameters<typeof validateReplyLanguage>[2],
): ThaiTextValidation {
  const value = text.trim();
  if (!value) {
    return { kind: "clean" };
  }
  const verdict = validateReplyLanguage(value, thaiReplyPolicy(options), mode);
  return verdict.valid
    ? { kind: "clean" }
    : { kind: "contaminated", fragments: Object.freeze([...new Set(verdict.violatingTokens)]) };
}

/** Whether this text carries Thai at all. */
export function isThaiText(text: string): boolean {
  return validateReplyLanguage(text, thaiReplyPolicy(), {
    requireExpectedScript: true,
  }).detectedScripts.includes("Thai");
}

/**
 * Strips foreign-script runs while leaving Thai, numerals and legitimate
 * identifiers in place.
 *
 * Only used where a caller owns a single structured FIELD and can judge the
 * result itself. It is never the outbound repair: removing characters from a
 * sentence leaves grammatical text that no longer means what it said.
 */
export function stripForeignFragments(text: string, options: ThaiValidationOptions = {}): string {
  const value = text.trim();
  if (!value || !isThaiText(value)) {
    return value;
  }
  const runs = foreignScriptRuns(value, thaiReplyPolicy(options), {
    strictAuxiliaryScripts: true,
  });
  if (runs.length === 0) {
    return value;
  }
  let kept = value;
  for (const run of runs) {
    kept = kept.replaceAll(run, "");
  }
  return kept.replaceAll(/[ \t]{2,}/gu, " ").trim();
}

/**
 * A paid-confirmation code in outbound text.
 *
 * Text carrying one is never rewritten: the code is the owner's only way to
 * authorise a billable render, and replacing the message that carries it would
 * either drop it or, worse, surface a stale one. A contaminated confirmation is
 * reported and passed through unchanged rather than repaired. This protects the
 * span's own message only — it is not a blanket exemption for other replies.
 */
const VIDEO_CONFIRMATION_CODE = /\bVIDEO\s+[A-Za-z0-9]{3,}\b/u;

export type OutboundLanguageDecision =
  | Readonly<{ kind: "pass" }>
  /** Regenerated from structured fields the caller owns. */
  | Readonly<{ kind: "rebuilt"; text: string; fragments: readonly string[] }>
  /** Contaminated sentences dropped; the rest kept verbatim. */
  | Readonly<{ kind: "rewritten"; text: string; fragments: readonly string[] }>
  | Readonly<{ kind: "fallback"; text: string; fragments: readonly string[] }>
  /** Carries bytes that must reach the user exactly; reported, not repaired. */
  | Readonly<{ kind: "skipped_exact"; fragments: readonly string[] }>;

export type OutboundLanguageParams = ThaiValidationOptions &
  Readonly<{
    text: string;
    /**
     * The deterministic summary for this conversation's structured state, when
     * one exists. Called only on failure, so a clean reply costs nothing.
     */
    rebuild?: () => string | undefined;
    fallback?: string;
  }>;

/**
 * Decides what LINE should actually send.
 *
 * The judgement and the repair order are core's — regenerate from structured
 * fields, else keep the clean sentences, else the safe line — so this layer
 * cannot develop a second opinion about the same turn. All it adds is the
 * product data core is handed and the paid-code exemption above.
 */
export function guardLineOutboundText(params: OutboundLanguageParams): OutboundLanguageDecision {
  const text = params.text;
  const policy: TurnPresentationPolicy = {
    ...thaiReplyPolicy(params),
    ...(params.fallback?.trim() ? { fallbackText: params.fallback.trim() } : {}),
  };
  const verdict = validateReplyLanguage(text, policy, { requireExpectedScript: false });
  if (verdict.valid) {
    return { kind: "pass" };
  }
  const fragments = Object.freeze([...new Set(verdict.violatingTokens)]);
  if (VIDEO_CONFIRMATION_CODE.test(text)) {
    return { kind: "skipped_exact", fragments };
  }
  const finalized = finalizeReplyText({
    text,
    policy,
    ...(params.rebuild ? { regenerate: params.rebuild } : {}),
  });
  switch (finalized.repairKind) {
    case "regenerated": {
      return { kind: "rebuilt", text: finalized.text, fragments };
    }
    case "rewritten": {
      return { kind: "rewritten", text: finalized.text, fragments };
    }
    case "fallback": {
      return { kind: "fallback", text: finalized.text, fragments };
    }
    default: {
      // Core found nothing it could honestly send instead. Report it rather
      // than claim a repair; `outboundReplacementText` then sends nothing new.
      return { kind: "skipped_exact", fragments };
    }
  }
}

/** The replacement text a decision implies, or undefined to send as-is. */
export function outboundReplacementText(decision: OutboundLanguageDecision): string | undefined {
  return decision.kind === "pass" || decision.kind === "skipped_exact" ? undefined : decision.text;
}

const NAMED_SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["thai", /\p{Script=Thai}/u],
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["kannada", /\p{Script=Kannada}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["han", /\p{Script=Han}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["hiragana", /\p{Script=Hiragana}/u],
  ["katakana", /\p{Script=Katakana}/u],
  ["arabic", /\p{Script=Arabic}/u],
]);

function namedScriptOf(character: string): string {
  return NAMED_SCRIPTS.find(([, matcher]) => matcher.test(character))?.[0] ?? "other";
}

/**
 * Script classes present in the reported fragments, for logs.
 *
 * Logging the fragments themselves put a hostname into a deploy log verbatim,
 * so only the class names leave this process.
 */
export function summarizeFragmentScripts(fragments: readonly string[]): string[] {
  const scripts = new Set<string>();
  for (const fragment of fragments) {
    for (const character of fragment) {
      if (/[\p{Script=Common}\p{Script=Inherited}]/u.test(character)) {
        continue;
      }
      scripts.add(namedScriptOf(character));
    }
  }
  return [...scripts].toSorted();
}
