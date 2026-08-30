import {
  PREVIS_ASPECT_RATIOS,
  type PrevisAspectRatio,
  type PrevisCastMember,
  type PrevisDocument,
  type PrevisMovement,
  type PrevisPlacement,
  type PrevisShot,
} from "./previs-types.js";

/**
 * Deterministic construction and time-range editing of previs documents.
 *
 * Everything here is pure: the same inputs always produce the same document, so
 * a previs is reviewable and testable without CozyClay, R2, Notion or LINE.
 */

/** CozyClay addresses cast by letter. Cast order is the only thing that assigns one. */
const STAND_IN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Stage half-width used to spread an unplaced cast across the floor, in metres. */
const DEFAULT_STAGE_SPREAD_M = 1.5;

export type PrevisCastInput = Readonly<{
  characterCode: string;
  characterPageId: string;
  displayName: string;
}>;

export function isPrevisAspectRatio(value: string): value is PrevisAspectRatio {
  return (PREVIS_ASPECT_RATIOS as readonly string[]).includes(value);
}

/**
 * Maps frozen Cloudbath Characters onto generic CozyClay stand-ins by cast
 * order. The mapping is positional and total, so CHAR-6 before CHAR-7 always
 * yields A then B; the canonical code and page id ride along untouched.
 */
