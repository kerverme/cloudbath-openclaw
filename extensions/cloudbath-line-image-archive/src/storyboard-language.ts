/**
 * Output language validation for storyboard text.
 *
 * The planner prompt is English-framed and never constrained its OUTPUT
 * language, so a Thai request produced Thai prose carrying stray Latin (and
 * occasionally other-script) fragments, which was then persisted into the
 * document and echoed to LINE.
 *
 * This validates a general property — script consistency — rather than
 * matching known bad phrases. A phrase list only ever catches the fragments
 * someone already saw; the rule below catches the shape of the defect: a run
 * of another script sitting inside Thai prose with nothing legitimising it.
 *
 * What stays legitimate is named, not guessed: proper nouns the storyboard
 * itself declares (cast display names) and technical product/model
 * identifiers. Everything else foreign to the sentence is contamination.
 */
import type { StoryboardBeatKind } from "./storyboard-types.js";

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
   * product/model identifiers. Supplied by the caller from the storyboard's
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
    allowed.has(fragment.toLowerCase()) || TECHNICAL_IDENTIFIER.test(fragment);
  if (!THAI.test(value)) {
    // A standalone non-Thai token: a whole word, name or identifier.
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
 * Text with no Thai at all is not judged: a caption that is only a model name
 * is a legitimate shape, and this layer decides consistency, not language
 * choice.
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
 * This is the LAST resort, used only where there is no structured field to
 * regenerate from. It removes, never transliterates: turning Thai into Latin
 * would destroy the very property this module protects.
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

/** The structured facts a Thai scene line is built from. */
export type StoryboardSummaryBeat = Readonly<{
  shotIndex: number;
  startSeconds: number;
  endSeconds: number;
  kind: StoryboardBeatKind;
  action: string;
  caption?: string;
  characterNames?: readonly string[];
}>;

/** Fixed Thai wording per beat kind. A closed union, so no beat can invent one. */
const KIND_LABEL: Readonly<Record<StoryboardBeatKind, string>> = Object.freeze({
  establishing: "ปูฉาก",
  locomotion: "เคลื่อนไหว",
  transition: "เปลี่ยนฉาก",
  dialogue: "บทพูด",
  action: "แอ็กชัน",
});

/**
 * Builds the owner-facing Thai scene list from STRUCTURED fields.
 *
 * Preferred over echoing planner prose because every part except the scene
 * description is a fixed Thai template or a number, so the only text that can
 * carry contamination is the one field validated and repaired below. Scene
 * ids, timings and cast names pass through untouched — this renames nothing.
 */
export function buildThaiStoryboardSummary(
  beats: readonly StoryboardSummaryBeat[],
  options: ThaiValidationOptions = {},
): string {
  return beats
    .map((beat) => {
      const description = repairThaiFragment(beat.caption?.trim() || beat.action, options);
      const cast = beat.characterNames?.length ? ` (${beat.characterNames.join(", ")})` : "";
      return `ฉาก ${beat.shotIndex} · ${beat.startSeconds}-${beat.endSeconds} วิ · ${KIND_LABEL[beat.kind]}${cast}\n${description}`;
    })
    .join("\n\n");
}

/**
 * Returns Thai text safe to show, repairing it when contaminated.
 *
 * Repair strips foreign fragments rather than rewriting the sentence, so the
 * scene still says what the owner's storyboard says. When stripping would
 * leave nothing meaningful the caller gets an empty string and should fall
 * back to a structured field instead of showing garbage.
 */
export function repairThaiFragment(text: string, options: ThaiValidationOptions = {}): string {
  const value = text.trim();
  if (validateThaiText(value, options).kind === "clean") {
    return value;
  }
  return stripForeignFragments(value, options);
}

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
export const STORYBOARD_PRODUCT_TERMS: readonly string[] = Object.freeze([
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

/**
 * The owner-facing Thai scene list for a whole version, or undefined when this
 * storyboard is not Thai.
 *
 * One implementation shared by the tool result and the outbound guard: if the
 * relay ever rebuilt a different summary than the tool advertised, the owner
 * would see the text change for no reason they can observe.
 */
export function thaiSummaryForVersion(version: {
  document: {
    beats: readonly Readonly<{
      startSeconds: number;
      endSeconds: number;
      kind: StoryboardBeatKind;
      action: string;
      caption?: string;
    }>[];
    cast: readonly Readonly<{ displayName: string }>[];
  };
  characterLocks: readonly Readonly<{ code: string }>[];
}): string | undefined {
  const beats = version.document.beats;
  if (!beats.some((beat) => isThaiText(beat.caption ?? beat.action))) {
    return undefined;
  }
  return buildThaiStoryboardSummary(
    beats.map((beat, index) => ({
      shotIndex: index + 1,
      startSeconds: beat.startSeconds,
      endSeconds: beat.endSeconds,
      kind: beat.kind,
      action: beat.action,
      caption: beat.caption ?? "",
    })),
    { allowedTerms: storyboardAllowedTerms(version) },
  );
}

/** Product vocabulary plus the cast and codes THIS storyboard declares. */
export function storyboardAllowedTerms(version: {
  document: { cast: readonly Readonly<{ displayName: string }>[] };
  characterLocks: readonly Readonly<{ code: string }>[];
}): readonly string[] {
  return [
    ...STORYBOARD_PRODUCT_TERMS,
    ...version.document.cast.map((member) => member.displayName),
    ...version.characterLocks.map((lock) => lock.code),
  ].filter(Boolean);
}
