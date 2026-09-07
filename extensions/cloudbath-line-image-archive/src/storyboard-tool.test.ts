import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import { openDirectorSession, storyboardDirectorKey } from "./storyboard-director.js";
import type { StoryboardPlannerComplete } from "./storyboard-planner.js";
import {
  CREATE_MESSAGE,
  harness,
  resolver,
  SESSION_KEY,
} from "./storyboard-router.test-support.js";
import { createStoryboardTool } from "./storyboard-tool.js";
import {
  StoryboardVisualService,
  type StoryboardVisualArtifact,
  type StoryboardVisualServiceDeps,
} from "./storyboard-visual.js";
import type { AsyncKeyedStore } from "./types.js";

function memory<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    lookup: async (key) => rows.get(key),
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function setup() {
  const generate = vi.fn<StoryboardVisualServiceDeps["generate"]>(async ({ shotIndex }) => ({
    bytes: Buffer.from(`panel-${shotIndex}`),
    mimeType: "image/png",
    width: 512,
    height: 320,
    provider: "fixture",
    model: "fixture",
  }));
  const artifacts = memory<StoryboardVisualArtifact>();
  const media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const normalize = vi.fn<StoryboardVisualServiceDeps["normalize"]>(async ({ bytes }) => ({
    bytes,
    mimeType: "image/jpeg",
    width: 1024,
    height: 1664,
  }));
  const visuals = new StoryboardVisualService({
    artifacts,
    generate,
    normalize,
    now: () => 1,
    persist: async ({ objectKey, bytes, contentType }) => {
      media.set(objectKey, { bytes, mimeType: contentType });
    },
    read: async ({ objectKey }) => media.get(objectKey)!,
  });
  const complete = vi.fn<StoryboardPlannerComplete>(async () => ({
    text: JSON.stringify({
      intent: "storyboard_request",
      referentType: "none",
      confidence: 0.99,
      needsClarification: false,
    }),
  }));
  const prepareStoryboardVideoDraft = vi.fn(async () => ({
    kind: "rejected" as const,
    reason: "unexpected video",
  }));
  const resolveProject = vi.fn(async () => {
    throw new Error("No library for text-only story");
  });
  const listCharacterNames = vi.fn(async () => []);
  const sendVisualImage = vi.fn(async () => {});
  const persistVisualReference = vi.fn(async ({ role }: { role: "identity" | "style" }) => ({
    role,
    objectKey: `ref/${role}`,
  }));
  const h = harness({
    binding: null,
    visuals,
    sendVisualImage,
    persistVisualReference,
    publicAssetBaseUrl: "https://assets.example",
    resolver: resolver({ resolveProject, listCharacterNames }),
    semanticResolver: createConversationSemanticResolver(complete),
    paidDraftRuntime: { prepareStoryboardVideoDraft },
    transcript: {
      readRecentTurns: async () => [
        { role: "assistant", text: "สร้างภาพนักดาบ Ragnarok ต่อสู้กับปิกาจูให้แล้วครับ" },
      ],
    },
  });
  const context: OpenClawPluginToolContext = {
    messageChannel: "line",
    agentAccountId: h.claim.accountId,
    requesterSenderId: h.claim.ownerSenderId,
    senderIsOwner: true,
    nativeChannelId: h.claim.lineGroupId,
    sessionKey: SESSION_KEY,
  };
  const tool = createStoryboardTool(context, h.storyboardRouter, h.conversationRouter)!;
  return {
    h,
    tool,
    context,
    generate,
    normalize,
    complete,
    artifacts,
    sendVisualImage,
    resolveProject,
    listCharacterNames,
    prepareStoryboardVideoDraft,
    persistVisualReference,
  };
}

const panels = [
  "นักดาบเดินเข้าป่าคริสตัล",
  "ปิกาจูปรากฏบนก้อนหิน",
  "ทั้งคู่เผชิญหน้ากัน",
  "ปิกาจูปล่อยสายฟ้า",
  "นักดาบใช้ดาบป้องกัน",
  "ทั้งคู่หยุดและหัวเราะ",
  "เดินออกจากป่าด้วยกัน",
].map((action) => ({ action, framing: "Wide", caption: action, characterIds: [] }));