export function assignStandIns(cast: readonly PrevisCastInput[]): readonly PrevisCastMember[] {
  if (cast.length === 0) {
    throw new Error("Previs cast must contain at least one character");
  }
  if (cast.length > STAND_IN_LETTERS.length) {
    throw new Error(`Previs cast is limited to ${STAND_IN_LETTERS.length} characters`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    cast.map((member, index) => {
      const code = member.characterCode.trim();
      if (!code) {
        throw new Error("Previs cast member is missing a canonical character code");
      }
      if (seen.has(code)) {
        throw new Error(`Previs cast repeats character ${code}`);
      }
      seen.add(code);
      const standIn = STAND_IN_LETTERS[index]!;
      return Object.freeze({
        characterCode: code,
        characterPageId: member.characterPageId,
        displayName: member.displayName,
        standIn,
        // Generic geometry only. The photoreal likeness stays with the frozen
        // Character lock; putting it here would leak identity into the engine.
        standInSubject: `previs stand-in ${standIn}`,
      });
    }),
  );
}

/** Spreads the cast evenly along x, facing each other across the stage centre. */
function defaultPlacements(cast: readonly PrevisCastMember[]): readonly PrevisPlacement[] {
  const span = cast.length === 1 ? 0 : (DEFAULT_STAGE_SPREAD_M * 2) / (cast.length - 1);
  return Object.freeze(
    cast.map((member, index) =>
      Object.freeze({
        standIn: member.standIn,
        x: cast.length === 1 ? 0 : -DEFAULT_STAGE_SPREAD_M + span * index,
        z: 0,
        facing: index % 2 === 0 ? 90 : 270,
      }),
    ),
  );
}

/**
 * One shot covering the whole scene, framed on the first cast member.
 *
 * Cast size picks the size: a single subject reads at a medium shot, but a
 * two-hander framed that tight puts the second stand-in outside the frame,
 * which is exactly the blocking a reviewer opened the previs to check.
 */
function defaultShots(
  durationSeconds: number,
  focus: string,
  castSize: number,
): readonly PrevisShot[] {
  return Object.freeze([
    Object.freeze({
      shotId: "SHOT-1",
      startSecond: 0,
      endSecond: durationSeconds,
      camera: Object.freeze({
        focus,
        size: castSize > 1 ? "medium-wide shot" : "medium shot",
        view: "profile",
        level: "eye",
        side: "right",
        move: "Static / locked-off",
      }),
    }),
  ]);
}

export function createPrevisDocument(params: {
  scenePrompt: string;
  durationSeconds: number;
  aspectRatio: PrevisAspectRatio;
  cast: readonly PrevisCastInput[];
  movements?: readonly PrevisMovement[];
}): PrevisDocument {
  if (!Number.isSafeInteger(params.durationSeconds) || params.durationSeconds < 1) {
    throw new Error("Previs duration must be a positive whole number of seconds");
  }
  const cast = assignStandIns(params.cast);
  const known = new Set(cast.map((member) => member.standIn));
  const movements = Object.freeze(
    (params.movements ?? []).map((movement) =>
      Object.freeze(requireRange(movement, params.durationSeconds, known)),
    ),
  );
  return Object.freeze({
    version: 1,
    scenePrompt: params.scenePrompt,
    durationSeconds: params.durationSeconds,
    aspectRatio: params.aspectRatio,
    cast,
    placements: defaultPlacements(cast),
    movements: sortMovements(movements),
    shots: defaultShots(params.durationSeconds, cast[0]!.standIn, cast.length),
  });
}

function requireRange(
  movement: PrevisMovement,
  durationSeconds: number,
  knownStandIns: ReadonlySet<string>,
): PrevisMovement {
  if (!knownStandIns.has(movement.standIn)) {
    throw new Error(`Previs movement references unknown stand-in ${movement.standIn}`);
  }
  if (
    !Number.isFinite(movement.startSecond) ||
    !Number.isFinite(movement.endSecond) ||
    movement.startSecond < 0 ||
    movement.endSecond <= movement.startSecond ||
    movement.endSecond > durationSeconds
  ) {
    throw new Error("Previs movement range must fall inside the scene duration");
  }
  return movement;
}

/** Deterministic order: by start, then stand-in, then end. Keeps documents comparable. */
function sortMovements(movements: readonly PrevisMovement[]): readonly PrevisMovement[] {
  return Object.freeze(
    movements.toSorted(
      (a, b) =>
        a.startSecond - b.startSecond ||
        a.standIn.localeCompare(b.standIn) ||
        a.endSecond - b.endSecond,
    ),
  );
}

export type PrevisTimeRangeEdit = Readonly<{
  standIn: string;
  fromSecond: number;
  toSecond: number;
  beat: string;
}>;

/**
 * Applies a natural-language beat to one time range and returns a NEW document.
 *
 * Only the requested [from, to) window changes. A movement that straddles the
 * window is split so its outside portions survive with their original beat —
 * without the split, an edit at 10-14s would silently rewrite a 6-16s beat and
 * lose blocking the owner never asked to change. The input document is not
 * mutated: versions are immutable and v1 must stay retrievable.
 */
export function applyTimeRangeEdit(
  document: PrevisDocument,
  edit: PrevisTimeRangeEdit,
): PrevisDocument {
  if (!document.cast.some((member) => member.standIn === edit.standIn)) {
    throw new Error(`Previs edit references unknown stand-in ${edit.standIn}`);
  }
  if (
    !Number.isFinite(edit.fromSecond) ||
    !Number.isFinite(edit.toSecond) ||
    edit.fromSecond < 0 ||
    edit.toSecond <= edit.fromSecond ||
    edit.toSecond > document.durationSeconds
  ) {
    throw new Error("Previs edit range must fall inside the scene duration");
  }
  const rewritten: PrevisMovement[] = [];
  for (const movement of document.movements) {
    const overlaps =
      movement.standIn === edit.standIn &&
      movement.startSecond < edit.toSecond &&
      movement.endSecond > edit.fromSecond;
    if (!overlaps) {
      rewritten.push(movement);
      continue;
    }
    if (movement.startSecond < edit.fromSecond) {
      rewritten.push(Object.freeze({ ...movement, endSecond: edit.fromSecond }));
    }
    if (movement.endSecond > edit.toSecond) {
      rewritten.push(Object.freeze({ ...movement, startSecond: edit.toSecond }));
    }
  }
  rewritten.push(
    Object.freeze({
      standIn: edit.standIn,
      startSecond: edit.fromSecond,
      endSecond: edit.toSecond,
      beat: edit.beat,
    }),
  );
  return Object.freeze({ ...document, movements: sortMovements(rewritten) });
}

/** Movements overlapping [fromSecond, toSecond), for review and assertions. */
export function movementsInRange(
  document: PrevisDocument,
  fromSecond: number,
  toSecond: number,
): readonly PrevisMovement[] {
  return document.movements.filter(
    (movement) => movement.startSecond < toSecond && movement.endSecond > fromSecond,
  );
}
