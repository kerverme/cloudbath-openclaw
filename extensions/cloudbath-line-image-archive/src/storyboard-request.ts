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

/**
 * Aspect ratios, anchored so a clock time is not one.
 *
 * Unanchored, "14:30" contains "4:3" and "11:15" contains "1:1", so ordinary
 * chat resolved to an aspect ratio and made a message look like a scene
 * request. The digit guards require the ratio to stand alone.
 */
const ASPECT_WORDS: ReadonlyArray<readonly [RegExp, StoryboardAspectRatio]> = [
  [/(?<![\d.])9\s*:\s*16(?!\d)|แนวตั้ง/u, "9:16"],
  [/(?<![\d.])16\s*:\s*9(?!\d)|แนวนอน/u, "16:9"],
  [/(?<![\d.])1\s*:\s*1(?!\d)/u, "1:1"],
  [/(?<![\d.])4\s*:\s*3(?!\d)/u, "4:3"],
  [/(?<!\d)2\.39\s*:\s*1(?!\d)/u, "2.39:1"],
];

const RESOLUTION_WORDS: ReadonlyArray<readonly [RegExp, StoryboardResolution]> = [
  [/\b4k\b/iu, "4K"],
  [/\b2k\b/iu, "2K"],
  [/\b1080p?\b/iu, "1080p"],
  [/\b720p?\b/iu, "720p"],
  [/\b480p?\b/iu, "480p"],
];

/**
 * Recognised action vocabulary, most specific first.
 *
 * Order is load-bearing: "เดินผ่าน" must win over "เดิน" on the same span, so
 * matches are claimed in this order and overlapping later matches are dropped.
 *
 * Every LATIN alternative is wrapped in `\b`, and only the Latin ones. Without
 * it a short verb matched inside an unrelated English word -- "brunch" became
 * locomotion, "returns" a turn, "visits" a sit -- and a claimed action is part
 * of what makes a message look like a scene request, which writes a real Notion
 * project and scene. `\b` is ASCII-only, so it must never wrap the Thai
 * alternatives: it would not fire between two Thai letters and would change
 * where these patterns match.
 */
const ACTION_PATTERNS: ReadonlyArray<
  Readonly<{ kind: StoryboardBeatKind; pattern: RegExp; framing: string; camera: string }>
> = [
  {
    kind: "locomotion",
    pattern: /เดินเข้ามา|เดินผ่าน|เดินไป|เดิน|วิ่ง|\b(?:walks?\s+past|walks?\s+in|walks?|runs?)\b/giu,
    framing: "Medium-wide tracking shot",
    camera: "Track with the subject",
  },
  {
    kind: "transition",
    pattern: /หันกลับ|หมุนตัว|หัน|เหลียว|\b(?:turns?\s+(?:back|around)|turns?|looks?\s+back)\b/giu,
    framing: "Medium shot",
    camera: "Static",
  },
  {
    kind: "dialogue",
    pattern: /คุยกัน|คุย|พูดคุย|พูด|ทักทาย|\b(?:talks?|chats?|converses?|speaks?|greets?)\b/giu,
    framing: "Medium two-shot",
    camera: "Static",
  },
  {
    kind: "action",
    pattern: /นั่งลง|นั่ง|ยืน|มองไปที่|มอง|\b(?:sits?\s+down|sits?|stands?|looks?\s+at)\b/giu,
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
  // Returned uncapped so the caller can tell "named 90 วิ" from "named none";
  // silently substituting the 15s default hid the request the owner made.
  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : undefined;
}

/** True when the request named a length this product will not storyboard. */
export function isDurationTooLong(seconds: number | undefined): boolean {
  return seconds !== undefined && seconds > STORYBOARD_MAX_DURATION_SECONDS;
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
  // Thai runs words together ("เดินเข้ามาในร้านกาแฟ"), so the Thai markers
  // cannot require preceding whitespace the way the English ones do.
  // English requires an article: a bare "in" is far more often a particle
  // ("zoom in ตอนท้าย") than a location marker.
  const marker = text.match(/(?:ใน|ที่)|(?:^|\s)(?:in|at)\s+(?:the|a)\s+/iu);
  if (marker?.index === undefined) {
    return "";
  }
  const rest = text.slice(marker.index + marker[0].length);
  const collected: string[] = [];
  for (const token of rest.split(/\s+/u)) {
    // A spaced Thai marker ("… ใน ร้านกาแฟ") leaves an empty leading token;
    // breaking on it returned no environment at all.
    if (!token) {
      continue;
    }
    if (isDimensionToken(token) || CONNECTIVE_TOKEN.test(token)) {
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

/** Starts a companion clause, so the location has ended ("cafe with Twong2"). */
const CONNECTIVE_TOKEN = /^(?:with|and|กับ|และ|ร่วมกับ|พร้อม)$/iu;

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

/**
 * A short descriptive run right after the verb, e.g. "เบาๆ" in "คุยกันเบาๆ".
 *
 * The tail is matched as a STRING, not code point by code point: the previous
 * per-character test could never match a multi-character clause marker such as
 * "แล้ว", so the modifier ran on into the next clause and carried it into the
 * beat action and the video plan.
 */
function readModifier(text: string, end: number): string {
  const tail = text.slice(end, end + MAX_MODIFIER_LENGTH);
  const stop = tail.search(MODIFIER_STOP);
  return stop === -1 ? tail : tail.slice(0, stop);
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

/**
 * A time range such as "วิ 10-14", "ช่วง 3 ถึง 6 วิ" or "10-14 sec".
 *
 * Storyboard-owned rather than reusing the previs parser, because that one
 * accepts a bare "วิ" prefix and so matches the first syllable of unrelated
 * Thai words -- "วิธีนี้ 3-6" and "วิทยาลัย 3-6" both parsed as ranges. The
 * unit here must be a standalone word, so ordinary chat containing digits can
 * never be read as an edit.
 */
const RANGE_LEADING_UNIT =
  /(?:(?:วินาที|วิ|ช่วง)(?![\p{L}\p{M}])|seconds?|sec)\s*(\d{1,3})\s*(?:-|–|—|ถึง|to)\s*(\d{1,3})/iu;
// Longest unit first: `secs?\b` would otherwise claim the "sec" of "seconds"
// and then fail its own boundary, leaving "10-14 seconds" unparsed.
const RANGE_TRAILING_UNIT =
  /(\d{1,3})\s*(?:-|–|—|ถึง|to)\s*(\d{1,3})\s*(?:(?:วินาที|วิ)(?![\p{L}\p{M}])|seconds?\b|secs?\b|s\b)/iu;

export function parseStoryboardTimeRange(
  text: string,
): { fromSeconds: number; toSeconds: number } | undefined {
  for (const pattern of [RANGE_LEADING_UNIT, RANGE_TRAILING_UNIT]) {
    const match = pattern.exec(text);
    if (match) {
      const fromSeconds = Number(match[1]);
      const toSeconds = Number(match[2]);
      if (Number.isFinite(fromSeconds) && Number.isFinite(toSeconds)) {
        return { fromSeconds, toSeconds };
      }
    }
  }
  return undefined;
}
