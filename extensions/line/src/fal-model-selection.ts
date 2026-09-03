/**
 * Capability matching between a FROZEN storyboard and fal's registry.
 *
 * Two rules shape everything here:
 *
 *   - The storyboard is the fixed side. A model is judged against what the
 *     owner already confirmed; the requirements are never relaxed to make a
 *     model fit, and choosing a model never edits the scene.
 *   - Unproven is not permission. A capability the registry marks `unknown`
 *     fails the check, so a model reaches a payable draft only when every
 *     requirement is answered by a fact with provenance behind it.
 *
 * The product default is MiniMax H3 when it clears those checks, but "default"
 * is a PREFERENCE ORDER over compatible models, never a bypass: H3 that cannot
 * execute the storyboard is not offered, and the owner is told which model
 * took its place and why.
 */
import {
  listFalVideoModels,
  type FalVideoModel,
  type FalVideoModelConfig,
} from "./fal-video-registry.js";

/**
 * What the frozen storyboard needs from a model.
 *
 * Derived once, from the confirmed version, and passed around unchanged so
 * every picker, filter and default decision judges the same scene.
 */
/**
 * The scene's audio decision, as this plugin sees it.
 *
 * Structurally the storyboard plugin's `StoryboardAudioMode`, restated here
 * rather than imported: a plugin never reaches into another plugin's `src/**`,
 * and the storyboard side hands this across the existing runtime seam.
 */
export type FalAudioRequirement = "off" | "ambient" | "full";

export type FalVideoRequirements = Readonly<{
  durationSeconds: number;
  aspectRatio: string;
  /**
   * The resolution the storyboard asked for, honoured when the endpoint offers
   * it and otherwise resolved to one the endpoint does support.
   *
   * Deliberately NOT a compatibility requirement. Output size is a property of
   * the endpoint, is never shown on the storyboard the owner confirms, and only
   * appears on the Final Video Draft — where the ACTUAL value is displayed. As
   * a hard filter it would rule out endpoints on a dimension the owner never
   * agreed to, including MiniMax H3, whose schema documents 2K as its only size.
   */
  resolution: string;
  audio: FalAudioRequirement;
  /** True when a beat carries a spoken line, which needs audible speech. */
  spokenDialogue: boolean;
  /** Character Library identity references the scene casts. */
  identityReferenceCount: number;
}>;

/** Why one model cannot execute this storyboard. Closed set; each is shown as-is. */
export type FalIncompatibility =
  | Readonly<{ kind: "duration"; requested: number; supported?: readonly number[] }>
  | Readonly<{ kind: "duration_unknown" }>
  | Readonly<{ kind: "aspect_ratio"; requested: string; supported: readonly string[] }>
  | Readonly<{ kind: "audio_required" }>
  | Readonly<{ kind: "audio_must_be_silent" }>
  | Readonly<{ kind: "identity_references_unsupported" }>
  | Readonly<{ kind: "too_many_references"; requested: number; supported: number }>;

export type FalModelCompatibility =
  | Readonly<{ compatible: true; model: FalVideoModel }>
  | Readonly<{ compatible: false; model: FalVideoModel; reasons: readonly FalIncompatibility[] }>;

function durationReasons(
  model: FalVideoModel,
  requirements: FalVideoRequirements,
): FalIncompatibility[] {
  const durations = model.durations;
  if (durations.kind === "unknown") {
    return [{ kind: "duration_unknown" }];
  }
  if (durations.kind === "enum") {
    return durations.seconds.includes(requirements.durationSeconds)
      ? []
      : [
          {
            kind: "duration",
            requested: requirements.durationSeconds,
            supported: durations.seconds,
          },
        ];
  }
  return requirements.durationSeconds >= durations.minSeconds &&
    requirements.durationSeconds <= durations.maxSeconds
    ? []
    : [{ kind: "duration", requested: requirements.durationSeconds }];
}

/**
 * Audio, judged in the direction the storyboard asked for.
 *
 * A silent scene needs a model that can be MADE silent, which an endpoint with
 * no audio control cannot be proven to be — so `unknown` fails both ways
 * rather than passing whichever way happens to be convenient.
 */
function audioReasons(
  model: FalVideoModel,
  requirements: FalVideoRequirements,
): FalIncompatibility[] {
  const wantsSound = requirements.audio !== "off";
  if (model.audio.kind === "controllable") {
    return [];
  }
  if (model.audio.kind === "always_on") {
    return wantsSound ? [] : [{ kind: "audio_must_be_silent" }];
  }
  return [wantsSound ? { kind: "audio_required" } : { kind: "audio_must_be_silent" }];
}

/**
 * Reference semantics, which are never substituted.
 *
 * A first-frame endpoint is rejected outright for a scene that casts Character
 * Library identities: starting a video on a picture of F1 is not the same
 * request as keeping F1 looking like F1, and silently treating it as one would
 * bill the owner for a video their storyboard did not describe.
 */
function referenceReasons(
  model: FalVideoModel,
  requirements: FalVideoRequirements,
): FalIncompatibility[] {
  if (requirements.identityReferenceCount === 0) {
    return [];
  }
  if (model.references.kind !== "identity_reference") {
    return [{ kind: "identity_references_unsupported" }];
  }
  return requirements.identityReferenceCount > model.references.maxImages
    ? [
        {
          kind: "too_many_references",
          requested: requirements.identityReferenceCount,
          supported: model.references.maxImages,
        },
      ]
    : [];
}

