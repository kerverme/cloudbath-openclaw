/**
 * Which endpoint a frozen storyboard defaults to, and why the owner is told.
 *
 * These are product rules, not internals: the default decides what gets
 * billed, and a default that changes silently is the failure mode. Everything
 * here is pure registry + config arithmetic — no provider is constructed and
 * no network call is possible from this file.
 */
import { describe, expect, it } from "vitest";
import type { FalVideoRequirements } from "./fal-model-selection.js";
import { offerFalStoryboardDefault, type FalStoryboardConfig } from "./fal-storyboard-seam.js";

const H3 = "minimax/h3/reference-to-video";
const SEEDANCE_25 = "bytedance/seedance-2.5/reference-to-video";

/** An operator rate for H3, which fal's own pages do not settle on their own. */
function cfg(h3UsdPerSecond?: number): FalStoryboardConfig {
  return {
    videoGeneration: {
      maxEstimatedCostUsd: 50,
      ...(h3UsdPerSecond === undefined
        ? {}
        : { falPricing: { models: { [H3]: { usdPerSecond: h3UsdPerSecond } } } }),
    },
  };
}

/** The ordinary Character Library scene: one identity reference, sound wanted. */
function scene(overrides: Partial<FalVideoRequirements> = {}): FalVideoRequirements {
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

describe("the default endpoint for a frozen storyboard", () => {
  it("E: a 15-second sound + reference scene defaults to H3 once it is payable", () => {
    const offer = offerFalStoryboardDefault(cfg(0.13), scene());

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: H3 } });
    // Quoted at the size H3 really produces, not the 720p that was asked for.
    expect(offer.kind === "offered" && offer.outputResolution).toBe("2K");
    expect(offer.kind === "offered" && offer.estimatedCostUsd).toBeCloseTo(15 * 0.13, 6);
    // Nothing was displaced, so nothing needs explaining.
    expect(offer.kind === "offered" && offer.displacedReason).toBeUndefined();
  });

  it("explains itself when H3 can run the scene but carries no confirmed rate", () => {
    const offer = offerFalStoryboardDefault(cfg(), scene());

    // Capability alone is not enough to be billed, and the owner is told which
    // model they are missing rather than being quietly moved off it.
    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain(
      "MiniMax H3 Reference-to-Video ทำได้ แต่ยังไม่มีราคาที่ยืนยันได้",
    );
  });

  it("F: a 30-second scene defaults to Seedance 2.5 and names H3's ceiling", () => {
    const offer = offerFalStoryboardDefault(cfg(0.13), scene({ durationSeconds: 30 }));

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain(
      "งานนี้ยาว 30 วินาที MiniMax H3 Reference-to-Video รองรับสูงสุด 15 วินาที",
    );
  });

  it("G: a silent scene excludes H3, whose audio has no proven off switch", () => {
    const offer = offerFalStoryboardDefault(cfg(0.13), scene({ audio: "off" }));

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain("งานนี้ต้องไม่มีเสียง");
  });
});