describe("LLM storyboard tool handoff", () => {
  it.each([
    "ทีนี้ทำ storyboard ให้หน่อย",
    "ทำรูป storyboard ออกมา",
    "ทำ storyboard เป็นภาพให้ดู",
    "สร้างภาพแต่ละฉาก",
    "ทำภาพแต่ละช็อต",
    "เอาภาพ storyboard ออกมา",
    "เล่าเรื่องต่อจากภาพนี้เป็นช่อง ๆ เหมือนรูปตัวอย่าง",
    "Turn our idea into a comic page",
  ])("lets the semantic result own %s before any video handler", async (message) => {
    const g = setup();
    await g.h.director.register(
      storyboardDirectorKey(g.h.claim),
      openDirectorSession({
        claim: g.h.claim,
        scenePrompt: "old video",
        characterNames: [],
        environment: "",
        updatedAt: "2026-08-30T10:00:00.000Z",
      }),
    );
    expect(await g.h.dispatch(message)).toMatchObject({
      source: "model",
      handled: false,
      conversation: { kind: "agent" },
    });
    expect(g.complete).toHaveBeenCalledOnce();
    const prompt = JSON.parse(g.complete.mock.calls[0]![0].messages[0]!.content);
    expect(prompt.message).toBe(message);
    expect(
      prompt.recentTurns.some((turn: { text: string }) => turn.text.includes("Ragnarok")),
    ).toBe(true);
    expect(g.listCharacterNames).not.toHaveBeenCalled();
    expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
    expect(g.h.previsEngineCalls).not.toHaveBeenCalled();
    expect(await g.h.drafts.entries()).toEqual([]);
  });

  it("authors a chat-only story and renders all seven latest panels with identity/style references", async () => {
    const g = setup();
    expect((await g.tool.execute("read", { action: "read" })).details).toMatchObject({
      status: "no_saved_storyboard",
    });
    await g.tool.execute("save", {
      action: "save",
      brief: "นักดาบกับปิกาจูในป่าคริสตัล",
      panels,
      columns: 2,
      references: [
        { image: "media://generated-swordsman", role: "identity" },
        { image: "media://comic-layout", role: "style" },
      ],
    });
    const revised = panels.map((panel, index) =>
      index === 6 ? { ...panel, action: "เดินกลับบ้านด้วยกันตอนกลางคืน" } : panel,
    );
    await g.tool.execute("revise", {
      action: "save",
      baseVersionNumber: 1,
      brief: "เรื่องเดิม จบตอนกลางคืน",
      panels: revised,
    });
    const latest = await g.h.latest();
    expect(latest.versionNumber).toBe(2);
    expect(latest.document.visualPresentation).toEqual({
      columns: 2,
      references: [
        { role: "identity", objectKey: "ref/identity" },
        { role: "style", objectKey: "ref/style" },
      ],
    });
    expect(latest.document.sourceImage).toBeUndefined();
    expect(latest.characterLocks).toEqual([]);
    const result = await g.tool.execute("render", { action: "render" });
    expect(result.details).toMatchObject({ text: expect.stringContaining("7 ช็อต") });
    expect(JSON.stringify(result)).not.toMatch(
      /เฟรมแรก|ยืนยัน.*วิดีโอ|VIDEO\s*\d{4}|Character Library/iu,
    );
    expect(g.generate).toHaveBeenCalledTimes(7);
    for (const [call] of g.generate.mock.calls) {
      expect(call.version).toEqual(latest);
      expect(call.identityReferences).toEqual([]);
      expect(call.sourceImage).toBeUndefined();
    }
    const sheet = (await g.artifacts.entries())
      .map((row) => row.value)
      .find((row) => row.generationPurpose === "storyboard-contact-sheet");
    expect(sheet).toMatchObject({
      panels: revised.map((panel, index) => ({ shotIndex: index + 1, caption: panel.caption })),
    });
    const svg = g.normalize.mock.calls.find(([call]) => call.mimeType === "image/svg+xml")![0]
      .bytes;
    expect(Buffer.from(svg).toString()).toContain('width="1024" height="1664"');
    expect(g.sendVisualImage).toHaveBeenCalledOnce();
    await g.tool.execute("render-again", { action: "render" });
    expect(g.generate).toHaveBeenCalledTimes(7);
    await g.tool.execute("layout", {
      action: "save",
      baseVersionNumber: 2,
      brief: "เรื่องเดิม จบตอนกลางคืน",
      panels: revised,
      columns: 3,
    });
    await g.tool.execute("render-layout", { action: "render" });
    expect(g.generate).toHaveBeenCalledTimes(7);
    expect((await g.h.latest()).document.visualPresentation?.columns).toBe(3);
    expect((await g.h.conversationContext.entries())[0]?.value).toMatchObject({
      activeStoryboardId: latest.storyboardId,
      activeStoryboardVersion: 3,
    });
    expect(
      g.normalize.mock.calls.some(
        ([call]) =>
          call.mimeType === "image/svg+xml" &&
          Buffer.from(call.bytes).toString().includes('width="1536" height="1248"'),
      ),
    ).toBe(true);
    expect(g.resolveProject).not.toHaveBeenCalled();
    expect(g.prepareStoryboardVideoDraft).not.toHaveBeenCalled();
    expect(await g.h.drafts.entries()).toEqual([]);
  });

  it("does not repeat an inconclusive semantic classification in the same turn", async () => {
    const resolve = vi.fn(async () => undefined);
    const h = harness({ semanticResolver: { resolve } });
    await h.dispatch(CREATE_MESSAGE);
    resolve.mockClear();
    await h.dispatch("ไม่เอาแบบนี้");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("keeps the selected duration when adding more panels than seconds", async () => {
    const g = setup();
    await g.tool.execute("save", { action: "save", brief: "A story", panels });
    await g.tool.execute("expand", {
      action: "save",
      baseVersionNumber: 1,
      brief: "Expanded story",
      panels: Array.from({ length: 20 }, (_, index) => ({
        action: `Action ${index + 1}`,
        framing: "Wide",
        caption: "",
        characterIds: [],
      })),
    });
    const latest = await g.h.latest();
    expect(latest.document.durationSeconds).toBe(7);
    expect(latest.document.beats.at(-1)?.endSeconds).toBe(7);
    expect(latest.document.beats.every((beat) => beat.endSeconds > beat.startSeconds)).toBe(true);
  });

  it("rejects stale edits and invented library identities before saving or rendering", async () => {
    const g = setup();
    await g.tool.execute("save", { action: "save", brief: "A story", panels });
    await expect(
      g.tool.execute("stale", { action: "save", brief: "overwrite", panels }),
    ).rejects.toThrow("baseVersionNumber");
    await expect(
      g.tool.execute("cast", {
        action: "save",
        baseVersionNumber: 1,
        brief: "A story",
        panels: [{ ...panels[0], characterIds: ["invented"] }],
      }),
    ).rejects.toThrow("saved cast");
    expect((await g.h.latest()).versionNumber).toBe(1);
    expect(g.generate).not.toHaveBeenCalled();
  });

  it("preserves frozen cast and project when the agent replaces panels", async () => {
    const h = harness();
    await h.dispatch(CREATE_MESSAGE);
    const before = await h.latest();
    await h.storyboardRouter.handleAgentTool(
      {
        action: "save",
        baseVersionNumber: 1,
        brief: "Reframe the same scene",
        panels: panels.map((panel) => ({
          ...panel,
          characterIds: before.document.cast.map((member) => member.characterId),
        })),
      },
      { content: "", senderId: h.claim.ownerSenderId, senderIsOwner: true },
      { channelId: "line", accountId: h.claim.accountId, conversationId: h.claim.lineGroupId },
    );
    const after = await h.latest();
    expect(after.characterLocks).toEqual(before.characterLocks);
    expect(after.project).toEqual(before.project);
    expect(after.document.cast).toEqual(before.document.cast);
    expect(after.document.visualPresentation?.columns).toBe(3);
    expect(after.document.durationSeconds).toBe(before.document.durationSeconds);
  });

  it("preserves shot metadata and timing when only layout changes", async () => {
    const g = setup();
    await g.tool.execute("save", { action: "save", brief: "A story", panels });
    const original = await g.h.latest();
    const previous = await g.h.store.replaceDocument({
      storyboardId: original.storyboardId,
      claim: g.h.claim,
      baseVersionNumber: 1,
      document: {
        ...original.document,
        beats: [
          {
            ...original.document.beats[0]!,
            camera: "Dolly in",
            environmentNote: "Rainy alley",
            soundDesign: "Rain",
            endSeconds: 0.5,
          },
          { ...original.document.beats[1]!, startSeconds: 0.5 },
          ...original.document.beats.slice(2),
        ],
      },
    });
    await g.tool.execute("layout", {
      action: "save",
      baseVersionNumber: 2,
      brief: "A story",
      panels,
      columns: 3,
    });
    expect((await g.h.latest()).document.beats).toEqual(previous.document.beats);
  });

  it("does not expose the tool to another sender or accept scope/provider fields", async () => {
    const g = setup();
    expect(
      createStoryboardTool({ ...g.context, senderIsOwner: false }, g.h.storyboardRouter),
    ).toBeNull();
    await expect(
      g.tool.execute("inject", { action: "render", ownerSenderId: "other", provider: "video" }),
    ).rejects.toThrow("Invalid");
    const sandboxed = createStoryboardTool(
      { ...g.context, sandboxed: true },
      g.h.storyboardRouter,
    )!;
    await expect(
      sandboxed.execute("ref", {
        action: "save",
        brief: "story",
        panels,
        references: [{ role: "style", image: "/host/file.png" }],
      }),
    ).rejects.toThrow("unconfined");
    expect(g.persistVisualReference).not.toHaveBeenCalled();
  });
});
