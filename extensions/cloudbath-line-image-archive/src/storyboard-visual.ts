import { createHash, randomBytes } from "node:crypto";
import type {
  StoryboardAccessClaim,
  StoryboardSourceImage,
  StoryboardVersion,
} from "./storyboard-types.js";
import type { AsyncKeyedStore, UgcReferenceAsset } from "./types.js";

export const CLOUDBATH_STORYBOARD_VISUAL_NAMESPACE = "cloudbath-storyboard-visual-v1";
export const CLOUDBATH_STORYBOARD_VISUAL_ROUTE = "/plugins/cloudbath/storyboard-visual";
const LINE_ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
const LINE_PREVIEW_MAX_BYTES = 1024 * 1024;

type StoryboardVisualArtifactBase = Readonly<{
  version: 1;
  artifactId: string;
  storyboardId: string;
  storyboardVersionNumber: number;
  accountId: string;
  ownerSenderId: string;
  conversationId: string;
  sourceCharacterIds: readonly string[];
  sourceReferenceAssetIds: readonly string[];
  /** The owner-selected first frame this shot was rendered from, if any. */
  sourceImageMediaId?: string;
  originalObjectKey: string;
  previewObjectKey: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byteSize: number;
  generationProvider: string;
  generationModel: string;
  status: "completed";
  createdAt: string;
}>;

export type StoryboardShotVisualArtifact = StoryboardVisualArtifactBase &
  Readonly<{
    shotIndex: number;
    beatId: string;
    generationPurpose: "storyboard-shot";
  }>;

export type StoryboardContactSheetArtifact = StoryboardVisualArtifactBase &
  Readonly<{
    generationPurpose: "storyboard-contact-sheet";
    panels: readonly Readonly<{
      shotIndex: number;
      shotArtifactId: string;
      caption: string;
    }>[];
  }>;

export type StoryboardVisualArtifact =
  | StoryboardShotVisualArtifact
  | StoryboardContactSheetArtifact;

export type StoryboardVisualStatus =
  | Readonly<{ kind: "not_generated" | "regeneration_required" }>
  | Readonly<{
      kind: "partial" | "ready";
      artifacts: readonly StoryboardShotVisualArtifact[];
      failedShotIndexes: readonly number[];
      contactSheet?: StoryboardContactSheetArtifact;
    }>;

export function storyboardVisualKey(
  storyboardId: string,
  storyboardVersionNumber: number,
  shotIndex: number,
): string {
  return `storyboard-visual:${storyboardId}:${storyboardVersionNumber}:${shotIndex}`;
}

