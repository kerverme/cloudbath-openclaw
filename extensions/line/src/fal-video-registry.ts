/**
 * The ONE place fal video endpoint + capability metadata lives.
 *
 * Every model the LINE flow can bill is described here, and nothing else in
 * the product holds a model list: the storyboard flow, the pickers, the
 * compatibility filter and the pricing adapter all read this registry, so
 * adding or retiring a model is a change to this file alone.
 *
 * PROVENANCE IS PART OF THE DATA. Each capability records where it came from:
 *
 *   - `fal_schema` — read out of fal's own published, generated endpoint
 *     schema (`@fal-ai/client`, `src/types/endpoints.d.ts`), which maps every
 *     endpoint id to its input type. That file is the machine-readable
 *     capability source fal ships; it is not scraped, and nothing here is
 *     fetched at runtime.
 *   - `operator_declared` — a fact fal's schema does NOT encode, supplied by
 *     the operator in config. `minimax/h3/*` declares `duration?: number` with
 *     no bound, for instance, so no duration is provable from the schema and
 *     hardcoding one would be an invented capability.
 *
 * An `unknown` capability is never treated as permission. A model whose
 * capabilities cannot answer the frozen storyboard's requirements is filtered
 * out before it can be offered, defaulted to, or given a payable VIDEO code.
 *
 * Verified against `@fal-ai/client@1.11.0-alpha.2` (published 2026-09-02, the
 * newest release; `latest` is 1.10.1 and carries the same endpoints minus the
 * newer resolutions). NOTE: fal publishes NO Seedance 2.5 endpoint of any
 * kind — its Seedance reference-to-video endpoints are `seedance-2.0` plus its
 * `fast`/`mini` variants. Seedance 2.5 exists on OpenRouter, not on fal, and
 * is deliberately absent here rather than aliased onto 2.0.
 */

export const FAL_PROVIDER_ID = "fal";
/** The exact package release every `fal_schema` fact below was read from. */
export const FAL_SCHEMA_SOURCE = "@fal-ai/client@1.11.0-alpha.2";

export type FalCapabilityProvenance = "fal_schema" | "operator_declared";

/**
 * How a model's prompt refers to its reference assets.
 *
 * Load-bearing, not cosmetic: Seedance reads `@Image1` and MiniMax H3 reads
 * `Image 1`, so the compiled prompt must be written in the selected model's
 * own dialect or the references silently go unused.
 */
export type FalReferenceMarkerStyle = "at_image_n" | "image_space_n" | "none";

export type FalDurationSupport =
  | Readonly<{ kind: "enum"; seconds: readonly number[]; provenance: FalCapabilityProvenance }>
  | Readonly<{
      kind: "range";
      minSeconds: number;
      maxSeconds: number;
      provenance: FalCapabilityProvenance;
    }>
  | Readonly<{ kind: "unknown" }>;

/**
 * Whether the endpoint lets the caller decide about audio.
 *
 * `controllable` means a `generate_audio` field exists, so both a sound-on and
 * a silent scene are satisfiable. `unknown` means the schema says nothing,
 * which satisfies NEITHER: a model that cannot be proven to produce sound
 * cannot serve a scene that asked for it, and one that cannot be proven to
 * stay silent cannot serve a scene that asked for silence.
 */
export type FalAudioSupport =
  | Readonly<{ kind: "controllable"; field: string; provenance: FalCapabilityProvenance }>
  | Readonly<{ kind: "always_on"; provenance: FalCapabilityProvenance }>
  | Readonly<{ kind: "unknown" }>;

/**
 * What the endpoint does with input images. These are NOT interchangeable.
 *
 * `identity_reference` keeps a subject looking like themselves across the
 * shot. `first_frame` merely starts the video on a picture. Feeding a
 * Character Library identity reference to a first-frame endpoint would answer
 * a different question than the storyboard asked, so the two are separate
 * kinds and the compatibility filter never substitutes one for the other.
 */
