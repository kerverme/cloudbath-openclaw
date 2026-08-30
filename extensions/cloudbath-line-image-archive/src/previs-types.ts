/**
 * Cloudbath previs (pre-visualisation) staging layer.
 *
 * A previs version is an IMMUTABLE Cloudbath-owned document describing a scene
 * as blocking, camera and timeline intent. CozyClay is the previs engine that
 * renders that intent into a `.cclayproject`; it never owns identity. Cloudbath
 * keeps the canonical Character identity, the stable review URL, the version
 * chain and the approval state.
 *
 * Phase 1 stops before paid generation: an approved previs version becomes
 * ELIGIBLE for the existing video-draft pipeline, and nothing here calls a
 * paid provider or bypasses the exact `ยืนยัน VIDEO ####` gate.
 */

/** Aspect ratios CozyClay's scene document accepts (`src/scenes.js` stage normaliser). */
export const PREVIS_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "2.39:1"] as const;
export type PrevisAspectRatio = (typeof PREVIS_ASPECT_RATIOS)[number];

/** CozyClay's production timeline clock. Frame numbers below are on this clock. */
export const PREVIS_TIMELINE_FPS = 24;

/**
 * One canonical Cloudbath Character mapped onto a generic CozyClay stand-in.
 *
 * `characterCode` / `characterPageId` stay authoritative: the stand-in letter is
 * a rendering detail of the previs engine and must never be treated as the
 * character's identity. Photoreal identity references remain Cloudbath's job.
 */
export type PrevisCastMember = Readonly<{
  /** Canonical Cloudbath Character code, e.g. "CHAR-6". */
  characterCode: string;
  /** Notion Character Library page id carried from the frozen project lock. */
  characterPageId: string;
  /** Display name as cast in this scene, e.g. "Twong". */
  displayName: string;
  /** CozyClay stand-in letter, assigned deterministically by cast order. */
  standIn: string;
  /** Stand-in description handed to CozyClay. Generic geometry only, never an identity reference. */
  standInSubject: string;
}>;

/** Where a stand-in starts, in CozyClay's metre/degree stage coordinates. */
export type PrevisPlacement = Readonly<{
  standIn: string;
  x: number;
  z: number;
  /** Yaw in degrees; 0 faces the default camera. */
  facing: number;
}>;

/**
 * One movement leg on the timeline. Legs are Cloudbath-owned: CozyClay's
 * headless MCP surface reports `layer.waypoints` but exposes no tool to author
 * them, so the path lives here and reaches the engine as start placement plus
 * a Phase 2 motion hand-off.
 */
export type PrevisMovement = Readonly<{
  standIn: string;
  startSecond: number;
  endSecond: number;
  /** Plain-language beat, e.g. "walks past B and slows". */
  beat: string;
  to?: Readonly<{ x: number; z: number }>;
}>;

/** Camera intent for a shot, in CozyClay's film vocabulary. */
export type PrevisCamera = Readonly<{
  /** Stand-in the camera frames. */
  focus: string;
  size: string;
  view: string;
  level: string;
  side: string;
  /** Named camera move between two framings; "Static" when the camera holds. */
  move: string;
}>;

/** A contiguous slice of the scene with one camera setup. */
export type PrevisShot = Readonly<{
  shotId: string;
  startSecond: number;
  endSecond: number;
  camera: PrevisCamera;
}>;

/**
 * The immutable previs document for one version.
 *
 * Every field is authored by Cloudbath. `compilePrevisPlan` turns it into the
 * CozyClay MCP calls that are actually supported headlessly; anything CozyClay
 * cannot do without an editor or a GPU is reported as a deferral, never faked.
 */
export type PrevisDocument = Readonly<{
  version: 1;
  scenePrompt: string;
  durationSeconds: number;
  aspectRatio: PrevisAspectRatio;
  cast: readonly PrevisCastMember[];
  placements: readonly PrevisPlacement[];
  movements: readonly PrevisMovement[];
  shots: readonly PrevisShot[];
}>;

/** Immutable durable record for one previs version. */
export type PrevisVersion = Readonly<{
  version: 1;
  previsProjectId: string;
  sceneId: string;
  /** Monotonic from 1. A version is never rewritten; edits append. */
  versionNumber: number;
  /** The version this one was derived from, absent for v1. */
  parentVersionNumber?: number;
  /** Frozen project cast this previs is bound to. */
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  /** Canonical Character page ids frozen at previs creation, in cast order. */
  frozenCharacterPageIds: readonly string[];
  document: PrevisDocument;
  /**
   * Durable private-R2 object key for the `.cclayproject` artifact, or absent
   * when the engine was unavailable. Canonical identity is this key — never a
   * signed URL, which expires and cannot address an object later.
   */
  artifactObjectKey?: string;
  /** Capabilities CozyClay could not satisfy headlessly, carried for Phase 2. */
  deferredCapabilities: readonly PrevisDeferral[];
  createdAt: string;
  /** Set once approved. An approved version is frozen and never edited in place. */
  approvedAt?: string;
}>;

/** A previs capability CozyClay cannot deliver in Phase 1, and why. */
export type PrevisDeferral = Readonly<{
  capability: "TIMELINE_PROMPT_BLOCKS" | "CHARACTER_MOTION" | "FRAME_CAPTURE" | "BATCH_MUTATION";
  /** What CozyClay requires before this capability becomes available. */
  requires: "LIVE_EDITOR" | "LIVE_EDITOR_AND_GPU";
  reason: string;
}>;

/** Head pointer for a previs project: latest version and the approved one, if any. */
export type PrevisProjectHead = Readonly<{
  version: 1;
  previsProjectId: string;
  sceneId: string;
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  /** Capability token embedded in the stable review URL. */
  reviewToken: string;
  latestVersionNumber: number;
  approvedVersionNumber?: number;
  updatedAt: string;
}>;

/** Who is asking. Every previs read is checked against this triple, fail-closed. */
export type PrevisAccessClaim = Readonly<{
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
}>;
