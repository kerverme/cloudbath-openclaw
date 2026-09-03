/**
 * The ONE place fal video endpoint + capability metadata lives.
 *
 * Every model the LINE flow can bill is described here, and nothing else in
 * the product holds a model list: the storyboard flow, the pickers, the
 * compatibility filter and the pricing adapter all read this registry, so
 * adding or retiring a model is a change to this file alone.
 *
 * PROVENANCE IS PART OF THE DATA, and its order is a PRECEDENCE order. Each
 * capability records where it came from, strongest first:
 *
 *   1. `fal_api_page`   — fal's current official API reference for the
 *      endpoint. This is the deployed contract and it WINS over everything
 *      below it.
 *   2. `fal_model_page` — fal's current official model page for the endpoint
 *      (product-level limits fal states but the API reference does not spell
 *      out, e.g. reference-file caps).
 *   3. `fal_client_schema` — the generated types in `@fal-ai/client`. Useful,
 *      but it LAGS: the npm package can be several endpoints behind fal's live
 *      catalog, so it is never sufficient on its own and never overrides a
 *      current API page.
 *   4. `operator_declared` — supplied in config, for facts none of the above
 *      establish.
 *
 * Nothing here is fetched or scraped at runtime; this is code, and the source
 * comment on each entry names the authoritative page it was read from.
 *
 * An `unknown` capability is never treated as permission. A model whose
 * capabilities cannot answer the frozen storyboard's requirements is filtered
 * out before it can be offered, defaulted to, or given a payable VIDEO code.
 */

export const FAL_PROVIDER_ID = "fal";
/**
 * Where a capability came from, strongest first.
 *
 * `fal_client_schema` is deliberately NOT the top of this list: the npm
 * package trails fal's deployed catalog, and treating it as the sole source of
 * truth is what previously hid `bytedance/seedance-2.5/reference-to-video`
 * from this registry entirely.
 */
export type FalCapabilityProvenance =
  | "fal_api_page"
  | "fal_model_page"
  | "fal_client_schema"
  | "operator_declared";

/** Ranked strongest-first; a later source never overrides an earlier one. */
export const FAL_PROVENANCE_RANK: Readonly<Record<FalCapabilityProvenance, number>> = Object.freeze(
  {
    fal_api_page: 0,
    fal_model_page: 1,
    fal_client_schema: 2,
    operator_declared: 3,
  },
);

/**
 * How a model's prompt refers to its reference assets.
 *
 * Load-bearing, not cosmetic, and it differs PER ENDPOINT: Seedance 2.5 reads
 * `[Image1]`, Seedance 2.0 reads `@Image1`, MiniMax H3 reads `Image 1`, and
 * Veo documents none. A prompt written in the wrong dialect does not fail —
 * the references are simply ignored and the owner pays for a video that does
 * not contain their character.
 */
export type FalReferenceMarkerStyle = "bracket_image_n" | "at_image_n" | "image_space_n" | "none";

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

/** Whole seconds in an inclusive range, for endpoints fal states as a range. */
function secondsRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset);
}

const SEEDANCE_2_0_DURATIONS: FalDurationSupport = Object.freeze({
  kind: "enum",
  seconds: Object.freeze(secondsRange(4, 15)),
  provenance: "fal_client_schema",
});
const SEEDANCE_ASPECTS = Object.freeze(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const SEEDANCE_2_0_REFERENCES: FalReferenceSupport = Object.freeze({
  kind: "identity_reference",
  field: "image_urls",
  markerStyle: "at_image_n",
  maxImages: 9,
  maxTotalFiles: 12,
  provenance: "fal_client_schema",
});
const CONTROLLABLE_AUDIO: FalAudioSupport = Object.freeze({
  kind: "controllable",
  field: "generate_audio",
  provenance: "fal_api_page",
});

function seedance20ReferenceModel(params: {
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
    durations: SEEDANCE_2_0_DURATIONS,
    resolutions: Object.freeze({
      values: Object.freeze([...params.resolutions]),
      provenance: "fal_client_schema",
    }),
    aspectRatios: Object.freeze({ values: SEEDANCE_ASPECTS, provenance: "fal_client_schema" }),
    audio: Object.freeze({
      kind: "controllable",
      field: "generate_audio",
      provenance: "fal_client_schema",
    }),
    references: SEEDANCE_2_0_REFERENCES,
    durationEncoding: "string_seconds",
    verifiedFrom: "@fal-ai/client@1.11.0-alpha.2",
  });
}

/**
 * MiniMax H3 and H3 Max, which share a contract shape but are NOT the same
 * model and must never be conflated.
 *
 * Both take `reference_*_urls` — a DIFFERENT field from Seedance's
 * `image_urls` — read `Image 1` / `Video 1` / `Audio 1` in the prompt, cap at
 * 12 reference files total, and produce native synchronized audio on every
 * generation with no documented off switch.
 */
