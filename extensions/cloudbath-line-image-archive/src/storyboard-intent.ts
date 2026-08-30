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

import { findUnknownCastNames, matchKnownNames, parseTimeRange } from "./previs-intent.js";
import {
  normalizeStoryboardText,
  parseStoryboardActions,
  readStoryboardAspectRatio,
  readStoryboardDuration,
  readStoryboardEnvironment,
  readStoryboardResolution,
} from "./storyboard-request.js";

/**
 * The exact paid gate, mirrored here only to REFUSE it.
 *
 * `video-confirmation.ts` owns the real gate; this copy exists so the
 * storyboard router can never claim the turn that must reach it.
 */
const PAID_CONFIRMATION_PATTERN = /^ยืนยัน\s+VIDEO\s+\d{4}$/iu;

/** Explicit legacy previs invocation, which stays routed to the previs flow. */
const EXPLICIT_PREVIS_PATTERN = /^\s*previs\b|พรีวิส|^\s*approve\s+previs\s*$|^\s*อนุมัติ\s+previs/iu;

/**
 * "Prepare the video" — tight on purpose.
 *
 * A bare agreement ("โอเค", "ทำเลย", "เอาเลย", "สร้างเลย") must never reach
 * this branch: the video noun is required, so agreement alone cannot advance
 * the flow towards anything billable.
 */
const CREATE_VIDEO_PATTERN =
  /^(?:สร้าง|ทำ)\s*(?:วิดีโอ|วีดีโอ|วิดิโอ|คลิป)(?:\s*(?:เลย|ครับ|ค่ะ|คะ|นะ|หน่อย|ให้หน่อย|ได้เลย))*$|^(?:create|make|generate)\s+(?:the\s+)?video$/iu;

/**
 * Scene words that make a named-cast message read as a video request.
 *
 * No `\b` after the Thai alternatives: JavaScript word boundaries are
 * ASCII-based, so `วิ\b` never matched Thai text and silently disabled most of
 * this branch.
 */
const SCENE_WORDS =
  /วินาที|วิ|ฉาก|แนวตั้ง|แนวนอน|คลิป|วิดีโอ|วีดีโอ|seconds?\b|sec\b|scene|shot|\d\s*:\s*\d/iu;

/**
 * An explicit casting instruction, e.g. "ใช้ Twong ..." / "ให้ Twong เดิน".
 *
 * A recognised verb alone is far too weak to claim the turn: a create writes a
 * real Notion project and scene, so "Twong ยืนอยู่ไหน" must stay conversation.
 */
const CASTING_MARKER = /(?:^|\s)(?:ใช้|ให้)\s*\S/u;

export type StoryboardIntent =
  | Readonly<{
      kind: "create";
      characterNames: readonly string[];
      unknownNames: readonly string[];
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

  const matched = matchKnownNames(text, params.knownCharacterNames);
  const unknownNames = findUnknownCastNames(text, params.knownCharacterNames);
  const range = parseTimeRange(text);
  if (range) {
    return {
      kind: "edit",
      fromSeconds: range.fromSecond,
      toSeconds: range.toSecond,
      characterNames: matched,
      unknownNames,
      action: text,
    };
  }

  // A create request needs real cast AND either scene wording or an explicit
  // casting instruction carrying a recognised action. A bare verb beside a
  // character name is conversation, and claiming it would mint a real Notion
  // project and scene for a question.
  const hasAction = parseStoryboardActions(text, params.knownCharacterNames).length > 0;
  const looksLikeScene = SCENE_WORDS.test(text) || (hasAction && CASTING_MARKER.test(text));
  if (matched.length === 0 || !looksLikeScene) {
    return undefined;
  }
  const durationSeconds = readStoryboardDuration(text);
  const aspectRatio = readStoryboardAspectRatio(text);
  const resolution = readStoryboardResolution(text);
  return {
    kind: "create",
    characterNames: matched,
    unknownNames,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
    environment: readStoryboardEnvironment(text),
    scenePrompt: text,
  };
}

/** True for a message the storyboard flow must leave to the previs router. */
export function isExplicitPrevisRequest(content: string): boolean {
  return EXPLICIT_PREVIS_PATTERN.test(normalizeStoryboardText(content));
}
