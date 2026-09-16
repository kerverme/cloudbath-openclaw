/**
 * Script-consistency validation and repair for assistant text going to LINE.
 *
 * The rule is general — a run of another script sitting inside Thai prose with
 * nothing legitimising it — rather than a list of phrases anyone happened to
 * see. A phrase list only catches the fragments already observed; this catches
 * the SHAPE of the defect, which is what kept reappearing: Cyrillic in one
 * reply, a stray Latin letter welded onto a Thai word in the next.
 *
 * What stays legitimate is named, not guessed: proper nouns the conversation
 * itself declares, this product's own vocabulary, technical identifiers, and
 * URLs. Everything else foreign to the sentence is contamination.
 *
 * This module owns no storyboard concept. It is the language floor for every
 * assistant-authored LINE message; `storyboard-language.ts` builds on it for
 * the one surface that can regenerate its text from structured fields.
 */

/** Scripts a run of characters can belong to, for consistency purposes. */
type ScriptClass = "thai" | "latin" | "common" | "other";

const THAI = /\p{Script=Thai}/u;
const LATIN = /\p{Script=Latin}/u;
/** Digits, punctuation, spaces, symbols — legitimate in any language. */
const COMMON = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * A Latin run that reads as a technical identifier rather than a word.
 *
 * Model and product ids (`gpt-5.6-luna`, `sonnet-4.6`, `LINE`, `R2`) stay
 * Latin in Thai copy by convention. Requiring a digit, an internal separator,
 * or all-caps keeps this to identifier SHAPES instead of "any English word".
 */
const TECHNICAL_IDENTIFIER =
  /^(?:[A-Za-z][A-Za-z0-9]*[-._/][A-Za-z0-9.\-_/]*|[A-Z0-9]{2,}|\d+[A-Za-z]+|[A-Za-z]+\d[A-Za-z0-9]*)$/u;

/**
 * A URL or bare host.
 *
 * Checked before the identifier shape because a URL carries `:` and `//`,
 * which no identifier pattern accepts — without this a perfectly good link in
 * a Thai sentence was reported as contamination and the whole reply replaced.
 * URLs must survive byte-identical: a repaired link is a broken link.
 */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)\S+$/iu;

/**
 * Latin words this product legitimately uses inside Thai copy.
 *
 * Derived from the shipped reply strings themselves ("ทำวิดีโอจาก Storyboard
 * นี้", "draft นี้ถูกแทนที่แล้ว", "ใช้ Default Model หรือเปลี่ยน Model?"), not
 * invented. Without it a script-consistency check would call the product's own
 * vocabulary contamination and rewrite correct messages — including paid video
 * copy. This is an allowlist of proper nouns, which is the opposite of a
 * blacklist of bad phrases: it can only ever permit MORE text through.
 */
export const LINE_PRODUCT_TERMS: readonly string[] = Object.freeze([
  "Storyboard",
  "storyboard",
  "Visual",
  "Previs",
  "VIDEO",
  "Video",
  "video",
  "AUDIO",
  "Audio",
  "Draft",
  "draft",
  "Final",
  "Model",
  "model",
  "Default",
  "Character",
  "Library",
  "UGC",
  "LINE",
  "GPT",
  "workspace",
  "fal.ai",
]);

function scriptOf(character: string): ScriptClass {
  if (THAI.test(character)) {
    return "thai";
  }
  if (LATIN.test(character)) {
    return "latin";
  }
  if (COMMON.test(character)) {
    return "common";
  }
  return "other";
}

/** Splits text into maximal runs of one script class, keeping order. */
function scriptRuns(text: string): readonly Readonly<{ script: ScriptClass; text: string }>[] {
  const runs: { script: ScriptClass; text: string }[] = [];
  for (const character of text) {
    const script = scriptOf(character);
    const last = runs.at(-1);
    if (last?.script === script) {
      last.text += character;
    } else {
      runs.push({ script, text: character });
    }
  }
  return runs;
}

export type ThaiTextValidation =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "contaminated"; fragments: readonly string[] }>;

export type ThaiValidationOptions = Readonly<{
  /**
   * Proper nouns that may legitimately stay Latin — cast display names and
   * product/model identifiers. Supplied by the caller from the conversation's
   * OWN structured data, never accumulated here.
   */
  allowedTerms?: readonly string[];
}>;

