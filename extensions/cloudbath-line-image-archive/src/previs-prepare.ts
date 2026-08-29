import { previsDeferrals } from "./previs-cozyclay.js";
import { createPrevisDocument, isPrevisAspectRatio } from "./previs-document.js";
import type { PrevisArtifactSink, PrevisEngine, PrevisStore } from "./previs-store.js";
import type {
  PrevisAccessClaim,
  PrevisCastMember,
  PrevisDeferral,
  PrevisMovement,
  PrevisVersion,
} from "./previs-types.js";
import type { UgcCharacterLock } from "./types.js";

/**
 * `cloudbath_ugc_previs_prepare` — the previs sibling of
 * `cloudbath_ugc_video_prepare`.
 *
 * It resolves nothing from Notion and freezes nothing new: the project's
 * character lock is already frozen by the video-prepare path, and previs reads
 * it. This never performs paid generation, and an approved previs still has to
 * pass the exact `ยืนยัน VIDEO ####` gate before anything is billed.
 *
 * Kept as a plain function on purpose. LINE tool registration and model-facing
 * routing are a later change; the previs layer must stay deterministic and
 * testable on its own.
 */
export type PrevisPrepareInput = Readonly<{
  sceneId: string;
  projectInstanceId: string;
  claim: PrevisAccessClaim;
  /** The frozen project cast. Cast order fixes the CozyClay stand-in letters. */
  characterLocks: readonly UgcCharacterLock[];
  /** Display names by character code, e.g. { "CHAR-6": "Twong" }. */
  displayNames: Readonly<Record<string, string>>;
  scenePrompt: string;
  durationSeconds: number;
  aspectRatio: string;
  movements?: readonly PrevisMovement[];
}>;

export type PrevisPrepareResult = Readonly<{
  previsProjectId: string;
  sceneId: string;
  versionNumber: number;
  cast: readonly PrevisCastMember[];
  durationSeconds: number;
  aspectRatio: string;
  artifactObjectKey?: string;
  reviewUrl: string;
  deferredCapabilities: readonly PrevisDeferral[];
  status: "PREVIS_READY";
}>;

export async function preparePrevis(params: {
  store: PrevisStore;
  input: PrevisPrepareInput;
  publicAssetBaseUrl: string;
  engine?: PrevisEngine;
  artifacts?: PrevisArtifactSink;
}): Promise<PrevisPrepareResult> {
  const { input } = params;
  if (input.characterLocks.length === 0) {
    throw new Error("Previs requires at least one frozen character lock");
  }
  if (!isPrevisAspectRatio(input.aspectRatio)) {
    throw new Error(`Previs aspect ratio "${input.aspectRatio}" is not supported`);
  }
  const document = createPrevisDocument({
    scenePrompt: input.scenePrompt,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    // Cast order is the frozen lock order, so the same project always produces
    // the same stand-in letters for the same characters.
    cast: input.characterLocks.map((lock) => ({
      characterCode: lock.code,
      characterPageId: lock.pageId,
      displayName: input.displayNames[lock.code] ?? lock.code,
    })),
    movements: input.movements,
  });
  const { head, version } = await params.store.createProject({
    document,
    sceneId: input.sceneId,
    projectInstanceId: input.projectInstanceId,
    claim: input.claim,
    engine: params.engine,
    artifacts: params.artifacts,
    deferrals: previsDeferrals(document),
  });
  return {
    previsProjectId: version.previsProjectId,
    sceneId: version.sceneId,
    versionNumber: version.versionNumber,
    cast: document.cast,
    durationSeconds: document.durationSeconds,
    aspectRatio: document.aspectRatio,
    ...(version.artifactObjectKey ? { artifactObjectKey: version.artifactObjectKey } : {}),
    reviewUrl: params.store.reviewUrl(head, params.publicAssetBaseUrl),
    deferredCapabilities: version.deferredCapabilities,
    status: "PREVIS_READY",
  };
}

/**
 * `APPROVE PREVIS` — freezes one previs version for the later video-draft
 * pipeline.
 *
 * Approval is a Cloudbath state change and nothing more. It calls no provider,
 * starts no generation, and does not substitute for the paid confirmation gate.
 */
export async function approvePrevis(params: {
  store: PrevisStore;
  previsProjectId: string;
  claim: PrevisAccessClaim;
  versionNumber?: number;
}): Promise<PrevisVersion> {
  return params.store.approve({
    previsProjectId: params.previsProjectId,
    claim: params.claim,
    versionNumber: params.versionNumber,
  });
}
