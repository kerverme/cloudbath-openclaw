import crypto from "node:crypto";
import { applyTimeRangeEdit, type PrevisTimeRangeEdit } from "./previs-document.js";
import type {
  PrevisAccessClaim,
  PrevisDeferral,
  PrevisDocument,
  PrevisProjectHead,
  PrevisVersion,
} from "./previs-types.js";
import {
  buildPrevisViewUrl,
  createPrevisProjectId,
  createPrevisReviewToken,
} from "./previs-url.js";
import { buildContentAddressedObjectKey } from "./r2.js";
import type { AsyncKeyedStore } from "./types.js";

/**
 * Durable previs storage: an append-only version chain plus a head pointer.
 *
 * Versions are never rewritten. An edit appends v2 and moves the head; v1 stays
 * retrievable because the whole point of previs review is comparing what
 * changed. Approval marks one version and freezes it — it does not collapse the
 * chain, and it performs no generation.
 */

export const CLOUDBATH_PREVIS_HEAD_NAMESPACE = "cloudbath-previs-head-v1";
export const CLOUDBATH_PREVIS_VERSION_NAMESPACE = "cloudbath-previs-version-v1";
/** Previs history outlives any scope window; the chain must not be evicted mid-review. */
export const CLOUDBATH_PREVIS_MAX_ENTRIES = 20_000;

export function previsHeadKey(previsProjectId: string): string {
  return `previs-head:${previsProjectId}`;
}

export function previsVersionKey(previsProjectId: string, versionNumber: number): string {
  return `previs-version:${previsProjectId}:${versionNumber}`;
}

/**
 * The CozyClay side of the boundary. Implemented by the MCP adapter; injected so
 * the previs layer stays deterministic and testable with no engine running.
 */
export type PrevisEngine = Readonly<{
  /** Runs a compiled plan and returns the `.cclayproject` document as text. */
  renderProjectArtifact(params: { document: PrevisDocument; projectName: string }): Promise<string>;
}>;