/**
 * Foreign fragments inside ONE whitespace-delimited token.
 *
 * Judged per token rather than per script run because identifiers carry their
 * own separators: `gpt-5.6-luna` is three Latin runs around digits and dashes,
 * and scoring those runs separately reported a legitimate model name as two
 * contaminating words.
 */
function foreignFragmentsInToken(token: string, allowed: ReadonlySet<string>): string[] {
  const value = token.trim();
  if (!value) {
    return [];
  }
  const legitimate = (fragment: string) =>
    allowed.has(fragment.toLowerCase()) ||
    URL_LIKE.test(fragment) ||
    TECHNICAL_IDENTIFIER.test(fragment);
  if (!THAI.test(value)) {
    // A standalone non-Thai token: a whole word, name, identifier or link.
    // Test the raw token before trimming punctuation so a trailing "/" or "?"
    // in a URL does not change the verdict.
    if (URL_LIKE.test(value)) {
      return [];
    }
    const bare = value.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!bare || !/\p{L}/u.test(bare)) {
      return [];
    }
    return legitimate(bare) ? [] : [bare];
  }
  // Mixed inside one token (e.g. Thai glued to Latin): score the foreign runs.
  return scriptRuns(value)
    .filter((run) => run.script === "other" || (run.script === "latin" && !legitimate(run.text)))
    .map((run) => run.text.trim())
    .filter(Boolean);
}

/**
 * Reports foreign-script fragments inside Thai text.
 *
 * Text with no Thai at all is not judged: a reply that is only a model name or
 * an English sentence is a legitimate shape, and this layer decides
 * consistency, not language choice.
 */
export function validateThaiText(
  text: string,
  options: ThaiValidationOptions = {},
): ThaiTextValidation {
  const value = text.trim();
  if (!value || !THAI.test(value)) {
    return { kind: "clean" };
  }
  const allowed = new Set((options.allowedTerms ?? []).map((term) => term.trim().toLowerCase()));
  const fragments = value
    .split(/\s+/u)
    .flatMap((token) => foreignFragmentsInToken(token, allowed))
    .filter(Boolean);
  return fragments.length === 0
    ? { kind: "clean" }
    : { kind: "contaminated", fragments: Object.freeze([...new Set(fragments)]) };
}

/** Whether a conversation should be held to Thai output consistency. */
export function isThaiText(text: string): boolean {
  return THAI.test(text);
}

/**
 * Strips foreign-script fragments while leaving Thai, numerals and legitimate
 * identifiers in place.
 *
 * Only used where a caller owns a single structured FIELD and can judge the
 * result itself. It is never the outbound repair: removing characters from a
 * sentence leaves grammatical text that no longer means what it said.
 */
export function stripForeignFragments(text: string, options: ThaiValidationOptions = {}): string {
  const value = text.trim();
  if (!value || !THAI.test(value)) {
    return value;
  }
  const allowed = new Set((options.allowedTerms ?? []).map((term) => term.trim().toLowerCase()));
  return value
    .split(/(\s+)/u)
    .map((token) => {
      if (!token.trim()) {
        return token;
      }
      const fragments = foreignFragmentsInToken(token, allowed);
      if (fragments.length === 0) {
        return token;
      }
      // Whole-token contamination drops the token; embedded runs drop in place.
      let kept = token;
      for (const fragment of fragments) {
        kept = kept.replaceAll(fragment, "");
      }
      return kept.trim();
    })
    .join("")
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();
}

/**
 * Splits text into the units a rewrite may drop.
 *
 * Lines, then sentence-terminated runs. Deliberately NOT words: dropping below
 * sentence level is the character-stripping this layer exists to avoid, and a
 * single unpunctuated sentence is therefore one indivisible unit that either
 * survives whole or sends the message to the fallback.
 */
function languageSegments(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/u))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Rebuilds the message from the segments that are already clean.
 *
 * This is the generic repair for prose that has no structured source to
 * regenerate from: the contaminated sentence goes, the rest is kept verbatim,
 * and nothing is invented. Returns undefined when no segment survives, or when
 * what survives carries no Thai and so no longer answers a Thai turn.
 */
