/**
 * The owner-selected first frame, end to end.
 *
 * A storyboard could claim `image_to_video` from `document.sourceImage` while
 * the paid seam carried only Character references — so the mode a draft
 * displayed and the inputs a provider received could disagree, and the image
 * the owner chose reached nothing at all. These assert the one fact that fixes
 * it: the frozen handle travels, and every consumer resolves THAT handle.
 *
 * The handle is opaque on purpose. It crosses a plugin boundary and is
 * persisted on both sides, so a signed URL would expire and would put an asset
 * locator into durable storyboard state.
 *
 * Nothing here reaches a provider: the paid runtime is a local stub with
 * counters, the planner answers from a table, and the visual service's
 * generator returns bytes from memory.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import { DIRECTOR_QUESTION } from "./storyboard-director.js";
import type { StoryboardPaidDraftRequest } from "./storyboard-paid-draft-runtime.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness } from "./storyboard-router.test-support.js";
import { resolveStoryboardInputMode } from "./storyboard-types.js";
import { StoryboardVisualService, type StoryboardVisualArtifact } from "./storyboard-visual.js";
import type { AsyncKeyedStore, UgcReferenceAsset } from "./types.js";

const ASK_VIDEO = "ช่วยทำวิดีโอให้หน่อย";
const PICK_TEXT_ONLY = "1";
const PICK_SOURCE_IMAGE = "2";
/** The durable handle the media store hands out. Opaque to everything here. */
const MEDIA_ID = "durable-media-key-abc123";

