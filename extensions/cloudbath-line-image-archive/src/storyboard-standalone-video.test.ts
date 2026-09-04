/**
 * Standalone storyboard work: the owner's video flow without a UGC workspace.
 *
 * Requiring a bound workspace to *begin* planning made an unbound owner ask for
 * a video and be told to go set up UGC — for a scene that would never have
 * touched the Character Library. Only one branch genuinely needs the project
 * space: casting frozen identities into a real Notion project. Text-only and
 * first-frame scenes need none of it, so they now get a real storyboard with a
 * real version chain and no invented project ids at all.
 *
 * The director asks what the scene is built FROM first, because that answer
 * decides both the provider input mode and whether a project is needed. It is
 * never inferred: an unrelated attachment silently becoming somebody's first
 * frame is a wrong-content failure, so an unprovable image gets one short
 * clarification instead of a guess.
 *
 * Nothing here can spend anything or reach any provider: the paid runtime is a
 * local stub with counters, the planner answers from a table, and the visual
 * service's generator returns bytes from memory.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import { DIRECTOR_QUESTION } from "./storyboard-director.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness } from "./storyboard-router.test-support.js";
import { resolveStoryboardInputMode } from "./storyboard-types.js";
import { StoryboardVisualService, type StoryboardVisualArtifact } from "./storyboard-visual.js";
import type { AsyncKeyedStore } from "./types.js";

/** Owner video requests that name no cast, in the wordings production saw. */
const ASK_VIDEO = "ช่วยทำวิดีโอให้หน่อย";
/** Menu answers AND their plain-language equivalents: not a phrase table. */
const PICK_TEXT_ONLY = ["1", "ข้อความอย่างเดียว"] as const;
const PICK_SOURCE_IMAGE = ["2", "ใช้ภาพที่ส่งมา"] as const;
const PICK_CHARACTER = ["3", "ใช้ตัวละครจาก Character Library"] as const;

function mem<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    lookup: async (key) => rows.get(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/** Records what the paid seam was asked for; never calls anything. */
function paidRuntime() {
  const runtime = {
    prepareCalls: 0,
    inputModes: [] as string[],
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "bytedance/seedance-2.5/text-to-video",
        displayName: "Seedance 2.5",
        familyId: "bytedance",
        familyDisplayName: "ByteDance",
      },
      estimatedCostUsd: 0.9,
    }),
    listCompatibleVideoModels: async () => [],
    readActiveVideoJob: async () => undefined,
    supersedeStoryboardDrafts: async () => [],
    prepareStoryboardVideoDraft: async (request: {
      durationSeconds: number;
      inputMode: string;
    }) => {
      runtime.prepareCalls += 1;
      runtime.inputModes.push(request.inputMode);
      return {
        kind: "created" as const,
        draftId: "4821",
        modelId: "bytedance/seedance-2.5/text-to-video",
        modelName: "Seedance 2.5",
        durationSeconds: request.durationSeconds,
        resolution: "1080p",
        aspectRatio: "9:16",
        audio: false,
        estimatedCostUsd: 0.9,
        maxAllowedUsd: 50,
        pricingSource: "fal:bytedance/seedance-2.5/text-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & {
    prepareCalls: number;
    inputModes: string[];
  };
}

function planner() {
  return new StoryboardLlmPlanner(async () => ({
    text: JSON.stringify({
      beats: [
        {
          startSeconds: 1,
          endSeconds: 4,
          kind: "establishing",
          framing: "Wide",
          action: "the cat walks",
          camera: "Static",
          characterNames: [],
        },
        {
          startSeconds: 4,
          endSeconds: 8,
          kind: "action",
          framing: "Medium",
          action: "the cat jumps",
          camera: "Track",
          characterNames: [],
        },
      ],
    }),
  }));
}

function visualService() {
  const artifacts = mem<StoryboardVisualArtifact>();
  const generate = vi.fn(async ({ shotIndex }: { shotIndex: number }) => ({
    bytes: Buffer.from(`shot-${shotIndex}`),
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    provider: "test-image-provider",
    model: "test-image-model",
  }));
  const service = new StoryboardVisualService({
    artifacts,
    now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    generate,
    normalize: async ({ bytes }) => ({
      bytes,
      mimeType: "image/png" as const,
      width: 1024,
      height: 1024,
    }),
    persist: async () => {},
  });
  return { artifacts, generate, service };
}

