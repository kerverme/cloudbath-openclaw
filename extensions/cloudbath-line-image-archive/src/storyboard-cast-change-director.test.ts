/**
 * Production regression: a fresh natural video request naming a Character the
 * active project never froze.
 *
 * F99 was saved as CHAR-13 while the owner's project was already frozen to
 * CHAR-12. The request below then died with `storyboard_create_failed` —
 * "This project is already locked to CHAR-12; start a new project to change
 * its cast" — before the planner or fal was ever reached.
 *
 * Two separate faults produced that. The parser read the word "วิดีโอ" as
 * proof the message specified a scene, so a request that pinned nothing down
 * went straight to project + storyboard creation instead of the director; and
 * project resolution only asked for a new-project-on-cast-change when the cast
 * arrived in "ใช้ X กับ Y" phrasing, so "เอา F99 ทำวิดีโอ ..." tried to
 * continue CHAR-12's project.
 *
 * No provider is reachable from this file: the paid-draft runtime is a local
 * stub that allocates a code without a network call, and the storyboard side
 * has no allocator of its own.
 */
import { describe, expect, it } from "vitest";
import { STORYBOARD_CONFIRMATION_PROMPT } from "./storyboard-confirmation.js";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import { DIRECTOR_QUESTION } from "./storyboard-director.js";
import type { StoryboardProjectResolver } from "./storyboard-line-router.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { harness } from "./storyboard-router.test-support.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

/** The exact production message. Names F99, describes actions, no duration. */
const PRODUCTION_REQUEST =
  "เอา F99 ทำวิดีโอ เดินอยู่ในสวน เจอขวดน้ำ แล้วเตะขวดน้ำกระเด็นออกไปนอกโลก มีเสียงบรรยากาศ ไม่มีเสียงพูด";

const FROZEN_PROJECT = "proj-char-12";
const FROZEN_CODE = "CHAR-12";
const NEW_CODE = "CHAR-13";

/**
 * The frozen-cast half of a resolution. Built through one helper so both
 * branches below share a `Record<string, string>` display map: a computed key
 * from a literal-typed constant would narrow to that single code and stop
 * satisfying the resolver's index signature.
 */
function cast(code: string, pageId: string, displayName: string) {
  const lock: UgcCharacterLock = {
    code,
    pageId,
    identityReferences: [{ kind: "identity", source: "r2", locator: `ugc/${pageId}.png` }],
    styleReferences: [],
    frozenAt: "2026-08-30T00:00:00.000Z",
  };
  return { characterLocks: [lock], displayNames: { [code]: displayName } };
}

/**
 * A resolver that models the production project state: one project already
 * frozen to CHAR-12, and the workflow's own cast-lock guard.
 *
 * The guard is reproduced here rather than mocked away, because it is the
 * thing that fired in production: continuing a frozen project with a cast it
 * never froze throws, and only `startNewProjectOnCastChange` opens new work.
 */
function frozenProjectResolver() {
  const calls: Array<{ characterNames: readonly string[]; startNew: boolean }> = [];
  const created: string[] = [];
  const resolver: StoryboardProjectResolver = {
    listCharacterNames: async () => ["F99", "Twong"],
    resolveProject: async ({ characterNames, startNewProjectOnCastChange }) => {
      calls.push({
        characterNames,
        startNew: startNewProjectOnCastChange === true,
      });
      const requested = characterNames.includes("F99") ? NEW_CODE : FROZEN_CODE;
      const namesSomeoneNew = requested !== FROZEN_CODE;
      if (namesSomeoneNew && !startNewProjectOnCastChange) {
        // Verbatim production failure.
        throw new Error(
          `This project is already locked to ${FROZEN_CODE}; start a new project to change its cast`,
        );
      }
      if (!namesSomeoneNew) {
        return {
          projectInstanceId: FROZEN_PROJECT,
          projectPageId: "page-proj-char-12",
          sceneId: "SCENE-1",
          scenePageId: "page-scene-1",
          ...cast(FROZEN_CODE, "page-char-12", "Twong"),
        };
      }
      const projectInstanceId = `proj-${NEW_CODE.toLowerCase()}-${created.length + 1}`;
      created.push(projectInstanceId);
      return {
        projectInstanceId,
        projectPageId: "page-proj-char-13",
        sceneId: "SCENE-1",
        scenePageId: "page-scene-13",
        ...cast(NEW_CODE, "page-char-13", "F99"),
      };
    },
    readProjectCast: async () => cast(NEW_CODE, "page-char-13", "F99"),
  };
  return { resolver, calls, created };
}

