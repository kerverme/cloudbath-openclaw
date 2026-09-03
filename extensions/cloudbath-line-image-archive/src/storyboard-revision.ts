/**
 * Natural revisions of the storyboard the owner is already iterating on.
 *
 * `applyStoryboardTimeRangeEdit` rewrites ONE beat window; these are the
 * document-level changes an owner asks for in the same breath ("ขอ 15 วิแทน",
 * "ไม่เอาเสียงพูด"). They are a closed union rather than free text so a
 * revision can never invent a shape the compiler does not already produce.
 *
 * Cast changes are deliberately NOT applied here. A request that adds someone
 * the project never froze is new work, and the shared lifecycle opens a new
 * project for it; rewriting the frozen cast in place would reverse that.
 */

import { matchKnownNames } from "./previs-intent.js";
import { applyStoryboardAudioMode, parseStoryboardAudioIntent } from "./storyboard-audio.js";
import { allocateBeatWindows } from "./storyboard-compiler.js";
import { normalizeStoryboardText, readStoryboardDuration } from "./storyboard-request.js";
import type {
  StoryboardAudioMode,
  StoryboardBeat,
  StoryboardDocument,
} from "./storyboard-types.js";

export type StoryboardDocumentRevision =
  | Readonly<{ kind: "duration"; durationSeconds: number }>
  | Readonly<{ kind: "environment"; environment: string }>
  | Readonly<{ kind: "audio"; audio: StoryboardAudioMode }>
  | Readonly<{ kind: "camera"; camera: string }>;

/** A revision that needs a new project rather than a new version of this one. */
export type StoryboardCastAddition = Readonly<{ kind: "cast_add"; names: readonly string[] }>;

/** "ขอ 15 วิแทน" — a length with a replacement marker and no other subject. */
const DURATION_REVISION = /แทน|แทนที่|instead|\bmake\s+it\b|ขอ|เปลี่ยน|เอา/iu;
/** "เปลี่ยนเป็นสวนญี่ปุ่น" — the new location follows the marker. */
const ENVIRONMENT_REVISION =
  /(?:เปลี่ยน(?:เป็น|ไปเป็น|ฉากเป็น)|ย้ายไป(?:ที่)?|เอาเป็น|\bchange\s+(?:it\s+)?to\b|\bmove\s+to\b)\s*(.+)$/iu;
/** "ให้กล้องเดินตาม" — the camera instruction follows the marker. */
const CAMERA_REVISION = /(?:ให้)?กล้อง\s*(.+)$|\bcamera\s+(?:should\s+)?(.+)$/iu;
/** "เพิ่ม Manju เข้ามาด้วย" — adds someone to the scene. */
const CAST_ADD = /เพิ่ม|ใส่.*เข้ามา|เอา.*เข้ามา(?:ด้วย)?|\badd\b/iu;

const MAX_REVISION_TEXT = 120;

function trimmed(value: string | undefined): string | undefined {
  const text = value
    ?.replace(/\s*(?:ครับ|ค่ะ|คะ|นะ|หน่อย|ด้วย|แทน)\s*$/u, "")
    .replace(/[.!。]+$/u, "")
    .trim();
  return text && text.length <= MAX_REVISION_TEXT ? text : undefined;
}

/**
 * Reads a document-level revision, or a cast addition, from one message.
 *
 * Returns undefined for everything else, which is what keeps ordinary
 * conversation and the existing range-edit path reachable.
 */
export function parseStoryboardRevision(params: {
  content: string;
  knownCharacterNames: readonly string[];
}): StoryboardDocumentRevision | StoryboardCastAddition | undefined {
  const text = normalizeStoryboardText(params.content);
  if (!text) {
    return undefined;
  }
  // Audio is read before anything else: "ไม่เอาเสียงพูด" also carries the
  // "เอา" that the duration and environment markers accept. The decision comes
  // from storyboard-audio.ts, the one parser that separates SOUND from SPEECH,
  // so a revision and a fresh request cannot disagree about the same wording.
  const audio = parseStoryboardAudioIntent(text);
  if (audio) {
    return { kind: "audio", audio };
  }
  const names = matchKnownNames(text, params.knownCharacterNames);
  if (names.length > 0 && CAST_ADD.test(text)) {
    return { kind: "cast_add", names };
  }
  // "ขอ 15 วิแทน" is one word to the duration reader: its unit guard rejects
  // "วิ" when a letter follows, and "แทน" is exactly that. Splitting the
  // replacement marker off lets the shared reader see "15 วิ" as it expects.
  const seconds = readStoryboardDuration(text.replace(/แทน(?:ที่)?/gu, " "));
  if (seconds !== undefined && DURATION_REVISION.test(text)) {
    return { kind: "duration", durationSeconds: seconds };
  }
  const camera = trimmed(text.match(CAMERA_REVISION)?.[1] ?? text.match(CAMERA_REVISION)?.[2]);
  if (camera) {
    return { kind: "camera", camera };
  }
  const environment = trimmed(text.match(ENVIRONMENT_REVISION)?.[1]);
  return environment ? { kind: "environment", environment } : undefined;
}

/**
 * Re-times the existing beats across a new total length.
 *
 * Beat KINDS are preserved, so the shape of the scene the owner approved
 * survives a length change; only the windows move. A length shorter than the
 * beat count drops trailing beats, which is the same rule the compiler applies
 * when it first plans them.
 */
function retimeBeats(
  beats: readonly StoryboardBeat[],
  durationSeconds: number,
): readonly StoryboardBeat[] {
  const kept = beats.slice(0, Math.max(1, Math.min(beats.length, durationSeconds)));
  const windows = allocateBeatWindows(
    durationSeconds,
    kept.map((beat) => beat.kind),
  );
  return Object.freeze(
    kept.map((beat, index) =>
      Object.freeze({
        ...beat,
        startSeconds: windows[index]!.startSeconds,
        endSeconds: windows[index]!.endSeconds,
      }),
    ),
  );
}

/** Applies one revision, returning a new immutable document. */
export function applyStoryboardDocumentRevision(
  document: StoryboardDocument,
  revision: StoryboardDocumentRevision,
): StoryboardDocument {
  if (revision.kind === "duration") {
    return Object.freeze({
      ...document,
      durationSeconds: revision.durationSeconds,
      beats: retimeBeats(document.beats, revision.durationSeconds),
    });
  }
  if (revision.kind === "environment") {
    return Object.freeze({ ...document, environment: revision.environment });
  }
  if (revision.kind === "camera") {
    return Object.freeze({
      ...document,
      beats: Object.freeze(
        document.beats.map((beat) => Object.freeze({ ...beat, camera: revision.camera })),
      ),
    });
  }
  return applyStoryboardAudioMode(document, revision.audio);
}
