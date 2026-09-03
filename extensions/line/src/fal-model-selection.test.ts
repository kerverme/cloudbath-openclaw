/**
 * Capability matching between a frozen storyboard and fal's registry.
 *
 * Every fact under test comes from fal's own published schema
 * (`@fal-ai/client`), transcribed in fal-video-registry.ts. No network call and
 * no provider call happens anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateFalModel,
  listCompatibleFalModels,
  resolveFalOutputResolution,
  selectDefaultFalModel,
  type FalVideoRequirements,
} from "./fal-model-selection.js";
import {
  FAL_PROVENANCE_RANK,
  listFalVideoModels,
  resolveFalVideoModel,
} from "./fal-video-registry.js";

const H3 = "minimax/h3/reference-to-video";
const H3_MAX = "minimax/h3-max/reference-to-video";
const SEEDANCE_25 = "bytedance/seedance-2.5/reference-to-video";
const SEEDANCE = "bytedance/seedance-2.0/reference-to-video";
const VEO = "fal-ai/veo3.1/reference-to-video";

/**
 * No operator declarations at all.
 *
 * H3's 5-15s range and its native audio come from fal's current official
 * product documentation, so nothing here needs declaring to be selectable.
 */
const CFG = {};

function requirements(overrides: Partial<FalVideoRequirements> = {}): FalVideoRequirements {
  return {
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: "full",
    spokenDialogue: false,
    identityReferenceCount: 1,
    ...overrides,
  };
}

describe("fal's currently deployed endpoint set", () => {
  it("carries Seedance 2.5 as its own endpoint, never aliased onto 2.0", () => {
    const ids = listFalVideoModels({}).map((model) => model.modelId);
    expect(ids).toContain(SEEDANCE_25);
    expect(ids).toContain(SEEDANCE);
    const model = resolveFalVideoModel({}, SEEDANCE_25);
    expect(model?.displayName).toContain("2.5");
    // Same vendor, different dialect: 2.5 reads [Image1], 2.0 reads @Image1.
    expect(model?.references).toMatchObject({ markerStyle: "bracket_image_n" });
    expect(resolveFalVideoModel({}, SEEDANCE)?.references).toMatchObject({
      markerStyle: "at_image_n",
    });
  });

  it("gives Seedance 2.5 the 4-30s range fal's API reference states", () => {
    const durations = resolveFalVideoModel({}, SEEDANCE_25)?.durations;
    expect(durations).toMatchObject({ kind: "enum", provenance: "fal_api_page" });
    if (durations?.kind !== "enum") {
      return;
    }
    expect(durations.seconds[0]).toBe(4);
    expect(durations.seconds.at(-1)).toBe(30);
  });

  it("proves H3's 5-15s duration from fal's product documentation, not a declaration", () => {
    const h3 = resolveFalVideoModel({}, H3);
    expect(h3?.durations).toMatchObject({ kind: "enum", provenance: "fal_model_page" });
    if (h3?.durations.kind !== "enum") {
      return;
    }
    expect(h3.durations.seconds).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // Native synchronized audio on every generation, with no proven off switch.
    expect(h3?.audio).toMatchObject({ kind: "always_on" });
  });

  it("keeps H3 Max a DISTINCT model, never an alias of H3", () => {
    const h3 = resolveFalVideoModel({}, H3);
    const max = resolveFalVideoModel({}, H3_MAX);
    expect(max).toBeDefined();
    expect(max?.modelId).not.toBe(h3?.modelId);
    // "MiniMax" itself contains "Max", so the guard is on the MODEL name.
    expect(max?.displayName).toContain("H3 Max");
    expect(h3?.displayName).not.toContain("H3 Max");
    expect(max?.resolutions.values).not.toEqual(h3?.resolutions.values);
  });

  it("ranks a current API page above the lagging npm client schema", () => {
    // The client package trails fal's deployed catalog, which is what hid
    // Seedance 2.5 from this registry entirely.
    expect(FAL_PROVENANCE_RANK.fal_api_page).toBeLessThan(FAL_PROVENANCE_RANK.fal_model_page);
    expect(FAL_PROVENANCE_RANK.fal_model_page).toBeLessThan(FAL_PROVENANCE_RANK.fal_client_schema);
    expect(FAL_PROVENANCE_RANK.fal_client_schema).toBeLessThan(
      FAL_PROVENANCE_RANK.operator_declared,
    );
  });
});

