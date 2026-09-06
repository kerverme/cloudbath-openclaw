/**
 * Deterministic LINE intent parsing for the storyboard-first video flow.
 *
 * The model is not consulted. A recognised request is classified here and
 * executed from `before_dispatch`, so a named-cast scene request reaches the
 * storyboard workflow instead of ending as a generic yes/no confirmation.
 *
 * Two categories are deliberately NOT claimed, so existing behaviour is
 * untouched: an explicit legacy previs request (which falls through to the
 * previs router), and anything shaped like the exact paid confirmation.
 */

import { matchKnownNames } from "./previs-intent.js";
import {
  normalizeStoryboardText,
  parseStoryboardActions,
  parseStoryboardTimeRange,
  readStoryboardAspectRatio,
  readStoryboardDuration,
  readStoryboardEnvironment,
  readStoryboardResolution,
} from "./storyboard-request.js";
import {
  parseStoryboardRevision,
  type StoryboardCastAddition,
  type StoryboardDocumentRevision,
} from "./storyboard-revision.js";

/**
 * The exact paid gate, mirrored here only to REFUSE it.
 *
 * `video-confirmation.ts` owns the real gate; this copy exists so the
 * storyboard router can never claim the turn that must reach it.
 */
const PAID_CONFIRMATION_PATTERN = /^ยืนยัน\s+VIDEO\s+\d{4}$/iu;

/** Explicit legacy previs invocation, which stays routed to the previs flow. */
const EXPLICIT_PREVIS_PATTERN = /\bprevis\b|พรีวิส|^\s*อนุมัติ\s+previs/iu;

/**
 * "Prepare the video" — tight on purpose.
 *
 * A bare agreement ("โอเค", "ทำเลย", "เอาเลย", "สร้างเลย") must never reach
 * this branch: the video noun is required, so agreement alone cannot advance
 * the flow towards anything billable.
 */
const CREATE_VIDEO_PATTERN =
  /^(?:สร้าง|ทำ)\s*(?:วิดีโอ|วีดีโอ|วิดิโอ|คลิป)(?:\s*(?:เลย|ครับ|ค่ะ|คะ|นะ|หน่อย|ให้หน่อย|ได้เลย))*$|^(?:create|make|generate)\s+(?:the\s+)?video$/iu;

/** Turns the conversation's explicitly tracked image into storyboard work. */
const IMAGE_TO_STORYBOARD_PATTERN =
  /(?:ทำ|สร้าง|เปลี่ยน).*(?:storyboard|สตอรี่บอร์ด)|(?:storyboard|สตอรี่บอร์ด).*(?:จาก|ด้วย).*(?:ภาพ|รูป)|\b(?:turn|make|convert)\b.*\b(?:image|photo|this|it)\b.*\bstoryboard\b/iu;

/**
 * Nouns that name a video artefact outright.
 *
 * Deliberately narrow. An earlier version matched a bare "วิ" and any "\d:\d",
 * which made "Twong คิดว่าวิธีนี้ดีไหม" and "Twong มาถึงตอน 10:30 นะ" read as
 * scene requests — and a claimed create writes a real Notion project and scene.
 * Duration and aspect are detected by their own parsers instead, so a match
 * means the message really did name one.
 *
 * The Latin nouns carry `\b` on BOTH sides: "scene\b" alone still matched the
 * tail of "obscene" and "shot\b" the tail of "snapshot".
 */
const SCENE_NOUNS = /ฉาก|คลิป|วิดีโอ|วีดีโอ|\b(?:scenes?|shots?|storyboards?)\b/iu;

/**
 * Wording that asks for a CHANGE, required before a time range is an edit.
 *
 * A range alone is far too weak: "วิธีนี้ 3-6 ดีไหม" and "ช่วง 10-14 ว่างไหม"
 * both parse as ranges, and an unguarded edit permanently appends a version
 * whose beat action is that chat text.
 */
/** Asks for a NEW scene rather than a change to the current one. */
/**
 * Latin tokens in an explicit CAST LIST that the library does not hold.
 *
 * Only "ใช้ X" / "กับ X" / "และ X" count. The previs scan also triggers on
 * "ให้ X", but "ให้" introduces DIRECTION as often as cast, so it refused
 * "ให้ zoom in ตอนท้าย" as a missing character named "zoom".
 */
