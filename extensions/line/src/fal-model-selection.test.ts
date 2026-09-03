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
import { listFalVideoModels, resolveFalVideoModel } from "./fal-video-registry.js";

const H3 = "minimax/h3/reference-to-video";
const SEEDANCE = "bytedance/seedance-2.0/reference-to-video";
const VEO = "fal-ai/veo3.1/reference-to-video";

/** An operator who declared what fal's schema leaves unbounded. */
const CFG = {
  videoGeneration: {
    falModels: { [H3]: { durationSeconds: [5, 10, 15], audio: "always_on" as const } },
  },
};

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

describe("fal's published endpoint set", () => {
  it("has NO Seedance 2.5 reference-to-video endpoint to route to", () => {
    // Re-verified against @fal-ai/client 1.11.0-alpha.2, fal's newest release.
    // Seedance 2.5 exists on OpenRouter; on fal it does not, and it is
    // deliberately absent rather than aliased onto 2.0.
    const ids = listFalVideoModels({}).map((model) => model.modelId);
    expect(ids.some((id) => id.includes("seedance-2.5"))).toBe(false);
    expect(ids).toContain(SEEDANCE);
    expect(resolveFalVideoModel({}, "bytedance/seedance-2.5/reference-to-video")).toBeUndefined();
  });

  it("ships MiniMax H3 with UNPROVEN duration and audio, not guessed ones", () => {
    // fal types H3's `duration` as an unbounded number and gives it no audio
    // field, so neither is provable; the registry says so rather than inventing.
    const h3 = resolveFalVideoModel({}, H3);
    expect(h3?.durations.kind).toBe("unknown");
    expect(h3?.audio.kind).toBe("unknown");
  });

  it("lets an operator declaration FILL an unknown, never widen a schema fact", () => {
    const declared = resolveFalVideoModel(
      {
        videoGeneration: {
          falModels: {
            [H3]: { durationSeconds: [15] },
            // Seedance's durations are schema-proven, so this is ignored.
            [SEEDANCE]: { durationSeconds: [99] },
          },
        },
      },
      H3,
    );
    expect(declared?.durations).toMatchObject({
      kind: "enum",
      seconds: [15],
      provenance: "operator_declared",
    });
    const seedance = resolveFalVideoModel(
      {
        videoGeneration: { falModels: { [SEEDANCE]: { durationSeconds: [99] } } },
      },
      SEEDANCE,
    );
    expect(seedance?.durations).toMatchObject({ provenance: "fal_schema" });
    expect(seedance?.durations.kind === "enum" && seedance.durations.seconds.includes(99)).toBe(
      false,
    );
  });
});

describe("unproven is not permission", () => {
  it("refuses H3 entirely until its duration and audio are declared", () => {
    const result = evaluateFalModel(resolveFalVideoModel({}, H3)!, requirements());
    expect(result.compatible).toBe(false);
    if (result.compatible) {
      return;
    }
    expect(result.reasons.map((reason) => reason.kind)).toEqual(
      expect.arrayContaining(["duration_unknown", "audio_required"]),
    );
  });

  it("refuses a model that cannot be proven able to stay silent", () => {
    const result = evaluateFalModel(resolveFalVideoModel(CFG, H3)!, requirements({ audio: "off" }));
    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.reasons[0]).toEqual({ kind: "audio_must_be_silent" });
    }
  });
});

describe("E/F. the capability-aware default", () => {
  it("defaults to MiniMax H3 when it can execute the scene", () => {
    const selection = selectDefaultFalModel(CFG, requirements());
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") {
      return;
    }
    expect(selection.model.modelId).toBe(H3);
    expect(selection.preferredUnavailable).toBeUndefined();
  });

  it("does NOT offer H3 for a 30-second scene, and finds nothing that can run it", () => {
    // fal's Seedance schema tops out at 15s and H3 is declared to 15, so a
    // 30-second reference-to-video has no endpoint at all on this provider.
    const selection = selectDefaultFalModel(CFG, requirements({ durationSeconds: 30 }));
    expect(selection.kind).toBe("none_compatible");
  });

  it("replaces H3 with a proven alternative and reports why", () => {
    const selection = selectDefaultFalModel(
      { videoGeneration: { falModels: { [H3]: { durationSeconds: [15], audio: "always_on" } } } },
      requirements({ durationSeconds: 12 }),
    );
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") {
      return;
    }
    expect(selection.model.modelId).toBe(SEEDANCE);
    expect(selection.preferredUnavailable?.model.modelId).toBe(H3);
    expect(selection.preferredUnavailable?.reasons[0]).toMatchObject({
      kind: "duration",
      requested: 12,
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
    // H3 documents 2K as its only output size, so a 720p request produces 2K —
    // and the Final Video Draft shows that, rather than the request.
    expect(resolveFalOutputResolution(resolveFalVideoModel({}, H3)!, "720p")).toBe("2K");
  });
});
