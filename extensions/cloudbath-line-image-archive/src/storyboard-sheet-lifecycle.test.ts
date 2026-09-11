/**
 * The storyboard's TWO visual representations and the boundary between them.
 *
 * Production only ever delivered individual shots because the sheet was
 * described as SVG and handed to a raster-only backend, which refused it with
 * "Unable to determine image dimensions". The sheet is derived, so these tests
 * pin what that means: the shots survive a composition failure, a retry
 * rebuilds the sheet from what is already stored without paying a provider
 * again, and the sheet is never mistaken for a per-shot first frame.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryboardAccessClaim, StoryboardVersion } from "./storyboard-types.js";
import {
  storyboardContactSheetKey,
  storyboardSheetColumns,
  storyboardVisualKey,
  StoryboardVisualService,
  type StoryboardVisualArtifact,
} from "./storyboard-visual.js";

const claim: StoryboardAccessClaim = {
  accountId: "acct-1",
  lineGroupId: "C1234567890abcdef",
  ownerSenderId: "U0987654321",
};

function version(shots = 6): StoryboardVersion {
  return {
    version: 1,
    storyboardId: "sb-sheet",
    versionNumber: 1,
    accountId: claim.accountId,
    lineGroupId: claim.lineGroupId,
    ownerSenderId: claim.ownerSenderId,
    createdAt: "2026-09-11T00:00:00.000Z",
    characterLocks: [],
    document: {
      version: 1,
      scenePrompt: "นักดาบในป่าคริสตัล",
      durationSeconds: shots,
      environment: "ป่าคริสตัล",
      audio: "silent",
      beats: Array.from({ length: shots }, (_, index) => ({
        beatId: `beat-${index + 1}`,
        startSeconds: index,
        endSeconds: index + 1,
        kind: "action" as const,
        framing: "Wide",
        action: `ฉากที่ ${index + 1}`,
        caption: `คำบรรยาย ${index + 1}`,
        camera: "Static",
        characterIds: [],
      })),
    },
  } as unknown as StoryboardVersion;
}

/** A service whose sheet composition can be made to fail on demand. */
function harness(options: { sheetFails?: boolean } = {}) {
  const rows = new Map<string, StoryboardVisualArtifact>();
  const media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  let sheetFails = options.sheetFails ?? false;
  let counter = 0;

  const generate = vi.fn(async ({ shotIndex }: { shotIndex: number }) => ({
    bytes: Buffer.from(`shot-${shotIndex}`),
    mimeType: "image/png",
    width: 1024,
    height: 1792,
    provider: "mock-image",
    model: "mock-model",
  }));
  const composeSheet = vi.fn(
    async ({
      panels,
      columns,
    }: {
      panels: readonly Readonly<{ bytes: Uint8Array; label: string }>[];
      columns: number;
    }) => {
      if (sheetFails) {
        throw new Error("Unable to determine image dimensions; refusing to process");
      }
      return {
        bytes: Buffer.from(`sheet:${panels.map((panel) => panel.label).join(",")}`),
        mimeType: "image/png" as const,
        width: columns * 512,
        height: Math.ceil(panels.length / columns) * 368,
      };
    },
  );

  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new StoryboardVisualService({
    artifacts: {
      lookup: async (key: string) => rows.get(key),
      register: async (key: string, value: StoryboardVisualArtifact) => void rows.set(key, value),
    } as never,
    concurrency: 2,
    now: () => Date.parse("2026-09-11T00:00:00.000Z"),
    randomId: () => String(++counter).padStart(36, "0"),
    generate: generate as never,
    composeSheet,
    normalize: async ({ bytes, maxWidth }) => ({
      bytes: Buffer.concat([Buffer.from(maxWidth === 240 ? "preview:" : "original:"), bytes]),
      mimeType: "image/jpeg" as const,
      width: maxWidth === 240 ? 137 : 1024,
      height: maxWidth === 240 ? 240 : 1792,
    }),
    persist: async ({ objectKey, bytes, contentType }) => {
      media.set(objectKey, { bytes, mimeType: contentType });
    },
    read: async ({ objectKey }) => media.get(objectKey)!,
    logger,
  });
  return {
    service,
    logger,
    generate,
    composeSheet,
    rows,
    media,
    failSheet: (value: boolean) => {
      sheetFails = value;
    },
  };
}

