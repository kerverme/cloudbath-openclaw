import crypto from "node:crypto";
import {
  applyStoryboardTimeRangeEdit,
  type StoryboardTimeRangeEdit,
} from "./storyboard-compiler.js";
import type {
  StoryboardAccessClaim,
  StoryboardDocument,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

/**
 * Durable storyboard storage: an append-only version chain plus a head pointer.
 *
 * Versions are never rewritten. An edit appends v2 and moves the head; v1 stays
 * retrievable, because comparing what changed between versions is the point of
 * storyboard review. The version namespace is opened with `reject-new` so a
 * full store surfaces an error instead of silently evicting an older version
 * the owner still expects to be able to look at.
 */

export const CLOUDBATH_STORYBOARD_HEAD_NAMESPACE = "cloudbath-storyboard-head-v1";
export const CLOUDBATH_STORYBOARD_VERSION_NAMESPACE = "cloudbath-storyboard-version-v1";
export const CLOUDBATH_STORYBOARD_ACTIVE_NAMESPACE = "cloudbath-storyboard-active-v1";
export const CLOUDBATH_STORYBOARD_DEDUPE_NAMESPACE = "cloudbath-storyboard-dedupe-v1";
export const CLOUDBATH_STORYBOARD_DRAFT_NAMESPACE = "cloudbath-storyboard-draft-v1";
export const CLOUDBATH_STORYBOARD_MAX_ENTRIES = 20_000;
/**
 * How long a storyboard stays the owner's ACTIVE one.
 *
 * Long enough to iterate on a scene across a conversation, short enough that an
 * abandoned storyboard stops intercepting "สร้างวิดีโอ" and bare time-range
 * edits. The version history it points at is durable and never expires.
 */
export const CLOUDBATH_STORYBOARD_ACTIVE_TTL_MS = 24 * 60 * 60 * 1_000;

export function storyboardHeadKey(storyboardId: string): string {
  return `storyboard-head:${storyboardId}`;
}

export function storyboardVersionKey(storyboardId: string, versionNumber: number): string {
  return `storyboard-version:${storyboardId}:${versionNumber}`;
}

export function createStoryboardId(): string {
  return `sb_${crypto.randomBytes(12).toString("hex")}`;
}

export type StoryboardStoreDeps = Readonly<{
  heads: AsyncKeyedStore<StoryboardHead>;
  versions: AsyncKeyedStore<StoryboardVersion>;
  now: () => number;
}>;

export type CreateStoryboardParams = Readonly<{
  document: StoryboardDocument;
  claim: StoryboardAccessClaim;
  projectInstanceId: string;
  projectPageId: string;
  sceneId: string;
  scenePageId: string;
  characterLocks: readonly UgcCharacterLock[];
}>;

export class StoryboardStore {
  constructor(private readonly deps: StoryboardStoreDeps) {}

  /** Creates version 1 and its head pointer. Calls no provider. */
  async createStoryboard(
    params: CreateStoryboardParams,
  ): Promise<{ head: StoryboardHead; version: StoryboardVersion }> {
    const storyboardId = createStoryboardId();
    const createdAt = new Date(this.deps.now()).toISOString();
    const version: StoryboardVersion = Object.freeze({
      version: 1,
      storyboardId,
      versionNumber: 1,
      projectInstanceId: params.projectInstanceId,
      projectPageId: params.projectPageId,
      sceneId: params.sceneId,
      scenePageId: params.scenePageId,
      accountId: params.claim.accountId,
      lineGroupId: params.claim.lineGroupId,
      ownerSenderId: params.claim.ownerSenderId,
      characterLocks: Object.freeze([...params.characterLocks]),
      document: params.document,
      createdAt,
    });
    const head: StoryboardHead = Object.freeze({
      version: 1,
      storyboardId,
      projectInstanceId: params.projectInstanceId,
      accountId: params.claim.accountId,
      lineGroupId: params.claim.lineGroupId,
      ownerSenderId: params.claim.ownerSenderId,
      latestVersionNumber: 1,
      updatedAt: createdAt,
    });
    const claimed = await this.deps.versions.registerIfAbsent(
      storyboardVersionKey(storyboardId, 1),
      version,
    );
    if (!claimed) {
      throw new Error("Storyboard version was written concurrently; retry the request");
    }
    await this.deps.heads.register(storyboardHeadKey(storyboardId), head);
    return { head, version };
  }

  /**
   * Appends an edited version derived from the current head.
   *
   * The parent document is read from the chain rather than taken from the
   * caller, so a stale client cannot discard an intervening version's beats.
   */
  async appendEdit(params: {
    storyboardId: string;
    claim: StoryboardAccessClaim;
    edit: StoryboardTimeRangeEdit;
    baseVersionNumber?: number;
  }): Promise<StoryboardVersion> {
    const head = await this.requireHead(params.storyboardId, params.claim);
    const baseNumber = params.baseVersionNumber ?? head.latestVersionNumber;
    const base = await this.deps.versions.lookup(
      storyboardVersionKey(params.storyboardId, baseNumber),
    );
    if (!base) {
      throw new Error("Storyboard base version does not exist");
    }
    const document = applyStoryboardTimeRangeEdit(base.document, params.edit);
    const versionNumber = head.latestVersionNumber + 1;
    const updatedAt = new Date(this.deps.now()).toISOString();
    const version: StoryboardVersion = Object.freeze({
      ...base,
      versionNumber,
      parentVersionNumber: baseNumber,
      document,
      createdAt: updatedAt,
    });
    // Claim the slot atomically. Two concurrent edits read the same head, so
    // without this the second would overwrite the first and lose an edit the
    // owner believes was saved.
    const claimed = await this.deps.versions.registerIfAbsent(
      storyboardVersionKey(params.storyboardId, versionNumber),
      version,
    );
    if (!claimed) {
      throw new Error("Storyboard version was written concurrently; retry the edit");
    }
    await this.deps.heads.register(
      storyboardHeadKey(params.storyboardId),
      Object.freeze({ ...head, latestVersionNumber: versionNumber, updatedAt }),
    );
    return version;
  }

  /** Owner-scoped read of the latest version. */
  async readLatest(params: {
    storyboardId: string;
    claim: StoryboardAccessClaim;
  }): Promise<StoryboardVersion | undefined> {
    const head = await this.requireHead(params.storyboardId, params.claim);
    return await this.deps.versions.lookup(
      storyboardVersionKey(params.storyboardId, head.latestVersionNumber),
    );
  }

  /** Owner-scoped read of one historical version. */
  async readVersion(params: {
    storyboardId: string;
    claim: StoryboardAccessClaim;
    versionNumber: number;
  }): Promise<StoryboardVersion | undefined> {
    await this.requireHead(params.storyboardId, params.claim);
    return await this.deps.versions.lookup(
      storyboardVersionKey(params.storyboardId, params.versionNumber),
    );
  }

  private async requireHead(
    storyboardId: string,
    claim: StoryboardAccessClaim,
  ): Promise<StoryboardHead> {
    const head = await this.deps.heads.lookup(storyboardHeadKey(storyboardId));
    // Fail closed on every element of the trusted triple: a storyboard is owner
    // scoped exactly like the UGC project it links to.
    if (
      !head ||
      head.accountId !== claim.accountId ||
      head.lineGroupId !== claim.lineGroupId ||
      head.ownerSenderId !== claim.ownerSenderId
    ) {
      throw new Error("Storyboard is not accessible to this owner");
    }
    return head;
  }
}

export function activeStoryboardKey(claim: StoryboardAccessClaim): string {
  return `storyboard-active:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}`;
}
