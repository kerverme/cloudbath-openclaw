/**
 * Whether a reply is written in the script the conversation expects.
 *
 * The expectation is DATA supplied by whichever layer owns the conversation —
 * core never guesses it, and never guesses it from the model's own output. A
 * reply written entirely in Russian answered a Thai question and passed the
 * previous guard precisely because that guard asked the output what language it
 * was: text containing no Thai has no Thai to be inconsistent with.
 *
 * Core owns the mechanism (script classification, tokenization, the incremental
 * stream scan). The channel layer owns the policy (which language, which proper
 * terms, whether this turn is deliberately multilingual). Nothing here knows
 * any product's vocabulary.
 */

/** Unicode scripts this module can name. Anything else classifies as neutral. */
const NAMED_SCRIPTS = [
  "Arabic",
  "Armenian",
  "Bengali",
  "Cyrillic",
  "Devanagari",
  "Ethiopic",
  "Georgian",
  "Greek",
  "Gujarati",
  "Gurmukhi",
  "Han",
  "Hangul",
  "Hebrew",
  "Hiragana",
  "Kannada",
  "Katakana",
  "Khmer",
  "Lao",
  "Latin",
  "Malayalam",
  "Myanmar",
  "Oriya",
  "Sinhala",
  "Tamil",
  "Telugu",
  "Thai",
  "Tibetan",
] as const;

export type ScriptName = (typeof NAMED_SCRIPTS)[number];

/**
 * Turn-level presentation policy, carried as data from channel ingress.
 *
 * `expectedReplyLanguageSource` is part of the shape so a consumer can tell a
 * configured policy from an absent one: with no expectation the validator
 * reports valid and nothing changes, which is how unconfigured deployments keep
 * today's behaviour.
 */
export type TurnPresentationPolicy = Readonly<{
  /** Primary language subtag, already normalized by the owning layer (e.g. `th`). */
  expectedReplyLanguage?: string;
  expectedReplyLanguageSource?: "group" | "account" | "none";
  /**
   * Proper nouns the owning layer permits in any script. URLs, identifiers and
   * codes do NOT belong here — those are recognized generically, so operators
   * never list model ids or links.
   */
  allowedTerms?: readonly string[];
  /**
   * This turn legitimately answers in another language — a translation or an
   * explicit "answer in X". `allowed` suspends the script expectation for the
   * turn; `language` and `reason` are carried for observability, not to swap the
   * expectation, because such a turn usually mixes framing in the configured
   * language with content in the requested one.
   */
  multilingualOverride?: Readonly<{
    allowed: boolean;
    language?: string;
    /** Why the turn was exempted. Recorded; never derived from model output. */
    reason: string;
  }>;
  /**
   * Short honest replacement in the expected language, used only when repair is
   * impossible. Core cannot author it: wording is the owning layer's.
   */
  fallbackText?: string;
}>;

export type ReplyLanguageReason =
  | "ok"
  /** No expectation configured, or one this module cannot map to a script. */
  | "no_expectation"
  /** The turn is allowed to answer in another language. */
  | "multilingual_allowed"
  /** The text carries letters but none in the expected script. */
  | "expected_script_absent"
  /** Whole words, or fragments inside a word, in a script the policy does not allow. */
  | "foreign_script";

export type ReplyLanguageValidation = Readonly<{
  valid: boolean;
  detectedScripts: readonly ScriptName[];
  violatingScripts: readonly ScriptName[];
  /** Offending words, for repair. Never log these: they are user/model content. */
  violatingTokens: readonly string[];
  reason: ReplyLanguageReason;
}>;

const SCRIPT_MATCHERS: ReadonlyArray<readonly [ScriptName, RegExp]> = NAMED_SCRIPTS.map(
  (script) => [script, new RegExp(`\\p{Script=${script}}`, "u")] as const,
);

/** Combining marks and shared punctuation/digits/emoji carry no script of their own. */
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Scripts that satisfy each language subtag.
 *
 * Grouped rather than enumerated so the table stays readable. A subtag absent
 * here yields NO expectation instead of a guess — an unmappable configured
 * value must not silently become a policy.
 */