/** An unbound owner conversation with the full storyboard-first wiring. */
function unbound(options: { selectedSourceImage?: string } = {}) {
  const paid = paidRuntime();
  const visuals = visualService();
  const sent: string[] = [];
  const h = harness({
    binding: null,
    paidDraftRuntime: paid,
    planner: planner(),
    modelSelection: mem<StoryboardModelSelectionState>(),
    visuals: visuals.service,
    publicAssetBaseUrl: "https://assets.example",
    sendVisualImage: async ({ originalContentUrl }) => void sent.push(originalContentUrl),
    resolveSelectedSourceImage: async () =>
      options.selectedSourceImage
        ? { kind: "selected" as const, mediaId: options.selectedSourceImage }
        : { kind: "none" as const },
  });
  return { h, paid, sent, ...visuals };
}

describe("B. an unbound owner reaches the director, not a setup demand", () => {
  it("asks what the scene is built from", async () => {
    const g = unbound();

    const opened = await g.h.dispatch(ASK_VIDEO);

    expect(opened.source).toBe("storyboard");
    expect(opened.text).toBe(DIRECTOR_QUESTION.media);
    // The workspace is not the missing thing, and nothing paid was touched.
    expect(opened.text).not.toContain("UGC");
    expect(opened.text).not.toContain("Video draft");
    expect(g.paid.prepareCalls).toBe(0);
  });

  it.each(PICK_TEXT_ONLY)("continues to the ordinary slots after %s", async (answer) => {
    const g = unbound();
    await g.h.dispatch(ASK_VIDEO);

    const asked = await g.h.dispatch(answer);

    expect(asked.text).toBe(DIRECTOR_QUESTION.duration);
  });
});

describe("standalone work is real, and honest about having no project", () => {
  it("creates a version chain with no project and no invented Character locks", async () => {
    const g = unbound();
    await g.h.dispatch(ASK_VIDEO);
    await g.h.dispatch(PICK_TEXT_ONLY[0]);
    await g.h.dispatch("8 วิ");

    const built = await g.h.dispatch("ไม่มี");

    expect(built.text).toContain("Storyboard v1");
    const version = await g.h.latest();
    expect(version.storyboardId).toBeTruthy();
    expect(version.versionNumber).toBe(1);
    // Scoped to the owner's own LINE identity, and nothing else.
    expect(version.accountId).toBe(g.h.claim.accountId);
    expect(version.lineGroupId).toBe(g.h.claim.lineGroupId);
    expect(version.ownerSenderId).toBe(g.h.claim.ownerSenderId);
    // No fabricated Notion ids, no fabricated cast.
    expect(version.project).toBeUndefined();
    expect(version.characterLocks).toEqual([]);
    expect(version.document.cast).toEqual([]);
  });

  it("reaches Final Video Draft through the same visuals gate, as text_to_video", async () => {
    const g = unbound();
    await g.h.dispatch(ASK_VIDEO);
    await g.h.dispatch(PICK_TEXT_ONLY[0]);
    await g.h.dispatch("8 วิ");
    await g.h.dispatch("ไม่มี");

    // Freezing is refused until every shot exists, exactly as for bound work.
    expect((await g.h.dispatch("ยืนยัน Storyboard")).text).toContain("ยังไม่มีภาพครบ");
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    expect(g.generate).toHaveBeenCalled();

    const confirmed = await g.h.dispatch("ยืนยัน Storyboard");
    expect(confirmed.text).toContain("Default Model");
    const drafted = await g.h.dispatch("ใช้ Default");

    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).not.toContain("🎬 Video draft");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    // The mode follows the storyboard's own inputs, not a chat attachment.
    expect(g.paid.inputModes).toEqual(["text_to_video"]);
    expect(resolveStoryboardInputMode(await g.h.latest())).toBe("text_to_video");
  });
});

