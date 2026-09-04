/**
 * Storyboard-first is the owner's video flow in EVERY conversation they own.
 *
 * Production compared two LINE groups. One had a UGC binding, an active
 * storyboard and a visible 5-panel image; the other had none of that. The
 * second group's natural "make me a video" fell through every storyboard gate
 * to the model, which answered with a legacy single-shot "🎬 Video draft" — a
 * different product, reached by accident, because one policy check was
 * answering two different questions. The visible image proved nothing either:
 * no per-shot artifact existed for the active version.
 *
 * These assert the separation that fixes both. Ownership decides whether the
 * storyboard flow runs; the UGC workspace decides only whether Character
 * Library casting and project freezing are reachable, and is reported at the
 * step that needs them. Readiness is per-shot artifacts and nothing else.
 *
 * Nothing here can spend anything or call any provider: the paid runtime is a
 * local stub with counters, the planner answers from a table, and the visual
 * service's generator returns bytes from memory.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness } from "./storyboard-router.test-support.js";
import {
  deriveContactSheetPreview,
  StoryboardVisualService,
  storyboardVisualKey,
  type StoryboardVisualArtifact,
} from "./storyboard-visual.js";
import type { AsyncKeyedStore } from "./types.js";

/** A natural owner video request that names a cast the library knows. */
const SCENE = "เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ";
/**
 * Four ways of asking for the same two things, so nothing below is a phrase
 * table: production routes on the utterance CLASS, not on these strings.
 */
const ASK_VISUALS = ["ทำ storyboard เป็นภาพให้ดู", "ทำภาพแต่ละช็อต", "เอาภาพมาดูก่อน"] as const;
const ASK_CONTINUE = "ทำต่อเลย";
/** Natural video requests that name no cast at all. */
const ASK_VIDEO = ["ช่วยทำวิดีโอให้หน่อย", "อยากได้วิดีโอแมวเดินในสวน", "ทำวิดีโอหน่อย"] as const;

function mem<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    lookup: async (key) => rows.get(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function paidRuntime() {
  const runtime = {
    prepareCalls: 0,
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "minimax/h3/reference-to-video",
        displayName: "MiniMax H3 Reference-to-Video",
        familyId: "minimax",
        familyDisplayName: "MiniMax",
      },
      estimatedCostUsd: 1.04,
    }),
    listCompatibleVideoModels: async () => [],
    readActiveVideoJob: async () => undefined,
    supersedeStoryboardDrafts: async () => [],
    prepareStoryboardVideoDraft: async (request: { durationSeconds: number }) => {
      runtime.prepareCalls += 1;
      return {
        kind: "created" as const,
        draftId: "2571",
        modelId: "minimax/h3/reference-to-video",
        modelName: "MiniMax H3 Reference-to-Video",
        durationSeconds: request.durationSeconds,
        resolution: "2K",
        aspectRatio: "9:16",
        audio: true,
        estimatedCostUsd: 1.04,
        maxAllowedUsd: 50,
        pricingSource: "fal:minimax/h3/reference-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & { prepareCalls: number };
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
          action: "Twong walks",
          camera: "Static",
          characterNames: ["Twong"],
        },
        {
          startSeconds: 4,
          endSeconds: 8,
          kind: "action",
          framing: "Medium",
          action: "Twong kicks the bottle",
          camera: "Track",
          characterNames: ["Twong"],
        },
      ],
    }),
  }));
}

/**
 * The REAL visual service over in-memory I/O.
 *
 * Its readiness logic is the thing under test, so it is not stubbed; only the
 * three side effects it performs are — and `generate` counts its calls, which
 * is what proves no image provider is reached.
 */
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