const CAST_LIST_NAME = /(?:ใช้|กับ|และ)\s*([A-Za-z][A-Za-z0-9_-]{1,31})/gu;

function findStoryboardUnknownCast(text: string, knownNames: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(CAST_LIST_NAME)) {
    const candidate = match[1]!;
    if (!knownNames.includes(candidate) && !unknown.includes(candidate)) {
      unknown.push(candidate);
    }
  }
  return unknown;
}

const NATURAL_SENTENCE_WORDS = new Set(["Then", "Next", "After", "Afterwards"]);

function findNaturalUnknownCast(text: string, knownNames: readonly string[]): string[] {
  return Array.from(text.matchAll(/\b[A-Z][A-Za-z0-9_-]{1,31}\b/gu), (match) => match[0]).filter(
    (name, index, all) =>
      !knownNames.includes(name) &&
      !NATURAL_SENTENCE_WORDS.has(name) &&
      all.indexOf(name) === index,
  );
}

const NEW_SCENE_MARKER = /ใหม่|\bnew\s+(?:scenes?|shots?|storyboards?)\b/iu;

/**
 * The owner ASKING for something to happen, as opposed to narrating.
 *
 * A cast name beside an action verb is far too weak on its own: "that was
 * obscene, Twong walks away" and "send me the snapshot where Twong walks past
 * Twong2" both contain one, and claiming them would answer ordinary chat with
 * a storyboard question. A directive marker is what makes "เอา F1 ไปเดินในสวน"
 * a request. Latin is deliberately absent: the English narration above is
 * exactly the shape that has to keep falling through.
 */
const DIRECTOR_REQUEST_MARKER = /(?:^|\s)(?:เอา|พา|ขอ|อยาก(?:ได้|ให้)?|ช่วย|ทำให้)\s*\S/u;

// Same Latin-only `\b` rule as the action vocabulary: unbounded, "cut" matched
// inside "haircut", "change" inside "exchange", and "set\b" inside "asset".
const EDIT_MARKER =
  /ให้|เปลี่ยน|แก้ไข|แก้|ตัด|ใส่|ลบ|ทำให้|ย้าย|\b(?:zooms?|changes?|cuts?|replaces?|sets?|swaps?)\b/iu;

/** Names a cast outright. "ใช้ Twong กับ Twong2" is a cast list by itself. */
const USE_CAST_MARKER = /(?:^|\s)ใช้\s*\S/u;

/** Every "ให้" in the message, so what follows each one can be inspected. */
const DIRECTION_MARKER = /ให้\s*/gu;

/**
 * Whether the message CASTS, rather than merely instructing.
 *
 * "ให้" is far too weak on its own. It introduces DIRECTION at least as often
 * as cast -- "ให้ดูหน่อย", "ฉากนี้ให้ดูดีขึ้น" -- and casting strength is what
 * lets a message mint a real Notion project and scene, so a bare "ให้" could
 * start a storyboard out of ordinary conversation. It now counts only when a
 * KNOWN cast name follows it, which is exactly how a real request reads:
 * "... ให้ Twong เดินผ่าน Twong2 ...".
 *
 * Names are compared by prefix rather than built into a pattern so a cast name
 * containing regex metacharacters cannot alter the match.
 */
function hasCastingMarker(text: string, knownNames: readonly string[]): boolean {
  if (USE_CAST_MARKER.test(text)) {
    return true;
  }
  for (const match of text.matchAll(DIRECTION_MARKER)) {
    const rest = text.slice(match.index + match[0].length);
    if (knownNames.some((name) => rest.startsWith(name))) {
      return true;
    }
  }
  return false;
}

/**
 * The range expression itself, so it does not survive into the beat.
 *
 * The stored `action` becomes the beat's instruction and is copied into the
 * provider-neutral plan, so leaving "วิ 10-14" in it would hand a video model
 * a timestamp as part of the thing to depict.
 *
 * The trailing units must stay in step with `RANGE_TRAILING_UNIT`: a unit that
 * parser accepts but this one does not is left behind in the beat.
 */
const RANGE_SPAN =
  /(?:วินาที|วิ|ช่วง|seconds?|sec)?\s*\d{1,3}\s*(?:-|–|—|ถึง|to)\s*\d{1,3}(?:\s*(?:(?:วินาที|วิ)(?![\p{L}\p{M}])|seconds?\b|secs?\b|s\b))?/giu;