describe("a chosen first frame, and only a chosen one", () => {
  it.each(PICK_SOURCE_IMAGE)("freezes the selected image after %s", async (answer) => {
    const g = unbound({ selectedSourceImage: "media-1" });
    await g.h.dispatch(ASK_VIDEO);

    const asked = await g.h.dispatch(answer);

    expect(asked.text).toBe(DIRECTOR_QUESTION.duration);
    await g.h.dispatch("8 วิ");
    await g.h.dispatch("ไม่มี");

    const version = await g.h.latest();
    expect(version.document.sourceImage).toMatchObject({
      kind: "owner_selected",
      mediaId: "media-1",
    });
    expect(resolveStoryboardInputMode(version)).toBe("image_to_video");
  });

  it("reaches Final Video Draft as image_to_video", async () => {
    const g = unbound({ selectedSourceImage: "media-1" });
    await g.h.dispatch(ASK_VIDEO);
    await g.h.dispatch(PICK_SOURCE_IMAGE[0]);
    await g.h.dispatch("8 วิ");
    await g.h.dispatch("ไม่มี");
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    await g.h.dispatch("ยืนยัน Storyboard");

    const drafted = await g.h.dispatch("ใช้ Default");

    expect(drafted.text).toContain("Final Video Draft");
    expect(g.paid.inputModes).toEqual(["image_to_video"]);
  });

  it("asks one short question rather than adopting a nearby image", async () => {
    // No provable selection. Guessing here would make an unrelated attachment
    // somebody's first frame, which is the failure this branch exists to stop.
    const g = unbound();
    await g.h.dispatch(ASK_VIDEO);

    const asked = await g.h.dispatch(PICK_SOURCE_IMAGE[0]);

    expect(asked.text).toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");
    // The slot stays open, so answering text-only still works.
    expect((await g.h.dispatch(PICK_TEXT_ONLY[0])).text).toBe(DIRECTOR_QUESTION.duration);
  });
});

describe("the Character Library stays project-backed", () => {
  it.each(PICK_CHARACTER)("requires the workspace for %s, and only then", async (answer) => {
    const g = unbound();
    await g.h.dispatch(ASK_VIDEO);

    const refused = await g.h.dispatch(answer);

    expect(refused.text).toContain("UGC");
    expect(g.paid.prepareCalls).toBe(0);
  });

  it("still names an explicitly requested Character as needing the workspace", async () => {
    const h = harness({ binding: null, resolverNames: ["Twong"] });

    const refused = await h.dispatch("เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ");

    expect(refused.text).toContain("UGC");
  });

  it("lets the bound conversation cast normally", async () => {
    const h = harness({ paidDraftRuntime: paidRuntime(), planner: planner() });

    const built = await h.dispatch("เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ");
    await h.dispatch("8 วิ");
    const storyboard = await h.dispatch("ไม่มี");

    expect(built.text).toBe(DIRECTOR_QUESTION.duration);
    expect(storyboard.text).toContain("Storyboard v1");
    // Group A keeps its real project linkage and its frozen cast.
    const version = await h.latest();
    expect(version.project?.projectInstanceId).toBe("proj-instance-1");
    expect(version.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6"]);
  });
});

describe("isolation with one routing policy", () => {
  it("keeps standalone and bound work apart while both route the same way", async () => {
    const standalone = unbound();
    const bound = harness({ paidDraftRuntime: paidRuntime(), planner: planner() });

    // Same question, both conversations.
    expect((await standalone.h.dispatch(ASK_VIDEO)).text).toBe(DIRECTOR_QUESTION.media);
    expect((await bound.dispatch(ASK_VIDEO)).text).toBe(DIRECTOR_QUESTION.media);

    await standalone.h.dispatch(PICK_TEXT_ONLY[0]);
    await standalone.h.dispatch("8 วิ");
    await standalone.h.dispatch("ไม่มี");

    // Separate state: the bound conversation never sees the standalone work.
    expect((await standalone.h.latest()).project).toBeUndefined();
    await expect(bound.latest()).rejects.toThrow();
  });
});

describe("the paid guarantees this must not weaken", () => {
  it("spends nothing anywhere in the standalone flow before the exact code", async () => {
    const g = unbound();

    for (const message of [ASK_VIDEO, PICK_TEXT_ONLY[0], "8 วิ", "ไม่มี", "ทำภาพแต่ละช็อต"]) {
      await g.h.dispatch(message);
    }
    // Natural approvals are not payment, whatever they sound like.
    for (const message of ["โอเค ทำต่อ", "เอาอันนี้", "ตกลง"]) {
      await g.h.dispatch(message);
    }

    expect(g.paid.prepareCalls).toBe(0);
  });
});
