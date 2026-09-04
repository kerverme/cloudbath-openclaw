import { createHash, randomBytes } from "node:crypto";
import type { StoryboardAccessClaim, StoryboardVersion } from "./storyboard-types.js";
import type { AsyncKeyedStore, UgcReferenceAsset } from "./types.js";

export const CLOUDBATH_STORYBOARD_VISUAL_NAMESPACE = "cloudbath-storyboard-visual-v1";
export const CLOUDBATH_STORYBOARD_VISUAL_ROUTE = "/plugins/cloudbath/storyboard-visual";
const LINE_ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
const LINE_PREVIEW_MAX_BYTES = 1024 * 1024;

export type StoryboardVisualArtifact = Readonly<{
  version: 1;
  artifactId: string;
  storyboardId: string;
  storyboardVersionNumber: number;
  shotIndex: number;
  beatId: string;
  accountId: string;
  ownerSenderId: string;
  conversationId: string;
  sourceCharacterIds: readonly string[];
  sourceReferenceAssetIds: readonly string[];
  originalObjectKey: string;
  previewObjectKey: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byteSize: number;
  generationProvider: string;
  generationModel: string;
  generationPurpose: "storyboard-shot";
  status: "completed";
  createdAt: string;
}>;

export type StoryboardVisualStatus =
  | Readonly<{ kind: "not_generated" | "regeneration_required" }>
  | Readonly<{
      kind: "partial" | "ready";
      artifacts: readonly StoryboardVisualArtifact[];
      failedShotIndexes: readonly number[];
    }>;

export function storyboardVisualKey(
  storyboardId: string,
  storyboardVersionNumber: number,
  shotIndex: number,
): string {
  return `storyboard-visual:${storyboardId}:${storyboardVersionNumber}:${shotIndex}`;
}