/** Private-R2 sink for previs artifacts. Object keys are the canonical identity. */
export type PrevisArtifactSink = Readonly<{
  putPrivateArtifact(params: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<void>;
}>;

export type PrevisStoreDeps = Readonly<{
  heads: AsyncKeyedStore<PrevisProjectHead>;
  versions: AsyncKeyedStore<PrevisVersion>;
  now: () => number;
  /** Key prefix inside the PRIVATE bucket. Never a public or signed URL. */
  artifactKeyPrefix: string;
}>;

export class PrevisStore {
  constructor(private readonly deps: PrevisStoreDeps) {}

  /**
   * Creates version 1. The engine runs BEFORE anything is persisted, so an
   * unavailable or failing CozyClay leaves no half-written previs project
   * behind — the caller sees the failure and Cloudbath state is untouched.
   */
  async createProject(params: {
    document: PrevisDocument;
    sceneId: string;
    projectInstanceId: string;
    claim: PrevisAccessClaim;
    engine?: PrevisEngine;
    artifacts?: PrevisArtifactSink;
    deferrals: readonly PrevisDeferral[];
  }): Promise<{ head: PrevisProjectHead; version: PrevisVersion }> {
    const previsProjectId = createPrevisProjectId();
    const createdAt = new Date(this.deps.now()).toISOString();
    const artifactObjectKey = await this.storeArtifact(params);
    const version: PrevisVersion = Object.freeze({
      version: 1,
      previsProjectId,
      sceneId: params.sceneId,
      versionNumber: 1,
      projectInstanceId: params.projectInstanceId,
      accountId: params.claim.accountId,
      lineGroupId: params.claim.lineGroupId,
      ownerSenderId: params.claim.ownerSenderId,
      frozenCharacterPageIds: Object.freeze(
        params.document.cast.map((member) => member.characterPageId),
      ),
      document: params.document,
      ...(artifactObjectKey ? { artifactObjectKey } : {}),
      deferredCapabilities: params.deferrals,
      createdAt,
    });
    const head: PrevisProjectHead = Object.freeze({
      version: 1,
      previsProjectId,
      sceneId: params.sceneId,
      projectInstanceId: params.projectInstanceId,
      accountId: params.claim.accountId,
      lineGroupId: params.claim.lineGroupId,
      ownerSenderId: params.claim.ownerSenderId,
      reviewToken: createPrevisReviewToken(),
      latestVersionNumber: 1,
      updatedAt: createdAt,
    });
    await this.deps.versions.register(previsVersionKey(previsProjectId, 1), version);
    await this.deps.heads.register(previsHeadKey(previsProjectId), head);
    return { head, version };
  }

  /**
   * Appends an edited version. The parent document is read from the chain, not
   * from the caller, so a stale client cannot silently discard an intervening
   * version's blocking.
   */
  async appendEdit(params: {
    previsProjectId: string;
    claim: PrevisAccessClaim;
    edit: PrevisTimeRangeEdit;
    baseVersionNumber?: number;
    engine?: PrevisEngine;
    artifacts?: PrevisArtifactSink;
  }): Promise<PrevisVersion> {
    const head = await this.requireHead(params.previsProjectId, params.claim);
    const baseNumber = params.baseVersionNumber ?? head.latestVersionNumber;
    const base = await this.deps.versions.lookup(
      previsVersionKey(params.previsProjectId, baseNumber),
    );
    if (!base) {
      throw new Error("Previs base version does not exist");
    }
    const document = applyTimeRangeEdit(base.document, params.edit);
    const artifactObjectKey = await this.storeArtifact({
      document,
      engine: params.engine,
      artifacts: params.artifacts,
    });
    const versionNumber = head.latestVersionNumber + 1;
    const updatedAt = new Date(this.deps.now()).toISOString();
    const { approvedAt: _parentApproval, ...carried } = base;
    const version: PrevisVersion = Object.freeze({
      // A new version starts unapproved: inheriting the parent's approval would
      // let an edit ride into the paid pipeline on an older version's consent.
      ...carried,
      versionNumber,
      parentVersionNumber: baseNumber,
      document,
      ...(artifactObjectKey ? { artifactObjectKey } : {}),
      createdAt: updatedAt,
    });
    // Claim the slot atomically. Two concurrent edits both read the same head,
    // so without this the second would overwrite the first's version and lose
    // an edit the owner believes was saved.
    const claimed = await this.deps.versions.registerIfAbsent(
      previsVersionKey(params.previsProjectId, versionNumber),
      version,
    );
    if (!claimed) {
      throw new Error("Previs version was written concurrently; retry the edit");
    }
    await this.deps.heads.register(
      previsHeadKey(params.previsProjectId),
      Object.freeze({ ...head, latestVersionNumber: versionNumber, updatedAt }),
    );
    return version;
  }

  /**
   * Marks one version approved and frozen. This is a state change only: it
   * starts no generation, calls no provider, and does not stand in for the
   * exact `ยืนยัน VIDEO ####` confirmation the paid pipeline still requires.
   */
  async approve(params: {
    previsProjectId: string;
    claim: PrevisAccessClaim;
    versionNumber?: number;
  }): Promise<PrevisVersion> {
    const head = await this.requireHead(params.previsProjectId, params.claim);
    const versionNumber = params.versionNumber ?? head.latestVersionNumber;
    const key = previsVersionKey(params.previsProjectId, versionNumber);
    const version = await this.deps.versions.lookup(key);
    if (!version) {
      throw new Error("Previs version does not exist");
    }
    if (version.approvedAt) {
      return version;
    }
    const approved = Object.freeze({
      ...version,
      approvedAt: new Date(this.deps.now()).toISOString(),
    });
    await this.deps.versions.register(key, approved);
    await this.deps.heads.register(
      previsHeadKey(params.previsProjectId),
      Object.freeze({
        ...head,
        approvedVersionNumber: versionNumber,
        updatedAt: approved.approvedAt,
      }),
    );
    return approved;
  }

  /**
   * Owner-scoped read of the latest version.
   *
   * Authorised by the trusted account/group/owner triple, NOT by the browser
   * capability token: a LINE mutation must never be gated on a URL secret.
   */
  async readLatest(params: {
    previsProjectId: string;
    claim: PrevisAccessClaim;
  }): Promise<PrevisVersion | undefined> {
    const head = await this.requireHead(params.previsProjectId, params.claim);
    return await this.deps.versions.lookup(
      previsVersionKey(params.previsProjectId, head.latestVersionNumber),
    );
  }

  /** Resolves the stable review URL to a version: latest by default. */
  async resolveForReview(params: {
    previsProjectId: string;
    token: string;
    versionNumber?: number;
  }): Promise<{ head: PrevisProjectHead; version: PrevisVersion } | undefined> {
    const head = await this.deps.heads.lookup(previsHeadKey(params.previsProjectId));
    if (!head || !timingSafeEqual(head.reviewToken, params.token)) {
      return undefined;
    }
    const versionNumber = params.versionNumber ?? head.latestVersionNumber;
    const version = await this.deps.versions.lookup(
      previsVersionKey(params.previsProjectId, versionNumber),
    );
    return version ? { head, version } : undefined;
  }

  reviewUrl(head: PrevisProjectHead, publicAssetBaseUrl: string): string {
    return buildPrevisViewUrl({
      publicAssetBaseUrl,
      previsProjectId: head.previsProjectId,
      token: head.reviewToken,
    });
  }

  private async requireHead(
    previsProjectId: string,
    claim: PrevisAccessClaim,
  ): Promise<PrevisProjectHead> {
    const head = await this.deps.heads.lookup(previsHeadKey(previsProjectId));
    // Fail closed on every element of the trusted triple. A previs is owner
    // scoped exactly like the UGC scope it will feed.
    if (
      !head ||
      head.accountId !== claim.accountId ||
      head.lineGroupId !== claim.lineGroupId ||
      head.ownerSenderId !== claim.ownerSenderId
    ) {
      throw new Error("Previs project is not accessible to this owner");
    }
    return head;
  }

  /** Renders and stores the artifact, returning its durable private-R2 key. */
  private async storeArtifact(params: {
    document: PrevisDocument;
    engine?: PrevisEngine;
    artifacts?: PrevisArtifactSink;
  }): Promise<string | undefined> {
    if (!params.engine || !params.artifacts) {
      return undefined;
    }
    const artifact = await params.engine.renderProjectArtifact({
      document: params.document,
      projectName: params.document.scenePrompt.slice(0, 60),
    });
    const body = new TextEncoder().encode(artifact);
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    const objectKey = buildContentAddressedObjectKey({
      keyPrefix: this.deps.artifactKeyPrefix,
      sha256,
      extension: ".json",
    });
    await params.artifacts.putPrivateArtifact({
      objectKey,
      body,
      contentType: "application/json",
      sha256,
    });
    return objectKey;
  }
}

function timingSafeEqual(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
