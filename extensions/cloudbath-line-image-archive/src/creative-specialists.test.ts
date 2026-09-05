import { describe, expect, it } from "vitest";
import {
  CLOUDBATH_SPECIALIST_KINDS,
  readGeneratedImageAttachment,
} from "./creative-specialists.js";

describe("Cloudbath specialist boundary", () => {
  it("declares the four internal directors behind the one LINE orchestrator", () => {
    expect(CLOUDBATH_SPECIALIST_KINDS).toEqual([
      "storyboard_director",
      "visual_director",
      "character_director",
      "video_director",
    ]);
  });

  it("accepts exactly one generated image artifact and rejects ambiguous output", () => {
    const image = { type: "image", path: "/managed/image.jpg", mimeType: "image/jpeg" };
    expect(readGeneratedImageAttachment({ details: { attachments: [image] } })).toEqual({
      path: image.path,
      mimeType: image.mimeType,
    });
    expect(readGeneratedImageAttachment({ details: { attachments: [image, image] } })).toBe(
      undefined,
    );
    expect(readGeneratedImageAttachment({ details: { attachments: [] } })).toBe(undefined);
  });
});