/**
 * The output size this endpoint will actually produce for the request.
 *
 * The requested size when the endpoint offers it; otherwise the endpoint's own
 * documented default, and only failing that its last listed size. The default
 * comes first because it is what the endpoint really does when the caller says
 * nothing, and because the largest size is also the dearest: falling to it
 * would quote H3 at 4K for a scene its endpoint would have rendered at 2K.
 * The result is what the Final Video Draft displays, what the draft freezes,
 * and what the quote is computed from.
 */
export function resolveFalOutputResolution(model: FalVideoModel, requested: string): string {
  const values = model.resolutions.values;
  const exact = values.find((value) => value.toLowerCase() === requested.trim().toLowerCase());
  return exact ?? model.resolutions.defaultValue ?? values.at(-1) ?? requested;
}

/** Judges one model against the frozen storyboard. Pure; no network call. */
export function evaluateFalModel(
  model: FalVideoModel,
  requirements: FalVideoRequirements,
): FalModelCompatibility {
  const reasons: FalIncompatibility[] = [
    ...durationReasons(model, requirements),
    ...audioReasons(model, requirements),
    ...referenceReasons(model, requirements),
  ];
  if (!model.aspectRatios.values.includes(requirements.aspectRatio)) {
    reasons.push({
      kind: "aspect_ratio",
      requested: requirements.aspectRatio,
      supported: model.aspectRatios.values,
    });
  }
  return reasons.length === 0
    ? { compatible: true, model }
    : { compatible: false, model, reasons: Object.freeze(reasons) };
}

/** Every registry model that can execute this storyboard, in preference order. */
export function listCompatibleFalModels(
  cfg: FalVideoModelConfig,
  requirements: FalVideoRequirements,
): FalVideoModel[] {
  return listFalVideoModels(cfg)
    .map((model) => evaluateFalModel(model, requirements))
    .filter(
      (result): result is Extract<FalModelCompatibility, { compatible: true }> => result.compatible,
    )
    .map((result) => result.model)
    .toSorted((left, right) => defaultRank(left) - defaultRank(right));
}

/**
 * Product preference order among COMPATIBLE models.
 *
 * MiniMax H3 first because it is the product's preferred look; the rest follow
 * registry order. This only ever reorders models that already passed every
 * check, so preference can never override capability.
 */
const DEFAULT_PREFERENCE: readonly string[] = Object.freeze([
  "minimax/h3/reference-to-video",
  "minimax/h3-max/reference-to-video",
  // The only registry endpoint that reaches 30 seconds, so a long scene lands
  // here once H3 is ruled out on duration.
  "bytedance/seedance-2.5/reference-to-video",
  "bytedance/seedance-2.0/reference-to-video",
]);

function defaultRank(model: FalVideoModel): number {
  const index = DEFAULT_PREFERENCE.indexOf(model.modelId);
  return index < 0 ? DEFAULT_PREFERENCE.length : index;
}

export type FalDefaultModelSelection =
  | Readonly<{
      kind: "selected";
      model: FalVideoModel;
      /**
       * The preferred model this one replaced, when it was displaced, with the
       * reasons it could not run. Present so the owner is told WHY the default
       * differs instead of quietly getting another model.
       */
      preferredUnavailable?: Readonly<{
        model: FalVideoModel;
        reasons: readonly FalIncompatibility[];
      }>;
      alternatives: readonly FalVideoModel[];
    }>
  | Readonly<{ kind: "none_compatible"; evaluated: readonly FalModelCompatibility[] }>;

/**
 * Picks the default model for a frozen storyboard.
 *
 * Never returns an incompatible model, and never silently swaps one in: when
 * the preferred model cannot run the scene, the replacement comes back with
 * the preferred model's failure reasons attached so the reply can explain it.
 */
export function selectDefaultFalModel(
  cfg: FalVideoModelConfig,
  requirements: FalVideoRequirements,
): FalDefaultModelSelection {
  const evaluated = listFalVideoModels(cfg).map((model) => evaluateFalModel(model, requirements));
  const compatible = evaluated
    .filter(
      (result): result is Extract<FalModelCompatibility, { compatible: true }> => result.compatible,
    )
    .map((result) => result.model)
    .toSorted((left, right) => defaultRank(left) - defaultRank(right));
  const chosen = compatible[0];
  if (!chosen) {
    return { kind: "none_compatible", evaluated: Object.freeze(evaluated) };
  }
  const preferredId = DEFAULT_PREFERENCE[0];
  const displaced =
    chosen.modelId === preferredId
      ? undefined
      : evaluated.find(
          (result): result is Extract<FalModelCompatibility, { compatible: false }> =>
            !result.compatible && result.model.modelId === preferredId,
        );
  return {
    kind: "selected",
    model: chosen,
    ...(displaced
      ? { preferredUnavailable: { model: displaced.model, reasons: displaced.reasons } }
      : {}),
    alternatives: Object.freeze(compatible.slice(1)),
  };
}
