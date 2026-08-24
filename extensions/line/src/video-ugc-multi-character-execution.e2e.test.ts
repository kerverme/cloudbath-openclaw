/**
 * Multi-character execution at the LINE paid seam.
 *
 * These drive orderLineVideoUgcReferences and materializeLineVideoUgcReferences
 * -- the code that decides what actually reaches generateVideo -- rather than
 * the preparation side. The guarantee under test: every locked character is
 * represented in the submission, nobody is truncated away, and scene 2 submits
 * byte-identical assets to scene 1.
 *
 * No provider call happens here: materialization stops at reference bytes, and
 * the R2 reader is stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  materializeLineVideoUgcReferences,
  orderLineVideoUgcReferences,
  validateLineVideoUgcScope,
  type LineVideoUgcCharacterLock,
  type LineVideoUgcReference,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";

const FROZEN_AT = "2026-08-23T00:00:00.000Z";

const TARGETS = {
  PRODUCT_LIBRARY: { databaseId: "a".repeat(32), dataSourceId: "1".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "2".repeat(32) },
  UGC_PROJECTS: { databaseId: "c".repeat(32), dataSourceId: "3".repeat(32) },
  UGC_SHOTS: { databaseId: "d".repeat(32), dataSourceId: "4".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "e".repeat(32), dataSourceId: "5".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "f".repeat(32), dataSourceId: "6".repeat(32) },
} as const;

/** A 1x1 PNG: materialization validates image bytes before submitting them. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

function identity(locator: string): LineVideoUgcReference {
  return { kind: "identity", source: "r2", locator };
}

function lock(code: string, pageId: string, locators: string[]): LineVideoUgcCharacterLock {
  return {
    code,
    pageId,
    contentIdentity: FROZEN_AT,
    identityReferences: locators.map(identity),
    styleReferences: [],
    frozenAt: FROZEN_AT,
  };
}

function scopeFor(params: {
  locks: LineVideoUgcCharacterLock[];
  references?: LineVideoUgcReference[];
  sceneNumber?: number;
  scenePageId?: string;
  previousScenePageId?: string;
}): LineVideoUgcScope {
  const locks = params.locks;
  const references = params.references ?? locks.flatMap((entry) => [...entry.identityReferences]);
  return {
    version: 1,
    policyId: "UGC",
    accountId: "acct-1",
    lineGroupId: "C-ugc",
    ownerSenderId: "U-owner",
    productPageId: "product-page",
    characterLocks: locks,
    projectPageId: "project-page",
    projectRecordId: "project-record",
    scene: {
      sceneNumber: params.sceneNumber ?? 1,
      ...(params.previousScenePageId ? { previousScenePageId: params.previousScenePageId } : {}),
      characterPageIds: locks.map((entry) => entry.pageId),
      characterCodes: locks.map((entry) => entry.code),
      prompt: "F1 plays with F2 in a garden",
    },
    scenePageId: params.scenePageId ?? "scene-1",
    shotPageIds: [params.scenePageId ?? "scene-1"],
    referenceAssets: references,
    frozenPrompt: "F1 plays with F2 in a garden",
    capabilities: TARGETS,
    r2Prefix: "outbound/line-video",
    createdAt: FROZEN_AT,
  };
}

/** Stubs the R2 reader so materialization never touches the network. */
function r2Deps() {
  const read: string[] = [];
  return {
    read,
    dependencies: {
      env: {
        R2_ACCOUNT_ID: "acct",
        R2_BUCKET_NAME: "bucket",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
      } as NodeJS.ProcessEnv,
      s3Client: {
        send: vi.fn(async (command: { input?: { Key?: string } }) => {
          read.push(command.input?.Key ?? "");
          return {
            ContentLength: PNG.byteLength,
            Body: { transformToByteArray: async () => new Uint8Array(PNG) },
          };
        }),
      },
    },
  };
}

const F1 = lock("F1", "page-f1", ["characters/f1/a.png", "characters/f1/b.png"]);
const F2 = lock("F2", "page-f2", ["characters/f2/a.png"]);

