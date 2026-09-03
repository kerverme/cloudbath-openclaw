/**
 * Cloudbath storyboard: the DEFAULT staging layer for a natural-language video
 * request.
 *
 * A storyboard version is an IMMUTABLE Cloudbath-owned document describing a
 * scene as ordered beats — framing, action, camera and dialogue intent. It is
 * deliberately NOT a `PrevisDocument`: previs describes 3D blocking for the
 * CozyClay engine, while a storyboard describes shot intent that a video model
 * can be driven from. Previs stays reachable for explicit legacy requests.
 *
 * Nothing in this layer is paid. Preparing a Final Video Draft calls no
 * provider and does not stand in for the exact `ยืนยัน VIDEO ####` gate that
 * remains the only path to a billed job.
 */

import type { UgcCharacterLock } from "./types.js";

/** Aspect ratios a storyboard request may select. Mirrors the previs set. */
export const STORYBOARD_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "2.39:1"] as const;
export type StoryboardAspectRatio = (typeof STORYBOARD_ASPECT_RATIOS)[number];

/** Target output resolutions a request may name. */
export const STORYBOARD_RESOLUTIONS = ["480p", "720p", "1080p", "4K"] as const;
export type StoryboardResolution = (typeof STORYBOARD_RESOLUTIONS)[number];

/**
 * What a beat is doing, which fixes its default framing, camera and weight.
 *
 * A closed union rather than free text so timing and framing stay derivable:
 * an unrecognised action becomes `"action"`, never a new implicit kind.
 */
/**
 * Scene-level audio decision.
 *
 * `ambient` is the shape the previous boolean could not express: sound on,
 * speech off. Collapsing it back to a boolean is what made "ไม่มีเสียงพูด
 * แต่มีเสียง" render as a silent scene.
 */
export type StoryboardAudioMode = "off" | "ambient" | "full";

export type StoryboardBeatKind =
  | "establishing"
  | "locomotion"
  | "transition"
  | "dialogue"
  | "action";

/**
 * One canonical Cloudbath Character as cast in this storyboard.
 *
 * `characterId` (e.g. "CHAR-6") stays authoritative. `displayName` ("Twong") is
 * only what the owner types and reads; it must never become the canonical id.
 */
export type StoryboardCastMember = Readonly<{
  /** Canonical Cloudbath Character code from the Character Library, e.g. "CHAR-6". */
  characterId: string;
  /** Notion Character Library page id, carried from the frozen project lock. */
  characterPageId: string;
  /** Name as cast in this scene, e.g. "Twong". */
  displayName: string;
}>;

/** One contiguous slice of the scene with a single shot setup. */
export type StoryboardBeat = Readonly<{
  beatId: string;
  startSeconds: number;
  endSeconds: number;
  kind: StoryboardBeatKind;
  /** Shot type / framing, e.g. "Wide establishing shot". */
  framing: string;
  /** What happens, in the owner's own scene language. */
  action: string;
  /** Camera instruction, e.g. "Track with the subject". */
  camera: string;
  /** SPEECH only: the spoken line, verbatim. Absent unless the beat is spoken. */
  dialogue?: string;
  /** SOUND only: ambience and effects for this window. Absent when audio is off. */
  soundDesign?: string;
  /** Beat-local environment note, when it differs from the scene environment. */
  environmentNote?: string;
  /** Canonical character ids this beat frames, in cast order. */
  characterIds: readonly string[];
}>;

/** The immutable storyboard document for one version. */
export type StoryboardDocument = Readonly<{
  version: 1;
  /** The owner's original request text for this version. */
  scenePrompt: string;
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  resolution: StoryboardResolution;
  /** Scene location, e.g. "ร้านกาแฟ". Empty when the request named none. */
  environment: string;
  /** Scene audio decision. Drives both the LINE rendering and the provider prompt. */
  audio: StoryboardAudioMode;
  cast: readonly StoryboardCastMember[];
  beats: readonly StoryboardBeat[];
}>;

/** Immutable durable record for one storyboard version. */
export type StoryboardVersion = Readonly<{
  version: 1;
  storyboardId: string;
  /** Monotonic from 1. A version is never rewritten; edits append. */
  versionNumber: number;
  /** The version this one was derived from, absent for v1. */
  parentVersionNumber?: number;
  /** Real UGC project instance this storyboard belongs to. */
  projectInstanceId: string;
  /** Real UGC_PROJECTS page id. */
  projectPageId: string;
  /** Real UGC scene label, e.g. "SCENE-1". */
  sceneId: string;
  /** Real UGC_SHOTS page id for that scene. */
  scenePageId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  /** Frozen canonical Character locks, in cast order. */
  characterLocks: readonly UgcCharacterLock[];
  document: StoryboardDocument;
  createdAt: string;
}>;