export function storyboardVisualUrl(params: {
  publicAssetBaseUrl: string;
  artifactId: string;
  variant: "original" | "preview";
}): string {
  const base = new URL(params.publicAssetBaseUrl);
  base.pathname = `${CLOUDBATH_STORYBOARD_VISUAL_ROUTE}/${params.artifactId}/${params.variant}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export type GeneratedStoryboardShot = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  model: string;
}>;

export type StoryboardVisualServiceDeps = Readonly<{
  artifacts: AsyncKeyedStore<StoryboardVisualArtifact>;
  generate(params: {
    version: StoryboardVersion;
    shotIndex: number;
    identityReferences: readonly UgcReferenceAsset[];
  }): Promise<GeneratedStoryboardShot>;
  normalize(params: {
    bytes: Uint8Array;
    mimeType: string;
    maxWidth: number;
    maxHeight: number;
  }): Promise<
    Readonly<{
      bytes: Uint8Array;
      mimeType: "image/jpeg" | "image/png";
      width: number;
      height: number;
    }>
  >;
  persist(params: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: "image/jpeg" | "image/png";
    sha256: string;
  }): Promise<void>;
  now: () => number;
  randomId?: () => string;
  concurrency?: number;
  logger?: {
    info?(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  };
}>;

/**
 * Whether a stored row is a real per-shot artifact this version can be judged on.
 *
 * Purpose is load-bearing, not decoration. A contact sheet is a DERIVED review
 * preview of shots that already exist, and a generic image the assistant
 * happened to attach is neither — treating either as a shot would let a
 * storyboard look ready with no authoritative visual behind it, which is the
 * exact separation this predicate closes. Scope is re-checked here too, so a
 * row written for one owner's storyboard can never satisfy another's.
 */
function isAuthoritativeShotArtifact(
  artifact: StoryboardVisualArtifact | undefined,
): artifact is StoryboardVisualArtifact {
  return (
    artifact?.generationPurpose === "storyboard-shot" &&
    artifact.status === "completed" &&
    Number.isInteger(artifact.shotIndex) &&
    artifact.shotIndex >= 1
  );
}

/**
 * A contact sheet as this flow is allowed to use it: a review preview DERIVED
 * from artifacts that already exist, listed newest-shot-last.
 *
 * Returned only for a `ready` status on purpose. A sheet built from a partial
 * set would show the owner a complete-looking storyboard whose shots are not
 * all there, and this flow has exactly one definition of complete.
 */
export function deriveContactSheetPreview(
  status: StoryboardVisualStatus,
): Readonly<{ kind: "derived_preview"; shotArtifactIds: readonly string[] }> | undefined {
  return status.kind === "ready"
    ? Object.freeze({
        kind: "derived_preview" as const,
        shotArtifactIds: Object.freeze(status.artifacts.map((artifact) => artifact.artifactId)),
      })
    : undefined;
}

function requireAccess(version: StoryboardVersion, claim: StoryboardAccessClaim): void {
  if (
    version.accountId !== claim.accountId ||
    version.lineGroupId !== claim.lineGroupId ||
    version.ownerSenderId !== claim.ownerSenderId
  ) {
    throw new Error("Storyboard visuals are not accessible to this owner");
  }
}

function objectKey(params: {
  storyboardId: string;
  versionNumber: number;
  shotIndex: number;
  variant: "original" | "preview";
  sha256: string;
  mimeType: "image/jpeg" | "image/png";
}): string {
  const extension = params.mimeType === "image/png" ? "png" : "jpg";
  return `storyboards/${params.storyboardId}/v${params.versionNumber}/shots/${params.shotIndex}/${params.variant}-${params.sha256}.${extension}`;
}

export class StoryboardVisualService {
  constructor(private readonly deps: StoryboardVisualServiceDeps) {}

  async status(params: {
    version: StoryboardVersion;
    claim: StoryboardAccessClaim;
  }): Promise<StoryboardVisualStatus> {
    requireAccess(params.version, params.claim);
    const artifacts = (
      await Promise.all(
        params.version.document.beats.map((_, index) =>
          this.deps.artifacts.lookup(
            storyboardVisualKey(
              params.version.storyboardId,
              params.version.versionNumber,
              index + 1,
            ),
          ),
        ),
      )
    ).filter(isAuthoritativeShotArtifact);
    if (artifacts.length === 0) {
      return params.version.versionNumber > 1
        ? { kind: "regeneration_required" }
        : { kind: "not_generated" };
    }
    const failedShotIndexes = params.version.document.beats
      .map((_, index) => index + 1)
      .filter((index) => !artifacts.some((artifact) => artifact.shotIndex === index));
    return {
      kind: failedShotIndexes.length === 0 ? "ready" : "partial",
      artifacts: Object.freeze(artifacts.toSorted((a, b) => a.shotIndex - b.shotIndex)),
      failedShotIndexes: Object.freeze(failedShotIndexes),
    };
  }

  async generate(params: {
    version: StoryboardVersion;
    claim: StoryboardAccessClaim;
    shotIndexes?: readonly number[];
  }): Promise<StoryboardVisualStatus> {
    requireAccess(params.version, params.claim);
    const requested = new Set(
      params.shotIndexes ?? params.version.document.beats.map((_, index) => index + 1),
    );
    const jobs = [...requested]
      .filter(
        (index) =>
          Number.isInteger(index) && index >= 1 && index <= params.version.document.beats.length,
      )
      .toSorted((a, b) => a - b);
    if (jobs.length === 0) {
      throw new Error("No valid storyboard shots were requested");
    }
    this.deps.logger?.info?.("storyboard_visual_generation_requested", {
      storyboardId: params.version.storyboardId,
      storyboardVersion: params.version.versionNumber,
      shotCount: jobs.length,
    });
    const concurrency = Math.max(1, Math.min(this.deps.concurrency ?? 2, 3));
    let cursor = 0;
    const failures: number[] = [];
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const shotIndex = jobs[cursor++]!;
        try {
          await this.generateOne(params.version, shotIndex);
        } catch (error) {
          failures.push(shotIndex);
          this.deps.logger?.warn("storyboard_visual_generation_failed", {
            storyboardId: params.version.storyboardId,
            storyboardVersion: params.version.versionNumber,
            shotIndex,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    });
    await Promise.all(workers);
    const status = await this.status(params);
    this.deps.logger?.info?.("storyboard_visual_generation_completed", {
      storyboardId: params.version.storyboardId,
      storyboardVersion: params.version.versionNumber,
      completedShotCount:
        status.kind === "ready" || status.kind === "partial" ? status.artifacts.length : 0,
      failedShotCount: failures.length,
    });
    return status;
  }

  private async generateOne(version: StoryboardVersion, shotIndex: number): Promise<void> {
    const beat = version.document.beats[shotIndex - 1]!;
    const identityReferences = version.characterLocks.flatMap((lock) => lock.identityReferences);
    const generated = await this.deps.generate({ version, shotIndex, identityReferences });
    const original = await this.deps.normalize({
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      maxWidth: 4096,
      maxHeight: 4096,
    });
    const preview = await this.deps.normalize({
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      maxWidth: 240,
      maxHeight: 240,
    });
    if (
      original.bytes.byteLength > LINE_ORIGINAL_MAX_BYTES ||
      preview.bytes.byteLength > LINE_PREVIEW_MAX_BYTES
    ) {
      throw new Error("Normalized storyboard image exceeds LINE image limits");
    }
    const originalSha = createHash("sha256").update(original.bytes).digest("hex");
    const previewSha = createHash("sha256").update(preview.bytes).digest("hex");
    const originalObjectKey = objectKey({
      storyboardId: version.storyboardId,
      versionNumber: version.versionNumber,
      shotIndex,
      variant: "original",
      sha256: originalSha,
      mimeType: original.mimeType,
    });
    const previewObjectKey = objectKey({
      storyboardId: version.storyboardId,
      versionNumber: version.versionNumber,
      shotIndex,
      variant: "preview",
      sha256: previewSha,
      mimeType: preview.mimeType,
    });
    await Promise.all([
      this.deps.persist({
        objectKey: originalObjectKey,
        bytes: original.bytes,
        contentType: original.mimeType,
        sha256: originalSha,
      }),
      this.deps.persist({
        objectKey: previewObjectKey,
        bytes: preview.bytes,
        contentType: preview.mimeType,
        sha256: previewSha,
      }),
    ]);
    const artifact: StoryboardVisualArtifact = Object.freeze({
      version: 1,
      artifactId: this.deps.randomId?.() ?? randomBytes(18).toString("hex"),
      storyboardId: version.storyboardId,
      storyboardVersionNumber: version.versionNumber,
      shotIndex,
      beatId: beat.beatId,
      accountId: version.accountId,
      ownerSenderId: version.ownerSenderId,
      conversationId: version.lineGroupId,
      sourceCharacterIds: Object.freeze(version.characterLocks.map((lock) => lock.code)),
      sourceReferenceAssetIds: Object.freeze(
        identityReferences.map((reference) => reference.locator),
      ),
      originalObjectKey,
      previewObjectKey,
      mimeType: original.mimeType,
      width: original.width,
      height: original.height,
      byteSize: original.bytes.byteLength,
      generationProvider: generated.provider,
      generationModel: generated.model,
      generationPurpose: "storyboard-shot",
      status: "completed",
      createdAt: new Date(this.deps.now()).toISOString(),
    });
    await this.deps.artifacts.register(
      storyboardVisualKey(version.storyboardId, version.versionNumber, shotIndex),
      artifact,
    );
    await this.deps.artifacts.register(
      `storyboard-visual-artifact:${artifact.artifactId}`,
      artifact,
    );
    this.deps.logger?.info?.("storyboard_visual_artifact_persisted", {
      storyboardId: version.storyboardId,
      storyboardVersion: version.versionNumber,
      shotIndex,
      artifactId: artifact.artifactId,
      mimeType: artifact.mimeType,
      byteSize: artifact.byteSize,
    });
  }
}
