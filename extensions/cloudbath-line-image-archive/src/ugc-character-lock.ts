/**
 * Project-level character identity lock and per-scene reference allocation.
 *
 * A UGC project may cast several characters ("F1", "F2"). Once the project is
 * frozen, every later scene must submit the SAME canonical reference assets
 * for each character: the Character Library is never re-queried to swap
 * references underneath an in-flight project, and nothing the model emits can
 * reach these page ids.
 *
 * Note the honest limit of this guarantee: freezing controls what we SUBMIT to
 * the provider. It does not make a generative model render identical subjects
 * across scenes, and nothing here should be described as preventing visual
 * drift.
 */
import type { UgcCharacterLock, UgcReferenceAsset } from "./types.js";

/**
 * Only what freezing needs from a Character Library row. Property reading is
 * injected, so this module stays independent of the Notion client's page shape.
 */
export type LockableCharacterPage = {
  id?: string;
  last_edited_time?: string;
};

/**
 * Canonical production property names on the Character Library. Reading only
 * the live names keeps this a single source of truth -- an older name silently
 * resolving would reintroduce exactly the drift the lock exists to prevent.
 */
export const CHARACTER_IDENTITY_PROPERTIES = [
  "Identity Reference R2 Keys",
  "Canonical Reference Set",
  "Preview",
] as const;

export const CHARACTER_STYLE_PROPERTIES = ["Style Reference R2 Keys"] as const;

export const PRODUCT_REFERENCE_PROPERTIES = [
  "Reference Images",
  "Reference Assets",
  "R2 Object Keys",
] as const;

export const PRODUCT_STYLE_PROPERTIES = ["Style Reference R2 Keys"] as const;

/** Deterministic submission order, applied after per-character fairness. */
const KIND_PRIORITY = { identity: 0, product: 1, style: 2 } as const;

export type CharacterReferenceReader = (
  page: LockableCharacterPage,
  names: readonly string[],
  kind: UgcReferenceAsset["kind"],
) => UgcReferenceAsset[];

/**
 * Freezes one character. `contentIdentity` records Notion's last edit stamp so
 * a later audit can tell whether the library row moved after the freeze; it is
 * evidence only and never re-resolves the references.
 */
export function freezeCharacterLock(params: {
  code: string;
  page: LockableCharacterPage;
  readReferences: CharacterReferenceReader;
  frozenAt: string;
}): UgcCharacterLock {
  const identityReferences = dedupe(
    params.readReferences(params.page, CHARACTER_IDENTITY_PROPERTIES, "identity"),
  );
  if (identityReferences.length === 0) {
    throw new Error(
      `Character "${params.code}" has no usable identity reference in the Character Library`,
    );
  }
  return Object.freeze({
    code: params.code,
    pageId: params.page.id!,
    ...(params.page.last_edited_time ? { contentIdentity: params.page.last_edited_time } : {}),
    identityReferences: Object.freeze(identityReferences),
    styleReferences: Object.freeze(
      dedupe(params.readReferences(params.page, CHARACTER_STYLE_PROPERTIES, "style")),
    ),
    frozenAt: params.frozenAt,
  });
}

function dedupe(assets: readonly UgcReferenceAsset[]): UgcReferenceAsset[] {
  const unique = new Map<string, UgcReferenceAsset>();
  for (const asset of assets) {
    unique.set(`${asset.kind}\0${asset.source}\0${asset.locator}`, asset);
  }
  return [...unique.values()];
}

export type ReferenceAllocation = Readonly<{
  assets: readonly UgcReferenceAsset[];
  /** Identity assets contributed per character code, for proof and diagnostics. */
  perCharacterIdentityCount: Readonly<Record<string, number>>;
}>;

/**
 * Allocates the scene's reference slots across every locked character.
 *
 * Straight priority sorting would let a large cast be truncated down to the
 * first character's references, silently dropping the rest -- the scene would
 * then generate without F2 at all. So each character is guaranteed one identity
 * slot first, and the request fails closed when even that is impossible, rather
 * than quietly casting fewer characters than the owner asked for.
 */
export function allocateSceneReferences(params: {
  characterLocks: readonly UgcCharacterLock[];
  productReferences: readonly UgcReferenceAsset[];
  maxAssets: number;
}): ReferenceAllocation {
  const locks = params.characterLocks;
  if (params.maxAssets < 1) {
    throw new Error("Scene reference budget must allow at least one asset");
  }
  if (locks.length > params.maxAssets) {
    throw new Error(
      `Scene requests ${locks.length} characters but only ${params.maxAssets} reference slots are available; ` +
        "reduce the cast rather than dropping a character",
    );
  }

  const selected: UgcReferenceAsset[] = [];
  const perCharacterIdentityCount: Record<string, number> = {};
  const seen = new Set<string>();
  const take = (asset: UgcReferenceAsset, code?: string): boolean => {
    const key = `${asset.source}\0${asset.locator}`;
    if (seen.has(key) || selected.length >= params.maxAssets) {
      return false;
    }
    seen.add(key);
    selected.push(asset);
    if (code) {
      perCharacterIdentityCount[code] = (perCharacterIdentityCount[code] ?? 0) + 1;
    }
    return true;
  };

  // Pass 1: one identity asset per character, in cast order. Guarantees every
  // requested character is actually represented in the submission.
  for (const lock of locks) {
    perCharacterIdentityCount[lock.code] ??= 0;
    const first = lock.identityReferences.find(
      (asset) => !seen.has(`${asset.source}\0${asset.locator}`),
    );
    if (!first) {
      throw new Error(
        `Character "${lock.code}" has no distinct identity reference left to allocate for this scene`,
      );
    }
    take(first, lock.code);
  }

  // Pass 2: remaining identity assets, round-robin so no single character
  // consumes the rest of the budget.
  for (let depth = 1; selected.length < params.maxAssets; depth += 1) {
    let progressed = false;
    for (const lock of locks) {
      const asset = lock.identityReferences[depth];
      if (asset && take(asset, lock.code)) {
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }

  // Pass 3: product, then character style -- lower priority than any identity.
  for (const asset of params.productReferences) {
    take(asset);
  }
  for (let depth = 0; selected.length < params.maxAssets; depth += 1) {
    let progressed = false;
    for (const lock of locks) {
      const asset = lock.styleReferences[depth];
      if (asset && take(asset)) {
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }

  return Object.freeze({
    assets: Object.freeze(
      selected.toSorted((left, right) => KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]),
    ),
    perCharacterIdentityCount: Object.freeze(perCharacterIdentityCount),
  });
}

/** Rejects a cast the owner did not unambiguously name. */
export function normalizeCharacterCodes(raw: readonly string[]): string[] {
  const codes = raw.map((value) => value.trim()).filter((value) => value.length > 0);
  if (codes.length === 0) {
    throw new Error("At least one character must be requested");
  }
  const seen = new Set<string>();
  for (const code of codes) {
    const key = code.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Character "${code}" was requested more than once`);
    }
    seen.add(key);
  }
  return codes;
}
