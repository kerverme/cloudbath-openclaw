import { describe, expect, it } from "vitest";
import { resolveVideoGenerationOverrides } from "./normalization.js";
import type { VideoGenerationProvider } from "./types.js";

function providerWith(generate: VideoGenerationProvider["capabilities"]["generate"]) {
  return {
    id: "openrouter",
    capabilities: { generate },
    generateVideo: async () => {
      throw new Error("not used in normalization tests");
    },
  } as VideoGenerationProvider;
}

describe("resolveVideoGenerationOverrides", () => {
  it("1: a model with a proper resolution enum keeps resolution and never sets size (no regression)", () => {
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["16:9", "9:16"],
      supportsResolution: true,
      resolutions: ["720P", "1080P"],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "google/veo-3.1",
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(result.resolution).toBe("720P");
    expect(result.size).toBeUndefined();
  });

  it("2: 720p + 16:9 never serializes 1080p-derived dimensions for a size-only model (regression for the production bug)", () => {
    // Mirrors the merged capability shape for a model whose live OpenRouter
    // catalog entry reports supported_sizes but no supported_resolutions --
    // e.g. Seedance 2.5 in production. Before the fix, a shallow capability
    // merge let the generic static provider default (supportsResolution:true,
    // resolutions:["720P","1080P"]) survive here, so a "720p" request would
    // pass resolution-axis validation and be sent as-is to a model that does
    // not actually accept a `resolution` parameter, which the provider
    // resolved using its own default (production symptom: 1080p dimensions).
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["16:9", "9:16"],
      supportsResolution: false,
      resolutions: [],
      supportsSize: true,
      sizes: ["1280x720", "1920x1080", "720x1280", "1080x1920"],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "bytedance/seedance-2.5",
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(result.resolution).toBeUndefined();
    expect(result.size).toBe("1280x720");
    expect(result.size).not.toBe("1920x1080");
    expect(result.normalization?.size).toMatchObject({
      applied: "1280x720",
      derivedFrom: "resolution",
    });
  });

  it("3: a 1080p request against the same size-only model derives the 1080p size, not 720p", () => {
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["16:9"],
      supportsResolution: false,
      resolutions: [],
      supportsSize: true,
      sizes: ["1280x720", "1920x1080"],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "bytedance/seedance-2.5",
      aspectRatio: "16:9",
      resolution: "1080p",
    });

    expect(result.size).toBe("1920x1080");
  });

  it("4: a portrait aspect ratio derives portrait dimensions from the resolution tier", () => {
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["9:16"],
      supportsResolution: false,
      resolutions: [],
      supportsSize: true,
      sizes: ["720x1280", "1080x1920"],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "bytedance/seedance-2.5",
      aspectRatio: "9:16",
      resolution: "720p",
    });

    expect(result.size).toBe("720x1280");
  });

  it("5: resolution is dropped (not silently kept) when the model supports neither resolution nor size", () => {
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["16:9"],
      supportsResolution: false,
      resolutions: [],
      supportsSize: false,
      sizes: [],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "some/fixed-output-model",
      aspectRatio: "16:9",
      resolution: "720p",
    });

    expect(result.resolution).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(result.ignoredOverrides).toContainEqual({ key: "resolution", value: "720p" });
  });

  it("6: an explicit size from the caller is never overridden by the resolution-derivation path", () => {
    const provider = providerWith({
      supportsAspectRatio: true,
      aspectRatios: ["16:9"],
      supportsResolution: false,
      resolutions: [],
      supportsSize: true,
      sizes: ["1280x720", "1920x1080"],
    });

    const result = resolveVideoGenerationOverrides({
      provider,
      model: "bytedance/seedance-2.5",
      aspectRatio: "16:9",
      resolution: "1080p",
      size: "1280x720",
    });

    // The caller's own explicit size wins; resolution disagreeing with it is
    // dropped rather than silently overriding what was explicitly requested.
    expect(result.size).toBe("1280x720");
  });
});
