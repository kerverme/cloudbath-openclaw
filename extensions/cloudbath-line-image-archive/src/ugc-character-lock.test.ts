import { describe, expect, it } from "vitest";
import type { UgcCharacterLock, UgcReferenceAsset } from "./types.js";
import {
  allocateSceneReferences,
  CHARACTER_IDENTITY_PROPERTIES,
  CHARACTER_STYLE_PROPERTIES,
  freezeCharacterLock,
  normalizeCharacterCodes,
} from "./ugc-character-lock.js";

const FROZEN_AT = "2026-08-23T00:00:00.000Z";

/** Reads a fake Character Library row keyed by the real production property names. */
function readerFor(row: Record<string, string[]>) {
  return (
    _page: { id?: string },
    names: readonly string[],
    kind: UgcReferenceAsset["kind"],
  ): UgcReferenceAsset[] =>
    names.flatMap((name) =>
      (row[name] ?? []).map((locator) => ({
        kind,
        source: locator.startsWith("https://") ? ("https" as const) : ("r2" as const),
        locator,
      })),
    );
}

function lockOf(code: string, identity: string[], style: string[] = []): UgcCharacterLock {
  return freezeCharacterLock({
    code,
    page: { id: `page-${code}`, last_edited_time: FROZEN_AT },
    readReferences: readerFor({
      "Identity Reference R2 Keys": identity,
      "Style Reference R2 Keys": style,
    }),
    frozenAt: FROZEN_AT,
  });
}

describe("character identity lock", () => {
  it("reads the live Character Library property names", () => {
    expect(CHARACTER_IDENTITY_PROPERTIES).toEqual([
      "Identity Asset URL",
      "Identity Reference R2 Keys",
      "Canonical Reference Set",
    ]);
    expect(CHARACTER_STYLE_PROPERTIES).toEqual(["Style Reference R2 Keys"]);
  });

  it("freezes only the canonical identity asset and ignores legacy duplicates and Preview", () => {
    const lock = freezeCharacterLock({
      code: "F1",
      page: { id: "page-f1", last_edited_time: FROZEN_AT },
      readReferences: readerFor({
        "Identity Asset URL": ["characters/f1/main.png"],
        "Identity Reference R2 Keys": ["characters/f1/identity-1.png"],
        "Canonical Reference Set": ["characters/f1/canonical.png"],
        Preview: ["https://example.com/f1-preview.png"],
        "Style Reference R2 Keys": ["characters/f1/style.png"],
      }),
      frozenAt: FROZEN_AT,
    });

    expect(lock.pageId).toBe("page-f1");
    expect(lock.contentIdentity).toBe(FROZEN_AT);
    expect(lock.identityReferences.map((asset) => asset.locator)).toEqual([
      "characters/f1/main.png",
    ]);
    expect(lock.styleReferences.map((asset) => asset.locator)).toEqual(["characters/f1/style.png"]);
  });

  it("falls back to the first supported legacy primary field", () => {
    const lock = freezeCharacterLock({
      code: "F1",
      page: { id: "page-f1" },
      readReferences: readerFor({
        "Identity Reference R2 Keys": ["characters/f1/legacy.png"],
        "Canonical Reference Set": ["characters/f1/secondary.png"],
        Preview: ["https://example.com/f1-preview.png"],
      }),
      frozenAt: FROZEN_AT,
    });

    expect(lock.identityReferences.map((asset) => asset.locator)).toEqual([
      "characters/f1/legacy.png",
    ]);
  });

  it("fails closed when a character has no usable identity reference", () => {
    expect(() =>
      freezeCharacterLock({
        code: "F9",
        page: { id: "page-f9" },
        readReferences: readerFor({ "Style Reference R2 Keys": ["characters/f9/style.png"] }),
        frozenAt: FROZEN_AT,
      }),
    ).toThrow(/no usable identity reference/u);
  });

  it("is frozen against mutation after the project is locked", () => {
    const lock = lockOf("F1", ["characters/f1/a.png"]);
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.identityReferences)).toBe(true);
  });

  it("rejects a duplicate character request", () => {
    expect(() => normalizeCharacterCodes(["F1", "f1"])).toThrow(/more than once/u);
  });

  it("rejects an empty cast", () => {
    expect(() => normalizeCharacterCodes(["  "])).toThrow(/At least one character/u);
  });
});

