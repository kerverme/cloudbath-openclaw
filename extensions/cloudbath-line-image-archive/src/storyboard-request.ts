/**
 * Deterministic parsing of a natural-language video request.
 *
 * Turns free text into the dimensions a storyboard is built from: duration,
 * aspect, resolution, environment and an ORDERED list of recognised actions.
 * Beat assembly lives in `storyboard-compiler.ts`; this module only reads what
 * the owner actually asked for and never invents structure.
 */

import type {
  StoryboardAspectRatio,
  StoryboardBeatKind,
  StoryboardResolution,
} from "./storyboard-types.js";

export const STORYBOARD_DEFAULT_DURATION_SECONDS = 15;
export const STORYBOARD_DEFAULT_ASPECT_RATIO: StoryboardAspectRatio = "9:16";
export const STORYBOARD_DEFAULT_RESOLUTION: StoryboardResolution = "720p";
/** Upper bound on one storyboard scene. Longer is a product decision, not a parse. */
export const STORYBOARD_MAX_DURATION_SECONDS = 60;

const ASPECT_WORDS: ReadonlyArray<readonly [RegExp, StoryboardAspectRatio]> = [
  [/9\s*:\s*16|แนวตั้ง/u, "9:16"],
  [/16\s*:\s*9|แนวนอน/u, "16:9"],
  [/1\s*:\s*1/u, "1:1"],
  [/4\s*:\s*3/u, "4:3"],
  [/2\.39\s*:\s*1/u, "2.39:1"],
];

const RESOLUTION_WORDS: ReadonlyArray<readonly [RegExp, StoryboardResolution]> = [
  [/\b4k\b/iu, "4K"],
  [/\b1080p?\b/iu, "1080p"],
  [/\b720p?\b/iu, "720p"],
  [/\b480p?\b/iu, "480p"],
];

/**
 * Recognised action vocabulary, most specific first.
 *
 * Order is load-bearing: "เดินผ่าน" must win over "เดิน" on the same span, so
 * matches are claimed in this order and overlapping later matches are dropped.
 */
const ACTION_PATTERNS: ReadonlyArray<
  Readonly<{ kind: StoryboardBeatKind; pattern: RegExp; framing: string; camera: string }>
> = [
  {
    kind: "locomotion",
    pattern: /เดินเข้ามา|เดินผ่าน|เดินไป|เดิน|วิ่ง|walks?\s+past|walks?\s+in|walks?|runs?/giu,
    framing: "Medium-wide tracking shot",
    camera: "Track with the subject",
  },
  {
    kind: "transition",
    pattern: /หันกลับ|หมุนตัว|หัน|เหลียว|turns?\s+(?:back|around)|turns?|looks?\s+back/giu,
    framing: "Medium shot",
    camera: "Static",
  },
  {
    kind: "dialogue",
    pattern: /คุยกัน|คุย|พูดคุย|พูด|ทักทาย|talks?|chats?|converses?|speaks?|greets?/giu,
    framing: "Medium two-shot",
    camera: "Static",
  },
  {
    kind: "action",
    pattern: /นั่งลง|นั่ง|ยืน|มองไปที่|มอง|sits?\s+down|sits?|stands?|looks?\s+at/giu,
    framing: "Medium shot",
    camera: "Static",
  },
];

/**
 * Stops a trailing modifier run: whitespace, another clause, a number, or a
 * new location. Whitespace is a stop because a Thai modifier attaches directly
 * to its verb ("คุยกันเบาๆ"), so anything past the space is the next phrase.
 */
const MODIFIER_STOP = /\s|[0-9]|แล้ว|และ|ใน|ที่|กับ|,|\.|·/u;
const MAX_MODIFIER_LENGTH = 24;

/**
 * NFKC folding, with Thai SARA AM put back together.
 *
 * NFKC gives compatibility folding (full-width Latin, digit variants) but it
 * also decomposes U+0E33 SARA AM into U+0E4D + U+0E32. That silently breaks
 * every literal Thai pattern in this plugin that contains "ำ" — "ทำวิดีโอ"
 * would stop matching — so the sequence is recomposed before matching.
 */
export function normalizeStoryboardText(text: string): string {
  return text.normalize("NFKC").replaceAll("\u0E4D\u0E32", "\u0E33").trim();
}

/**
 * Requested scene length in whole seconds, when the message names one.
 *
 * Both sides are anchored deliberately. Without the leading guard, the "2" in
 * a cast name like "Twong2" reads as a number; without the trailing guard,
 * "วิ" matches the start of an unrelated word such as "วิ่ง". Together those
 * two turned "Twong2 วิ่งเล่น … 30 วินาที" into a 2-second scene.
 */