const LANGUAGE_SCRIPTS: ReadonlyMap<string, readonly ScriptName[]> = new Map(
  (
    [
      [
        ["Latin"],
        "af ca cs cy da de en es et eu fi fr ga gl hr hu id is it lt lv ms mt nb nl no pl pt ro sk sl sq sv sw tl tr uz vi",
      ],
      [["Cyrillic"], "be bg kk ky mk mn ru sr tg uk"],
      [["Arabic"], "ar fa ps sd ug ur"],
      [["Devanagari"], "hi mr ne sa"],
      [["Hebrew"], "he yi"],
      [["Ethiopic"], "am ti"],
      [["Han", "Hiragana", "Katakana"], "ja"],
      [["Hangul", "Han"], "ko"],
      [["Han"], "yue zh"],
      [["Bengali"], "as bn"],
      [["Greek"], "el"],
      [["Armenian"], "hy"],
      [["Georgian"], "ka"],
      [["Gujarati"], "gu"],
      [["Gurmukhi"], "pa"],
      [["Kannada"], "kn"],
      [["Khmer"], "km"],
      [["Lao"], "lo"],
      [["Malayalam"], "ml"],
      [["Myanmar"], "my"],
      [["Oriya"], "or"],
      [["Sinhala"], "si"],
      [["Tamil"], "ta"],
      [["Telugu"], "te"],
      [["Thai"], "th"],
      [["Tibetan"], "bo dz"],
    ] as ReadonlyArray<readonly [readonly ScriptName[], string]>
  ).flatMap(([scripts, subtags]) => subtags.split(" ").map((subtag) => [subtag, scripts] as const)),
);

/**
 * Tokens that are identifiers rather than prose: URLs, model refs, file paths,
 * confirmation codes. Recognized generically so a policy never has to list
 * them, and protected as exact spans by repair.
 */
const TECHNICAL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~#?&=%-]*$/u;
const TECHNICAL_HINT = /[0-9._:/@]/u;

export function isTechnicalToken(token: string): boolean {
  return TECHNICAL_TOKEN.test(token) && TECHNICAL_HINT.test(token);
}

/** ASCII is most of what streams through here, and needs no property lookup. */
const ASCII_LETTER = /^[A-Za-z]$/u;

/** The script of one character, or undefined when it is neutral or unknown. */
function scriptOf(character: string): ScriptName | undefined {
  if ((character.codePointAt(0) ?? 0) < 128) {
    return ASCII_LETTER.test(character) ? "Latin" : undefined;
  }
  if (NEUTRAL.test(character)) {
    return undefined;
  }
  for (const [script, matcher] of SCRIPT_MATCHERS) {
    if (matcher.test(character)) {
      return script;
    }
  }
  return undefined;
}

/** Scripts present in one word, in first-seen order. */
function scriptsInToken(token: string): ScriptName[] {
  const scripts: ScriptName[] = [];
  for (const character of token) {
    const script = scriptOf(character);
    if (script && !scripts.includes(script)) {
      scripts.push(script);
    }
  }
  return scripts;
}

/** The scripts a language subtag accepts, or undefined when it states nothing. */
export function expectedScriptsFor(
  language: string | undefined,
): readonly ScriptName[] | undefined {
  return language ? LANGUAGE_SCRIPTS.get(language.toLowerCase()) : undefined;
}

/**
 * Removes policy-allowed proper nouns before tokenizing.
 *
 * Matched only at token boundaries. Boundaries exclude letters and digits in ANY
 * script, because an allowed term fused to another script
 * (`storyboardเรียบร้อย`) is exactly the defect being hunted and the allowlist
 * must not hide it. They also exclude identifier punctuation, so a term that
 * happens to be a prefix cannot be cut out of the middle of an identifier and
 * leave a fragment behind (`GPT` inside `gpt-5.6-luna`). Longest-first so a term
 * containing another cannot be half-consumed, and the replacement is a space so
 * a removed term cannot fuse its neighbours into one mixed-script word.
 */
function withoutAllowedTerms(text: string, allowedTerms: readonly string[] | undefined): string {
  if (!allowedTerms?.length) {
    return text;
  }
  let result = text;
  for (const term of allowedTerms.toSorted((a, b) => b.length - a.length)) {
    const trimmed = term.trim();
    if (!trimmed) {
      continue;
    }
    const escaped = trimmed.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
    result = result.replaceAll(
      new RegExp(`(?<![\\p{L}\\p{N}._:/@+~#-])${escaped}(?![\\p{L}\\p{N}._:/@+~#-])`, "giu"),
      " ",
    );
  }
  return result;
}

type ScanTally = {
  scripts: Set<ScriptName>;
  violatingScripts: Set<ScriptName>;
  violatingTokens: string[];
  /**
   * Words that are prose rather than identifiers. A reply made only of links,
   * digits and emoji states nothing about language and must not be failed for
   * lacking the expected script.
   */
  substantiveTokens: number;
  expectedPresent: boolean;
};

function emptyTally(): ScanTally {
  return {
    scripts: new Set(),
    violatingScripts: new Set(),
    violatingTokens: [],
    substantiveTokens: 0,
    expectedPresent: false,
  };
}

