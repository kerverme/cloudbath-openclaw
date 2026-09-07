import { describe, expect, it, vi } from "vitest";
import { conversationContextKey, emptyConversationContext } from "./conversation-context.js";
import {
  nextDirectorSlot,
  openDirectorSession,
  storyboardDirectorKey,
} from "./storyboard-director.js";
import { parseStoryboardIntent } from "./storyboard-intent.js";
import { harness, resolver } from "./storyboard-router.test-support.js";
import { activeStoryboardKey } from "./storyboard-store.js";
import type { StoryboardDocument } from "./storyboard-types.js";
import {
  StoryboardVisualService,
  storyboardVisualKey,
  type StoryboardVisualArtifact,
  type StoryboardVisualServiceDeps,
} from "./storyboard-visual.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const REQUESTS = [
  "ทำรูป storyboard ออกมา",
  "สร้างภาพ storyboard",
  "ทำ storyboard เป็นภาพให้ดู",
  "ทำภาพแต่ละฉาก",
  "สร้างภาพแต่ละฉาก",
  "ทำภาพแต่ละช็อต",
  "เอาภาพ storyboard ออกมา",
  "render the storyboard as images",
  "generate the storyboard with one image per shot",
  "สร้างภาพ storyboard ด้วยรูปแบบ 16:9",
  "from this storyboard make images for every shot",
  "สร้าง storyboard ด้วยภาพทุกช็อต",
  "render the storyboard using one image for every shot",
  "render the storyboard using my image format",
  "render the storyboard using the previous image style",
  "render the storyboard using my image's style",
  "render the storyboard using my image’s layout",
  "render the storyboard using my image-format settings",
  "render the storyboard using my image's aspect ratio",
  "render the storyboard using my image file format",
];
const NOW = "2026-09-07T00:00:00.000Z";

function memory<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    lookup: async (key) => rows.get(key),
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, value);
      return true;
    },
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

async function setup(
  options: { locks?: readonly UgcCharacterLock[]; contactSheet?: boolean } = {},
) {
  const artifacts = memory<StoryboardVisualArtifact>();
  const media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const generate = vi.fn<StoryboardVisualServiceDeps["generate"]>(async ({ shotIndex }) => ({
    bytes: Buffer.from(`shot-${shotIndex}`),
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    provider: "test",
    model: "test",
  }));
  const visuals = new StoryboardVisualService({
    artifacts,
    generate,
    now: () => Date.parse(NOW),
    normalize: async ({ bytes }) => ({ bytes, mimeType: "image/png", width: 1024, height: 1024 }),
    persist: async ({ objectKey, bytes, contentType }) => {
      media.set(objectKey, { bytes, mimeType: contentType });
    },
    ...(options.contactSheet === false
      ? {}
      : { read: async ({ objectKey }: { objectKey: string }) => media.get(objectKey)! }),
  });
  const prepareStoryboardVideoDraft = vi.fn(async () => ({
    kind: "rejected" as const,
    reason: "unexpected paid call",
  }));
  const offerDefaultVideoModel = vi.fn(async () => ({ kind: "none_compatible" as const }));
  const listCharacterNames = vi.fn(async () => {
    throw new Error("Character Library unavailable");
  });
  const resolveProject = vi.fn(async () => {
    throw new Error("Character Library must not be required");
  });
  const resolveSelectedSourceImage = vi.fn(async () => ({ kind: "none" as const }));
  const characterHandler = vi.fn(async () => undefined);
  const sendVisualImage = vi.fn(async () => {});
  const h = harness({
    binding: null,
    resolver: resolver({ listCharacterNames, resolveProject }),
    paidDraftRuntime: { prepareStoryboardVideoDraft, offerDefaultVideoModel },
    visuals,
    sendVisualImage,
    resolveSelectedSourceImage,
    characterHandler,
    publicAssetBaseUrl: "https://assets.example",
  });
  const document: StoryboardDocument = {
    version: 1,
    scenePrompt: "A swordsman and an electric creature explore a crystal forest",
    durationSeconds: 35,
    aspectRatio: "16:9",
    resolution: "1080p",
    environment: "crystal forest",
    audio: "off",
    cast: [],
    beats: Array.from({ length: 7 }, (_, index) => ({
      beatId: `beat-${index + 1}`,
      startSeconds: index * 5,
      endSeconds: (index + 1) * 5,
      kind: "action" as const,
      framing: "wide",
      action: `Scene ${index + 1}: the swordsman follows the electric creature`,
      camera: "track",
      characterIds: [],
    })),
  };
  const { version: first } = await h.store.createStoryboard({
    document,
    claim: h.claim,
    characterLocks: options.locks ?? [],
  });
  const latest = await h.store.appendRevision({
    storyboardId: first.storyboardId,
    claim: h.claim,
    revision: { kind: "environment", environment: "moonlit crystal forest" },
  });
  await h.active.register(activeStoryboardKey(h.claim), {
    version: 1,
    ...h.claim,
    storyboardId: latest.storyboardId,
    updatedAt: NOW,
  });
  return {
    h,
    latest,
    artifacts,
    generate,
    prepareStoryboardVideoDraft,
    offerDefaultVideoModel,
    listCharacterNames,
    resolveProject,
    resolveSelectedSourceImage,
    characterHandler,
    sendVisualImage,
  };
}

