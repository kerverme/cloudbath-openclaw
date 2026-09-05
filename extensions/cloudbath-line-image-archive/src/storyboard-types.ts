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

/**
 * Target output resolutions a REQUEST may name.
 *
 * "2K" and "4K" are here because provider endpoints offer them: MiniMax H3's
 * reference-to-video enumerates 768P/2K/4K, so without them the storyboard
 * vocabulary could not describe a scene that endpoint can execute. What the
 * endpoint actually produces is a separate, provider-owned value — see the
 * Final Video Draft's own `resolution`.
 */
export const STORYBOARD_RESOLUTIONS = ["480p", "720p", "1080p", "2K", "4K"] as const;
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
  /** Short owner-facing label used below the shot in review UI. */
  caption?: string;
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
  /**
   * The image the owner explicitly chose as this scene's first frame.
   *
   * Frozen into the storyboard because it is the authoritative input the
   * provider mode is derived from. Never inferred from whatever image happened
   * to arrive recently: an unrelated attachment silently becoming a video's
   * first frame is a wrong-content failure, so the director asks instead.
   */
  sourceImage?: StoryboardSourceImage;
}>;

/**
 * An owner-selected first-frame image, by reference.
 *
 * A locator the owning store can resolve, never bytes and never a signed URL:
 * this record is read back by logging and by the paid handoff, and neither may
 * carry an asset location.
 */
export type StoryboardInputMode =
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video"
  | "storyboard_shot_to_video";

/**
 * The provider input mode a frozen storyboard implies.
 *
 * ONE derivation, from the storyboard's own authoritative inputs, so the mode
 * a draft displays, the mode it is quoted against and the mode it submits
 * cannot drift apart. Frozen Character identities outrank a chosen first frame:
 * a scene cast from the Library is a reference render whatever else it carries.
 */
export function resolveStoryboardInputMode(
  version: Pick<StoryboardVersion, "characterLocks" | "document">,
): StoryboardInputMode {
  if (version.characterLocks.some((lock) => lock.identityReferences.length > 0)) {
    return "reference_to_video";
  }
  return version.document.sourceImage ? "image_to_video" : "text_to_video";
}

export type StoryboardSourceImage = Readonly<{
  kind: "owner_selected";
  /** Opaque handle the media store resolves. Never a URL. */
  mediaId: string;
  selectedAt: string;
}>;

/**
 * The UGC project a storyboard is filed under, when it has one.
 *
 * All four ids or none: they name one real Notion project and scene, and a
 * storyboard that has some of them would be a project nothing downstream could
 * resolve. Absent means STANDALONE work — an owner planning a video in a
 * conversation with no workspace still gets a real storyboard with a real
 * version chain, and inventing page ids for it would make a fabricated project
 * indistinguishable from a real one everywhere that reads these.
 */
export type StoryboardProjectLink = Readonly<{
  projectInstanceId: string;
  projectPageId: string;
  /** Real UGC scene label, e.g. "SCENE-1". */
  sceneId: string;
  scenePageId: string;
}>;

/** Immutable durable record for one storyboard version. */
export type StoryboardVersion = Readonly<{
  version: 1;
  storyboardId: string;
  /** Monotonic from 1. A version is never rewritten; edits append. */
  versionNumber: number;
  /** The version this one was derived from, absent for v1. */
  parentVersionNumber?: number;
  /** Absent for standalone work. See `StoryboardProjectLink`. */
  project?: StoryboardProjectLink;
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
  /** Absent for standalone work. */
  projectInstanceId?: string;
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
  /** Absent for standalone work. */
  projectInstanceId?: string;
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
  | Readonly<{
      kind: "provider-bound";
      /** Provider that will receive the paid request, e.g. "fal.ai". */
      provider: string;
      /** The ACTUAL endpoint id billed, e.g. "minimax/h3/reference-to-video". */
      providerModelId: string;
      displayName: string;
    }>
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
  /** Absent for standalone work. See `StoryboardProjectLink`. */
  project?: StoryboardProjectLink;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  characterLocks: readonly UgcCharacterLock[];
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  /**
   * The size the chosen endpoint will REALLY produce, in that endpoint's own
   * spelling ("2K", "768P", "720p").
   *
   * Deliberately not `StoryboardResolution`: this is a provider answer, not
   * the owner's request, and the two differ whenever the endpoint cannot
   * produce what was asked for. It is what the draft displays and what the
   * quote was computed from, so it must not be re-narrowed to the request
   * vocabulary.
   */
  resolution: string;
  model: StoryboardVideoModelSelection;
  estimatedCost: StoryboardCostEstimate;
  inputMode: StoryboardInputMode;
  renderStrategy: "quick_video" | "best_quality_shot_by_shot";
  plan: StoryboardVideoPlan;
  confirmation: StoryboardDraftConfirmation;
  createdAt: string;
}>;