function cloneTally(tally: ScanTally): ScanTally {
  return {
    scripts: new Set(tally.scripts),
    violatingScripts: new Set(tally.violatingScripts),
    violatingTokens: [...tally.violatingTokens],
    substantiveTokens: tally.substantiveTokens,
    expectedPresent: tally.expectedPresent,
  };
}

/**
 * Classifies one word against the expected scripts.
 *
 * Two rules, and they differ on purpose:
 *
 * - A word that MIXES the expected script with another is always a violation.
 *   This is the corruption actually observed (`ไม่มีตัวอักษรp`, `ใช่ไಮೈ`): the
 *   model emitted a token half in the right script and half not.
 * - A word wholly in another script is a violation UNLESS that script is Latin
 *   and Latin is not itself expected. Latin is the conventional carrier of
 *   proper nouns, product names, model refs and links inside non-Latin prose,
 *   so flagging it would reject `LINE`, `gpt-5.6-luna` and `https://…` while
 *   catching nothing the first rule misses. A wholly Latin REPLY is still
 *   caught, by the separate "expected script absent" check.
 */
function tallyToken(
  token: string,
  expected: readonly ScriptName[],
  tally: ScanTally,
  strictAuxiliaryScripts = false,
): void {
  const scripts = scriptsInToken(token);
  if (scripts.length === 0) {
    return;
  }
  for (const script of scripts) {
    tally.scripts.add(script);
  }
  const technical = isTechnicalToken(token);
  if (!technical) {
    tally.substantiveTokens += 1;
  }
  const foreign = scripts.filter((script) => !expected.includes(script));
  if (foreign.length < scripts.length) {
    tally.expectedPresent = true;
  }
  if (foreign.length === 0) {
    return;
  }
  const mixesExpected = scripts.length > foreign.length;
  const latinAuxiliary =
    !strictAuxiliaryScripts &&
    !mixesExpected &&
    !expected.includes("Latin") &&
    foreign.length === 1 &&
    foreign[0] === "Latin";
  if (latinAuxiliary || (!mixesExpected && technical)) {
    return;
  }
  for (const script of foreign) {
    tally.violatingScripts.add(script);
  }
  tally.violatingTokens.push(token);
}

/** Words of a text: whitespace-separated, since many expected scripts have no word spaces. */
function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

/**
 * A growing buffer cannot yet be judged for a MISSING script: a Thai reply may
 * legitimately open with a Latin product name. Four prose words with still no
 * expected-script character is no longer a slow start, so streaming waits that
 * long while a complete text is judged immediately.
 */
const STREAM_MIN_SUBSTANTIVE_TOKENS = 4;

function buildResult(tally: ScanTally, minSubstantiveForAbsent: number): ReplyLanguageValidation {
  const detectedScripts = [...tally.scripts].toSorted();
  if (tally.violatingTokens.length > 0) {
    return {
      valid: false,
      detectedScripts,
      violatingScripts: [...tally.violatingScripts].toSorted(),
      violatingTokens: tally.violatingTokens,
      reason: "foreign_script",
    };
  }
  if (!tally.expectedPresent && tally.substantiveTokens >= minSubstantiveForAbsent) {
    return {
      valid: false,
      detectedScripts,
      violatingScripts: detectedScripts,
      violatingTokens: [],
      reason: "expected_script_absent",
    };
  }
  return {
    valid: true,
    detectedScripts,
    violatingScripts: [],
    violatingTokens: [],
    reason: "ok",
  };
}

const NO_EXPECTATION: ReplyLanguageValidation = Object.freeze({
  valid: true,
  detectedScripts: Object.freeze([]),
  violatingScripts: Object.freeze([]),
  violatingTokens: Object.freeze([]),
  reason: "no_expectation",
});

export type ValidateReplyLanguageOptions = Readonly<{
  /**
   * Whether text containing none of the expected script fails.
   *
   * True (the default) for a whole reply: answering a Thai turn entirely in
   * another language is the failure this exists to catch. False for a caller
   * holding ONE structured field, where an all-Latin value can be a legitimate
   * name and only mixing inside the field is a defect.
   */
  requireExpectedScript?: boolean;
  /**
   * Whether Latin loses its auxiliary status.
   *
   * False (the default) suits a whole reply: Latin carries proper nouns, product
   * names, model refs and links inside non-Latin prose, so rejecting unlisted
   * English words would reject correct replies. True suits ONE structured field
   * that should be written in the expected language throughout — a scene
   * description in Thai is not the place for a stray English word — where only
   * declared terms and identifier shapes may stay Latin.
   */
  strictAuxiliaryScripts?: boolean;
}>;