export function rewriteWithoutContaminatedSegments(
  text: string,
  options: ThaiValidationOptions = {},
): string | undefined {
  const segments = languageSegments(text);
  if (segments.length < 2) {
    // One segment means the only thing to drop is the whole message.
    return undefined;
  }
  const kept = segments.filter((segment) => validateThaiText(segment, options).kind === "clean");
  if (kept.length === 0) {
    return undefined;
  }
  const rewritten = kept.join("\n");
  return isThaiText(rewritten) ? rewritten : undefined;
}

/**
 * Minimal, deterministic Thai sent when no trustworthy text can be produced.
 *
 * It says only what the system can always know — that the reply did not come
 * out intact — and claims nothing about storyboards, jobs or state.
 */
export const LINE_SAFE_THAI_FALLBACK = "ขออภัยครับ ระบบตอบกลับไม่สมบูรณ์ กรุณาลองถามใหม่อีกครั้ง";

/**
 * A paid-confirmation code in outbound text.
 *
 * Text carrying one is never rewritten: the code is the owner's only way to
 * authorise a billable render, and replacing the message that carries it would
 * either drop it or, worse, surface a stale one. A contaminated confirmation is
 * reported and passed through unchanged rather than repaired.
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
 * Repair order is most faithful first: regenerate from structured fields, else
 * keep the clean sentences, else say nothing beyond the safe line. Returns
 * `pass` for everything it does not positively judge wrong, so a reply this
 * layer does not understand is never altered.
 */
export function guardLineOutboundText(params: OutboundLanguageParams): OutboundLanguageDecision {
  const text = params.text;
  const options: ThaiValidationOptions = params.allowedTerms
    ? { allowedTerms: params.allowedTerms }
    : {};
  const verdict = validateThaiText(text, options);
  if (verdict.kind === "clean") {
    return { kind: "pass" };
  }
  if (VIDEO_CONFIRMATION_CODE.test(text)) {
    return { kind: "skipped_exact", fragments: verdict.fragments };
  }
  const rebuilt = params.rebuild?.()?.trim();
  if (rebuilt && validateThaiText(rebuilt, options).kind === "clean") {
    return { kind: "rebuilt", text: rebuilt, fragments: verdict.fragments };
  }
  const rewritten = rewriteWithoutContaminatedSegments(text, options);
  if (rewritten && validateThaiText(rewritten, options).kind === "clean") {
    return { kind: "rewritten", text: rewritten, fragments: verdict.fragments };
  }
  return {
    kind: "fallback",
    text: params.fallback?.trim() || LINE_SAFE_THAI_FALLBACK,
    fragments: verdict.fragments,
  };
}

/** The replacement text a decision implies, or undefined to send as-is. */
export function outboundReplacementText(decision: OutboundLanguageDecision): string | undefined {
  return decision.kind === "pass" || decision.kind === "skipped_exact" ? undefined : decision.text;
}

/**
 * Names the Unicode scripts a set of fragments belongs to, with counts.
 *
 * Diagnostics need to know WHICH script leaked and how often, never the text:
 * a contaminated reply can carry hostnames, paths or user content, and logging
 * the fragments verbatim republishes exactly what the guard just withheld.
 */
export function summarizeFragmentScripts(
  fragments: readonly string[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const fragment of fragments) {
    const scripts = new Set<string>();
    // for..of over a string, matching `scriptRuns` above: code-point iteration
    // is what script classification wants, and spreading would trip the
    // emoji-splitting lint for no gain.
    for (const character of fragment) {
      scripts.add(namedScriptOf(character));
    }
    for (const script of scripts) {
      counts[script] = (counts[script] ?? 0) + 1;
    }
  }
  return Object.freeze(counts);
}

/** Coarse script name for one character, for diagnostics only. */
function namedScriptOf(character: string): string {
  for (const [name, pattern] of NAMED_SCRIPTS) {
    if (pattern.test(character)) {
      return name;
    }
  }
  return scriptOf(character) === "common" ? "common" : "other";
}

/**
 * Scripts worth naming in a log line. Ordered, so the first match wins and a
 * character is counted once.
 */
const NAMED_SCRIPTS: readonly (readonly [string, RegExp])[] = Object.freeze([
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
] as const);
