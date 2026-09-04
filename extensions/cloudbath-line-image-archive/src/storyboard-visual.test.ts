import { describe, expect, it, vi } from "vitest";
import { StoryboardStore } from "./storyboard-store.js";
import type { StoryboardDocument, StoryboardVersion } from "./storyboard-types.js";
import {
  StoryboardVisualService,
  storyboardVisualKey,
  storyboardVisualUrl,
  type StoryboardVisualArtifact,
} from "./storyboard-visual.js";

class MemoryStore<T> {
  readonly values = new Map<string, T>();
  async lookup(key: string) {
    return this.values.get(key);
  }
  async register(key: string, value: T) {
    this.values.set(key, value);
  }
  async registerIfAbsent(key: string, value: T) {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
}

const claim = { accountId: "account", lineGroupId: "C-group", ownerSenderId: "U-owner" };
const document: StoryboardDocument = Object.freeze({
  version: 1,
  scenePrompt: "F99 walks through a garden",
  durationSeconds: 8,
  aspectRatio: "9:16",
  resolution: "1080p",
  environment: "night garden",
  audio: "ambient",
  cast: Object.freeze([{ characterId: "F99", characterPageId: "page-f99", displayName: "F99" }]),
  beats: Object.freeze([
    {
      beatId: "beat-1",
      startSeconds: 0,
      endSeconds: 4,
      kind: "establishing",
      framing: "wide",
      action: "walks",
      camera: "track",
      characterIds: Object.freeze(["F99"]),
    },
    {
      beatId: "beat-2",
      startSeconds: 4,
      endSeconds: 8,
      kind: "action",
      framing: "close",
      action: "kicks bottle",
      camera: "low angle",
      characterIds: Object.freeze(["F99"]),
    },
  ]),
});

function version(versionNumber = 1): StoryboardVersion {
  return Object.freeze({
    version: 1,
    storyboardId: "sb-test",
    versionNumber,
    ...(versionNumber > 1 ? { parentVersionNumber: versionNumber - 1 } : {}),
    projectInstanceId: "project",
    projectPageId: "project-page",
    sceneId: "SCENE-1",
    scenePageId: "scene-page",
    ...claim,
    characterLocks: Object.freeze([
      {
        code: "F99",
        pageId: "page-f99",
        identityReferences: Object.freeze([
          { kind: "identity" as const, source: "r2" as const, locator: "characters/f99/front.jpg" },
          { kind: "identity" as const, source: "r2" as const, locator: "characters/f99/side.jpg" },
        ]),
        styleReferences: Object.freeze([]),
        frozenAt: "2026-09-04T00:00:00.000Z",
      },
    ]),
    document,
    createdAt: "2026-09-04T00:00:00.000Z",
  });
}

function harness(failShot?: number) {
  const artifacts = new MemoryStore<StoryboardVisualArtifact>();
  const persisted: string[] = [];
  let counter = 0;
  const service = new StoryboardVisualService({
    artifacts,
    concurrency: 2,
    now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    randomId: () => `${String(++counter).padStart(36, "0")}`,
    generate: vi.fn(async ({ shotIndex, identityReferences }) => {
      expect(identityReferences.map((reference) => reference.locator)).toEqual([
        "characters/f99/front.jpg",
        "characters/f99/side.jpg",
      ]);
      if (shotIndex === failShot) throw new Error("mock generation failed");
      return {
        bytes: Buffer.from(`provider-image-${shotIndex}`),
        mimeType: "image/webp",
        width: 1024,
        height: 1792,
        provider: "mock-image",
        model: "mock-model",
      };
    }),
    normalize: vi.fn(async ({ bytes, maxWidth }) => ({
      bytes: Buffer.concat([Buffer.from(maxWidth === 240 ? "preview:" : "original:"), bytes]),
      mimeType: "image/jpeg" as const,
      width: maxWidth === 240 ? 137 : 1024,
      height: maxWidth === 240 ? 240 : 1792,
    })),
    persist: vi.fn(async ({ objectKey }) => void persisted.push(objectKey)),
  });
  return { artifacts, persisted, service };
}

describe("storyboard visual artifacts", () => {
  it("persists one original and preview per shot with frozen identity metadata", async () => {
    const h = harness();
    const result = await h.service.generate({ version: version(), claim });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready visuals");
    expect(result.artifacts).toHaveLength(2);
    expect(h.persisted).toHaveLength(4);
    expect(result.artifacts[0]).toMatchObject({
      storyboardId: "sb-test",
      storyboardVersionNumber: 1,
      shotIndex: 1,
      sourceCharacterIds: ["F99"],
      sourceReferenceAssetIds: ["characters/f99/front.jpg", "characters/f99/side.jpg"],
      mimeType: "image/jpeg",
      generationProvider: "mock-image",
      generationModel: "mock-model",
    });
    expect(result.artifacts[0]?.originalObjectKey).not.toBe(result.artifacts[0]?.previewObjectKey);
  });

  it("keeps prior visuals on v1 and requires regeneration for v2", async () => {
    const h = harness();
    await h.service.generate({ version: version(1), claim });

    expect(await h.service.status({ version: version(2), claim })).toEqual({
      kind: "regeneration_required",
    });
    expect(await h.artifacts.lookup(storyboardVisualKey("sb-test", 1, 1))).toMatchObject({
      storyboardVersionNumber: 1,
    });
  });

  it("represents partial failure and retries only the failed shot", async () => {
    const failed = harness(2);
    expect(await failed.service.generate({ version: version(), claim })).toMatchObject({
      kind: "partial",
      failedShotIndexes: [2],
    });
    const retry = harness();
    for (const [key, value] of failed.artifacts.values) retry.artifacts.values.set(key, value);
    const result = await retry.service.generate({ version: version(), claim, shotIndexes: [2] });
    expect(result.kind).toBe("ready");
  });

  it("derives stable query-free LINE URLs instead of provider URLs", () => {
    const url = storyboardVisualUrl({
      publicAssetBaseUrl: "https://cloudbath.example",
      artifactId: "a".repeat(36),
      variant: "preview",
    });
    expect(url).toBe(
      `https://cloudbath.example/plugins/cloudbath/storyboard-visual/${"a".repeat(36)}/preview`,
    );
    expect(url).not.toContain("temporary-provider.example");
    expect(url).not.toContain("?");
  });

  it("leaves paid video allocation outside image generation", async () => {
    const paidCalls = vi.fn();
    const h = harness();
    await h.service.generate({ version: version(), claim, shotIndexes: [1] });
    expect(paidCalls).not.toHaveBeenCalled();
  });
});

describe("storyboard version transition", () => {
  it("increments authoritative content without copying visual metadata", async () => {
    const heads = new MemoryStore<never>();
    const versions = new MemoryStore<never>();
    const store = new StoryboardStore({ heads, versions, now: () => 1 });
    const created = await store.createStoryboard({
      document,
      claim,
      projectInstanceId: "project",
      projectPageId: "project-page",
      sceneId: "SCENE-1",
      scenePageId: "scene-page",
      characterLocks: version().characterLocks,
    });
    const revised = await store.appendRevision({
      storyboardId: created.version.storyboardId,
      claim,
      revision: { kind: "duration", durationSeconds: 15 },
    });
    expect(revised.versionNumber).toBe(2);
    expect(revised.document.durationSeconds).toBe(15);
  });
});
