import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { movementsInRange } from "./previs-document.js";
import type { PrevisStore } from "./previs-store.js";
import { PREVIS_TIMELINE_FPS, type PrevisVersion } from "./previs-types.js";
import { parsePrevisViewPath, type PrevisViewCapability } from "./previs-url.js";

/**
 * The stable private previs review surface.
 *
 * Mirrors the Character view route: capability token in the path, no query
 * string, no caching, and a bare 404 for anything that does not resolve so the
 * route never confirms which previs projects exist. The response is review
 * metadata only — the private `.cclayproject` artifact is referenced by its
 * durable R2 object key and never streamed as a public or signed URL.
 */
export type PrevisReviewRuntime = Readonly<{
  store: PrevisStore;
}>;

function finish(res: Parameters<OpenClawPluginHttpRouteHandler>[1], statusCode: number): true {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end();
  return true;
}

/** Timeline projection: 0s to duration, with the playhead the reviewer asked for. */
export function previsTimelineView(version: PrevisVersion): Readonly<Record<string, unknown>> {
  const { document } = version;
  return {
    previsProjectId: version.previsProjectId,
    sceneId: version.sceneId,
    versionNumber: version.versionNumber,
    parentVersionNumber: version.parentVersionNumber,
    approved: Boolean(version.approvedAt),
    durationSeconds: document.durationSeconds,
    aspectRatio: document.aspectRatio,
    fps: PREVIS_TIMELINE_FPS,
    frameCount: document.durationSeconds * PREVIS_TIMELINE_FPS,
    scenePrompt: document.scenePrompt,
    movements: document.movements,
    shots: document.shots,
    // What CozyClay could not render headlessly, so a reviewer is never shown
    // an empty timeline and told the previs is complete.
    deferredCapabilities: version.deferredCapabilities,
  };
}

function previsCastView(version: PrevisVersion): Readonly<Record<string, unknown>> {
  return {
    previsProjectId: version.previsProjectId,
    versionNumber: version.versionNumber,
    // Canonical Cloudbath identity first; the stand-in letter is engine detail.
    cast: version.document.cast.map((member) => ({
      characterCode: member.characterCode,
      characterPageId: member.characterPageId,
      displayName: member.displayName,
      cozyClayStandIn: member.standIn,
    })),
    frozenCharacterPageIds: version.frozenCharacterPageIds,
  };
}

function previsCameraView(version: PrevisVersion): Readonly<Record<string, unknown>> {
  return {
    previsProjectId: version.previsProjectId,
    versionNumber: version.versionNumber,
    placements: version.document.placements,
    shots: version.document.shots.map((shot) => ({
      ...shot,
      movementsInShot: movementsInRange(version.document, shot.startSecond, shot.endSecond),
    })),
  };
}

function previsArtifactView(version: PrevisVersion): Readonly<Record<string, unknown>> {
  return {
    previsProjectId: version.previsProjectId,
    versionNumber: version.versionNumber,
    // Durable object identity only. A signed URL expires and can never be the
    // canonical locator for an artifact a later pipeline stage must re-read.
    artifactObjectKey: version.artifactObjectKey ?? null,
    artifactStorage: "private-r2",
    format: "cclayproject",
  };
}

const VIEWS: Record<
  PrevisViewCapability,
  (version: PrevisVersion) => Readonly<Record<string, unknown>>
> = {
  timeline: previsTimelineView,
  cast: previsCastView,
  camera: previsCameraView,
  artifact: previsArtifactView,
};

export function createPrevisReviewRouteHandler(
  getRuntime: () => PrevisReviewRuntime | undefined,
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return finish(res, 405);
    }
    const requestUrl = new URL(req.url ?? "/", "https://cloudbath.invalid");
    const reference = parsePrevisViewPath(requestUrl.pathname);
    if (!reference || requestUrl.search || requestUrl.hash) {
      return finish(res, 404);
    }
    const runtime = getRuntime();
    if (!runtime) {
      return finish(res, 503);
    }
    try {
      const resolved = await runtime.store.resolveForReview({
        previsProjectId: reference.previsProjectId,
        token: reference.token,
        versionNumber: reference.versionNumber,
      });
      if (!resolved) {
        return finish(res, 404);
      }
      const body = Buffer.from(
        JSON.stringify({
          latestVersionNumber: resolved.head.latestVersionNumber,
          approvedVersionNumber: resolved.head.approvedVersionNumber ?? null,
          ...VIEWS[reference.capability](resolved.version),
        }),
      );
      res.statusCode = 200;
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", body.byteLength);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    } catch {
      return finish(res, 404);
    }
  };
}