describe("scene reference allocation", () => {
  it("gives F1 and F2 at least one identity reference each", () => {
    const allocation = allocateSceneReferences({
      characterLocks: [
        lockOf("F1", ["f1/a.png", "f1/b.png"]),
        lockOf("F2", ["f2/a.png", "f2/b.png"]),
      ],
      productReferences: [],
      maxAssets: 8,
    });

    expect(allocation.perCharacterIdentityCount).toEqual({ F1: 1, F2: 1 });
    expect(allocation.assets.map((asset) => asset.locator)).toContain("f1/a.png");
    expect(allocation.assets.map((asset) => asset.locator)).toContain("f2/a.png");
  });

  it("cannot silently drop a character when the budget is tight", () => {
    // F1 alone has more identity refs than the whole budget.
    const allocation = allocateSceneReferences({
      characterLocks: [
        lockOf("F1", ["f1/a.png", "f1/b.png", "f1/c.png", "f1/d.png"]),
        lockOf("F2", ["f2/a.png", "f2/b.png"]),
      ],
      productReferences: [],
      maxAssets: 3,
    });

    expect(allocation.assets).toHaveLength(2);
    expect(allocation.perCharacterIdentityCount.F1).toBeGreaterThanOrEqual(1);
    expect(allocation.perCharacterIdentityCount.F2).toBeGreaterThanOrEqual(1);
    expect(allocation.assets.map((asset) => asset.locator)).toContain("f2/a.png");
  });

  it("fails closed rather than casting fewer characters than requested", () => {
    expect(() =>
      allocateSceneReferences({
        characterLocks: [
          lockOf("F1", ["f1/a.png"]),
          lockOf("F2", ["f2/a.png"]),
          lockOf("F3", ["f3/a.png"]),
        ],
        productReferences: [],
        maxAssets: 2,
      }),
    ).toThrow(/only 2 reference slots/u);
  });

  it("keeps identity ahead of product and style in submission order", () => {
    const allocation = allocateSceneReferences({
      characterLocks: [lockOf("F1", ["f1/a.png"], ["f1/style.png"])],
      productReferences: [{ kind: "product", source: "r2", locator: "product/a.png" }],
      maxAssets: 8,
    });

    expect(allocation.assets.map((asset) => asset.kind)).toEqual(["identity", "product", "style"]);
  });

  it("never submits the same asset twice when characters share a secondary reference", () => {
    const allocation = allocateSceneReferences({
      characterLocks: [
        lockOf("F1", ["f1/a.png", "shared/b.png"]),
        lockOf("F2", ["f2/a.png", "shared/b.png"]),
      ],
      productReferences: [],
      maxAssets: 8,
    });

    const locators = allocation.assets.map((asset) => asset.locator);
    expect(new Set(locators).size).toBe(locators.length);
    expect(locators).toContain("f1/a.png");
    expect(locators).toContain("f2/a.png");
  });

  // Two characters whose ONLY identity reference is the same asset cannot both
  // be guaranteed representation, and that is a library misconfiguration worth
  // surfacing rather than casting one of them invisibly.
  it("fails closed when a character's only identity reference was taken by another", () => {
    expect(() =>
      allocateSceneReferences({
        characterLocks: [lockOf("F1", ["shared/a.png"]), lockOf("F2", ["shared/a.png"])],
        productReferences: [],
        maxAssets: 8,
      }),
    ).toThrow(/no distinct identity reference/u);
  });

  it("reuses the identical frozen references for a later scene", () => {
    const locks = [lockOf("F1", ["f1/a.png"]), lockOf("F2", ["f2/a.png"])];
    const scene1 = allocateSceneReferences({
      characterLocks: locks,
      productReferences: [],
      maxAssets: 8,
    });
    const scene2 = allocateSceneReferences({
      characterLocks: locks,
      productReferences: [],
      maxAssets: 8,
    });

    expect(scene2.assets).toEqual(scene1.assets);
  });
});