export type FalReferenceSupport =
  | Readonly<{
      kind: "identity_reference";
      /** Request field the URLs go in, e.g. `reference_image_urls`. */
      field: string;
      markerStyle: FalReferenceMarkerStyle;
      maxImages: number;
      /** Cap across images + videos + audio, when the endpoint states one. */
      maxTotalFiles?: number;
      provenance: FalCapabilityProvenance;
    }>
  | Readonly<{ kind: "first_frame"; field: string; provenance: FalCapabilityProvenance }>
  | Readonly<{ kind: "none" }>;

/**
 * A brand the owner can name.
 *
 * `aliases` are BRAND-level words only ("gemini", "veo", "seedance"). They live
 * here rather than on models on purpose: naming a brand is a narrowing, so it
 * must show that brand's compatible versions instead of silently selecting one
 * of them and billing it.
 */
export type FalVideoFamily = Readonly<{
  id: string;
  displayName: string;
  aliases: readonly string[];
}>;

export const FAL_VIDEO_FAMILIES: Readonly<Record<string, FalVideoFamily>> = Object.freeze({
  minimax: Object.freeze({
    id: "minimax",
    displayName: "MiniMax",
    aliases: Object.freeze(["minimax", "hailuo"]),
  }),
  bytedance: Object.freeze({
    id: "bytedance",
    displayName: "ByteDance / Seedance",
    aliases: Object.freeze(["bytedance", "seedance"]),
  }),
  google: Object.freeze({
    id: "google",
    displayName: "Google / Veo",
    aliases: Object.freeze(["google", "gemini", "veo"]),
  }),
});

export type FalVideoModel = Readonly<{
  provider: typeof FAL_PROVIDER_ID;
  /** fal endpoint id, submitted as `fal/<modelId>`. */
  modelId: string;
  familyId: string;
  displayName: string;
  /** Search aliases for the fuzzy picker. Never used to auto-bill on a weak match. */
  aliases: readonly string[];
  durations: FalDurationSupport;
  resolutions: Readonly<{ values: readonly string[]; provenance: FalCapabilityProvenance }>;
  aspectRatios: Readonly<{ values: readonly string[]; provenance: FalCapabilityProvenance }>;
  audio: FalAudioSupport;
  references: FalReferenceSupport;
  /** Request field carrying the prompt's duration, and how it is encoded. */
  durationEncoding: "number" | "string_seconds";
  verifiedFrom: string;
}>;

