/**
 * Narrow internal specialist boundaries for the single Cloudbath LINE orchestrator.
 *
 * OpenClaw's native subagent runtime is request-scoped and returns an untyped
 * child transcript. It cannot grant the per-specialist store tools required
 * here, so using it for mutations would either expose broad tools or make chat
 * memory authoritative. These in-process specialists keep the existing stores
 * and paid guards as the only mutation paths and never receive a LINE sender.
 */
import type {
  CloudbathStoryboardLineRouter,
  ResolvedStoryboardReferent,
} from "./storyboard-line-router.js";
import type { StoryboardAccessClaim, StoryboardVersion } from "./storyboard-types.js";
import type { StoryboardVisualService, StoryboardVisualStatus } from "./storyboard-visual.js";

export function readGeneratedImageAttachment(
  result: unknown,
): Readonly<{ path: string; mimeType: string }> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const attachments = (details as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length !== 1) {
    return undefined;
  }
  const attachment = attachments[0];
  if (!attachment || typeof attachment !== "object") {
    return undefined;
  }
  const { path, mimeType, type } = attachment as Record<string, unknown>;
  return type === "image" && typeof path === "string" && typeof mimeType === "string"
    ? { path, mimeType }
    : undefined;
}

export const CLOUDBATH_SPECIALIST_KINDS = [
  "storyboard_director",
  "visual_director",
  "character_director",
  "video_director",
] as const;

export type CloudbathCreativeSpecialists = Readonly<{
  storyboard: Readonly<{
    resolveReferent(params: {
      storyboardId: string;
      claim: StoryboardAccessClaim;
    }): Promise<ResolvedStoryboardReferent | undefined>;
    isRevisionCandidate(params: {
      request: string;
      claim: StoryboardAccessClaim;
    }): Promise<boolean>;
  }>;
  visual?: Readonly<{
    status(params: {
      version: StoryboardVersion;
      claim: StoryboardAccessClaim;
    }): Promise<StoryboardVisualStatus>;
  }>;
  character: Readonly<{
    listNames(claim: StoryboardAccessClaim): Promise<readonly string[]>;
  }>;
}>;

export function createCloudbathCreativeSpecialists(params: {
  storyboard: CloudbathStoryboardLineRouter;
  visuals?: StoryboardVisualService;
  listCharacterNames(claim: StoryboardAccessClaim): Promise<readonly string[]>;
}): CloudbathCreativeSpecialists {
  return Object.freeze({
    storyboard: Object.freeze({
      resolveReferent: (request: { storyboardId: string; claim: StoryboardAccessClaim }) =>
        params.storyboard.resolveStoryboardReferent(request),
      isRevisionCandidate: (request: { request: string; claim: StoryboardAccessClaim }) =>
        params.storyboard.isStoryboardRevisionCandidate(request),
    }),
    ...(params.visuals
      ? {
          visual: Object.freeze({
            status: (request: { version: StoryboardVersion; claim: StoryboardAccessClaim }) =>
              params.visuals!.status(request),
          }),
        }
      : {}),
    character: Object.freeze({
      listNames: (claim: StoryboardAccessClaim) => params.listCharacterNames(claim),
    }),
  });
}
