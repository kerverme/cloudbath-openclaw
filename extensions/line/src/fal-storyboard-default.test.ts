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

/**
 * No operator rates at all: H3 and Seedance 2.5 both carry fal's own published
 * price, so the ordinary production setup needs nothing declared.
 *
 * `maxEstimatedCostUsd` is a separate LINE-owned budget gate applied after
 * this offer, not a field this seam's own type declares or reads, so it has
 * no place in a `FalStoryboardConfig` fixture.
 */
function cfg(overrides: FalStoryboardConfig["videoGeneration"] = {}): FalStoryboardConfig {
  return { videoGeneration: { ...overrides } };
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
  it("M: a 15-second sound + reference scene defaults to H3 at 2K for ~$1.95", () => {
    const offer = offerFalStoryboardDefault(cfg(), scene());

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: H3 } });
    // The endpoint's documented default, not the 720p that was asked for and
    // not the dearer 4K it also offers.
    expect(offer.kind === "offered" && offer.outputResolution).toBe("2K");
    // 15s x $0.13 at 2K, with the single Character reference inside the free
    // allowance of five.
    expect(offer.kind === "offered" && offer.estimatedCostUsd).toBeCloseTo(1.95, 6);
    // Nothing was displaced, so nothing needs explaining.
    expect(offer.kind === "offered" && offer.displacedReason).toBeUndefined();
  });

  it("explains itself when the preferred endpoint carries no confirmed rate", () => {
    // With H3 retired, the preference falls to H3 Max, which publishes no rate
    // we have read. Capability alone is not enough to be billed, and the owner
    // is told which model they are missing rather than quietly moved off it.
    const offer = offerFalStoryboardDefault(
      cfg({ falModels: { [H3]: { enabled: false } } }),
      scene(),
    );

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain(
      "MiniMax H3 Max Reference-to-Video ทำได้ แต่ยังไม่มีราคาที่ยืนยันได้",
    );
  });

  it("N: a 30-second scene defaults to Seedance 2.5 and names H3's ceiling", () => {
    const offer = offerFalStoryboardDefault(cfg(), scene({ durationSeconds: 30 }));

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain(
      "งานนี้ยาว 30 วินาที MiniMax H3 Reference-to-Video รองรับสูงสุด 15 วินาที",
    );
  });

  it("O: a silent scene excludes H3, whose audio has no proven off switch", () => {
    const offer = offerFalStoryboardDefault(cfg(), scene({ audio: "off" }));

    expect(offer).toMatchObject({ kind: "offered", model: { modelId: SEEDANCE_25 } });
    expect(offer.kind === "offered" && offer.displacedReason).toContain("งานนี้ต้องไม่มีเสียง");
  });

  it("quotes the size the owner actually asked for when H3 offers it", () => {
    const cheap = offerFalStoryboardDefault(cfg(), scene({ resolution: "768P" }));
    const dear = offerFalStoryboardDefault(cfg(), scene({ resolution: "4K" }));

    expect(cheap.kind === "offered" && cheap.outputResolution).toBe("768P");
    expect(cheap.kind === "offered" && cheap.estimatedCostUsd).toBeCloseTo(1.2, 6);
    expect(dear.kind === "offered" && dear.outputResolution).toBe("4K");
    expect(dear.kind === "offered" && dear.estimatedCostUsd).toBeCloseTo(2.4, 6);
  });

  it("charges for reference images past the free five, on the same quote", () => {
    const six = offerFalStoryboardDefault(cfg(), scene({ identityReferenceCount: 6 }));

    expect(six).toMatchObject({ kind: "offered", model: { modelId: H3 } });
    expect(six.kind === "offered" && six.estimatedCostUsd).toBeCloseTo(2.03, 6);
  });
});
