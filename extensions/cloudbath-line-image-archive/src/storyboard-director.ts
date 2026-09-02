/**
 * Conversational gathering for a natural video request.
 *
 * A request like "เอา F1 ไปเดินในสวน" names a cast member and an action but
 * none of the dimensions a storyboard needs. Rather than refusing it (which is
 * what made the flow feel command-like) or silently defaulting them, the router
 * opens a director session, asks for the missing pieces one at a time, and only
 * then compiles the storyboard.
 *
 * Nothing here is paid and nothing here writes to Notion: a session holds only
 * what the owner said, and the storyboard is created once the session is
 * complete. The model is not consulted; every answer is parsed deterministically
 * so an ordinary reply cannot advance the flow towards anything billable.
 */

import {
  isDurationTooLong,
  normalizeStoryboardText,
  readStoryboardDuration,
} from "./storyboard-request.js";
import type { StoryboardAccessClaim } from "./storyboard-types.js";

export const CLOUDBATH_STORYBOARD_DIRECTOR_NAMESPACE = "cloudbath-storyboard-director-v1";
/**
 * Long enough to answer two questions in a chat, short enough that an abandoned
 * request cannot capture an unrelated message an hour later.
 */
export const CLOUDBATH_STORYBOARD_DIRECTOR_TTL_MS = 30 * 60 * 1_000;

/** Whether the scene carries spoken dialogue, and what is said. */
export type DirectorDialogue =
  | Readonly<{ wanted: false }>
  | Readonly<{ wanted: true; text?: string }>;

/**
 * One in-progress natural request, owner scoped exactly like the storyboard it
 * will become. Held as a single record so a half-answered request can never
 * disagree with itself across slots.
 */
export type StoryboardDirectorSession = Readonly<{
  version: 1;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  scenePrompt: string;
  characterNames: readonly string[];
  environment: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  dialogue?: DirectorDialogue;
  /**
   * Set once the request became a storyboard, or the owner cancelled it.
   *
   * A closed record is inert rather than deleted: the shared keyed store only
   * offers lookup/register, and a closed session answers no slot, so it cannot
   * capture a later message. It ages out on the store's own TTL.
   */
  closed?: true;
  updatedAt: string;
}>;

/** The slot the owner is being asked about, or undefined once none is left. */
export type DirectorSlot = "duration" | "dialogue" | "dialogue_text";

export function storyboardDirectorKey(claim: StoryboardAccessClaim): string {
  return `storyboard-director:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}`;
}

/**
 * Next unanswered slot, in the order the questions are asked.
 *
 * Dialogue text is only ever asked for after the owner said there IS dialogue,
 * so a silent scene never gets a third question.
 */
export function nextDirectorSlot(session: StoryboardDirectorSession): DirectorSlot | undefined {
  if (session.durationSeconds === undefined) {
    return "duration";
  }
  if (!session.dialogue) {
    return "dialogue";
  }
  return session.dialogue.wanted && !session.dialogue.text ? "dialogue_text" : undefined;
}

export const DIRECTOR_QUESTION: Readonly<Record<DirectorSlot, string>> = Object.freeze({
  duration: "ต้องการความยาวกี่วินาที? (เช่น 10 วิ)",
  dialogue: "มีเสียงพูดในคลิปไหม? (มี / ไม่มี)",
  dialogue_text: "ให้พูดว่าอะไร?",
});

const AFFIRMATIVE = /^(?:มี|เอา|ใช่|ต้องการ|ครับ|ค่ะ|คะ|โอเค|ok|yes|y)\b|^(?:มี|เอา|ใช่)/iu;
const NEGATIVE = /ไม่มี|ไม่เอา|ไม่ต้อง|ไม่ใช่|เงียบ|\b(?:no|none|nope|silent)\b|ไม่พูด|ไม่เอาเสียง/iu;

/** Cancels the pending request outright rather than answering it. */
const CANCEL = /^(?:ยกเลิก|ไม่เอาแล้ว|พอแล้ว|\bcancel\b|\bstop\b)/iu;

/**
 * A bare number answering "how many seconds", e.g. "10".
 *
 * Only consulted while the duration slot is open, so a lone number in ordinary
 * conversation cannot start a scene.
 */
const BARE_SECONDS = /^(\d{1,3})$/u;

export type DirectorAnswer =
  | Readonly<{ kind: "cancel" }>
  | Readonly<{ kind: "duration"; durationSeconds: number }>
  | Readonly<{ kind: "duration_too_long"; durationSeconds: number }>
  | Readonly<{ kind: "dialogue"; wanted: boolean }>
  | Readonly<{ kind: "dialogue_text"; text: string }>;