function mem<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    lookup: async (key) => rows.get(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/** Records exactly what the paid seam was handed. Calls nothing. */
function paidRuntime(options: { rejectSourceImage?: boolean } = {}) {
  const runtime = {
    prepareCalls: 0,
    requests: [] as StoryboardPaidDraftRequest[],
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "bytedance/seedance-2.5/image-to-video",
        displayName: "Seedance 2.5",
        familyId: "bytedance",
        familyDisplayName: "ByteDance",
      },
      estimatedCostUsd: 0.9,
    }),
    listCompatibleVideoModels: async () => [],
    readActiveVideoJob: async () => undefined,
    supersedeStoryboardDrafts: async () => [],
    prepareStoryboardVideoDraft: async (request: StoryboardPaidDraftRequest) => {
      runtime.prepareCalls += 1;
      runtime.requests.push(request);
      // Stands where the LINE allocator resolves the handle. A handle it cannot
      // resolve refuses the draft, so no code is minted for a quote whose image
      // will not be there at submission.
      if (options.rejectSourceImage && request.sourceImage) {
        return { kind: "rejected" as const, reason: "source_image_unavailable" };
      }
      return {
        kind: "created" as const,
        draftId: "4821",
        modelId: "bytedance/seedance-2.5/image-to-video",
        modelName: "Seedance 2.5",
        durationSeconds: request.durationSeconds,
        resolution: "1080p",
        aspectRatio: "9:16",
        audio: false,
        estimatedCostUsd: 0.9,
        maxAllowedUsd: 50,
        pricingSource: "fal:bytedance/seedance-2.5/image-to-video",
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & {
    prepareCalls: number;
    requests: StoryboardPaidDraftRequest[];
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

/** The REAL visual service; only its three side effects are in memory. */
function visualService() {
  const artifacts = mem<StoryboardVisualArtifact>();
  const calls: {
    shotIndex: number;
    identityReferences: readonly UgcReferenceAsset[];
    sourceImageMediaId?: string;
  }[] = [];
  const generate = vi.fn(
    async (params: {
      shotIndex: number;
      identityReferences: readonly UgcReferenceAsset[];
      sourceImage?: { mediaId: string };
    }) => {
      calls.push({
        shotIndex: params.shotIndex,
        identityReferences: params.identityReferences,
        ...(params.sourceImage ? { sourceImageMediaId: params.sourceImage.mediaId } : {}),
      });
      return {
        bytes: Buffer.from(`shot-${params.shotIndex}`),
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        provider: "test-image-provider",
        model: "test-image-model",
      };
    },
  );
  const service = new StoryboardVisualService({
    artifacts,
    now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    generate: generate as never,
    normalize: async ({ bytes }) => ({
      bytes,
      mimeType: "image/png" as const,
      width: 1024,
      height: 1024,
    }),
    persist: async () => {},
  });
  return { artifacts, calls, generate, service };
}

function unbound(
  options: {
    selection?: "selected" | "none" | "ambiguous";
    rejectSourceImage?: boolean;
    /** Answers `selected` only once the flow has asked which image to use. */
    resolvesAfterAsk?: boolean;
  } = {},
) {
  const paid = paidRuntime(options.rejectSourceImage ? { rejectSourceImage: true } : {});
  const visuals = visualService();
  const askedAtSeen: (string | undefined)[] = [];
  const h = harness({
    binding: null,
    paidDraftRuntime: paid,
    planner: planner(),
    modelSelection: mem<StoryboardModelSelectionState>(),
    visuals: visuals.service,
    publicAssetBaseUrl: "https://assets.example",
    sendVisualImage: async () => {},
    resolveSelectedSourceImage: async (_claim, askedAt) => {
      askedAtSeen.push(askedAt);
      if (options.resolvesAfterAsk) {
        // Stands for the production rule: an image that arrived after the
        // question IS the answer, whatever it displaced.
        return askedAt
          ? { kind: "selected" as const, mediaId: MEDIA_ID }
          : { kind: "ambiguous" as const };
      }
      if (options.selection === "none") {
        return { kind: "none" as const };
      }
      return options.selection === "ambiguous"
        ? { kind: "ambiguous" as const }
        : { kind: "selected" as const, mediaId: MEDIA_ID };
    },
  });
  return { h, paid, askedAtSeen, ...visuals };
}

/** Drives an unbound owner from the request to a built storyboard. */
async function buildStoryboard(g: ReturnType<typeof unbound>, mediaAnswer: string) {
  expect((await g.h.dispatch(ASK_VIDEO)).text).toBe(DIRECTOR_QUESTION.media);
  await g.h.dispatch(mediaAnswer);
  await g.h.dispatch("8 วิ");
  const built = await g.h.dispatch("ไม่มี");
  expect(built.text).toContain("Storyboard v1");
}

describe("the selected first frame reaches every consumer", () => {
  it("freezes the handle the owner's selection resolved to", async () => {
    const g = unbound();

    await buildStoryboard(g, PICK_SOURCE_IMAGE);

    const version = await g.h.latest();
    expect(version.document.sourceImage).toEqual({
      kind: "owner_selected",
      mediaId: MEDIA_ID,
      selectedAt: expect.any(String),
    });
    expect(resolveStoryboardInputMode(version)).toBe("image_to_video");
  });

  it("hands the visual service that exact image, separately from identities", async () => {
    const g = unbound();
    await buildStoryboard(g, PICK_SOURCE_IMAGE);

    await g.h.dispatch("ทำภาพแต่ละช็อต");

    const version = await g.h.latest();
    expect(g.calls).toHaveLength(version.document.beats.length);
    for (const call of g.calls) {
      expect(call.sourceImageMediaId).toBe(MEDIA_ID);
      // A first frame is NOT a Character identity, and must never arrive as one.
      expect(call.identityReferences).toEqual([]);
    }
    // The artifact records it distinctly too, so a later reader can still tell
    // a first frame from a Character reference.
    const artifacts = await g.artifacts.entries();
    for (const { value } of artifacts) {
      expect(value.sourceImageMediaId).toBe(MEDIA_ID);
      expect(value.sourceReferenceAssetIds).toEqual([]);
    }
  });

  it("carries the same handle across the paid seam, as image_to_video", async () => {
    const g = unbound();
    await buildStoryboard(g, PICK_SOURCE_IMAGE);
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    await g.h.dispatch("ยืนยัน Storyboard");

    const drafted = await g.h.dispatch("ใช้ Default");

    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    const request = g.paid.requests.at(-1)!;
    // One fact, not two: the mode and the image come from the same frozen input.
    expect(request.inputMode).toBe("image_to_video");
    expect(request.sourceImage).toEqual({ kind: "owner_selected", mediaId: MEDIA_ID });
    expect(request.referenceAssets).toEqual([]);
  });
});

describe("image mode fails closed when the image cannot be honoured", () => {
  it("mints no VIDEO code when the paid side cannot resolve the handle", async () => {
    // Stands for the LINE allocator refusing: the frozen handle no longer
    // resolves to media. Quoting image mode without the image would submit a
    // text-only request against an image quote.
    const g = unbound({ rejectSourceImage: true });
    await buildStoryboard(g, PICK_SOURCE_IMAGE);
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    await g.h.dispatch("ยืนยัน Storyboard");

    const drafted = await g.h.dispatch("ใช้ Default");

    expect(drafted.text).not.toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(g.paid.requests.at(-1)?.sourceImage).toEqual({
      kind: "owner_selected",
      mediaId: MEDIA_ID,
    });
  });

  it("asks rather than guessing when no selection can be proven", async () => {
    const g = unbound({ selection: "none" });
    await g.h.dispatch(ASK_VIDEO);

    const asked = await g.h.dispatch(PICK_SOURCE_IMAGE);

    expect(asked.text).toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");
    const version = await g.h.latest().catch(() => undefined);
    expect(version).toBeUndefined();
  });
});

describe("the other two modes are unchanged", () => {
  it("text_to_video carries no source image anywhere", async () => {
    const g = unbound();

    await buildStoryboard(g, PICK_TEXT_ONLY);
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    await g.h.dispatch("ยืนยัน Storyboard");
    await g.h.dispatch("ใช้ Default");

    const version = await g.h.latest();
    expect(version.document.sourceImage).toBeUndefined();
    expect(resolveStoryboardInputMode(version)).toBe("text_to_video");
    for (const call of g.calls) {
      expect(call.sourceImageMediaId).toBeUndefined();
      expect(call.identityReferences).toEqual([]);
    }
    const request = g.paid.requests.at(-1)!;
    expect(request.inputMode).toBe("text_to_video");
    expect(request.sourceImage).toBeUndefined();
  });

  it("reference_to_video still runs on Character Library references", async () => {
    const paid = paidRuntime();
    const visuals = visualService();
    const h = harness({
      paidDraftRuntime: paid,
      planner: planner(),
      modelSelection: mem<StoryboardModelSelectionState>(),
      visuals: visuals.service,
      publicAssetBaseUrl: "https://assets.example",
      sendVisualImage: async () => {},
    });
    await h.dispatch("เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ");
    await h.dispatch("8 วิ");
    await h.dispatch("ไม่มี");
    await h.dispatch("ทำภาพแต่ละช็อต");
    await h.dispatch("ยืนยัน Storyboard");
    await h.dispatch("ใช้ Default");

    const version = await h.latest();
    expect(resolveStoryboardInputMode(version)).toBe("reference_to_video");
    expect(version.document.sourceImage).toBeUndefined();
    // Identities arrive as identities, and no first frame is invented for them.
    for (const call of visuals.calls) {
      expect(call.identityReferences.length).toBeGreaterThan(0);
      expect(call.sourceImageMediaId).toBeUndefined();
    }
    const request = paid.requests.at(-1)!;
    expect(request.inputMode).toBe("reference_to_video");
    expect(request.sourceImage).toBeUndefined();
    expect(request.referenceAssets.length).toBeGreaterThan(0);
  });
});

describe("a contact sheet is never a video source", () => {
  it("keeps rendered shots out of the paid request's inputs", async () => {
    const g = unbound();
    await buildStoryboard(g, PICK_TEXT_ONLY);
    await g.h.dispatch("ทำภาพแต่ละช็อต");
    await g.h.dispatch("ยืนยัน Storyboard");
    await g.h.dispatch("ใช้ Default");

    // Shots exist and a preview could be derived from them, but nothing about
    // that review artifact reaches the provider request.
    expect((await g.artifacts.entries()).length).toBeGreaterThan(0);
    const request = g.paid.requests.at(-1)!;
    expect(request.referenceAssets).toEqual([]);
    expect(request.sourceImage).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("contact");
  });
});

describe("two candidate images are a question, not a guess", () => {
  it("asks which one rather than taking the newer", async () => {
    const g = unbound({ selection: "ambiguous" });
    await g.h.dispatch(ASK_VIDEO);

    const asked = await g.h.dispatch(PICK_SOURCE_IMAGE);

    expect(asked.text).toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");
    // Nothing was frozen from a selection the flow could not prove.
    await expect(g.h.latest()).rejects.toThrow();
  });

  it("accepts the image the owner sends after being asked", async () => {
    // The anchor is what makes a re-send unambiguous: without it every replay
    // would displace a recent image again and the owner could never proceed.
    const g = unbound({ resolvesAfterAsk: true });
    await g.h.dispatch(ASK_VIDEO);
    expect((await g.h.dispatch(PICK_SOURCE_IMAGE)).text).toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");

    const retried = await g.h.dispatch(PICK_SOURCE_IMAGE);

    expect(retried.text).toBe(DIRECTOR_QUESTION.duration);
    // First call had no anchor, the second carried the recorded question time.
    expect(g.askedAtSeen[0]).toBeUndefined();
    expect(g.askedAtSeen[1]).toEqual(expect.any(String));
    await g.h.dispatch("8 วิ");
    await g.h.dispatch("ไม่มี");
    expect((await g.h.latest()).document.sourceImage).toMatchObject({ mediaId: MEDIA_ID });
  });
});