const SEEDANCE_2_DURATIONS: FalDurationSupport = Object.freeze({
  kind: "enum",
  seconds: Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  provenance: "fal_schema",
});
const SEEDANCE_2_ASPECTS = Object.freeze(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const SEEDANCE_2_REFERENCES: FalReferenceSupport = Object.freeze({
  kind: "identity_reference",
  field: "image_urls",
  markerStyle: "at_image_n",
  maxImages: 9,
  maxTotalFiles: 12,
  provenance: "fal_schema",
});
const SEEDANCE_2_AUDIO: FalAudioSupport = Object.freeze({
  kind: "controllable",
  field: "generate_audio",
  provenance: "fal_schema",
});

function seedanceReferenceModel(params: {
  modelId: string;
  displayName: string;
  aliases: readonly string[];
  resolutions: readonly string[];
}): FalVideoModel {
  return Object.freeze({
    provider: FAL_PROVIDER_ID,
    modelId: params.modelId,
    familyId: "bytedance",
    displayName: params.displayName,
    aliases: Object.freeze([...params.aliases]),
    durations: SEEDANCE_2_DURATIONS,
    resolutions: Object.freeze({
      values: Object.freeze([...params.resolutions]),
      provenance: "fal_schema",
    }),
    aspectRatios: Object.freeze({ values: SEEDANCE_2_ASPECTS, provenance: "fal_schema" }),
    audio: SEEDANCE_2_AUDIO,
    references: SEEDANCE_2_REFERENCES,
    durationEncoding: "string_seconds",
    verifiedFrom: FAL_SCHEMA_SOURCE,
  });
}

/**
 * Every fal video endpoint this product can bill.
 *
 * Reference-to-video only, deliberately: this flow always casts Character
 * Library identities, and a text-to-video or first-frame endpoint cannot
 * execute that storyboard however good its output is.
 */
export const FAL_VIDEO_MODELS: readonly FalVideoModel[] = Object.freeze([
  Object.freeze({
    provider: FAL_PROVIDER_ID,
    modelId: "minimax/h3/reference-to-video",
    familyId: "minimax",
    displayName: "MiniMax H3 Reference-to-Video",
    aliases: Object.freeze(["minimax h3", "h3", "hailuo h3"]),
    // fal's schema declares `duration?: number` with NO bound, so no duration
    // is provable here. Left unknown rather than guessed; the operator
    // declares it (see falModels config) exactly as they declare the price.
    durations: Object.freeze({ kind: "unknown" }),
    // "Only 2K is currently supported" is stated in the schema's own doc
    // comment on `resolution`, which is typed as an open string.
    resolutions: Object.freeze({ values: Object.freeze(["2K"]), provenance: "fal_schema" }),
    aspectRatios: Object.freeze({
      values: Object.freeze(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
      provenance: "fal_schema",
    }),
    // No `generate_audio` field exists on this endpoint, so neither "makes
    // sound" nor "can be silent" is provable from the schema.
    audio: Object.freeze({ kind: "unknown" }),
    references: Object.freeze({
      kind: "identity_reference",
      field: "reference_image_urls",
      markerStyle: "image_space_n",
      maxImages: 12,
      maxTotalFiles: 12,
      provenance: "fal_schema",
    }),
    durationEncoding: "number",
    verifiedFrom: FAL_SCHEMA_SOURCE,
  }),
  seedanceReferenceModel({
    modelId: "bytedance/seedance-2.0/reference-to-video",
    displayName: "Seedance 2.0 Reference-to-Video",
    aliases: ["seedance 2.0", "seedance 2"],
    resolutions: ["480p", "720p", "1080p", "4k"],
  }),
  seedanceReferenceModel({
    modelId: "bytedance/seedance-2.0/fast/reference-to-video",
    displayName: "Seedance 2.0 Fast Reference-to-Video",
    aliases: ["seedance 2.0 fast", "seedance fast"],
    resolutions: ["480p", "720p"],
  }),
  seedanceReferenceModel({
    modelId: "bytedance/seedance-2.0/mini/reference-to-video",
    displayName: "Seedance 2.0 Mini Reference-to-Video",
    aliases: ["seedance 2.0 mini", "seedance mini"],
    resolutions: ["480p", "720p"],
  }),
  Object.freeze({
    provider: FAL_PROVIDER_ID,
    modelId: "fal-ai/veo3.1/reference-to-video",
    familyId: "google",
    displayName: "Veo 3.1 Reference-to-Video",
    aliases: Object.freeze(["veo 3.1", "veo3.1"]),
    // `duration?: string` defaulting to "8s", with no enum: one documented
    // value, not a provable set, so it is declared as the single length fal's
    // schema actually shows.
    durations: Object.freeze({
      kind: "enum",
      seconds: Object.freeze([8]),
      provenance: "fal_schema",
    }),
    resolutions: Object.freeze({
      values: Object.freeze(["720p", "1080p", "4k"]),
      provenance: "fal_schema",
    }),
    aspectRatios: Object.freeze({
      values: Object.freeze(["16:9", "9:16"]),
      provenance: "fal_schema",
    }),
    audio: Object.freeze({
      kind: "controllable",
      field: "generate_audio",
      provenance: "fal_schema",
    }),
    references: Object.freeze({
      kind: "identity_reference",
      field: "image_urls",
      markerStyle: "none",
      maxImages: 3,
      provenance: "fal_schema",
    }),
    durationEncoding: "string_seconds",
    verifiedFrom: FAL_SCHEMA_SOURCE,
  }),
]);

/**
 * Operator overlay for facts fal's schema does not encode.
 *
 * Same principle as pricing: the product never invents a capability, and a
 * model stays unusable until the operator supplies what the schema left out.
 */
export type FalVideoModelConfig = {
  videoGeneration?: {
    falModels?: Record<
      string,
      {
        /** Whole seconds this endpoint accepts, per the operator's own check. */
        durationSeconds?: number[];
        /** "controllable" | "always_on" — how this endpoint treats audio. */
        audio?: "controllable" | "always_on";
        /** Set false to retire a model without editing the registry. */
        enabled?: boolean;
      }
    >;
  };
};

/**
 * The registry as this operator has it: schema facts, plus their declarations.
 *
 * Returned newly-built rather than cached: it is read a handful of times per
 * storyboard, and a cache keyed on config would have to be invalidated on
 * every config reload for no measurable gain.
 */
export function listFalVideoModels(cfg: FalVideoModelConfig): FalVideoModel[] {
  const declarations = cfg.videoGeneration?.falModels ?? {};
  const models: FalVideoModel[] = [];
  for (const model of FAL_VIDEO_MODELS) {
    const declared = declarations[model.modelId];
    if (declared?.enabled === false) {
      continue;
    }
    models.push(applyDeclaration(model, declared));
  }
  return models;
}

type FalVideoModelDeclaration = NonNullable<
  NonNullable<FalVideoModelConfig["videoGeneration"]>["falModels"]
>[string];

function applyDeclaration(
  model: FalVideoModel,
  declared: FalVideoModelDeclaration | undefined,
): FalVideoModel {
  if (!declared) {
    return model;
  }
  const seconds = declared.durationSeconds?.filter((value) => Number.isInteger(value) && value > 0);
  // A declaration only ever FILLS an unknown. It cannot widen or contradict a
  // capability fal's own schema states, so a config typo can never talk the
  // product into submitting a request the endpoint will reject.
  const durations: FalDurationSupport =
    model.durations.kind === "unknown" && seconds && seconds.length > 0
      ? Object.freeze({
          kind: "enum",
          seconds: Object.freeze(seconds.toSorted((left, right) => left - right)),
          provenance: "operator_declared",
        })
      : model.durations;
  const audio: FalAudioSupport =
    model.audio.kind === "unknown" && declared.audio
      ? declared.audio === "controllable"
        ? Object.freeze({
            kind: "controllable",
            field: "generate_audio",
            provenance: "operator_declared",
          })
        : Object.freeze({ kind: "always_on", provenance: "operator_declared" })
      : model.audio;
  return Object.freeze({ ...model, durations, audio });
}

/** One model by exact endpoint id, or undefined when it is not in the registry. */
export function resolveFalVideoModel(
  cfg: FalVideoModelConfig,
  modelId: string,
): FalVideoModel | undefined {
  return listFalVideoModels(cfg).find((model) => model.modelId === modelId.trim());
}

/** Families that still have at least one model, in registry order. */
export function listFalVideoFamilies(models: readonly FalVideoModel[]): FalVideoFamily[] {
  const seen = new Set<string>();
  const families: FalVideoFamily[] = [];
  for (const model of models) {
    const family = FAL_VIDEO_FAMILIES[model.familyId];
    if (family && !seen.has(family.id)) {
      seen.add(family.id);
      families.push(family);
    }
  }
  return families;
}

/**
 * Whole-second lengths at least one registry endpoint accepts.
 *
 * For telling an owner what IS available after a request no endpoint can run.
 * Derived from the registry so a new endpoint widens it automatically.
 */
export function falSeedanceDurations(cfg: FalVideoModelConfig = {}): number[] {
  const seconds = new Set<number>();
  for (const model of listFalVideoModels(cfg)) {
    if (model.durations.kind === "enum") {
      for (const value of model.durations.seconds) {
        seconds.add(value);
      }
    }
  }
  return [...seconds].toSorted((left, right) => left - right);
}