describe("six shots become one 2x3 storyboard sheet", () => {
  it("defaults six scenes to two columns", () => {
    expect(storyboardSheetColumns(6)).toBe(2);
    expect(storyboardSheetColumns(1)).toBe(1);
    // An explicit presentation choice still wins.
    expect(storyboardSheetColumns(6, 3)).toBe(3);
  });

  it("persists six shots and composes one sheet from them, in order", async () => {
    const h = harness();

    const status = await h.service.generate({ version: version(), claim });

    expect(status.kind).toBe("ready");
    if (status.kind !== "ready") {
      throw new Error("expected ready");
    }
    expect(status.artifacts.map((artifact) => artifact.shotIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.composeSheet).toHaveBeenCalledTimes(1);
    expect(h.composeSheet.mock.calls[0]![0]).toMatchObject({
      columns: 2,
      panels: [
        { label: "1" },
        { label: "2" },
        { label: "3" },
        { label: "4" },
        { label: "5" },
        { label: "6" },
      ],
    });
    expect(status.contactSheet?.panels.map((panel) => panel.shotIndex)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("a sheet failure never costs the shots", () => {
  it("keeps all six shots available when composition fails", async () => {
    const h = harness({ sheetFails: true });

    const status = await h.service.generate({ version: version(), claim });

    expect(status.kind).toBe("ready");
    if (status.kind !== "ready") {
      throw new Error("expected ready");
    }
    expect(status.artifacts).toHaveLength(6);
    expect(status.contactSheet).toBeUndefined();
    // Storyboard state is intact: every shot row is still readable.
    for (let shotIndex = 1; shotIndex <= 6; shotIndex += 1) {
      expect(h.rows.get(storyboardVisualKey("sb-sheet", 1, shotIndex))).toBeDefined();
    }
  });

  it("reports the composition failure instead of swallowing it silently", async () => {
    const h = harness({ sheetFails: true });

    await h.service.generate({ version: version(), claim });

    expect(h.logger.warn).toHaveBeenCalledWith(
      "storyboard_contact_sheet_failed",
      expect.objectContaining({
        storyboardId: "sb-sheet",
        shotCount: 6,
        reason: expect.stringContaining("image dimensions"),
      }),
    );
  });
});

describe("retrying the sheet reuses persisted shots", () => {
  it("rebuilds the sheet with zero new image-provider calls", async () => {
    const h = harness({ sheetFails: true });
    await h.service.generate({ version: version(), claim });
    const providerCallsAfterShots = h.generate.mock.calls.length;
    expect(providerCallsAfterShots).toBe(6);

    h.failSheet(false);
    const retried = await h.service.rebuildContactSheet({ version: version(), claim });

    expect(retried.kind).toBe("ready");
    if (retried.kind !== "ready") {
      throw new Error("expected ready");
    }
    expect(retried.contactSheet).toBeDefined();
    // The whole point: no scene was redrawn to rebuild the overview.
    expect(h.generate).toHaveBeenCalledTimes(providerCallsAfterShots);
    expect(retried.artifacts).toHaveLength(6);
  });

  it("rebuilds in shot order even after a retry", async () => {
    const h = harness({ sheetFails: true });
    await h.service.generate({ version: version(), claim });
    h.failSheet(false);

    await h.service.rebuildContactSheet({ version: version(), claim });

    const lastCall = h.composeSheet.mock.calls.at(-1)![0];
    expect(lastCall.panels.map((panel) => panel.label)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("refuses to rebuild from an incomplete shot set", async () => {
    const h = harness({ sheetFails: true });
    await h.service.generate({ version: version(), claim, shotIndexes: [1, 2] });
    h.failSheet(false);

    const status = await h.service.rebuildContactSheet({ version: version(), claim });

    // Partial, so no sheet: a complete-looking overview must mean complete.
    expect(status.kind).toBe("partial");
    expect(h.composeSheet).not.toHaveBeenCalled();
  });
});

describe("the sheet is not a shot", () => {
  it("stores the sheet under its own key, never a shot key", async () => {
    const h = harness();
    await h.service.generate({ version: version(), claim });

    const sheet = h.rows.get(storyboardContactSheetKey("sb-sheet", 1));
    expect(sheet?.generationPurpose).toBe("storyboard-contact-sheet");
    for (let shotIndex = 1; shotIndex <= 6; shotIndex += 1) {
      expect(h.rows.get(storyboardVisualKey("sb-sheet", 1, shotIndex))?.generationPurpose).toBe(
        "storyboard-shot",
      );
    }
  });

  it("does not count a sheet as visual readiness when no shot exists", async () => {
    const h = harness();
    // A sheet row planted where shots should be must not make a version look ready.
    h.rows.set(storyboardContactSheetKey("sb-sheet", 1), {
      version: 1,
      artifactId: "sheet-only",
      storyboardId: "sb-sheet",
      storyboardVersionNumber: 1,
      accountId: claim.accountId,
      ownerSenderId: claim.ownerSenderId,
      conversationId: claim.lineGroupId,
      sourceCharacterIds: [],
      sourceReferenceAssetIds: [],
      originalObjectKey: "o",
      previewObjectKey: "p",
      mimeType: "image/jpeg",
      width: 1024,
      height: 1536,
      byteSize: 1,
      generationProvider: "derived",
      generationModel: "storyboard-sheet-raster-v1",
      generationPurpose: "storyboard-contact-sheet",
      status: "completed",
      panels: [],
      createdAt: "2026-09-11T00:00:00.000Z",
    } as StoryboardVisualArtifact);

    const status = await h.service.status({ version: version(), claim });

    expect(status.kind).toBe("not_generated");
  });

  it("exposes per-shot artifacts a video first frame can use, and the sheet separately", async () => {
    const h = harness();
    const status = await h.service.generate({ version: version(), claim });
    if (status.kind !== "ready") {
      throw new Error("expected ready");
    }

    // Every artifact offered as a shot is a shot; the sheet is reached only
    // through its own field, so a first-frame selection cannot pick it up.
    expect(status.artifacts.every((a) => a.generationPurpose === "storyboard-shot")).toBe(true);
    expect(status.artifacts.map((a) => a.shotIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(status.contactSheet?.generationPurpose).toBe("storyboard-contact-sheet");
    expect(
      (status.contactSheet as unknown as { shotIndex?: number } | undefined)?.shotIndex,
    ).toBeUndefined();
  });
});
