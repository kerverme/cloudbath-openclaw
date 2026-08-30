import { describe, expect, it } from "vitest";
import {
  allocateBeatWindows,
  applyStoryboardTimeRangeEdit,
  compileStoryboardDocument,
} from "./storyboard-compiler.js";
import { formatStoryboardForLine } from "./storyboard-format.js";
import { parseStoryboardIntent, stripTimeRangeSpan } from "./storyboard-intent.js";
import {
  parseStoryboardActions,
  parseStoryboardTimeRange,
  readStoryboardAspectRatio,
  readStoryboardDuration,
  readStoryboardEnvironment,
  readStoryboardResolution,
} from "./storyboard-request.js";
import { StoryboardStore } from "./storyboard-store.js";
import type {
  StoryboardCastMember,
  StoryboardDocument,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import {
  compileStoryboardVideoPlan,
  estimateStoryboardCost,
  resolveStoryboardVideoModel,
} from "./storyboard-video-plan.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const PRODUCTION_REQUEST =
  "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ ในร้านกาแฟ แนวตั้ง";
const NAMES = ["Twong", "Twong2"] as const;
const CLAIM = { accountId: "acct-1", lineGroupId: "C1", ownerSenderId: "U1" } as const;

const CAST: readonly StoryboardCastMember[] = [
  { characterId: "CHAR-6", characterPageId: "page-char-6", displayName: "Twong" },
  { characterId: "CHAR-7", characterPageId: "page-char-7", displayName: "Twong2" },
];

const LOCKS: readonly UgcCharacterLock[] = [
  {
    code: "CHAR-6",
    pageId: "page-char-6",
    identityReferences: [{ kind: "identity", source: "r2", locator: "ugc/char-6.png" }],
    styleReferences: [],
    frozenAt: "2026-08-30T00:00:00.000Z",
  },
  {
    code: "CHAR-7",
    pageId: "page-char-7",
    identityReferences: [{ kind: "identity", source: "r2", locator: "ugc/char-7.png" }],
    styleReferences: [],
    frozenAt: "2026-08-30T00:00:00.000Z",
  },
];

function mem<T>(): AsyncKeyedStore<T> {
  const m = new Map<string, T>();
  return {
    register: async (k, v) => void m.set(k, v),
    registerIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    lookup: async (k) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function compile(overrides: Partial<Parameters<typeof compileStoryboardDocument>[0]> = {}) {
  return compileStoryboardDocument({
    scenePrompt: PRODUCTION_REQUEST,
    cast: CAST,
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "720p",
    environment: readStoryboardEnvironment(PRODUCTION_REQUEST),
    ...overrides,
  });
}

function storeHarness() {
  const versions = mem<StoryboardVersion>();
  const store = new StoryboardStore({
    heads: mem<StoryboardHead>(),
    versions,
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
  });
  return { store, versions };
}

describe("request parsing", () => {
  it("reads every dimension out of the production request", () => {
    expect(readStoryboardDuration(PRODUCTION_REQUEST)).toBe(15);
    expect(readStoryboardAspectRatio(PRODUCTION_REQUEST)).toBe("9:16");
    expect(readStoryboardEnvironment(PRODUCTION_REQUEST)).toBe("ร้านกาแฟ");
    // No resolution was requested, so the compiler default applies later.
    expect(readStoryboardResolution(PRODUCTION_REQUEST)).toBeUndefined();
  });

  it("reads a landscape request and an explicit resolution", () => {
    const text = "ใช้ Twong เดิน 10 วิ แนวนอน 1080p";
    expect(readStoryboardAspectRatio(text)).toBe("16:9");
    expect(readStoryboardResolution(text)).toBe("1080p");
    expect(readStoryboardDuration(text)).toBe(10);
  });

  it("claims a specific action span only once", () => {
    const actions = parseStoryboardActions(PRODUCTION_REQUEST, NAMES);
    expect(actions.map((action) => action.kind)).toEqual(["locomotion", "dialogue"]);
    // "เดินผ่าน" wins over the bare "เดิน" it contains.
    expect(actions[0]!.phrase).toBe("เดินผ่าน");
    expect(actions[0]!.subject).toBe("Twong");
    expect(actions[0]!.object).toBe("Twong2");
    expect(actions[1]!.phrase).toBe("คุยกันเบาๆ");
  });

  it("does not mistake the shorter cast name for the longer one", () => {
    const actions = parseStoryboardActions("ให้ Twong เดินผ่าน Twong2", NAMES);
    expect(actions[0]!.object).toBe("Twong2");
  });
});

describe("request parsing regressions", () => {
  it("does not read a cast-name digit or a same-prefix word as a duration", () => {
    // "Twong2 วิ่ง…" previously parsed as 2 seconds: the "2" came from the cast
    // name and the unit from the first syllable of "วิ่ง".
    const text = "ใช้ Twong กับ Twong2 วิ่งเล่นในสวน 30 วินาที";
    expect(readStoryboardDuration(text)).toBe(30);
    expect(readStoryboardDuration("Twong2 วิ่งเล่น")).toBeUndefined();
    expect(readStoryboardDuration("Twong มาถึงตอน 10:30 นะ")).toBeUndefined();
  });

  it("still reads every supported duration form", () => {
    expect(readStoryboardDuration("ใช้ Twong เดิน 15 วิ แนวตั้ง")).toBe(15);
    expect(readStoryboardDuration("ใช้ Twong เดิน 10 sec")).toBe(10);
    expect(readStoryboardDuration("ใช้ Twong เดิน 10 seconds")).toBe(10);
    expect(readStoryboardDuration("ใช้ Twong เดิน 12s")).toBe(12);
  });

  it("does not read a clock time as an aspect ratio", () => {
    // "14:30" contains "4:3" and "11:15" contains "1:1".
    expect(readStoryboardAspectRatio("Twong ประชุม 14:30")).toBeUndefined();
    expect(readStoryboardAspectRatio("Twong มาถึง 11:15")).toBeUndefined();
    expect(readStoryboardAspectRatio("Twong 10:30 นะ")).toBeUndefined();
  });

  it("still reads every real aspect form", () => {
    expect(readStoryboardAspectRatio("แนวตั้ง")).toBe("9:16");
    expect(readStoryboardAspectRatio("แนวนอน")).toBe("16:9");
    expect(readStoryboardAspectRatio("9:16")).toBe("9:16");
    expect(readStoryboardAspectRatio("16:9")).toBe("16:9");
    expect(readStoryboardAspectRatio("1:1")).toBe("1:1");
    expect(readStoryboardAspectRatio("4:3")).toBe("4:3");
    expect(readStoryboardAspectRatio("2.39:1")).toBe("2.39:1");
  });

  it("stops a modifier at a multi-character clause marker", () => {
    // The per-character scan could never match "แล้ว", so the modifier ran on.
    const actions = parseStoryboardActions("ให้ Twong คุยกันเบาๆแล้วเดินออกไป", ["Twong"]);
    const dialogue = actions.find((action) => action.kind === "dialogue");
    expect(dialogue?.phrase).toBe("คุยกันเบาๆ");
  });

  it("requires a standalone unit before reading a time range", () => {
    // "วิ" as the first syllable of another word is not a seconds marker.
    expect(parseStoryboardTimeRange("วิธีนี้ 3-6 เอาไหม")).toBeUndefined();
    expect(parseStoryboardTimeRange("วิทยาลัย 3-6 ให้ไหม")).toBeUndefined();
  });

  it("reads every supported range grammar", () => {
    expect(parseStoryboardTimeRange("วิ 10-14 ให้ Twong หัน")).toEqual({
      fromSeconds: 10,
      toSeconds: 14,
    });
    expect(parseStoryboardTimeRange("วินาที 3-6 เปลี่ยน")).toEqual({
      fromSeconds: 3,
      toSeconds: 6,
    });
    expect(parseStoryboardTimeRange("ช่วง 3 ถึง 6 วิ เปลี่ยน")).toEqual({
      fromSeconds: 3,
      toSeconds: 6,
    });
    expect(parseStoryboardTimeRange("10-14 sec ให้ Twong หัน")).toEqual({
      fromSeconds: 10,
      toSeconds: 14,
    });
    expect(parseStoryboardTimeRange("seconds 10-14 ให้ Twong หัน")).toEqual({
      fromSeconds: 10,
      toSeconds: 14,
    });
  });

  it("strips the time-range span out of an edit instruction", () => {
    expect(stripTimeRangeSpan("วิ 10-14 ให้ Twong หันกลับมามอง Twong2")).toBe(
      "ให้ Twong หันกลับมามอง Twong2",
    );
    expect(stripTimeRangeSpan("ช่วง 3 ถึง 6 วิ เปลี่ยนเป็น close-up Twong2")).toBe(
      "เปลี่ยนเป็น close-up Twong2",
    );
    expect(stripTimeRangeSpan("10-14 sec ให้ Twong หันกลับ")).toBe("ให้ Twong หันกลับ");
  });
});

describe("beat compilation", () => {
  it("produces the expected production storyboard", () => {
    const document = compile();
    expect(document.beats.map((beat) => [beat.startSeconds, beat.endSeconds])).toEqual([
      [0, 3],
      [3, 8],
      [8, 11],
      [11, 15],
    ]);
    expect(document.beats.map((beat) => beat.kind)).toEqual([
      "establishing",
      "locomotion",
      "transition",
      "dialogue",
    ]);
    expect(document.beats[1]!.action).toBe("Twong เดินผ่าน Twong2");
    expect(document.beats[2]!.action).toBe("Twong หันกลับมามอง Twong2");
    expect(document.beats[3]!.dialogue).toBe("คุยกันเบาๆ");
    expect(document.beats[0]!.environmentNote).toBe("ร้านกาแฟ");
  });

  it("generalises to other durations without hardcoding the example", () => {
    for (const durationSeconds of [6, 8, 12, 20, 30, 45]) {
      const document = compile({ durationSeconds });
      expect(document.beats[0]!.startSeconds, `${durationSeconds}`).toBe(0);
      expect(document.beats.at(-1)!.endSeconds, `${durationSeconds}`).toBe(durationSeconds);
      for (const [index, beat] of document.beats.entries()) {
        expect(beat.endSeconds, `${durationSeconds}`).toBeGreaterThan(beat.startSeconds);
        if (index > 0) {
          expect(beat.startSeconds).toBe(document.beats[index - 1]!.endSeconds);
        }
      }
    }
  });

  it("still fits when the duration cannot seat every beat", () => {
    const document = compile({ durationSeconds: 2 });
    expect(document.beats.length).toBeLessThanOrEqual(2);
    expect(document.beats.at(-1)!.endSeconds).toBe(2);
  });

  it("keeps windows contiguous for any weighting", () => {
    const windows = allocateBeatWindows(7, ["establishing", "locomotion", "dialogue"]);
    expect(windows[0]!.startSeconds).toBe(0);
    expect(windows.at(-1)!.endSeconds).toBe(7);
    for (const [index, window] of windows.entries()) {
      expect(window.endSeconds).toBeGreaterThan(window.startSeconds);
      if (index > 0) {
        expect(window.startSeconds).toBe(windows[index - 1]!.endSeconds);
      }
    }
  });

  it("renders the storyboard for LINE from the structure", () => {
    const text = formatStoryboardForLine({ versionNumber: 1, document: compile() });
    expect(text).toContain("🎬 Storyboard v1 — 15 วิ · 9:16");
    expect(text).toContain("0–3 วิ");
    expect(text).toContain("11–15 วิ");
    expect(text).toContain("Twong · CHAR-6");
    expect(text).toContain("Twong2 · CHAR-7");
    expect(text).toContain("สร้างวิดีโอ");
  });
});

describe("allocator invariants (regression)", () => {
  it("never emits a zero-length beat for any duration and beat mix", () => {
    const kinds = ["establishing", "locomotion", "transition", "dialogue", "action"] as const;
    for (let durationSeconds = 1; durationSeconds <= 60; durationSeconds += 1) {
      for (let count = 1; count <= Math.min(6, durationSeconds); count += 1) {
        for (let seed = 0; seed < kinds.length; seed += 1) {
          const mix = Array.from(
            { length: count },
            (_unused, index) => kinds[(index + seed) % kinds.length]!,
          );
          const windows = allocateBeatWindows(durationSeconds, mix);
          const label = `${durationSeconds}s ${mix.join(",")}`;
          expect(windows[0]!.startSeconds, label).toBe(0);
          expect(windows.at(-1)!.endSeconds, label).toBe(durationSeconds);
          for (const [index, window] of windows.entries()) {
            expect(window.endSeconds, label).toBeGreaterThan(window.startSeconds);
            if (index > 0) {
              expect(window.startSeconds, label).toBe(windows[index - 1]!.endSeconds);
            }
          }
        }
      }
    }
  });

  it("covers the exact mix that previously produced a 4-4 beat", () => {
    const windows = allocateBeatWindows(7, [
      "establishing",
      "locomotion",
      "locomotion",
      "transition",
      "locomotion",
      "locomotion",
    ]);
    expect(windows.every((window) => window.endSeconds > window.startSeconds)).toBe(true);
  });
});

describe("time-range editing", () => {
  it("returns a new document and never mutates the input", () => {
    const v1 = compile();
    const snapshot = structuredClone(v1) as StoryboardDocument;
    const v2 = applyStoryboardTimeRangeEdit(v1, {
      fromSeconds: 10,
      toSeconds: 14,
      action: "Twong หันกลับมามอง Twong2",
    });
    expect(v1).toEqual(snapshot);
    expect(v2).not.toBe(v1);
    const edited = v2.beats.find((beat) => beat.startSeconds === 10 && beat.endSeconds === 14);
    expect(edited?.action).toBe("Twong หันกลับมามอง Twong2");
    // The scene is still fully covered and still ordered.
    expect(v2.beats[0]!.startSeconds).toBe(0);
    expect(v2.beats.at(-1)!.endSeconds).toBe(15);
    for (const [index, beat] of v2.beats.entries()) {
      if (index > 0) {
        expect(beat.startSeconds).toBe(v2.beats[index - 1]!.endSeconds);
      }
    }
  });

  it("rejects a range outside the duration instead of clamping", () => {
    const v1 = compile();
    for (const range of [
      { fromSeconds: 20, toSeconds: 25 },
      { fromSeconds: 10, toSeconds: 16 },
      { fromSeconds: -1, toSeconds: 5 },
      { fromSeconds: 8, toSeconds: 8 },
    ]) {
      expect(() => applyStoryboardTimeRangeEdit(v1, { ...range, action: "x" })).toThrow();
    }
  });
});

describe("K. version storage keeps every version", () => {
  it("keeps v1 after v2 and v2 after v3", async () => {
    const { store } = storeHarness();
    const created = await store.createStoryboard({
      document: compile(),
      claim: CLAIM,
      projectInstanceId: "proj-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-1",
      scenePageId: "page-scene-1",
      characterLocks: LOCKS,
    });
    const storyboardId = created.head.storyboardId;

    await store.appendEdit({
      storyboardId,
      claim: CLAIM,
      edit: { fromSeconds: 10, toSeconds: 14, action: "แก้ครั้งที่หนึ่ง" },
    });
    const v1AfterV2 = await store.readVersion({ storyboardId, claim: CLAIM, versionNumber: 1 });
    expect(v1AfterV2?.document).toEqual(created.version.document);

    await store.appendEdit({
      storyboardId,
      claim: CLAIM,
      edit: { fromSeconds: 3, toSeconds: 6, action: "แก้ครั้งที่สอง" },
    });
    const v1AfterV3 = await store.readVersion({ storyboardId, claim: CLAIM, versionNumber: 1 });
    const v2AfterV3 = await store.readVersion({ storyboardId, claim: CLAIM, versionNumber: 2 });
    expect(v1AfterV3?.document).toEqual(created.version.document);
    expect(v2AfterV3?.versionNumber).toBe(2);
    expect(v2AfterV3?.parentVersionNumber).toBe(1);
    expect((await store.readLatest({ storyboardId, claim: CLAIM }))?.versionNumber).toBe(3);
  });

  it("refuses a concurrent write to the same version slot", async () => {
    const { store } = storeHarness();
    const created = await store.createStoryboard({
      document: compile(),
      claim: CLAIM,
      projectInstanceId: "proj-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-1",
      scenePageId: "page-scene-1",
      characterLocks: LOCKS,
    });
    const storyboardId = created.head.storyboardId;
    const results = await Promise.allSettled([
      store.appendEdit({
        storyboardId,
        claim: CLAIM,
        edit: { fromSeconds: 3, toSeconds: 6, action: "a" },
      }),
      store.appendEdit({
        storyboardId,
        claim: CLAIM,
        edit: { fromSeconds: 8, toSeconds: 11, action: "b" },
      }),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled").length).toBe(1);
    expect(results.filter((entry) => entry.status === "rejected").length).toBe(1);
  });

  it("fails closed for another owner", async () => {
    const { store } = storeHarness();
    const created = await store.createStoryboard({
      document: compile(),
      claim: CLAIM,
      projectInstanceId: "proj-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-1",
      scenePageId: "page-scene-1",
      characterLocks: LOCKS,
    });
    await expect(
      store.readLatest({
        storyboardId: created.head.storyboardId,
        claim: { ...CLAIM, ownerSenderId: "U-other" },
      }),
    ).rejects.toThrow(/not accessible/u);
  });
});

describe("provider-neutral video plan", () => {
  it("preserves cast order, references, timing and camera intent", async () => {
    const { store } = storeHarness();
    const created = await store.createStoryboard({
      document: compile(),
      claim: CLAIM,
      projectInstanceId: "proj-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-1",
      scenePageId: "page-scene-1",
      characterLocks: LOCKS,
    });
    const plan = compileStoryboardVideoPlan(created.version);

    expect(plan.durationSeconds).toBe(15);
    expect(plan.aspectRatio).toBe("9:16");
    expect(plan.resolution).toBe("720p");
    expect(plan.environment).toBe("ร้านกาแฟ");
    expect(plan.characters.map((character) => character.characterId)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(plan.characters[1]!.identityReferences).toEqual(["ugc/char-7.png"]);
    expect(plan.beats.map((beat) => beat.startSeconds)).toEqual([0, 3, 8, 11]);
    expect(plan.beats[1]!.camera).toBe("Track with the subject");
    expect(plan.beats.at(-1)!.dialogue).toBe("คุยกันเบาๆ");
  });

  it("names the preferred model without inventing a provider id", () => {
    const model = resolveStoryboardVideoModel();
    expect(model).toEqual({ kind: "deferred", displayName: "Seedance 2.5" });
    expect(estimateStoryboardCost(model)).toEqual({
      kind: "unavailable",
      reason: "provider-binding-deferred",
    });
  });
});

describe("intent classification", () => {
  it("classifies the production request as a storyboard create", () => {
    const intent = parseStoryboardIntent({
      content: PRODUCTION_REQUEST,
      knownCharacterNames: NAMES,
    });
    expect(intent?.kind).toBe("create");
  });

  it("never claims the exact paid confirmation or an explicit previs request", () => {
    for (const content of [
      "ยืนยัน VIDEO 1234",
      "ยืนยัน VIDEO 0001",
      `PREVIS ${PRODUCTION_REQUEST}`,
      "APPROVE PREVIS",
      "อนุมัติ PREVIS",
    ]) {
      expect(
        parseStoryboardIntent({ content, knownCharacterNames: NAMES }),
        content,
      ).toBeUndefined();
    }
  });

  it("treats only an explicit video request as create_video", () => {
    for (const content of ["สร้างวิดีโอ", "สร้างวิดีโอเลย", "create video", "ทำวิดีโอ"]) {
      expect(parseStoryboardIntent({ content, knownCharacterNames: NAMES }), content).toEqual({
        kind: "create_video",
      });
    }
    for (const content of ["สร้างเลย", "ทำเลย", "เอาเลย", "โอเค", "ยืนยัน", "yes", "go"]) {
      expect(
        parseStoryboardIntent({ content, knownCharacterNames: NAMES }),
        content,
      ).toBeUndefined();
    }
  });

  it("survives NFKC decomposition of Thai SARA AM", () => {
    // A LINE client may send "ทำ" decomposed; the classifier must still see it.
    const decomposed = "ทำวิดีโอ".normalize("NFKD");
    expect(decomposed).not.toBe("ทำวิดีโอ");
    expect(parseStoryboardIntent({ content: decomposed, knownCharacterNames: NAMES })).toEqual({
      kind: "create_video",
    });
  });

  it("ignores conversation that names a character but describes no scene", () => {
    expect(
      parseStoryboardIntent({ content: "Twong สบายดีไหม", knownCharacterNames: NAMES }),
    ).toBeUndefined();
  });
});