function minimaxH3ReferenceModel(params: {
  modelId: string;
  displayName: string;
  aliases: readonly string[];
  resolutions: readonly string[];
}): FalVideoModel {
  return Object.freeze({
    provider: FAL_PROVIDER_ID,
    modelId: params.modelId,
    familyId: "minimax",
    displayName: params.displayName,
    aliases: Object.freeze([...params.aliases]),
    // 5-15s is stated by fal's current official product documentation, so it
    // is proven and needs no operator declaration.
    durations: Object.freeze({
      kind: "enum",
      seconds: Object.freeze(secondsRange(5, 15)),
      provenance: "fal_model_page",
    }),
    resolutions: Object.freeze({
      values: Object.freeze([...params.resolutions]),
      provenance: "fal_model_page",
    }),
    // `adaptive` plus the six named ratios, default `adaptive`, per the
    // endpoint's own documented enum.
    aspectRatios: Object.freeze({
      values: Object.freeze(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
      provenance: "fal_model_page",
    }),
    // Native stereo audio on EVERY generation, with no proven off switch in
    // the reference contract. `always_on` is therefore the honest shape: it
    // satisfies a scene that wants sound and fails one that must be silent.
    audio: Object.freeze({ kind: "always_on", provenance: "fal_model_page" }),
    references: Object.freeze({
      kind: "identity_reference",
      field: "reference_image_urls",
      markerStyle: "image_space_n",
      maxImages: 9,
      maxTotalFiles: 12,
      provenance: "fal_model_page",
    }),
    durationEncoding: "number",
    verifiedFrom: "fal official model page",
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
  minimaxH3ReferenceModel({
    modelId: "minimax/h3/reference-to-video",
    displayName: "MiniMax H3 Reference-to-Video",
    aliases: ["minimax h3", "h3", "hailuo h3"],
    // 2K ONLY. The endpoint documents `resolution` with a single default of
    // "2K" and describes itself as generating 2K video; fal's comparison
    // articles list 480p/768p/2K/4K rates for the H3 family, but a rate table
    // is not an input enum and does not outrank the endpoint's own contract.
    // Listing a size the endpoint may not accept is the expensive direction of
    // this error, so the unproven ones stay out.
    resolutions: ["2K"],
  }),
  minimaxH3ReferenceModel({
    modelId: "minimax/h3-max/reference-to-video",
    // A DISTINCT model, never an alias of H3: different endpoint, different
    // output sizes, and selecting one when the owner named the other would
    // bill something they did not choose.
    displayName: "MiniMax H3 Max Reference-to-Video",
    aliases: ["minimax h3 max", "h3 max", "h3max"],
    // H3 Max's contract is the clear one: an explicit 480P/768P enum. These
    // are ITS sizes and must never be copied onto plain H3, which documents 2K.
    resolutions: ["480P", "768P"],
  }),
  Object.freeze({
    provider: FAL_PROVIDER_ID,
    modelId: "bytedance/seedance-2.5/reference-to-video",
    familyId: "bytedance",
    displayName: "Seedance 2.5 Reference-to-Video",
    aliases: Object.freeze(["seedance 2.5", "seedance 2 5", "seedance25"]),
    // 4-30s, from fal's current official API reference for this endpoint. This
    // is the only registry entry that reaches 30 seconds, which is why a
    // 30-second storyboard resolves here.
    durations: Object.freeze({
      kind: "enum",
      seconds: Object.freeze(secondsRange(4, 30)),
      provenance: "fal_api_page",
    }),
    resolutions: Object.freeze({
      values: Object.freeze(["480p", "720p"]),
      provenance: "fal_api_page",
    }),
    aspectRatios: Object.freeze({ values: SEEDANCE_ASPECTS, provenance: "fal_api_page" }),
    audio: CONTROLLABLE_AUDIO,
    references: Object.freeze({
      kind: "identity_reference",
      field: "image_urls",
      // `[Image1]`, NOT Seedance 2.0's `@Image1`. Same vendor, different
      // dialect; writing 2.0's form here would silently drop the references.
      markerStyle: "bracket_image_n",
      // Up to 50 multimodal reference inputs in total across images, videos
      // and audio, per fal's current API reference.
      maxImages: 50,
      maxTotalFiles: 50,
      provenance: "fal_api_page",
    }),
    durationEncoding: "string_seconds",
    verifiedFrom: "fal official API reference",
  }),
  seedance20ReferenceModel({
    modelId: "bytedance/seedance-2.0/reference-to-video",
    displayName: "Seedance 2.0 Reference-to-Video",
    aliases: ["seedance 2.0", "seedance 2"],
    resolutions: ["480p", "720p", "1080p", "4k"],
  }),
  seedance20ReferenceModel({
    modelId: "bytedance/seedance-2.0/fast/reference-to-video",
    displayName: "Seedance 2.0 Fast Reference-to-Video",
    aliases: ["seedance 2.0 fast", "seedance fast"],
    resolutions: ["480p", "720p"],
  }),
  seedance20ReferenceModel({
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
    durations: Object.freeze({
      kind: "enum",
      seconds: Object.freeze([8]),
      provenance: "fal_client_schema",
    }),
    resolutions: Object.freeze({
      values: Object.freeze(["720p", "1080p", "4k"]),
      provenance: "fal_client_schema",
    }),
    aspectRatios: Object.freeze({
      values: Object.freeze(["16:9", "9:16"]),
      provenance: "fal_client_schema",
    }),
    audio: Object.freeze({
      kind: "controllable",
      field: "generate_audio",
      provenance: "fal_client_schema",
    }),
    references: Object.freeze({
      kind: "identity_reference",
      field: "image_urls",
      markerStyle: "none",
      maxImages: 3,
      provenance: "fal_client_schema",
    }),
    durationEncoding: "string_seconds",
    verifiedFrom: "@fal-ai/client@1.11.0-alpha.2",
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
