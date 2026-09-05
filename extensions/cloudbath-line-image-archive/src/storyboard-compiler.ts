/**
 * Deterministic beat assembly for a storyboard.
 *
 * Takes the parsed request (see `storyboard-request.ts`) and derives ordered
 * beats by fixed rules: one beat per recognised action, plus an establishing
 * opener and a connective turn, with screen time divided by weight. Prose is
 * generated last, from the structure — the structure is the source of truth,
 * never the formatted text.
 */

import { applyStoryboardAudioMode } from "./storyboard-audio.js";
import { parseStoryboardActions, type ParsedAction } from "./storyboard-request.js";
import type {
  StoryboardAspectRatio,
  StoryboardAudioMode,
  StoryboardBeat,
  StoryboardBeatKind,
  StoryboardCastMember,
  StoryboardDocument,
  StoryboardResolution,
  StoryboardSourceImage,
} from "./storyboard-types.js";

/** Relative screen time each beat kind earns when the duration is divided up. */
const BEAT_WEIGHTS: Readonly<Record<StoryboardBeatKind, number>> = {
  establishing: 2,
  locomotion: 3,
  transition: 2,
  dialogue: 3,
  action: 2,
};

/** Dropped first when the duration cannot seat every beat: generated before requested. */
const DROP_ORDER: readonly StoryboardBeatKind[] = ["transition", "establishing", "action"];

type PlannedBeat = Readonly<{
  kind: StoryboardBeatKind;
  framing: string;
  camera: string;
  action: string;
  dialogue?: string;
  soundDesign?: string;
  environmentNote?: string;
  characterIds: readonly string[];
  /** Names this beat was built from, so a connective beat can reuse them. */
  subject?: string;
  object?: string;
}>;

function castIds(cast: readonly StoryboardCastMember[]): readonly string[] {
  return cast.map((member) => member.characterId);
}

/** Canonical ids for the named display names, kept in frozen cast order. */
function idsForNames(
  cast: readonly StoryboardCastMember[],
  names: ReadonlyArray<string | undefined>,
): readonly string[] {
  const wanted = new Set(names.filter((name): name is string => Boolean(name)));
  const matched = cast.filter((member) => wanted.has(member.displayName));
  return (matched.length > 0 ? matched : cast).map((member) => member.characterId);
}

function displayList(cast: readonly StoryboardCastMember[]): string {
  return cast.map((member) => member.displayName).join(" และ ");
}

/**
 * Beats implied by the parsed actions.
 *
 * Two beats are generated rather than requested: an opening establishing shot,
 * and a connective turn between moving and talking. Both are ordinary
 * cinematic grammar, and both are the first to be dropped when the requested
 * duration cannot seat every beat.
 */
function planBeats(
  actions: readonly ParsedAction[],
  cast: readonly StoryboardCastMember[],
  environment: string,
): readonly PlannedBeat[] {
  const fromActions: PlannedBeat[] = actions.map((action) => {
    const subjects = [action.subject, action.object];
    if (action.kind === "dialogue") {
      return {
        kind: action.kind,
        framing: cast.length > 1 ? action.framing : "Medium shot",
        camera: action.camera,
        action: `${displayList(cast)} ${action.phrase}`.trim(),
        dialogue: action.phrase,
        characterIds: castIds(cast),
      };
    }
    return {
      kind: action.kind,
      framing: action.framing,
      camera: action.camera,
      action: [action.subject, action.phrase, action.object].filter(Boolean).join(" "),
      characterIds: idsForNames(cast, subjects),
      ...(action.subject ? { subject: action.subject } : {}),
      ...(action.object ? { object: action.object } : {}),
    };
  });

  const withConnectives: PlannedBeat[] = [];
  for (const [index, beat] of fromActions.entries()) {
    withConnectives.push(beat);
    const next = fromActions[index + 1];
    if (beat.kind !== "locomotion" || next?.kind !== "dialogue") {
      continue;
    }
    withConnectives.push({
      kind: "transition",
      framing: "Medium shot",
      camera: "Static",
      action: [beat.subject, "หันกลับมามอง", beat.object === beat.subject ? undefined : beat.object]
        .filter(Boolean)
        .join(" "),
      characterIds: beat.characterIds,
    });
  }

  if (cast.length === 0 && withConnectives.length === 0) {
    return [];
  }
  return [
    {
      kind: "establishing",
      framing: "Wide establishing shot",
      camera: "Static",
      action: cast.length > 0 ? `${displayList(cast)} อยู่ในฉาก` : "เปิดฉาก",
      ...(environment ? { environmentNote: environment } : {}),
      characterIds: castIds(cast),
    },
    ...withConnectives,
  ];
}