export function storyboardContactSheetKey(
  storyboardId: string,
  storyboardVersionNumber: number,
): string {
  return `storyboard-contact-sheet:${storyboardId}:${storyboardVersionNumber}`;
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
    /** Frozen Character Library identities, in cast order. */
    identityReferences: readonly UgcReferenceAsset[];
    /**
     * The owner's chosen first frame, when this scene is built from one.
     *
     * Kept separate from `identityReferences` on purpose: a first frame says
     * what the shot LOOKS like, an identity says WHO is in it. Folding one into
     * the other would make an ordinary photo behave like a frozen Character
     * lock, and no consumer could tell them apart afterwards.
     */
    sourceImage?: StoryboardSourceImage;
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
  read?(params: { objectKey: string }): Promise<Readonly<{ bytes: Uint8Array; mimeType: string }>>;
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
): artifact is StoryboardShotVisualArtifact {
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
): StoryboardContactSheetArtifact | undefined {
  return status.kind === "ready" ? status.contactSheet : undefined;
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

function contactSheetObjectKey(params: {
  storyboardId: string;
  versionNumber: number;
  variant: "original" | "preview";
  sha256: string;
}): string {
  return `storyboards/${params.storyboardId}/v${params.versionNumber}/contact-sheet/${params.variant}-${params.sha256}.jpg`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function composeContactSheetSvg(params: {
  panels: readonly Readonly<{ bytes: Uint8Array; mimeType: string; caption: string }>[];
}): Uint8Array {
  const columns = 3;
  const panelWidth = 512;
  const imageHeight = 320;
  const captionHeight = 96;
  const rows = Math.ceil(params.panels.length / columns);
  const cells = params.panels
    .map((panel, index) => {
      const x = (index % columns) * panelWidth;
      const y = Math.floor(index / columns) * (imageHeight + captionHeight);
      const data = Buffer.from(panel.bytes).toString("base64");
      const caption = escapeXml(panel.caption.slice(0, 80));
      return [
        `<rect x="${x}" y="${y}" width="${panelWidth}" height="${imageHeight + captionHeight}" fill="#111827"/>`,
        `<image x="${x}" y="${y}" width="${panelWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid slice" href="data:${panel.mimeType};base64,${data}"/>`,
        `<text x="${x + 20}" y="${y + imageHeight + 34}" fill="#ffffff" font-size="22" font-family="sans-serif">Shot ${index + 1}</text>`,
        `<text x="${x + 20}" y="${y + imageHeight + 68}" fill="#e5e7eb" font-size="18" font-family="sans-serif">${caption}</text>`,
      ].join("");
    })
    .join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * panelWidth}" height="${rows * (imageHeight + captionHeight)}" viewBox="0 0 ${columns * panelWidth} ${rows * (imageHeight + captionHeight)}">${cells}</svg>`,
  );
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
    const contactSheet = await this.deps.artifacts.lookup(
      storyboardContactSheetKey(params.version.storyboardId, params.version.versionNumber),
    );
    return {
      kind: failedShotIndexes.length === 0 ? "ready" : "partial",
      artifacts: Object.freeze(artifacts.toSorted((a, b) => a.shotIndex - b.shotIndex)),
      failedShotIndexes: Object.freeze(failedShotIndexes),
      ...(contactSheet?.generationPurpose === "storyboard-contact-sheet" ? { contactSheet } : {}),
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
    const existing = await this.status(params);
    const completed = new Set(
      existing.kind === "ready" || existing.kind === "partial"
        ? existing.artifacts.map((artifact) => artifact.shotIndex)
        : [],
    );
    const jobs = [...requested]
      .filter(
        (index) =>
          Number.isInteger(index) &&
          index >= 1 &&
          index <= params.version.document.beats.length &&
          (params.shotIndexes !== undefined || !completed.has(index)),
      )
      .toSorted((a, b) => a - b);
    if (jobs.length === 0) {
      return existing;
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
    let status = await this.status(params);
    if (status.kind === "ready" && !status.contactSheet && this.deps.read) {
      await this.generateContactSheet(params.version, status.artifacts);
      status = await this.status(params);
    }
    this.deps.logger?.info?.("storyboard_visual_generation_completed", {
      storyboardId: params.version.storyboardId,
      storyboardVersion: params.version.versionNumber,
      completedShotCount:
        status.kind === "ready" || status.kind === "partial" ? status.artifacts.length : 0,
      failedShotCount: failures.length,
    });
    return status;
  }

  private async generateContactSheet(
    version: StoryboardVersion,
    artifacts: readonly StoryboardShotVisualArtifact[],
  ): Promise<void> {
    const panels = await Promise.all(
      artifacts.map(async (artifact) => {
        const media = await this.deps.read!({ objectKey: artifact.previewObjectKey });
        const beat = version.document.beats[artifact.shotIndex - 1]!;
        return {
          bytes: media.bytes,
          mimeType: media.mimeType,
          caption: beat.caption?.trim() || beat.action.slice(0, 80),
        };
      }),
    );
    const svg = composeContactSheetSvg({ panels });
    const original = await this.deps.normalize({
      bytes: svg,
      mimeType: "image/svg+xml",
      maxWidth: 2048,
      maxHeight: 2048,
    });
    const preview = await this.deps.normalize({
      bytes: svg,
      mimeType: "image/svg+xml",
      maxWidth: 240,
      maxHeight: 240,
    });
    const originalSha = createHash("sha256").update(original.bytes).digest("hex");
    const previewSha = createHash("sha256").update(preview.bytes).digest("hex");
    const originalObjectKey = contactSheetObjectKey({
      storyboardId: version.storyboardId,
      versionNumber: version.versionNumber,
      variant: "original",
      sha256: originalSha,
    });
    const previewObjectKey = contactSheetObjectKey({
      storyboardId: version.storyboardId,
      versionNumber: version.versionNumber,
      variant: "preview",
      sha256: previewSha,
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
    const artifact: StoryboardContactSheetArtifact = Object.freeze({
      version: 1,
      artifactId: this.deps.randomId?.() ?? randomBytes(18).toString("hex"),
      storyboardId: version.storyboardId,
      storyboardVersionNumber: version.versionNumber,
      accountId: version.accountId,
      ownerSenderId: version.ownerSenderId,
      conversationId: version.lineGroupId,
      sourceCharacterIds: Object.freeze(version.characterLocks.map((lock) => lock.code)),
      sourceReferenceAssetIds: Object.freeze([]),
      originalObjectKey,
      previewObjectKey,
      mimeType: original.mimeType,
      width: original.width,
      height: original.height,
      byteSize: original.bytes.byteLength,
      generationProvider: "derived",
      generationModel: "contact-sheet-svg-v1",
      generationPurpose: "storyboard-contact-sheet",
      status: "completed",
      panels: Object.freeze(
        artifacts.map((shot, index) =>
          Object.freeze({
            shotIndex: shot.shotIndex,
            shotArtifactId: shot.artifactId,
            caption:
              version.document.beats[index]?.caption?.trim() ||
              version.document.beats[index]?.action.slice(0, 80) ||
              `Shot ${shot.shotIndex}`,
          }),
        ),
      ),
      createdAt: new Date(this.deps.now()).toISOString(),
    });
    await this.deps.artifacts.register(
      storyboardContactSheetKey(version.storyboardId, version.versionNumber),
      artifact,
    );
    await this.deps.artifacts.register(
      `storyboard-visual-artifact:${artifact.artifactId}`,
      artifact,
    );
  }

  /** Carries only byte-identical shot semantics into a new storyboard version. */
  async inheritUnchangedShots(params: {
    previous: StoryboardVersion;
    next: StoryboardVersion;
    claim: StoryboardAccessClaim;
  }): Promise<void> {
    requireAccess(params.previous, params.claim);
    requireAccess(params.next, params.claim);
    const previousDocument = params.previous.document;
    const nextDocument = params.next.document;
    const globalChanged =
      previousDocument.environment !== nextDocument.environment ||
      previousDocument.aspectRatio !== nextDocument.aspectRatio ||
      previousDocument.sourceImage?.mediaId !== nextDocument.sourceImage?.mediaId ||
      JSON.stringify(params.previous.characterLocks) !== JSON.stringify(params.next.characterLocks);
    if (globalChanged) {
      return;
    }
    for (const [index, beat] of nextDocument.beats.entries()) {
      const previousBeat = previousDocument.beats[index];
      if (!previousBeat || JSON.stringify(previousBeat) !== JSON.stringify(beat)) {
        continue;
      }
      const inherited = await this.deps.artifacts.lookup(
        storyboardVisualKey(params.previous.storyboardId, params.previous.versionNumber, index + 1),
      );
      if (!isAuthoritativeShotArtifact(inherited)) {
        continue;
      }
      const artifact = Object.freeze({
        ...inherited,
        artifactId: this.deps.randomId?.() ?? randomBytes(18).toString("hex"),
        storyboardVersionNumber: params.next.versionNumber,
        createdAt: new Date(this.deps.now()).toISOString(),
      });
      await this.deps.artifacts.register(
        storyboardVisualKey(params.next.storyboardId, params.next.versionNumber, index + 1),
        artifact,
      );
      await this.deps.artifacts.register(
        `storyboard-visual-artifact:${artifact.artifactId}`,
        artifact,
      );
    }
  }

  private async generateOne(version: StoryboardVersion, shotIndex: number): Promise<void> {
    const beat = version.document.beats[shotIndex - 1]!;
    const identityReferences = version.characterLocks.flatMap((lock) => lock.identityReferences);
    const sourceImage = version.document.sourceImage;
    const generated = await this.deps.generate({
      version,
      shotIndex,
      identityReferences,
      ...(sourceImage ? { sourceImage } : {}),
    });
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
      // Recorded distinctly from the identity locators above, so a later reader
      // can still tell a first frame from a Character reference.
      ...(sourceImage ? { sourceImageMediaId: sourceImage.mediaId } : {}),
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
