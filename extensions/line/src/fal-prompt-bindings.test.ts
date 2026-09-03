import { describe, expect, it } from "vitest";
import { compileFalProviderPrompt, falReferenceMarker } from "./fal-prompt-bindings.js";
import { resolveFalVideoModel } from "./fal-video-registry.js";

const H3 = resolveFalVideoModel({}, "minimax/h3/reference-to-video")!;
const SEEDANCE_25 = resolveFalVideoModel({}, "bytedance/seedance-2.5/reference-to-video")!;
const SEEDANCE = resolveFalVideoModel({}, "bytedance/seedance-2.0/reference-to-video")!;
const VEO = resolveFalVideoModel({}, "fal-ai/veo3.1/reference-to-video")!;

const STORYBOARD = "Setting: garden\nBeats:\n0-15s | F1 walks";
const TWO = [
  { index: 0, characterCode: "CHAR-12", displayName: "F1" },
  { index: 1, characterCode: "CHAR-13", displayName: "F2" },
];

describe("N. reference markers match the submitted ordering", () => {
  it("writes Seedance 2.5's '[ImageN]' dialect, NOT 2.0's '@ImageN'", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: SEEDANCE_25,
      references: TWO,
    });
    expect(prompt).toContain("[Image1] = F1 (CHAR-12), identity reference.");
    expect(prompt).toContain("[Image2] = F2 (CHAR-13), identity reference.");
    // Same vendor, different dialect: 2.0's form would be silently ignored.
    expect(prompt).not.toContain("@Image1");
  });

  it("writes Seedance 2.0's own '@ImageN' dialect", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: SEEDANCE,
      references: TWO,
    });
    expect(prompt).toContain("@Image1 = F1 (CHAR-12), identity reference.");
    expect(prompt).toContain("@Image2 = F2 (CHAR-13), identity reference.");
  });

  it("writes MiniMax H3's 'Image N' dialect instead, never Seedance's", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: H3,
      references: TWO,
    });
    expect(prompt).toContain("Image 1 = F1 (CHAR-12), identity reference.");
    expect(prompt).toContain("Image 2 = F2 (CHAR-13), identity reference.");
    expect(prompt).not.toContain("@Image1");
  });

  it("emits no marker for an endpoint that documents none", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: VEO,
      references: TWO,
    });
    // Veo takes `image_urls` for subject consistency and documents no marker
    // syntax; inventing one would put noise in a paid prompt.
    expect(prompt).toBe(STORYBOARD);
  });

  it("never emits a marker for a reference that does not exist", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: SEEDANCE,
      references: [TWO[0]!],
    });
    expect(prompt).toContain("@Image1");
    expect(prompt).not.toContain("@Image2");
  });

  it("adds nothing at all when the scene casts no references", () => {
    expect(
      compileFalProviderPrompt({ storyboardPrompt: STORYBOARD, model: SEEDANCE, references: [] }),
    ).toBe(STORYBOARD);
  });

  it("preserves the confirmed storyboard text byte-for-byte, ahead of the bindings", () => {
    const prompt = compileFalProviderPrompt({
      storyboardPrompt: STORYBOARD,
      model: SEEDANCE,
      references: TWO,
    });
    expect(prompt.startsWith(`${STORYBOARD}\n\n`)).toBe(true);
  });

  it("numbers markers from 1, matching the 1-based positions fal documents", () => {
    expect(falReferenceMarker("bracket_image_n", 0)).toBe("[Image1]");
    expect(falReferenceMarker("at_image_n", 0)).toBe("@Image1");
    expect(falReferenceMarker("image_space_n", 0)).toBe("Image 1");
    expect(falReferenceMarker("none", 0)).toBeUndefined();
  });
});