/** Group A: a bound workspace, an active storyboard, no visuals yet. */
async function groupA() {
  const paid = paidRuntime();
  const visuals = visualService();
  const sent: string[] = [];
  const h = harness({
    paidDraftRuntime: paid,
    planner: planner(),
    modelSelection: mem<StoryboardModelSelectionState>(),
    visuals: visuals.service,
    publicAssetBaseUrl: "https://assets.example",
    sendVisualImage: async ({ originalContentUrl }) => void sent.push(originalContentUrl),
  });
  await h.dispatch(SCENE);
  await h.dispatch("8 วิ");
  const built = await h.dispatch("ไม่มี");
  expect(built.text).toContain("Storyboard v1");
  return { h, paid, sent, ...visuals };
}

describe("A. an active storyboard renders authoritative per-shot visuals", () => {
  it.each(ASK_VISUALS)("routes %s to per-shot generation, not to a phrase match", async (asked) => {
    const g = await groupA();

    const rendered = await g.h.dispatch(asked);

    expect(rendered.source).toBe("storyboard");
    const version = await g.h.latest();
    // Every beat has its own artifact, keyed by storyboard, version and shot.
    for (let shotIndex = 1; shotIndex <= version.document.beats.length; shotIndex += 1) {
      const artifact = await g.artifacts.lookup(
        storyboardVisualKey(version.storyboardId, version.versionNumber, shotIndex),
      );
      expect(artifact).toMatchObject({
        storyboardId: version.storyboardId,
        storyboardVersionNumber: version.versionNumber,
        shotIndex,
        accountId: version.accountId,
        ownerSenderId: version.ownerSenderId,
        conversationId: version.lineGroupId,
        generationPurpose: "storyboard-shot",
        status: "completed",
      });
      expect(artifact?.artifactId).toMatch(/^[a-f0-9]{36}$/u);
    }
    expect(g.sent).toHaveLength(version.document.beats.length);
  });

  it("offers a contact sheet only as a preview DERIVED from ready shots", async () => {
    const g = await groupA();
    const version = await g.h.latest();

    // Nothing rendered yet: there is no complete set to derive a sheet from.
    expect(deriveContactSheetPreview(await g.service.status({ version, claim: CLAIM }))).toBe(
      undefined,
    );

    await g.h.dispatch(ASK_VISUALS[0]);
    const ready = await g.service.status({ version: await g.h.latest(), claim: CLAIM });

    expect(ready.kind).toBe("ready");
    expect(deriveContactSheetPreview(ready)).toMatchObject({ kind: "derived_preview" });
  });
});

describe("A. continuing toward the video from the same storyboard", () => {
  it("renders the missing visuals instead of drafting, then reaches Final Video Draft", async () => {
    const g = await groupA();

    // "ทำต่อ" names nothing. Before visuals exist it must advance to the step
    // that is actually missing — never to a paid draft.
    const continued = await g.h.dispatch(ASK_CONTINUE);
    expect(continued.source).toBe("storyboard");
    expect(g.paid.prepareCalls).toBe(0);
    expect(await g.service.status({ version: await g.h.latest(), claim: CLAIM })).toMatchObject({
      kind: "ready",
    });

    // Only once the visuals exist may the storyboard be frozen, and only then
    // does a model get chosen and a code minted.
    const confirmed = await g.h.dispatch("ยืนยัน Storyboard");
    expect(confirmed.text).toContain("Default Model");
    const drafted = await g.h.dispatch("ใช้ Default");

    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).not.toContain("🎬 Video draft");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    // A draft is a quote, not a purchase: nothing was submitted for it.
    expect(g.paid.prepareCalls).toBe(1);
  });

  it("refuses to freeze a storyboard whose shots are not all rendered", async () => {
    const g = await groupA();

    const refused = await g.h.dispatch("ยืนยัน Storyboard");

    expect(refused.text).toContain("ยังไม่มีภาพครบ");
    expect(g.paid.prepareCalls).toBe(0);
  });
});

const CLAIM = {
  accountId: "acct-1",
  lineGroupId: "C1234567890abcdef",
  ownerSenderId: "U0987654321",
};