/**
 * Reads the owner's reply to the question currently open.
 *
 * Returns undefined when the reply does not answer that question; the router
 * then leaves the turn alone, so an unrelated message during a pending request
 * still reaches ordinary conversation instead of being swallowed as an answer.
 */
export function parseDirectorAnswer(params: {
  content: string;
  slot: DirectorSlot;
}): DirectorAnswer | undefined {
  const text = normalizeStoryboardText(params.content);
  if (!text) {
    return undefined;
  }
  if (CANCEL.test(text)) {
    return { kind: "cancel" };
  }
  if (params.slot === "duration") {
    const bare = text.match(BARE_SECONDS)?.[1];
    const seconds = readStoryboardDuration(text) ?? (bare ? Number(bare) : undefined);
    if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 1) {
      return undefined;
    }
    return isDurationTooLong(seconds)
      ? { kind: "duration_too_long", durationSeconds: seconds }
      : { kind: "duration", durationSeconds: seconds };
  }
  if (params.slot === "dialogue") {
    // Negative is tested first: "ไม่เอา" contains "เอา", so an affirmative-first
    // order would read every refusal as consent to add dialogue.
    if (NEGATIVE.test(text)) {
      return { kind: "dialogue", wanted: false };
    }
    return AFFIRMATIVE.test(text) ? { kind: "dialogue", wanted: true } : undefined;
  }
  // Dialogue text is free speech; only its length is constrained so one message
  // cannot push an unbounded string into the provider prompt.
  const spoken = text.slice(0, 280).trim();
  return spoken ? { kind: "dialogue_text", text: spoken } : undefined;
}

/** Applies one answer, returning the session to store next. */
export function applyDirectorAnswer(
  session: StoryboardDirectorSession,
  answer: Extract<DirectorAnswer, { kind: "duration" | "dialogue" | "dialogue_text" }>,
  updatedAt: string,
): StoryboardDirectorSession {
  if (answer.kind === "duration") {
    return Object.freeze({ ...session, durationSeconds: answer.durationSeconds, updatedAt });
  }
  if (answer.kind === "dialogue") {
    return Object.freeze({
      ...session,
      dialogue: answer.wanted
        ? Object.freeze({ wanted: true as const })
        : Object.freeze({ wanted: false as const }),
      updatedAt,
    });
  }
  return Object.freeze({
    ...session,
    dialogue: Object.freeze({ wanted: true as const, text: answer.text }),
    updatedAt,
  });
}

/** Opens a session from a natural request, carrying anything already named. */
export function openDirectorSession(params: {
  claim: StoryboardAccessClaim;
  scenePrompt: string;
  characterNames: readonly string[];
  environment: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  updatedAt: string;
}): StoryboardDirectorSession {
  return Object.freeze({
    version: 1,
    accountId: params.claim.accountId,
    lineGroupId: params.claim.lineGroupId,
    ownerSenderId: params.claim.ownerSenderId,
    scenePrompt: params.scenePrompt,
    characterNames: Object.freeze([...params.characterNames]),
    environment: params.environment,
    ...(params.durationSeconds === undefined ? {} : { durationSeconds: params.durationSeconds }),
    ...(params.aspectRatio === undefined ? {} : { aspectRatio: params.aspectRatio }),
    ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
    updatedAt: params.updatedAt,
  });
}

/** Closes the session so no later message can answer it. */
export function closeDirectorSession(
  session: StoryboardDirectorSession,
  updatedAt: string,
): StoryboardDirectorSession {
  return Object.freeze({ ...session, closed: true as const, updatedAt });
}

/** Owner-scoped read: another owner or group never resolves this session. */
export function ownsDirectorSession(
  session: StoryboardDirectorSession | undefined,
  claim: StoryboardAccessClaim,
): session is StoryboardDirectorSession {
  return (
    session !== undefined &&
    !session.closed &&
    session.accountId === claim.accountId &&
    session.lineGroupId === claim.lineGroupId &&
    session.ownerSenderId === claim.ownerSenderId
  );
}

/**
 * Scene text handed to the compiler once the session completes.
 *
 * The dialogue line is appended so the beat planner sees it as part of the
 * request, which is where every other scene detail already comes from.
 */
export function directorScenePrompt(session: StoryboardDirectorSession): string {
  const spoken = session.dialogue?.wanted ? session.dialogue.text : undefined;
  return spoken ? `${session.scenePrompt} พูดว่า "${spoken}"` : session.scenePrompt;
}