describe("multi-character references reaching the paid seam", () => {
  it("submits identity assets for both F1 and F2", async () => {
    const deps = r2Deps();

    const assets = await materializeLineVideoUgcReferences(
      scopeFor({ locks: [F1, F2] }),
      deps.dependencies,
    );

    expect(deps.read).toContain("characters/f1/a.png");
    expect(deps.read).toContain("characters/f2/a.png");
    expect(assets).toHaveLength(3);
  });

  it("cannot truncate a character away when the budget is tight", () => {
    // Eight F1 assets would fill the whole budget under naive ordering.
    const greedy = lock(
      "F1",
      "page-f1",
      Array.from({ length: 8 }, (_, index) => `characters/f1/${index}.png`),
    );
    const ordered = orderLineVideoUgcReferences(scopeFor({ locks: [greedy, F2] }));

    expect(ordered).toHaveLength(8);
    expect(ordered.map((asset) => asset.locator)).toContain("characters/f2/a.png");
  });

  it("fails closed when a locked character has no frozen identity asset", () => {
    const scope = scopeFor({
      locks: [F1, F2],
      // F2's asset was never frozen into the scope.
      references: [...F1.identityReferences],
    });

    expect(() => orderLineVideoUgcReferences(scope)).toThrow(
      /no usable frozen identity reference for character "F2"/u,
    );
  });

  it("fails closed when the cast exceeds the reference budget", () => {
    const cast = Array.from({ length: 9 }, (_, index) =>
      lock(`F${index}`, `page-${index}`, [`characters/f${index}/a.png`]),
    );

    expect(() => orderLineVideoUgcReferences(scopeFor({ locks: cast }))).toThrow(
      /more characters than reference slots/u,
    );
  });

  it("keeps identity ahead of product and style", () => {
    const scope = scopeFor({
      locks: [F1, F2],
      references: [
        { kind: "style", source: "r2", locator: "style/a.png" },
        { kind: "product", source: "r2", locator: "product/a.png" },
        ...F1.identityReferences,
        ...F2.identityReferences,
      ],
    });

    expect(orderLineVideoUgcReferences(scope).map((asset) => asset.kind)).toEqual([
      "identity",
      "identity",
      "identity",
      "product",
      "style",
    ]);
  });

  it("never submits an asset that is not frozen into the confirmed scope", () => {
    const tampered = scopeFor({ locks: [F1, F2] });
    const smuggled: LineVideoUgcScope = {
      ...tampered,
      characterLocks: [{ ...F1, identityReferences: [identity("attacker/not-frozen.png")] }, F2],
    };

    expect(() => orderLineVideoUgcReferences(smuggled)).toThrow(
      /no usable frozen identity reference for character "F1"/u,
    );
  });
});

describe("scene-to-scene identity reuse at the paid seam", () => {
  it("scene 2 submits byte-identical assets to scene 1", async () => {
    const scene1Deps = r2Deps();
    const scene2Deps = r2Deps();

    await materializeLineVideoUgcReferences(
      scopeFor({ locks: [F1, F2], sceneNumber: 1, scenePageId: "scene-1" }),
      scene1Deps.dependencies,
    );
    await materializeLineVideoUgcReferences(
      scopeFor({
        locks: [F1, F2],
        sceneNumber: 2,
        scenePageId: "scene-2",
        previousScenePageId: "scene-1",
      }),
      scene2Deps.dependencies,
    );

    expect(scene2Deps.read).toEqual(scene1Deps.read);
  });

  it("a Character Library edit after lock cannot change what is submitted", () => {
    const scene1 = orderLineVideoUgcReferences(scopeFor({ locks: [F1, F2] }));

    // The library row now points elsewhere, but the frozen lock is what the
    // paid path reads, so the submission is unchanged.
    const editedLibraryLock = lock("F2", "page-f2", ["characters/f2/REPLACED.png"]);
    const scene2 = orderLineVideoUgcReferences(
      scopeFor({
        locks: [F1, F2],
        references: [
          ...F1.identityReferences,
          ...F2.identityReferences,
          ...editedLibraryLock.identityReferences,
        ],
        sceneNumber: 2,
      }),
    );

    expect(scene2.map((asset) => asset.locator)).toEqual(scene1.map((asset) => asset.locator));
    expect(scene2.some((asset) => asset.locator.includes("REPLACED"))).toBe(false);
  });
});

describe("confirmation cannot swap project, scene or cast", () => {
  const cfg = {
    plugins: {
      entries: {
        "cloudbath-line-image-archive": {
          config: { groupWorkspacePolicies: { ugc: { capabilities: TARGETS } } },
        },
      },
    },
  } as never;
  const binding = {
    policyId: "UGC" as const,
    accountId: "acct-1",
    groupId: "C-ugc",
    boundByOwnerId: "U-owner",
  };
  const base = {
    cfg,
    binding,
    accountId: "acct-1",
    groupId: "C-ugc",
    ownerSenderId: "U-owner",
    frozenPrompt: "F1 plays with F2 in a garden",
  };

  it("accepts a scope whose scene and lock agree", () => {
    expect(validateLineVideoUgcScope({ ...base, scope: scopeFor({ locks: [F1, F2] }) })).toBe(true);
  });

  it("rejects a scene whose cast no longer matches the lock", () => {
    const scope = scopeFor({ locks: [F1, F2] });
    const swapped: LineVideoUgcScope = {
      ...scope,
      scene: { ...scope.scene, characterPageIds: ["page-f1", "page-IMPOSTER"] },
    };

    expect(validateLineVideoUgcScope({ ...base, scope: swapped })).toBe(false);
  });

  it("rejects a scene whose prompt drifted from the confirmed prompt", () => {
    const scope = scopeFor({ locks: [F1, F2] });
    const drifted: LineVideoUgcScope = {
      ...scope,
      scene: { ...scope.scene, prompt: "a different scene entirely" },
    };

    expect(validateLineVideoUgcScope({ ...base, scope: drifted })).toBe(false);
  });

  it("rejects a cast member carrying no identity reference", () => {
    const scope = scopeFor({ locks: [F1, { ...F2, identityReferences: [] }] });

    expect(validateLineVideoUgcScope({ ...base, scope })).toBe(false);
  });

  it("rejects an invalid scene number", () => {
    const scope = scopeFor({ locks: [F1, F2] });
    const zeroth: LineVideoUgcScope = { ...scope, scene: { ...scope.scene, sceneNumber: 0 } };

    expect(validateLineVideoUgcScope({ ...base, scope: zeroth })).toBe(false);
  });
});