export function readStoryboardDuration(text: string): number | undefined {
  const match = text.match(
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s*(?:วินาที|วิ|seconds?|sec|s)(?![\p{L}\p{N}\p{M}])/iu,
  );
  const seconds = Number(match?.[1]);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= STORYBOARD_MAX_DURATION_SECONDS
    ? seconds
    : undefined;
}

export function readStoryboardAspectRatio(text: string): StoryboardAspectRatio | undefined {
  return ASPECT_WORDS.find(([pattern]) => pattern.test(text))?.[1];
}

export function readStoryboardResolution(text: string): StoryboardResolution | undefined {
  return RESOLUTION_WORDS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * Scene location named by "ใน…" / "ที่…" / "in …" / "at …".
 *
 * Collection stops at the first token that belongs to another dimension
 * (duration, aspect, resolution), so "ในร้านกาแฟ แนวตั้ง" yields the café
 * without swallowing the aspect word that follows it.
 */
export function readStoryboardEnvironment(text: string): string {
  const marker = text.match(/(?:^|\s)(?:ใน|ที่|in\s+(?:the\s+|a\s+)?|at\s+(?:the\s+|a\s+)?)/iu);
  if (marker?.index === undefined) {
    return "";
  }
  const rest = text.slice(marker.index + marker[0].length);
  const collected: string[] = [];
  for (const token of rest.split(/\s+/u)) {
    if (!token || isDimensionToken(token)) {
      break;
    }
    collected.push(token);
    // A location is a short noun phrase; more than two tokens is the rest of
    // the sentence, not the place.
    if (collected.length === 2) {
      break;
    }
  }
  return collected.join(" ").replace(/[,.]+$/u, "");
}

function isDimensionToken(token: string): boolean {
  return (
    /\d/u.test(token) ||
    ASPECT_WORDS.some(([pattern]) => pattern.test(token)) ||
    RESOLUTION_WORDS.some(([pattern]) => pattern.test(token)) ||
    /^(?:วิ|วินาที|sec|seconds?)$/iu.test(token)
  );
}

export type ParsedAction = Readonly<{
  kind: StoryboardBeatKind;
  framing: string;
  camera: string;
  /** The verb span exactly as the owner wrote it, plus any short modifier. */
  phrase: string;
  index: number;
  subject?: string;
  object?: string;
}>;

/**
 * Actions the request names, in the order they appear.
 *
 * Spans already claimed by an earlier (more specific) pattern are skipped, so a
 * single "เดินผ่าน" yields one locomotion action rather than also a bare "เดิน".
 */
export function parseStoryboardActions(
  text: string,
  castNames: readonly string[],
): readonly ParsedAction[] {
  const claimed: Array<readonly [number, number]> = [];
  const actions: ParsedAction[] = [];
  for (const entry of ACTION_PATTERNS) {
    for (const match of text.matchAll(entry.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some(([from, to]) => start < to && end > from)) {
        continue;
      }
      claimed.push([start, end]);
      actions.push({
        kind: entry.kind,
        framing: entry.framing,
        camera: entry.camera,
        phrase: `${match[0]}${readModifier(text, end)}`,
        index: start,
        ...nearestNames(text, start, end, castNames),
      });
    }
  }
  return actions.toSorted((a, b) => a.index - b.index);
}

/** A short descriptive run right after the verb, e.g. "เบาๆ" in "คุยกันเบาๆ". */
function readModifier(text: string, end: number): string {
  let taken = "";
  for (const character of text.slice(end, end + MAX_MODIFIER_LENGTH)) {
    if (MODIFIER_STOP.test(character)) {
      break;
    }
    taken += character;
  }
  return taken;
}

/** Cast member named closest before the verb (subject) and closest after it (object). */
function nearestNames(
  text: string,
  start: number,
  end: number,
  castNames: readonly string[],
): { subject?: string; object?: string } {
  const before = castNames
    .map((name) => ({ name, at: text.lastIndexOf(name, start) }))
    .filter((entry) => entry.at >= 0)
    .toSorted((a, b) => b.at - a.at || b.name.length - a.name.length)[0]?.name;
  const after = castNames
    .map((name) => ({ name, at: text.indexOf(name, end) }))
    .filter((entry) => entry.at >= 0)
    .toSorted((a, b) => a.at - b.at || b.name.length - a.name.length)[0]?.name;
  return { ...(before ? { subject: before } : {}), ...(after ? { object: after } : {}) };
}