/**
 * Drops generated beats before requested ones until every beat can hold >= 1s.
 *
 * When even the requested beats cannot all be seated -- a duration shorter than
 * the number of actions named -- the EARLIEST requested beats are kept and the
 * tail is truncated. Something has to give at that point; keeping the opening
 * of the scene is the least surprising choice.
 */
function trimToDuration(
  beats: readonly PlannedBeat[],
  durationSeconds: number,
): readonly PlannedBeat[] {
  const kept = [...beats];
  for (const kind of DROP_ORDER) {
    while (kept.length > durationSeconds) {
      const index = kept.findIndex((beat) => beat.kind === kind);
      if (index < 0 || kept.length <= 1) {
        break;
      }
      kept.splice(index, 1);
    }
  }
  return kept.slice(0, Math.max(1, durationSeconds));
}

/**
 * Splits the duration across beats by weight.
 *
 * Every window is at least one second, strictly increasing, contiguous from 0
 * and ending exactly on the requested duration — a rounded plan must never
 * lose, invent, or zero out screen time. Requires `durationSeconds >= kinds.length`,
 * which `trimToDuration` guarantees.
 */
export function allocateBeatWindows(
  durationSeconds: number,
  kinds: readonly StoryboardBeatKind[],
): ReadonlyArray<{ startSeconds: number; endSeconds: number }> {
  const total = kinds.reduce((sum, kind) => sum + BEAT_WEIGHTS[kind], 0);
  const boundaries: number[] = [];
  let running = 0;
  for (const [index, kind] of kinds.entries()) {
    running += BEAT_WEIGHTS[kind];
    // Every earlier beat needs at least one second, and so does every later
    // one: those two bounds make the window feasible before rounding is
    // applied, and `previous + 1` then makes it strictly increasing. Clamping
    // after rounding without them is what produced zero-length beats.
    const floor = index + 1;
    const ceiling = durationSeconds - (kinds.length - 1 - index);
    const rounded = Math.round((durationSeconds * running) / total);
    const previous = boundaries[index - 1] ?? 0;
    boundaries.push(Math.min(Math.max(rounded, floor, previous + 1), ceiling));
  }
  boundaries[boundaries.length - 1] = durationSeconds;
  return boundaries.map((endSeconds, index) => ({
    startSeconds: index === 0 ? 0 : boundaries[index - 1]!,
    endSeconds,
  }));
}

export type CompileStoryboardParams = Readonly<{
  scenePrompt: string;
  cast: readonly StoryboardCastMember[];
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  resolution: StoryboardResolution;
  environment: string;
  /**
   * Scene audio decision, when the request named one.
   *
   * Absent, it is derived from whether any beat carries a spoken line, which
   * is the pre-audio-mode behaviour: a scene the owner never discussed audio
   * for gets no invented sound direction.
   */
  audio?: StoryboardAudioMode;
  /** The first frame the owner chose, when this scene is built from one. */
  sourceImage?: StoryboardSourceImage;
  /** Already schema-validated and canonically mapped by StoryboardLlmPlanner. */
  plannedBeats?: readonly StoryboardBeat[];
}>;

/** Compiles one immutable storyboard document. Deterministic for a given input. */
export function compileStoryboardDocument(params: CompileStoryboardParams): StoryboardDocument {
  const beats = params.plannedBeats
    ? (validatePlannedTimeline(params.plannedBeats, params.durationSeconds),
      [...params.plannedBeats])
    : buildDerivedBeats(params);
  const base = Object.freeze({
    version: 1,
    scenePrompt: params.scenePrompt,
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    environment: params.environment,
    audio: "off",
    cast: Object.freeze([...params.cast]),
    beats: Object.freeze(beats),
    ...(params.sourceImage ? { sourceImage: params.sourceImage } : {}),
  } satisfies StoryboardDocument);
  // One place decides audio, and it is the same one a later revision goes
  // through, so a spoken beat always arrives with its sound design attached
  // instead of a `generate_audio` flag over a prompt that never mentions sound.
  const audio =
    params.audio ?? (beats.some((beat) => Boolean(beat.dialogue?.trim())) ? "full" : "off");
  return applyStoryboardAudioMode(base, audio);
}

