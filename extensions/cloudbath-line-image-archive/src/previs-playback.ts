import type { PrevisDocument, PrevisShot } from "./previs-types.js";

/**
 * Deterministic timeline sampling for the previs review player.
 *
 * Cloudbath owns the timeline, so scene state at time t is derived here from the
 * PrevisDocument alone -- the same input always yields the same state, which is
 * what makes a scrubbed review reproducible and testable without a browser.
 *
 * The camera solve below is a REVIEW APPROXIMATION, not CozyClay's geometry. It
 * turns the same film vocabulary into a plausible viewpoint so blocking and
 * timing can be judged; the authoritative solve lives in the `.cclayproject`
 * that CozyClay itself produced. Keeping our own arithmetic here is also what
 * lets the viewer ship without any CozyClay (AGPL) code in the browser.
 */

/** Metres from subject for each shot size, at the review lens. */
const SIZE_DISTANCE_M: Readonly<Record<string, number>> = {
  "extreme close-up": 0.7,
  "close-up": 1.1,
  "medium close-up": 1.8,
  "medium shot": 3.2,
  "medium-wide shot": 4.8,
  "wide shot": 8,
  "extreme wide shot": 14,
};

/** Lens height above the floor for each level, in metres. */
const LEVEL_HEIGHT_M: Readonly<Record<string, number>> = {
  ground: 0.2,
  low: 0.7,
  hip: 1,
  eye: 1.6,
  high: 2.6,
  overhead: 5,
};

/** Degrees of yaw the camera sits off the subject's facing, per view. */
const VIEW_OFFSET_DEG: Readonly<Record<string, number>> = {
  front: 0,
  "front three-quarter": 45,
  profile: 90,
  "rear three-quarter": 135,
  back: 180,
};

const DEFAULT_FOCAL_MM = 35;

export type PrevisActorState = Readonly<{
  standIn: string;
  x: number;
  z: number;
  facing: number;
  /** The beat active at this instant, when one covers it. */
  beat?: string;
}>;

export type PrevisCameraState = Readonly<{
  x: number;
  y: number;
  z: number;
  /** Point the lens aims at. */
  targetX: number;
  targetY: number;
  targetZ: number;
  focalMm: number;
}>;

export type PrevisFrameState = Readonly<{
  second: number;
  actors: readonly PrevisActorState[];
  shot?: PrevisShot;
  camera: PrevisCameraState;
}>;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Movements for one stand-in in timeline order; ties break on end, then beat. */
function legsFor(document: PrevisDocument, standIn: string) {
  return document.movements
    .filter((movement) => movement.standIn === standIn)
    .toSorted(
      (a, b) =>
        a.startSecond - b.startSecond || a.endSecond - b.endSecond || a.beat.localeCompare(b.beat),
    );
}

/**
 * Position and facing for one stand-in at `second`.
 *
 * Legs apply in order: one entirely in the past lands on its endpoint, the one
 * containing `second` interpolates, and anything still in the future is ignored.
 * A stand-in therefore holds its last committed pose between legs rather than
 * snapping back to its placement.
 */
export function actorStateAt(
  document: PrevisDocument,
  standIn: string,
  second: number,
): PrevisActorState {
  const placement = document.placements.find((entry) => entry.standIn === standIn);
  if (!placement) {
    throw new Error(`Previs has no placement for stand-in ${standIn}`);
  }
  let x = placement.x;
  let z = placement.z;
  let facing = placement.facing;
  let beat: string | undefined;
  for (const leg of legsFor(document, standIn)) {
    if (second <= leg.startSecond) {
      break;
    }
    const span = leg.endSecond - leg.startSecond;
    const progress =
      second >= leg.endSecond ? 1 : span <= 0 ? 1 : (second - leg.startSecond) / span;
    if (leg.to) {
      x = x + (leg.to.x - x) * progress;
      z = z + (leg.to.z - z) * progress;
    }
    if (leg.facingTo !== undefined) {
      // Shortest-arc turn, so a 350deg -> 10deg beat rotates 20deg forward
      // rather than sweeping the long way around.
      const delta = ((leg.facingTo - facing + 540) % 360) - 180;
      facing = facing + delta * progress;
    }
    if (second < leg.endSecond) {
      beat = leg.beat;
      break;
    }
    // A leg that has fully elapsed commits its endpoint before the next one.
    if (leg.to) {
      x = leg.to.x;
      z = leg.to.z;
    }
    if (leg.facingTo !== undefined) {
      facing = leg.facingTo;
    }
  }
  return { standIn, x, z, facing: ((facing % 360) + 360) % 360, ...(beat ? { beat } : {}) };
}

/** The shot covering `second`; the last shot stays active at exactly duration. */
export function shotAt(document: PrevisDocument, second: number): PrevisShot | undefined {
  return (
    document.shots.find((shot) => second >= shot.startSecond && second < shot.endSecond) ??
    document.shots.findLast((shot) => second >= shot.endSecond)
  );
}

/** Places the review camera from the shot's film vocabulary and its subject. */
export function cameraStateAt(document: PrevisDocument, second: number): PrevisCameraState {
  const shot = shotAt(document, second);
  const focusStandIn = shot?.camera.focus ?? document.cast[0]?.standIn;
  const subject = focusStandIn
    ? actorStateAt(document, focusStandIn, second)
    : { x: 0, z: 0, facing: 0 };
  const distance = SIZE_DISTANCE_M[shot?.camera.size ?? "medium shot"] ?? 3.2;
  const height = LEVEL_HEIGHT_M[shot?.camera.level ?? "eye"] ?? 1.6;
  const viewOffset = VIEW_OFFSET_DEG[shot?.camera.view ?? "profile"] ?? 90;
  // Camera left mirrors the orbit, so "left profile" and "right profile" are
  // opposite sides of the subject rather than the same shot twice.
  const side = shot?.camera.side === "left" ? -1 : 1;
  const angle = ((subject.facing + viewOffset * side) * Math.PI) / 180;
  // Chest height: a standing figure then sits inside the frame rather than
  // overflowing it at close shot sizes.
  const targetY = 1.1;
  return {
    x: subject.x + Math.sin(angle) * distance,
    y: height,
    z: subject.z + Math.cos(angle) * distance,
    targetX: subject.x,
    targetY,
    targetZ: subject.z,
    focalMm: DEFAULT_FOCAL_MM,
  };
}

/** Full scene state at `second`, clamped into [0, duration]. */
export function frameStateAt(document: PrevisDocument, second: number): PrevisFrameState {
  const clamped = clamp(second, 0, document.durationSeconds);
  return {
    second: clamped,
    actors: document.cast.map((member) => actorStateAt(document, member.standIn, clamped)),
    ...(shotAt(document, clamped) ? { shot: shotAt(document, clamped) } : {}),
    camera: cameraStateAt(document, clamped),
  };
}