describe("audio capability is judged in the direction asked for", () => {
  it("refuses H3 for a scene that must be silent", () => {
    // H3 produces native audio on every generation with no proven off switch,
    // so it cannot be made to deliver a truly silent video.
    const result = evaluateFalModel(resolveFalVideoModel(CFG, H3)!, requirements({ audio: "off" }));
    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.reasons[0]).toEqual({ kind: "audio_must_be_silent" });
    }
  });

  it("accepts H3 for a scene that wants sound", () => {
    expect(evaluateFalModel(resolveFalVideoModel(CFG, H3)!, requirements()).compatible).toBe(true);
  });

  it("lets Seedance 2.5 satisfy both directions, because it controls audio", () => {
    for (const audio of ["off", "ambient", "full"] as const) {
      expect(
        evaluateFalModel(resolveFalVideoModel(CFG, SEEDANCE_25)!, requirements({ audio }))
          .compatible,
      ).toBe(true);
    }
  });
});

describe("E/F. the capability-aware default", () => {
  it("defaults to MiniMax H3 on a 15-second scene it can execute", () => {
    const selection = selectDefaultFalModel(CFG, requirements());
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") {
      return;
    }
    expect(selection.model.modelId).toBe(H3);
    expect(selection.preferredUnavailable).toBeUndefined();
  });

  it("F: a 30-second scene defaults to Seedance 2.5 and explains why, not 'none'", () => {
    const selection = selectDefaultFalModel(CFG, requirements({ durationSeconds: 30 }));
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") {
      return;
    }
    // Seedance 2.5 is the only registry endpoint that reaches 30 seconds.
    expect(selection.model.modelId).toBe(SEEDANCE_25);
    expect(selection.preferredUnavailable?.model.modelId).toBe(H3);
    expect(selection.preferredUnavailable?.reasons[0]).toMatchObject({
      kind: "duration",
      requested: 30,
    });
  });

  it("never returns an incompatible model as the default", () => {
    for (const durationSeconds of [3, 16, 30, 60]) {
      const selection = selectDefaultFalModel(CFG, requirements({ durationSeconds }));
      if (selection.kind === "selected") {
        expect(
          evaluateFalModel(selection.model, requirements({ durationSeconds })).compatible,
        ).toBe(true);
      }
    }
  });

  it("finds nothing for a length no fal endpoint reaches", () => {
    expect(selectDefaultFalModel(CFG, requirements({ durationSeconds: 60 })).kind).toBe(
      "none_compatible",
    );
  });
});

describe("reference semantics are never substituted", () => {
  it("drops an endpoint that cannot take identity references", () => {
    const result = evaluateFalModel(
      resolveFalVideoModel(CFG, H3)!,
      requirements({ identityReferenceCount: 20 }),
    );
    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.reasons[0]).toMatchObject({ kind: "too_many_references", requested: 20 });
    }
  });

  it("keeps Veo out of a 15-second scene its schema cannot produce", () => {
    const compatible = listCompatibleFalModels(CFG, requirements()).map((m) => m.modelId);
    expect(compatible).toContain(SEEDANCE_25);
    // Veo 3.1 documents a single "8s" duration.
    expect(compatible).not.toContain(VEO);
    const veoScene = listCompatibleFalModels(CFG, requirements({ durationSeconds: 8 })).map(
      (m) => m.modelId,
    );
    expect(veoScene).toContain(VEO);
  });
});

describe("output resolution is resolved, not required", () => {
  it("honours the requested size when the endpoint offers it", () => {
    expect(resolveFalOutputResolution(resolveFalVideoModel({}, SEEDANCE)!, "1080p")).toBe("1080p");
  });

  it("falls to the endpoint's own size when it cannot produce the requested one", () => {
    // H3 lists 768P/1080P, so a lower-case "720p" request resolves to a size
    // it really produces — and the Final Video Draft shows that.
    expect(resolveFalOutputResolution(resolveFalVideoModel({}, H3)!, "720p")).toBe("1080P");
  });
});