/** Head pointer for a storyboard: which version is current. */
export type StoryboardHead = Readonly<{
  version: 1;
  storyboardId: string;
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  latestVersionNumber: number;
  updatedAt: string;
}>;

/** Who is asking. Every storyboard read is checked against this triple, fail-closed. */
export type StoryboardAccessClaim = Readonly<{
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
}>;

/** The owner's current storyboard, scoped to the trusted LINE identity triple. */
export type ActiveStoryboardContext = Readonly<{
  version: 1;
  storyboardId: string;
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  updatedAt: string;
}>;

/**
 * Which video model a draft names.
 *
 * `deferred` carries a display name only: this repository has no verified
 * canonical provider id for the preferred model, and inventing one would bind
 * the paid pipeline to a string no catalog can resolve.
 */
export type StoryboardVideoModelSelection =
  | Readonly<{ kind: "provider-bound"; providerModelId: string; displayName: string }>
  | Readonly<{ kind: "deferred"; displayName: string }>;

/**
 * A cost estimate, or a typed reason there is none.
 *
 * Pricing in this repository is derived from the provider's live catalog for a
 * BOUND model. With binding deferred there is no honest number, so the estimate
 * is explicitly unavailable rather than a placeholder the owner might trust.
 */
export type StoryboardCostEstimate =
  | Readonly<{ kind: "available"; amountUsd: number; source: string }>
  | Readonly<{ kind: "unavailable"; reason: "provider-binding-deferred" | "pricing-unavailable" }>;

/**
 * Provider-neutral final-video instruction compiled from a storyboard.
 *
 * Deliberately not shaped for any one vendor: this is the input the future
 * provider adapter will translate, so beat timing, cast order and camera
 * intent survive the handoff without a lossy vendor-specific rewrite.
 */
export type StoryboardVideoPlan = Readonly<{
  version: 1;
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  resolution: StoryboardResolution;
  environment: string;
  audio: StoryboardAudioMode;
  characters: readonly StoryboardPlanCharacter[];
  beats: readonly StoryboardPlanBeat[];
}>;

/** One cast member in a provider-neutral plan, with the references already held. */
export type StoryboardPlanCharacter = Readonly<{
  characterId: string;
  characterPageId: string;
  displayName: string;
  /** Identity reference locators the UGC workflow already froze for this character. */
  identityReferences: readonly string[];
}>;

/** One beat in a provider-neutral plan. */
export type StoryboardPlanBeat = Readonly<{
  beatId: string;
  startSeconds: number;
  endSeconds: number;
  framing: string;
  action: string;
  camera: string;
  dialogue?: string;
  soundDesign?: string;
  characterIds: readonly string[];
}>;

/**
 * How a draft can be confirmed.
 *
 * A `ยืนยัน VIDEO ####` code is only meaningful once the draft is registered
 * with the LINE paid draft store, which requires a bound provider model. Until
 * then the state is `deferred`: the owner is told the draft is ready and that
 * confirmation is not yet enabled, rather than being handed a code that could
 * collide with an unrelated pending paid draft.
 */
export type StoryboardDraftConfirmation =
  | Readonly<{ kind: "ready"; code: string }>
  | Readonly<{ kind: "deferred" }>;

/**
 * A prepared Final Video Draft. Creating one calls NO provider.
 *
 * This record does not itself submit or authorise a paid job; the exact
 * `ยืนยัน VIDEO ####` gate in the LINE plugin remains the only path to one.
 */
export type StoryboardFinalVideoDraft = Readonly<{
  version: 1;
  draftId: string;
  storyboardId: string;
  storyboardVersionNumber: number;
  projectInstanceId: string;
  projectPageId: string;
  sceneId: string;
  scenePageId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  characterLocks: readonly UgcCharacterLock[];
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  resolution: StoryboardResolution;
  model: StoryboardVideoModelSelection;
  estimatedCost: StoryboardCostEstimate;
  plan: StoryboardVideoPlan;
  confirmation: StoryboardDraftConfirmation;
  createdAt: string;
}>;