/** Allocates a code and quotes H3, with no network call of any kind. */
function stubPaidRuntime(): StoryboardPaidDraftRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "minimax/h3/reference-to-video",
        displayName: "MiniMax H3 Reference-to-Video",
        familyId: "minimax",
        familyDisplayName: "MiniMax",
      },
      estimatedCostUsd: 1.95,
    }),
    prepareStoryboardVideoDraft: async (request: { durationSeconds: number }) => {
      runtime.calls += 1;
      return {
        kind: "created" as const,
        draftId: "4821",
        modelId: "minimax/h3/reference-to-video",
        modelName: "MiniMax H3 Reference-to-Video",
        durationSeconds: request.durationSeconds,
        resolution: "2K",
        aspectRatio: "9:16",
        audio: true,
        estimatedCostUsd: 1.95,
        maxAllowedUsd: 50,
        pricingSource: "fal:minimax/h3/reference-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & { calls: number };
}

function mem<T>(): AsyncKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) =>
      values.has(key) ? false : (values.set(key, value), true),
    lookup: async (key) => values.get(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

describe("a fresh natural request naming a Character the project never froze", () => {
  it("asks 15 or 30 before writing any project or storyboard", async () => {
    const project = frozenProjectResolver();
    const paid = stubPaidRuntime();
    const h = harness({ resolver: project.resolver, paidDraftRuntime: paid });

    const asked = await h.dispatch(PRODUCTION_REQUEST);

    expect(asked).toMatchObject({ source: "storyboard", handled: true });
    expect(asked.text).toBe(DIRECTOR_QUESTION.duration);
    // The whole production failure was reaching project resolution here. It
    // must not have been touched, so neither the cast-lock guard nor the
    // planner nor any allocator can have run.
    expect(project.calls).toEqual([]);
    expect(project.created).toEqual([]);
    expect((await h.storyboardVersions.entries()).length).toBe(0);
    expect(paid.calls).toBe(0);
  });

  it("starts a NEW project for CHAR-13 once the duration arrives", async () => {
    const project = frozenProjectResolver();
    const h = harness({ resolver: project.resolver, paidDraftRuntime: stubPaidRuntime() });
    await h.dispatch(PRODUCTION_REQUEST);
    // "ไม่มีเสียงพูด" in the request is about sound, not speech, so the
    // director still asks its dialogue slot before it can build anything.
    expect((await h.dispatch("15"))?.text).toBe(DIRECTOR_QUESTION.dialogue);

    const storyboard = await h.dispatch("ไม่มี");

    expect(storyboard.text).toContain("Storyboard v1");
    expect(storyboard.text).toContain("F99");
    // Exactly one project resolution, asking for new work, and it opened a new
    // instance rather than continuing the one frozen to CHAR-12.
    expect(project.calls).toEqual([{ characterNames: ["F99"], startNew: true }]);
    expect(project.created).toHaveLength(1);
    const version = await h.latest();
    expect(version.project?.projectInstanceId).not.toBe(FROZEN_PROJECT);
    expect(version.document.cast.map((member) => member.characterId)).toEqual([NEW_CODE]);
    expect(version.document.durationSeconds).toBe(15);
  });

  it("leaves the CHAR-12 project untouched", async () => {
    const project = frozenProjectResolver();
    const h = harness({ resolver: project.resolver, paidDraftRuntime: stubPaidRuntime() });
    await h.dispatch(PRODUCTION_REQUEST);
    await h.dispatch("15");
    await h.dispatch("ไม่มี");

    // Nothing ever asked to resolve, continue or re-cast CHAR-12's project, and
    // no storyboard version was written against its instance id.
    for (const call of project.calls) {
      expect(call.characterNames).not.toContain("Twong");
    }
    const versions = await h.storyboardVersions.entries();
    expect(versions.length).toBeGreaterThan(0);
    for (const { value } of versions) {
      expect(value.project?.projectInstanceId).not.toBe(FROZEN_PROJECT);
      expect(value.document.cast.map((member) => member.characterId)).not.toContain(FROZEN_CODE);
    }
  });

  it("mints no VIDEO code until ยืนยัน Storyboard, then defaults to H3", async () => {
    const project = frozenProjectResolver();
    const paid = stubPaidRuntime();
    const h = harness({
      resolver: project.resolver,
      paidDraftRuntime: paid,
      modelSelection: mem<StoryboardModelSelectionState>(),
    });
    await h.dispatch(PRODUCTION_REQUEST);
    await h.dispatch("15");
    const storyboard = await h.dispatch("ไม่มี");

    // The storyboard is content, so it carries no payable code and the paid
    // runtime has not been asked for one.
    expect(storyboard.text).toContain(STORYBOARD_CONFIRMATION_PROMPT);
    expect(storyboard.text).not.toMatch(/ยืนยัน VIDEO/u);
    expect(paid.calls).toBe(0);
    expect((await h.drafts.entries()).length).toBe(0);

    const confirmed = await h.dispatch("ยืนยัน Storyboard");

    // Freezing opens the model conversation and still mints nothing.
    expect(confirmed.text).toContain("MiniMax H3 Reference-to-Video");
    expect(confirmed.text).not.toMatch(/ยืนยัน VIDEO/u);
    expect(paid.calls).toBe(0);

    const drafted = await h.dispatch("ใช้ Default");

    // Only now, on the confirmed storyboard and the default endpoint.
    expect(drafted.text).toMatch(/ยืนยัน VIDEO 4821/u);
    expect(paid.calls).toBe(1);
  });

  it("still routes a genuine audio-only revision to the revision path", async () => {
    // The production request ends in sound wording, which is why the parser
    // now has to outrank the revision parse. An audio tweak with no action to
    // depict must NOT be stolen into a new director session.
    const project = frozenProjectResolver();
    const h = harness({ resolver: project.resolver, paidDraftRuntime: stubPaidRuntime() });
    await h.dispatch(PRODUCTION_REQUEST);
    await h.dispatch("15");
    await h.dispatch("ไม่มี");
    const before = await h.latest();

    await h.dispatch("เอา F99 ไม่ต้องมีเสียงพูด");

    const after = await h.latest();
    expect(after.versionNumber).toBeGreaterThan(before.versionNumber);
    expect(after.storyboardId).toBe(before.storyboardId);
    // A revision, so no second project was opened.
    expect(project.created).toHaveLength(1);
  });

  it("keeps an explicitly cast, explicitly timed request on the create path", async () => {
    // Unchanged shipped behaviour: the owner pinned cast AND length, so there
    // is nothing to ask and the director is not involved.
    const project = frozenProjectResolver();
    const h = harness({ resolver: project.resolver, paidDraftRuntime: stubPaidRuntime() });

    const created = await h.dispatch("ใช้ F99 ให้เดินในสวน 15 วิ แนวตั้ง");

    expect(created.text).toContain("Storyboard v1");
    expect(created.text).not.toBe(DIRECTOR_QUESTION.duration);
    expect(project.calls).toEqual([{ characterNames: ["F99"], startNew: true }]);
  });
});