describe("visual storyboard intent owns the LINE turn", () => {
  it.each(REQUESTS)("classifies %s as visual output", (content) => {
    expect(parseStoryboardIntent({ content, knownCharacterNames: [] })).toEqual({
      kind: "generate_visuals",
    });
  });

  it.each(REQUESTS)(
    "renders all seven latest scenes for %s with no conversation cache",
    async (content) => {
      const g = await setup();
      const result = await g.h.dispatch(content);
      expect(result.conversation).toMatchObject({
        kind: "route",
        route: {
          kind: "generate_storyboard_visuals",
          referent: { storyboardVersionNumber: 2 },
        },
      });
      expect(result.source).toBe("storyboard");
      expect(result.text).toContain("Visual Storyboard v2 พร้อมแล้ว (7 ช็อต)");
      expect(result.text).not.toMatch(
        /เฟรมแรก|first.frame|ยืนยัน.*วิดีโอ|VIDEO\s*\d{4}|Character Library/iu,
      );
      expect(g.generate).toHaveBeenCalledTimes(7);
      expect(
        g.generate.mock.calls.map(([call]) => call.shotIndex).toSorted((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      for (const [call] of g.generate.mock.calls) {
        expect(call.version).toEqual(g.latest);
        expect(call.identityReferences).toEqual([]);
        expect(call.sourceImage).toBeUndefined();
        expect(
          await g.artifacts.lookup(storyboardVisualKey(g.latest.storyboardId, 2, call.shotIndex)),
        ).toMatchObject({
          generationPurpose: "storyboard-shot",
          storyboardVersionNumber: 2,
          shotIndex: call.shotIndex,
        });
      }
      expect(g.sendVisualImage).toHaveBeenCalledTimes(1);
      expect(await g.h.drafts.entries()).toEqual([]);
      expect(await g.h.director.entries()).toEqual([]);
      expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
      expect(g.offerDefaultVideoModel).not.toHaveBeenCalled();
      expect(g.resolveProject).not.toHaveBeenCalled();
      expect(g.resolveSelectedSourceImage).not.toHaveBeenCalled();
      expect(g.characterHandler).not.toHaveBeenCalled();
      expect(g.listCharacterNames).not.toHaveBeenCalled();
    },
  );

  it.each(["media", "scene"] as const)(
    "outranks an open %s director slot even without arbitration",
    async (slot) => {
      const g = await setup();
      const session = {
        ...openDirectorSession({
          claim: g.h.claim,
          scenePrompt: "make video",
          characterNames: [],
          environment: "",
          updatedAt: NOW,
        }),
        mediaRequired: true as const,
        sceneRequired: true as const,
        ...(slot === "scene" ? { media: { kind: "none" as const } } : {}),
      };
      expect(nextDirectorSlot(session)).toBe(slot);
      await g.h.director.register(storyboardDirectorKey(g.h.claim), session);
      const result = await g.h.storyboardRouter.handleBeforeDispatch(
        { content: REQUESTS[0]!, senderId: g.h.claim.ownerSenderId, senderIsOwner: true },
        {
          channelId: "line",
          accountId: g.h.claim.accountId,
          conversationId: g.h.claim.lineGroupId,
        },
      );
      expect(result?.text).toContain("Visual Storyboard v2 พร้อมแล้ว (7 ช็อต)");
      expect(g.generate).toHaveBeenCalledTimes(7);
      expect(await g.h.director.lookup(storyboardDirectorKey(g.h.claim))).toMatchObject({
        closed: true,
      });
      expect(await g.h.drafts.entries()).toEqual([]);
      expect(g.resolveSelectedSourceImage).not.toHaveBeenCalled();
      expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
    },
  );

  it("uses the active pointer instead of a stale conversation storyboard and model question", async () => {
    const g = await setup();
    await g.h.conversationContext.register(conversationContextKey(g.h.claim), {
      ...emptyConversationContext(g.h.claim, NOW),
      activeStoryboardId: "stale-storyboard",
      question: {
        id: "model_default",
        stance: "asked",
        proposition: "change",
        prompt: "Change model?",
        nonce: "nonce0001",
        askedAt: NOW,
        subject: { kind: "storyboard", id: "stale-storyboard", version: 1 },
        choices: [{ token: "yes", label: "Yes", role: "affirm", canonicalText: "ใช้ Default" }],
      },
    });
    const result = await g.h.dispatch("เอาภาพ storyboard ออกมา");
    expect(result.conversation).toMatchObject({
      kind: "route",
      route: {
        kind: "generate_storyboard_visuals",
        referent: { storyboardId: g.latest.storyboardId },
      },
    });
    expect(g.generate).toHaveBeenCalledTimes(7);
    expect(g.offerDefaultVideoModel).not.toHaveBeenCalled();
  });

  it("retains frozen identities and sends all shots when contact sheets are unavailable", async () => {
    const locks: readonly UgcCharacterLock[] = [
      {
        code: "CHAR-6",
        pageId: "character-page",
        frozenAt: NOW,
        identityReferences: [{ kind: "identity", source: "r2", locator: "characters/frozen.png" }],
        styleReferences: [],
      },
    ];
    const g = await setup({ locks, contactSheet: false });
    const result = await g.h.dispatch(REQUESTS[0]!);
    expect(result.text).toContain("พร้อมแล้ว (7 ช็อต)");
    expect(g.sendVisualImage).toHaveBeenCalledTimes(7);
    for (const [call] of g.generate.mock.calls) {
      expect(call.version.characterLocks).toEqual(locks);
      expect(call.identityReferences).toEqual(locks[0]!.identityReferences);
    }
    expect(g.resolveProject).not.toHaveBeenCalled();
  });

  it("keeps a video request using a storyboard image on the video continuation route", async () => {
    const g = await setup();
    const result = await g.h.dispatch("สร้างวิดีโอจากภาพ storyboard นี้");
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("Visual Storyboard v2 พร้อมแล้ว (7 ช็อต)");
    expect(result.text).not.toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");
    expect(g.resolveSelectedSourceImage).not.toHaveBeenCalled();
    expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
  });

  it.each([
    "เอารูปนี้ทำ storyboard",
    "ทำ storyboard โดยใช้ภาพนี้",
    "use this image to make a storyboard",
    "create a storyboard using my image",
    "make a storyboard from attached photos",
    "turn photos into a storyboard",
    "ทำ storyboard ด้วยภาพนี้",
    "create a storyboard using uploaded images",
    "make a storyboard with this image",
    "create a storyboard with uploaded photos",
    "ทำ storyboard โดยใช้ภาพที่ฉันส่งมา",
    "ทำ storyboard โดยใช้ภาพที่ผมแนบไว้",
    "make this image a storyboard",
    "make these images a new storyboard",
    "convert this image into a seven-shot storyboard",
  ])("routes explicit image input ahead of the active storyboard visuals: %s", async (content) => {
    const g = await setup();
    const result = await g.h.dispatch(content);
    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("ยังไม่แน่ใจว่าจะใช้ภาพไหน");
    expect(g.resolveSelectedSourceImage).toHaveBeenCalled();
    expect(g.generate).not.toHaveBeenCalled();
    expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
  });

  it.each(["ทำ storyboard จากภาพนี้", "ทำภาพนี้เป็น storyboard", "convert this image to storyboard"])(
    "preserves explicit image input: %s",
    (content) => {
      expect(parseStoryboardIntent({ content, knownCharacterNames: [] })?.kind).toBe(
        "source_storyboard",
      );
    },
  );
  it.each(["ไม่เอาภาพ storyboard", "ยืนยัน VIDEO 1234", "สร้างวิดีโอจากภาพนี้", "สร้าง previs จากภาพนี้"])(
    "does not turn another intent into visuals: %s",
    (content) => {
      expect(parseStoryboardIntent({ content, knownCharacterNames: [] })?.kind).not.toBe(
        "generate_visuals",
      );
    },
  );
});
