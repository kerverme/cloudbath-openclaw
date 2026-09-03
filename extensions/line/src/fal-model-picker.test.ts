import { describe, expect, it } from "vitest";
import { listCompatibleFalFamilies, matchFalFamily, searchFalModels } from "./fal-model-picker.js";
import { listCompatibleFalModels, type FalVideoRequirements } from "./fal-model-selection.js";
import { matchFalStoryboardQuery, type FalStoryboardConfig } from "./fal-storyboard-seam.js";

const H3 = "minimax/h3/reference-to-video";
const H3_MAX = "minimax/h3-max/reference-to-video";
const SEEDANCE_25 = "bytedance/seedance-2.5/reference-to-video";
const SEEDANCE = "bytedance/seedance-2.0/reference-to-video";
const SEEDANCE_FAST = "bytedance/seedance-2.0/fast/reference-to-video";
const VEO = "fal-ai/veo3.1/reference-to-video";

const CFG: FalStoryboardConfig = {
  videoGeneration: {
    falPricing: {
      models: {
        [H3]: { usdPerSecond: 0.1 },
        [H3_MAX]: { usdPerSecond: 0.15 },
        [SEEDANCE]: { usdPerSecond: 0.05 },
        [SEEDANCE_FAST]: { usdPerSecond: 0.02 },
        [VEO]: { usdPerSecond: 0.3 },
      },
    },
  },
};

function requirements(overrides: Partial<FalVideoRequirements> = {}): FalVideoRequirements {
  return {
    durationSeconds: 8,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: "full",
    spokenDialogue: false,
    identityReferenceCount: 1,
    ...overrides,
  };
}

const compatible = () => listCompatibleFalModels(CFG, requirements());

describe("G. the family picker", () => {
  it("lists only families that have a compatible endpoint", () => {
    const families = listCompatibleFalFamilies(compatible()).map((family) => family.id);
    expect(families).toEqual(expect.arrayContaining(["minimax", "bytedance", "google"]));
  });

  it("omits a family entirely once nothing in it can run the scene", () => {
    // 15s: Veo documents only "8s", so Google drops out of the menu.
    const families = listCompatibleFalFamilies(
      listCompatibleFalModels(CFG, requirements({ durationSeconds: 15 })),
    ).map((family) => family.id);
    expect(families).not.toContain("google");
  });
});

describe("H. the version picker", () => {
  it("shows only compatible Seedance versions, 2.5 among them", () => {
    const seedance = compatible().filter((model) => model.familyId === "bytedance");
    expect(seedance.map((model) => model.modelId)).toEqual(
      expect.arrayContaining([SEEDANCE_25, SEEDANCE, SEEDANCE_FAST]),
    );
    expect(seedance.every((model) => model.modelId.includes("seedance"))).toBe(true);
  });
});

describe("I. typed model queries", () => {
  it("applies an exact endpoint name", () => {
    const result = searchFalModels(compatible(), "seedance 2.0 fast");
    expect(result.autoApply?.modelId).toBe(SEEDANCE_FAST);
  });

  it("does NOT auto-apply 'minimax h3': it is ambiguous with H3 Max", () => {
    // Confusing H3 with H3 Max would bill a model the owner did not choose,
    // so an ambiguous brand+family query renders choices instead.
    const result = searchFalModels(compatible(), "minimax h3");
    expect(result.autoApply).toBeUndefined();
    expect(result.candidates.map((entry) => entry.model.modelId)).toEqual(
      expect.arrayContaining([H3, H3_MAX]),
    );
  });

  it("applies an unambiguous 'h3 max'", () => {
    expect(searchFalModels(compatible(), "h3 max").autoApply?.modelId).toBe(H3_MAX);
  });

  it("never auto-applies an ambiguous query: it shows choices", () => {
    const result = searchFalModels(compatible(), "seedance");
    expect(result.autoApply).toBeUndefined();
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("treats 'gemini' as the Google family, not one silently chosen model", () => {
    const families = listCompatibleFalFamilies(compatible());
    expect(matchFalFamily(families, "gemini")?.id).toBe("google");
    expect(matchFalStoryboardQuery(CFG, requirements(), "gemini")).toEqual({
      kind: "family",
      familyId: "google",
    });
  });

  it("treats 'veo' the same way rather than binding one endpoint", () => {
    expect(matchFalStoryboardQuery(CFG, requirements(), "veo")).toEqual({
      kind: "family",
      familyId: "google",
    });
  });

  it("resolves a typo'd query to choices, never straight to a billed model", () => {
    const result = matchFalStoryboardQuery(CFG, requirements(), "seedanse");
    expect(result?.kind).not.toBe("model");
  });

  it("cannot match an endpoint that fails the frozen storyboard's requirements", () => {
    // 15s rules Veo out entirely; naming it must not resurrect it.
    const result = matchFalStoryboardQuery(CFG, requirements({ durationSeconds: 15 }), "veo 3.1");
    expect(result?.kind).not.toBe("model");
  });

  it("applies 'seedance 2.5' to fal's real 2.5 endpoint, never aliased to 2.0", () => {
    expect(searchFalModels(compatible(), "seedance 2.5").autoApply?.modelId).toBe(SEEDANCE_25);
  });
});