/** Validates one complete text against a turn policy. */
export function validateReplyLanguage(
  text: string,
  policy: TurnPresentationPolicy | undefined,
  options: ValidateReplyLanguageOptions = {},
): ReplyLanguageValidation {
  const expected = expectedScriptsFor(policy?.expectedReplyLanguage);
  if (!expected) {
    return NO_EXPECTATION;
  }
  if (policy?.multilingualOverride?.allowed) {
    return { ...NO_EXPECTATION, reason: "multilingual_allowed" };
  }
  const tally = emptyTally();
  for (const token of tokenize(withoutAllowedTerms(text, policy?.allowedTerms))) {
    tallyToken(token, expected, tally, options.strictAuxiliaryScripts === true);
  }
  return buildResult(tally, options.requireExpectedScript === false ? Infinity : 1);
}

/**
 * Foreign-script runs inside the text, as substrings.
 *
 * For a caller that owns ONE structured field and can judge the result itself.
 * Never a repair for prose: removing runs from a sentence leaves grammatical
 * text that no longer means what it said.
 */
export function foreignScriptRuns(
  text: string,
  policy: TurnPresentationPolicy | undefined,
  options: ValidateReplyLanguageOptions = {},
): readonly string[] {
  const expected = expectedScriptsFor(policy?.expectedReplyLanguage);
  if (!expected) {
    return [];
  }
  const runs: string[] = [];
  for (const token of tokenize(withoutAllowedTerms(text, policy?.allowedTerms))) {
    const tally = emptyTally();
    tallyToken(token, expected, tally, options.strictAuxiliaryScripts === true);
    if (tally.violatingTokens.length === 0) {
      continue;
    }
    // Only the offending runs, so a mixed token loses its foreign part and
    // keeps the expected-script part exactly as written.
    let current = "";
    let currentForeign = false;
    for (const character of token) {
      const script = scriptOf(character);
      const foreign = script !== undefined && !expected.includes(script);
      if (current && foreign !== currentForeign) {
        if (currentForeign) {
          runs.push(current);
        }
        current = "";
      }
      currentForeign = foreign;
      current += character;
    }
    if (current && currentForeign) {
      runs.push(current);
    }
  }
  return runs.filter((run) => run.trim().length > 0);
}

/**
 * Incremental state for validating a growing stream buffer.
 *
 * Re-classifying the whole buffer on every delta is quadratic over a turn. The
 * scanner keeps the prefix it has already classified plus the script tally, and
 * on an append only classifies the new words. A buffer that is REWRITTEN rather
 * than appended to (the projection can rewrite earlier text) fails the prefix
 * check and is rescanned in full, so the result never depends on arrival shape.
 */
export type ReplyLanguageScanner = Readonly<{
  /** Validates the cumulative buffer. Callers pass the whole buffer every time. */
  push(cumulativeText: string): ReplyLanguageValidation;
}>;

export function createReplyLanguageScanner(
  policy: TurnPresentationPolicy | undefined,
): ReplyLanguageScanner {
  const expectedScripts = expectedScriptsFor(policy?.expectedReplyLanguage);
  if (!expectedScripts || policy?.multilingualOverride?.allowed) {
    const constant: ReplyLanguageValidation = expectedScripts
      ? { ...NO_EXPECTATION, reason: "multilingual_allowed" }
      : NO_EXPECTATION;
    return { push: () => constant };
  }
  const expected = expectedScripts;
  let scannedPrefix = "";
  let tally = emptyTally();
  return {
    push(cumulativeText: string): ReplyLanguageValidation {
      const text = withoutAllowedTerms(cumulativeText, policy?.allowedTerms);
      if (!text.startsWith(scannedPrefix)) {
        scannedPrefix = "";
        tally = emptyTally();
      }
      const pending = text.slice(scannedPrefix.length);
      const tokens = tokenize(pending);
      // The trailing word may still be growing, so classify it for this result
      // but do not retire it into the scanned prefix.
      const endsMidWord = pending.length > 0 && !/\s$/u.test(pending);
      const settled = endsMidWord ? tokens.slice(0, -1) : tokens;
      for (const token of settled) {
        tallyToken(token, expected, tally);
      }
      const trailing = endsMidWord ? tokens.at(-1) : undefined;
      if (settled.length > 0 || !endsMidWord) {
        const retire = trailing ? text.length - trailing.length : text.length;
        scannedPrefix = text.slice(0, retire);
      }
      if (!trailing) {
        return buildResult(tally, STREAM_MIN_SUBSTANTIVE_TOKENS);
      }
      const withTrailing = cloneTally(tally);
      tallyToken(trailing, expected, withTrailing);
      return buildResult(withTrailing, STREAM_MIN_SUBSTANTIVE_TOKENS);
    },
  };
}