export function stripTimeRangeSpan(text: string): string {
  return text.replace(RANGE_SPAN, " ").replace(/\s+/gu, " ").trim();
}

export type StoryboardIntent =
  | Readonly<{
      kind: "create";
      characterNames: readonly string[];
      unknownNames: readonly string[];
      /** True when the request names its cast outright ("ใช้ X กับ Y"). */
      explicitCasting: boolean;
      durationSeconds?: number;
      aspectRatio?: string;
      resolution?: string;
      environment: string;
      scenePrompt: string;
    }>
  | Readonly<{
      kind: "edit";
      fromSeconds: number;
      toSeconds: number;
      characterNames: readonly string[];
      unknownNames: readonly string[];
      action: string;
    }>
  | Readonly<{ kind: "natural_edit"; request: string }>
  /**
   * A natural request that names a cast member and an action but none of the
   * dimensions a storyboard needs. Emitted ONLY where this parser previously
   * returned undefined, so every already-recognised request keeps its shipped
   * immediate-create behaviour; the router gathers the rest conversationally.
   */
  | Readonly<{
      kind: "director_open";
      characterNames: readonly string[];
      unknownNames: readonly string[];
      environment: string;
      scenePrompt: string;
    }>
  | Readonly<{ kind: "source_storyboard"; scenePrompt: string }>
  /** A document-level change to the storyboard already being iterated on. */
  | Readonly<{ kind: "revision"; revision: StoryboardDocumentRevision | StoryboardCastAddition }>
  | Readonly<{ kind: "create_video" }>;

/**
 * Classifies one inbound LINE message.
 *
 * Returns undefined when the message is not a storyboard request, leaving every
 * other flow — previs, the paid confirmation gate, ordinary conversation —
 * exactly as it was.
 */
