import { describe, expect, it } from "vitest";
import {
  applyStoryboardAudioMode,
  parseStoryboardAudioIntent,
  storyboardWantsProviderAudio,
} from "./storyboard-audio.js";
import { compileStoryboardDocument } from "./storyboard-compiler.js";
import { formatStoryboardForLine } from "./storyboard-format.js";
import { applyStoryboardDocumentRevision, parseStoryboardRevision } from "./storyboard-revision.js";
import type { StoryboardDocument, StoryboardVersion } from "./storyboard-types.js";
import {
  compileStoryboardProviderPrompt,
  compileStoryboardVideoPlan,
} from "./storyboard-video-plan.js";

const CAST = [
  { characterId: "CHAR-6", characterPageId: "a".repeat(32), displayName: "Twong" },
] as const;

function documentFor(scenePrompt: string): StoryboardDocument {
  return compileStoryboardDocument({
    scenePrompt,
    cast: [...CAST],
    durationSeconds: 10,
    aspectRatio: "9:16",
    resolution: "720p",
    environment: "สวน",
    ...((mode) => (mode ? { audio: mode } : {}))(parseStoryboardAudioIntent(scenePrompt)),
  });
}

function versionFor(document: StoryboardDocument): StoryboardVersion {
  return {
    version: 1,
    storyboardId: "sb-1",
    versionNumber: 1,
    projectInstanceId: "proj-1",
    projectPageId: "b".repeat(32),
    sceneId: "SCENE-1",
    scenePageId: "c".repeat(32),
    accountId: "acct",
    lineGroupId: "C1",
    ownerSenderId: "U1",
    characterLocks: [],
    document,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as StoryboardVersion;
}

describe("storyboard audio intent", () => {
  it("reads 'มีเสียง' and 'เปิดเสียง' as sound on", () => {
    expect(parseStoryboardAudioIntent("เอา Twong เดินในสวน มีเสียงด้วย")).toBe("full");
    expect(parseStoryboardAudioIntent("เปิดเสียงด้วยนะ")).toBe("full");
  });

  it("reads 'ไม่มีเสียงพูด แต่มีเสียง' as sound on WITHOUT speech", () => {
    expect(parseStoryboardAudioIntent("ไม่มีเสียงพูด แต่มีเสียง")).toBe("ambient");
  });

  it("reads plain 'ไม่มีเสียง' as fully silent", () => {
    expect(parseStoryboardAudioIntent("ไม่มีเสียง")).toBe("off");
    expect(parseStoryboardAudioIntent("เอา Twong เดินในสวน ไม่มีเสียง")).toBe("off");
  });

  it("returns undefined when the message never mentions audio", () => {
    expect(parseStoryboardAudioIntent("เอา Twong ไปเดินในสวน")).toBeUndefined();
  });

  it("keeps the shipped 'ไม่เอาเสียงพูด' revision silent rather than turning ambience on", () => {
    expect(parseStoryboardAudioIntent("ไม่เอาเสียงพูด")).toBe("off");
  });
});

describe("beat-level audio direction", () => {
  it("gives EVERY beat an audio direction when sound is on", () => {
    const document = documentFor("เอา Twong เดินแล้วนั่งในสวน มีเสียง");
    expect(document.audio).toBe("full");
    expect(document.beats.length).toBeGreaterThan(1);
    expect(document.beats.every((beat) => Boolean(beat.soundDesign?.trim()))).toBe(true);
  });

  it("invents no audio direction at all when the owner said ไม่มีเสียง", () => {
    const document = documentFor("เอา Twong เดินในสวน ไม่มีเสียง");
    expect(document.audio).toBe("off");
    expect(document.beats.some((beat) => beat.soundDesign)).toBe(false);
    expect(document.beats.some((beat) => beat.dialogue)).toBe(false);
    expect(storyboardWantsProviderAudio(document)).toBe(false);
  });

  it("keeps ambience but drops every spoken line for ไม่มีเสียงพูด แต่มีเสียง", () => {
    const spoken = applyStoryboardAudioMode(
      {
        ...documentFor("เอา Twong คุยกันในสวน"),
        beats: [
          {
            beatId: "BEAT-1",
            startSeconds: 0,
            endSeconds: 10,
            kind: "dialogue",
            framing: "Medium shot",
            action: "Twong พูด",
            camera: "Static",
            dialogue: "สวัสดีครับ",
            characterIds: ["CHAR-6"],
          },
        ],
      },
      "ambient",
    );
    expect(spoken.audio).toBe("ambient");
    expect(spoken.beats[0]?.dialogue).toBeUndefined();
    expect(spoken.beats[0]?.soundDesign).toBeTruthy();
    expect(storyboardWantsProviderAudio(spoken)).toBe(true);
  });

  it("preserves a requested line verbatim, in its own beat window", () => {
    const document = applyStoryboardAudioMode(
      {
        ...documentFor("เอา Twong คุยกันในสวน"),
        beats: [
          {
            beatId: "BEAT-1",
            startSeconds: 0,
            endSeconds: 4,
            kind: "establishing",
            framing: "Wide",
            action: "เปิดฉาก",
            camera: "Static",
            characterIds: ["CHAR-6"],
          },
          {
            beatId: "BEAT-2",
            startSeconds: 4,
            endSeconds: 10,
            kind: "dialogue",
            framing: "Medium shot",
            action: "Twong พูด",
            camera: "Static",
            dialogue: "สวัสดีครับ วันนี้อากาศดีนะ",
            characterIds: ["CHAR-6"],
          },
        ],
      },
      "full",
    );
    expect(document.beats[0]?.dialogue).toBeUndefined();
    expect(document.beats[1]?.dialogue).toBe("สวัสดีครับ วันนี้อากาศดีนะ");
    expect(document.beats[1]?.startSeconds).toBe(4);
    expect(document.beats[1]?.endSeconds).toBe(10);
  });
});

describe("LINE storyboard and provider prompt agree", () => {
  it("puts the same beat-level audio timeline in both", () => {
    const document = documentFor("เอา Twong เดินแล้วนั่งในสวน มีเสียง");
    const rendered = formatStoryboardForLine({ versionNumber: 1, document });
    const prompt = compileStoryboardProviderPrompt(
      compileStoryboardVideoPlan(versionFor(document)),
    );
    expect(prompt).toContain("Audio timeline:");
    for (const beat of document.beats) {
      expect(rendered).toContain(`เสียง: ${beat.soundDesign}`);
      expect(prompt).toContain(
        `${beat.startSeconds}-${beat.endSeconds}s | sound: ${beat.soundDesign}`,
      );
    }
  });

  it("tells the provider to stay silent, and adds no timeline, when audio is off", () => {
    const document = documentFor("เอา Twong เดินในสวน ไม่มีเสียง");
    const prompt = compileStoryboardProviderPrompt(
      compileStoryboardVideoPlan(versionFor(document)),
    );
    expect(prompt).toContain("Audio: none.");
    expect(prompt).not.toContain("Audio timeline:");
  });

  it("says no spoken dialogue in the prompt for the ambient mode", () => {
    const document = applyStoryboardAudioMode(documentFor("เอา Twong เดินในสวน"), "ambient");
    const prompt = compileStoryboardProviderPrompt(
      compileStoryboardVideoPlan(versionFor(document)),
    );
    expect(prompt).toContain("No spoken dialogue anywhere in the video.");
    expect(prompt).not.toContain("| speech: สวัสดี");
  });
});

describe("audio revisions", () => {
  it("routes an audio revision through the same parser", () => {
    const revision = parseStoryboardRevision({
      content: "ไม่มีเสียงพูด แต่มีเสียง",
      knownCharacterNames: ["Twong"],
    });
    expect(revision).toEqual({ kind: "audio", audio: "ambient" });
  });

  it("applies the revision to every beat of the existing document", () => {
    const document = documentFor("เอา Twong เดินในสวน");
    const revision = parseStoryboardRevision({
      content: "ขอมีเสียงด้วย",
      knownCharacterNames: ["Twong"],
    });
    expect(revision).toEqual({ kind: "audio", audio: "full" });
    const revised = applyStoryboardDocumentRevision(document, revision as never);
    expect(revised.audio).toBe("full");
    expect(revised.beats.every((beat) => Boolean(beat.soundDesign))).toBe(true);
  });
});