/** Beats derived from the request text, when no planner supplied them. */
function buildDerivedBeats(params: CompileStoryboardParams): StoryboardBeat[] {
  const actions = parseStoryboardActions(
    params.scenePrompt,
    params.cast.map((member) => member.displayName),
  );
  const planned = trimToDuration(
    planBeats(actions, params.cast, params.environment),
    params.durationSeconds,
  );
  const windows = allocateBeatWindows(
    params.durationSeconds,
    planned.map((beat) => beat.kind),
  );
  return planned.map((beat, index) =>
    Object.freeze({
      beatId: `BEAT-${index + 1}`,
      startSeconds: windows[index]!.startSeconds,
      endSeconds: windows[index]!.endSeconds,
      kind: beat.kind,
      framing: beat.framing,
      action: beat.action,
      caption: beat.action.slice(0, 80),
      camera: beat.camera,
      ...(beat.dialogue ? { dialogue: beat.dialogue } : {}),
      ...(beat.environmentNote ? { environmentNote: beat.environmentNote } : {}),
      characterIds: Object.freeze([...beat.characterIds]),
    }),
  );
}

function validatePlannedTimeline(beats: readonly StoryboardBeat[], durationSeconds: number): void {
  if (beats.length === 0 || beats[0]?.startSeconds !== 0) {
    throw new Error("Planned storyboard must start at zero");
  }
  for (const [index, beat] of beats.entries()) {
    if (
      beat.endSeconds <= beat.startSeconds ||
      beat.startSeconds !== (index === 0 ? 0 : beats[index - 1]!.endSeconds)
    ) {
      throw new Error("Planned storyboard beats must be positive and contiguous");
    }
  }
  if (beats.at(-1)?.endSeconds !== durationSeconds) {
    throw new Error("Planned storyboard must end at its duration");
  }
}

export type StoryboardTimeRangeEdit = Readonly<{
  fromSeconds: number;
  toSeconds: number;
  /** What should happen across that range, in the owner's words. */
  action: string;
  /** Cast the edit names; falls back to the beat being replaced. */
  characterIds?: readonly string[];
}>;

/**
 * Returns a NEW document with `[from, to)` replaced by one beat.
 *
 * The input document is never mutated: an earlier version stays exactly as the
 * owner approved it, which is the whole point of storyboard versioning. An
 * out-of-range edit throws instead of clamping, so a mistyped range cannot
 * silently rewrite a different part of the scene.
 */
export function applyStoryboardTimeRangeEdit(
  document: StoryboardDocument,
  edit: StoryboardTimeRangeEdit,
): StoryboardDocument {
  if (
    !Number.isFinite(edit.fromSeconds) ||
    !Number.isFinite(edit.toSeconds) ||
    edit.fromSeconds < 0 ||
    edit.toSeconds <= edit.fromSeconds ||
    edit.toSeconds > document.durationSeconds
  ) {
    throw new Error("Storyboard edit range must fall inside the scene duration");
  }
  // The first overlapped beat supplies the framing the edit inherits, so a
  // reworded beat keeps the shot it replaced unless the owner says otherwise.
  const anchor = document.beats.find(
    (beat) => beat.startSeconds < edit.toSeconds && beat.endSeconds > edit.fromSeconds,
  );
  const rewritten: StoryboardBeat[] = [];
  for (const beat of document.beats) {
    if (beat.startSeconds >= edit.toSeconds || beat.endSeconds <= edit.fromSeconds) {
      rewritten.push(beat);
      continue;
    }
    if (beat.startSeconds < edit.fromSeconds) {
      rewritten.push(Object.freeze({ ...beat, endSeconds: edit.fromSeconds }));
    }
    if (beat.endSeconds > edit.toSeconds) {
      rewritten.push(Object.freeze({ ...beat, startSeconds: edit.toSeconds }));
    }
  }
  rewritten.push(
    Object.freeze({
      beatId: "BEAT-EDIT",
      startSeconds: edit.fromSeconds,
      endSeconds: edit.toSeconds,
      kind: anchor?.kind ?? "action",
      framing: anchor?.framing ?? "Medium shot",
      action: edit.action,
      camera: anchor?.camera ?? "Static",
      characterIds: Object.freeze([
        ...(edit.characterIds ??
          anchor?.characterIds ??
          document.cast.map((member) => member.characterId)),
      ]),
    }),
  );
  const ordered = rewritten
    .toSorted((left, right) => left.startSeconds - right.startSeconds)
    .map((beat, index) => Object.freeze({ ...beat, beatId: `BEAT-${index + 1}` }));
  return Object.freeze({ ...document, beats: Object.freeze(ordered) });
}
