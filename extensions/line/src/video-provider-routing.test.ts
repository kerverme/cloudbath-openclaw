import { describe, expect, it } from "vitest";
import {
  FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL,
  falSeedanceDurations,
  isSeedanceVideoModel,
  resolveLineVideoProviderRoute,
} from "./video-provider-routing.js";

describe("LINE paid video provider routing", () => {
  it("routes a Seedance request WITH identity references to fal reference-to-video", () => {
    expect(
      resolveLineVideoProviderRoute({
        modelId: "bytedance/seedance-2.5",
        identityReferenceCount: 2,
        falEnabled: true,
      }),
    ).toEqual({
      provider: "fal",
      modelId: FAL_SEEDANCE_REFERENCE_TO_VIDEO_MODEL,
      catalogModelId: "bytedance/seedance-2.5",
    });
  });

  it("keeps a Seedance request WITHOUT references on OpenRouter", () => {
    expect(
      resolveLineVideoProviderRoute({
        modelId: "bytedance/seedance-2.5",
        identityReferenceCount: 0,
        falEnabled: true,
      }),
    ).toEqual({ provider: "openrouter", modelId: "bytedance/seedance-2.5" });
  });

  it("keeps every other OpenRouter video model on OpenRouter, references or not", () => {
    for (const modelId of [
      "minimax/hailuo-2.3",
      "google/veo-3",
      "kuaishou/kling-2.5",
      "openai/sora-2",
    ]) {
      expect(
        resolveLineVideoProviderRoute({ modelId, identityReferenceCount: 3, falEnabled: true }),
      ).toEqual({ provider: "openrouter", modelId });
      expect(
        resolveLineVideoProviderRoute({ modelId, identityReferenceCount: 0, falEnabled: true }),
      ).toEqual({ provider: "openrouter", modelId });
    }
  });

  it("detects the Seedance family by segment, not by a pinned version", () => {
    expect(isSeedanceVideoModel("bytedance/seedance-2.5")).toBe(true);
    expect(isSeedanceVideoModel("bytedance/seedance-1-pro")).toBe(true);
    expect(isSeedanceVideoModel("bytedance/seedance")).toBe(true);
    // Not a Seedance model just because the name contains the letters.
    expect(isSeedanceVideoModel("acme/seedancer-lite")).toBe(false);
    expect(isSeedanceVideoModel("minimax/hailuo-2.3")).toBe(false);
  });

  it("is deterministic: the same inputs always pick the same provider", () => {
    const first = resolveLineVideoProviderRoute({
      modelId: "bytedance/seedance-2.5",
      identityReferenceCount: 1,
      falEnabled: true,
    });
    const second = resolveLineVideoProviderRoute({
      modelId: "bytedance/seedance-2.5",
      identityReferenceCount: 1,
      falEnabled: true,
    });
    expect(first).toEqual(second);
  });

  it("keeps the existing OpenRouter path when fal is not configured for this product", () => {
    expect(
      resolveLineVideoProviderRoute({
        modelId: "bytedance/seedance-2.5",
        identityReferenceCount: 2,
        falEnabled: false,
      }),
    ).toEqual({ provider: "openrouter", modelId: "bytedance/seedance-2.5" });
  });

  it("exposes exactly the durations fal's published schema accepts", () => {
    expect(falSeedanceDurations()).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});