export function parseStoryboardIntent(params: {
  content: string;
  knownCharacterNames: readonly string[];
}): StoryboardIntent | undefined {
  const text = normalizeStoryboardText(params.content);
  if (!text || PAID_CONFIRMATION_PATTERN.test(text) || EXPLICIT_PREVIS_PATTERN.test(text)) {
    return undefined;
  }
  if (CREATE_VIDEO_PATTERN.test(text)) {
    return { kind: "create_video" };
  }
  if (IMAGE_TO_STORYBOARD_PATTERN.test(text)) {
    return { kind: "source_storyboard", scenePrompt: text };
  }

  const matched = matchKnownNames(text, params.knownCharacterNames);
  const hasAction = parseStoryboardActions(text, params.knownCharacterNames).length > 0;
  const explicitUnknownNames = findStoryboardUnknownCast(text, params.knownCharacterNames);
  const range = parseStoryboardTimeRange(text);
  const allRanges = Array.from(text.matchAll(/(\d{1,3})\s*(?:-|–|—|ถึง|to)\s*(\d{1,3})/giu));
  // A new-scene request outranks an edit even when it names a range: both
  // "ทำฉากใหม่ 10-15 วิ ให้ Twong เดิน" and "ทำคลิป ให้ Twong เดิน 10-15 วิ"
  // ask for a scene of that length, not a rewrite of those seconds.
  const asksForNewScene = NEW_SCENE_MARKER.test(text) || (SCENE_NOUNS.test(text) && hasAction);
  if (range && allRanges.length === 1 && EDIT_MARKER.test(text) && !asksForNewScene) {
    return {
      kind: "edit",
      fromSeconds: range.fromSeconds,
      toSeconds: range.toSeconds,
      characterNames: matched,
      unknownNames: explicitUnknownNames,
      action: stripTimeRangeSpan(text),
    };
  }

  const durationSeconds = readStoryboardDuration(text);
  const aspectRatio = readStoryboardAspectRatio(text);
  const resolution = readStoryboardResolution(text);
  const casting = hasCastingMarker(text, params.knownCharacterNames);
  // A dimension the parsers actually resolved is a request on its own. Short of
  // that the message must name an ACTION to depict: a scene noun beside a cast
  // reference is only talking ABOUT a scene -- "ฉากนี้ ให้ Twong ดูดีนะ",
  // "ดูคลิป Twong หน่อย" -- and a claimed create writes a real Notion project
  // and scene, so there is nothing to storyboard without a verb.
  const naturalActionCount = Array.from(
    text.matchAll(
      /กระโดด|เข้าไป|หยิบ|ตี|พลาด|โดน|\b(?:jumps?|enters?|picks?\s+up|swings?|miss(?:es)?|hits?)\b/giu,
    ),
  ).length;
  const naturalAction = naturalActionCount > 0;
  const naturalSequence =
    naturalActionCount > 1 ||
    (/แล้ว|จากนั้น|ต่อมา|\b(?:then|afterwards?|next)\b/iu.test(text) && naturalAction);
  const unknownNames = naturalSequence
    ? [...explicitUnknownNames, ...findNaturalUnknownCast(text, params.knownCharacterNames)].filter(
        (name, index, all) => all.indexOf(name) === index,
      )
    : explicitUnknownNames;
  if (!range && activeEditMarker(text) && !SCENE_NOUNS.test(text)) {
    return { kind: "natural_edit", request: text };
  }
  // A second storyboard needs an explicit cast list, OR a self-contained
  // request: an action plus a dimension the owner actually named.
  const explicitCasting =
    casting ||
    naturalSequence ||
    (hasAction && (durationSeconds !== undefined || aspectRatio !== undefined));
  const directorRequest = matched.length > 0 && hasAction && DIRECTOR_REQUEST_MARKER.test(text);
  const directorOpen = (): StoryboardIntent =>
    ({
      kind: "director_open",
      characterNames: matched,
      unknownNames: explicitUnknownNames,
      environment: readStoryboardEnvironment(text),
      scenePrompt: text,
    }) as const;
  // "เอา F99 ทำวิดีโอ เดินอยู่ในสวน ..." asks FOR a video; it does not specify
  // one. The scene noun alone satisfied `looksLikeScene`, so a request the
  // owner had pinned nothing down in went straight to project + storyboard
  // creation: it defaulted a length nobody chose, and against a project frozen
  // to another cast it died on the cast-lock guard. Naming a video is the ASK,
  // so unless the owner also pinned the cast or a dimension it belongs to the
  // director, which asks 15 or 30 first and writes no Notion work until the
  // answer arrives.
  //
  // Deliberately ahead of the revision parse below, and deliberately narrower
  // than `directorRequest` alone. The production message ends
  // "มีเสียงบรรยากาศ ไม่มีเสียงพูด", which reads as an audio revision in
  // isolation — describing the sound of a video you are asking for is not a
  // rewrite of an existing one. The scene noun is what separates the two:
  // "เอา F99 ไม่ต้องมีเสียงพูด" names no video and stays a revision.
  if (directorRequest && !explicitCasting && SCENE_NOUNS.test(text)) {
    return directorOpen();
  }
  const looksLikeScene =
    durationSeconds !== undefined ||
    aspectRatio !== undefined ||
    (hasAction && (SCENE_NOUNS.test(text) || casting)) ||
    naturalSequence ||
    (allRanges.length > 1 && naturalAction);
  if (matched.length === 0 || !looksLikeScene) {
    // Everything below here previously ended the parse. A revision is only
    // acted on when a storyboard is already active (the router enforces that),
    // and a director request writes nothing until the owner answers, so
    // neither can create Notion work straight off an unrecognised message.
    const revision = parseStoryboardRevision({
      content: params.content,
      knownCharacterNames: params.knownCharacterNames,
    });
    if (revision) {
      return { kind: "revision", revision };
    }
    if (directorRequest) {
      return directorOpen();
    }
    return undefined;
  }
  return {
    kind: "create",
    characterNames: matched,
    unknownNames,
    explicitCasting,
    ...(durationSeconds === undefined
      ? allRanges.length > 1
        ? { durationSeconds: Math.max(...allRanges.map((entry) => Number(entry[2]))) }
        : {}
      : { durationSeconds }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
    environment: readStoryboardEnvironment(text),
    scenePrompt: text,
  };
}

function activeEditMarker(text: string): boolean {
  return /เปลี่ยน(?:ตอน|ฉาก|ช็อต)|แก้(?:ช่วง|ฉาก|ช็อต)|ปรับ(?:ช่วง|ฉาก|ช็อต)|เอา.+เป็น\s*(?:close-up|wide|medium)|\b(?:change|replace)\s+(?:the\s+)?(?:part|beat|shot|scene)\b/iu.test(
    text,
  );
}

/** True for a message the storyboard flow must leave to the previs router. */
export function isExplicitPrevisRequest(content: string): boolean {
  return EXPLICIT_PREVIS_PATTERN.test(normalizeStoryboardText(content));
}