describe("visual readiness is per-shot artifacts and nothing else", () => {
  it("stays unready when a sheet-shaped row exists but the shots do not", async () => {
    const g = await groupA();
    const version = await g.h.latest();

    // A contact sheet, or any generic generated image, written into the same
    // namespace. It is not a shot, so it cannot make a version look ready —
    // which is exactly what a visible 5-panel image did in production.
    await g.artifacts.register(
      storyboardVisualKey(version.storyboardId, version.versionNumber, 1),
      {
        version: 1,
        artifactId: "0".repeat(36),
        storyboardId: version.storyboardId,
        storyboardVersionNumber: version.versionNumber,
        shotIndex: 1,
        beatId: "beat-1",
        accountId: version.accountId,
        ownerSenderId: version.ownerSenderId,
        conversationId: version.lineGroupId,
        sourceCharacterIds: [],
        sourceReferenceAssetIds: [],
        originalObjectKey: "sheet.png",
        previewObjectKey: "sheet-preview.png",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        byteSize: 10,
        generationProvider: "generic",
        generationModel: "generic",
        // The one field that decides it: a sheet is a review preview, not a shot.
        generationPurpose: "contact-sheet",
        status: "completed",
        createdAt: "2026-09-04T00:00:00.000Z",
      } as unknown as StoryboardVisualArtifact,
    );

    const status = await g.service.status({ version, claim: CLAIM });

    expect(status.kind).not.toBe("ready");
    expect(g.generate).not.toHaveBeenCalled();
  });
});

describe("B. a conversation with no workspace binding gets the same product", () => {
  it.each(ASK_VIDEO)(
    "claims %s for storyboard-first instead of the legacy draft",
    async (asked) => {
      const paid = paidRuntime();
      const h = harness({ binding: null, paidDraftRuntime: paid });

      const answered = await h.dispatch(asked);

      // Claimed HERE. Falling through is what reached "🎬 Video draft".
      expect(answered.source).toBe("storyboard");
      expect(answered.handled).toBe(true);
      expect(answered.text?.trim()).not.toBe("");
      expect(answered.text).not.toContain("Video draft");
      expect(paid.prepareCalls).toBe(0);
    },
  );

  it("names the capability it needs rather than silently doing nothing", async () => {
    const h = harness({ binding: null });

    const answered = await h.dispatch(ASK_VIDEO[0]);

    expect(answered.text).toContain("UGC");
  });

  it("asks who is in the scene when the workspace IS bound", async () => {
    const h = harness({ paidDraftRuntime: paidRuntime() });

    const answered = await h.dispatch(ASK_VIDEO[0]);

    expect(answered.source).toBe("storyboard");
    expect(answered.text).toContain("Storyboard");
  });
});

describe("group isolation with one routing policy", () => {
  it("keeps state separate while both conversations route identically", async () => {
    const bound = harness({ paidDraftRuntime: paidRuntime() });
    const unbound = harness({ binding: null, paidDraftRuntime: paidRuntime() });

    // Same request, same product decision, whatever the workspace policy says.
    expect((await bound.dispatch(ASK_VIDEO[0])).source).toBe("storyboard");
    expect((await unbound.dispatch(ASK_VIDEO[0])).source).toBe("storyboard");

    // Separate state, though: a storyboard built in one conversation is not
    // visible from the other, so neither can answer for the other's work.
    const built = await groupA();
    expect((await built.h.latest()).storyboardId).toBeTruthy();
    await expect(bound.latest()).rejects.toThrow();
    await expect(unbound.latest()).rejects.toThrow();
  });
});

describe("the paid guarantees this must not weaken", () => {
  it("keeps every natural step free of a paid submission", async () => {
    const g = await groupA();

    for (const message of [ASK_VISUALS[0], ASK_CONTINUE, "โอเค ทำต่อ", "เอาอันนี้"]) {
      await g.h.dispatch(message);
    }

    // Rendering, continuing and agreeing are all free. Only the exact typed
    // code reaches generation, and nothing here is that code.
    expect(g.paid.prepareCalls).toBe(0);
    expect(g.generate).toHaveBeenCalled();
  });
});
