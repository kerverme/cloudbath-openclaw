/**
 * Ranking is a pure function of (live catalog rows, query), so these drive it
 * directly. No model or vendor is hardcoded in the ranker itself — the rows
 * below stand in for whatever OpenRouter returns on the day.
 */
import { describe, expect, it } from "vitest";
import type { OpenRouterVideoModel } from "./video-model-catalog.js";
import {
  normalizeVideoModelText,
  searchVideoModels,
  VIDEO_MODEL_MATCH_TIER,
} from "./video-model-search.js";

function model(id: string, name: string, extra?: Partial<OpenRouterVideoModel>) {
  return {
    id,
    name,
    supportedDurationSeconds: [6, 10],
    supportedAspectRatios: ["16:9"],
    supportedResolutions: ["720p"],
    supportedSizes: ["1280x720"],
    supportsFrameImages: false,
    ...extra,
  } satisfies OpenRouterVideoModel;
}

/** Shaped like a real mixed-vendor catalog page. */
const CATALOG: OpenRouterVideoModel[] = [
  model("minimax/hailuo-h3", "MiniMax: Hailuo H3"),
  model("minimax/hailuo-h3-fast", "MiniMax: Hailuo H3 Fast"),
  model("minimax/hailuo-02", "MiniMax: Hailuo 02"),
  model("bytedance/seedance-2.5", "Seedance 2.5", { supportsAudio: true }),
  model("bytedance/seedance-1.0-pro", "Seedance 1.0 Pro"),
  model("kuaishou/kling-2.1", "Kling 2.1"),
  model("google/veo-3", "Google: Veo 3"),
];

const names = (query: string) =>
  searchVideoModels(CATALOG, query).candidates.map((entry) => entry.model.name);

describe("normalizeVideoModelText", () => {
  it("collapses case, punctuation and spacing to one comparable form", () => {
    for (const variant of [
      "MiniMax: H3",
      "minimax-h3",
      "MINIMAX   H3",
      "minimax_h3",
      "MiniMax/H3",
    ]) {
      expect(normalizeVideoModelText(variant), variant).toBe("minimax h3");
    }
  });
});

describe("searchVideoModels", () => {
  it("A: 'minimax h3' returns only MiniMax-family candidates", () => {
    const result = searchVideoModels(CATALOG, "minimax h3");

    expect(result.candidates.length).toBeGreaterThan(0);
    for (const entry of result.candidates) {
      expect(entry.model.id, entry.model.name).toMatch(/^minimax\//u);
    }
  });

  it.each(["MiniMax: H3", "minimax-h3", "mini max h3", "MINIMAX H3"])(
    "B: punctuation and spacing variant %s ranks equivalently",
    (variant) => {
      expect(names(variant)).toEqual(names("minimax h3"));
    },
  );

  it("C: a strong family match hides unrelated vendors", () => {
    const listed = names("minimax h3");

    expect(listed).not.toContain("Seedance 2.5");
    expect(listed).not.toContain("Kling 2.1");
    expect(listed).not.toContain("Google: Veo 3");
  });

  it("auto-applies an exact id, name or slug", () => {
    for (const query of ["bytedance/seedance-2.5", "Seedance 2.5", "seedance-2.5"]) {
      expect(searchVideoModels(CATALOG, query).autoApply?.model.id, query).toBe(
        "bytedance/seedance-2.5",
      );
    }
  });

  it("never auto-applies an ambiguous or weak match", () => {
    // Several rows match the family, so the owner must choose. Auto-applying
    // here would silently change which model a paid confirmation bills.
    expect(searchVideoModels(CATALOG, "minimax").autoApply).toBeUndefined();
    expect(searchVideoModels(CATALOG, "hailuo").autoApply).toBeUndefined();
    for (const entry of searchVideoModels(CATALOG, "minimax").candidates) {
      expect(entry.tier).toBeLessThan(VIDEO_MODEL_MATCH_TIER.exactSlug);
    }
  });

  it("tolerates a typo without leaving the right family", () => {
    const listed = names("minmax hailuo");

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((name) => name.startsWith("MiniMax"))).toBe(true);
  });

  it("keeps the list useful rather than dumping the catalog", () => {
    expect(searchVideoModels(CATALOG, "minimax").candidates.length).toBeLessThanOrEqual(8);
  });

  it("lists the catalog for an empty query, and matches nothing for nonsense", () => {
    expect(searchVideoModels(CATALOG, "").candidates.length).toBeGreaterThan(0);
    expect(searchVideoModels(CATALOG, "zzzzqqqq").candidates).toEqual([]);
  });

  it("ranks only rows from the catalog it was given", () => {
    // The ranker owns no model list of its own: an empty catalog can never
    // produce a candidate, which is what makes new OpenRouter models selectable
    // without a deployment.
    expect(searchVideoModels([], "minimax h3").candidates).toEqual([]);
  });
});
