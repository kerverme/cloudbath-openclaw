import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { R2ArchiveClient } from "./r2.js";
import {
  CLOUDBATH_STORYBOARD_VISUAL_ROUTE,
  type StoryboardVisualArtifact,
} from "./storyboard-visual.js";
import type { AsyncKeyedStore } from "./types.js";

export type StoryboardVisualRouteRuntime = Readonly<{
  artifacts: AsyncKeyedStore<StoryboardVisualArtifact>;
  r2: R2ArchiveClient;
  bucketName: string;
  maxBytes: number;
}>;

function finish(res: Parameters<OpenClawPluginHttpRouteHandler>[1], status: number): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end();
  return true;
}

function parsePath(
  pathname: string,
): { artifactId: string; variant: "original" | "preview" } | undefined {
  const prefix = `${CLOUDBATH_STORYBOARD_VISUAL_ROUTE}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || !/^[a-f0-9]{36}$/u.test(parts[0] ?? "")) {
    return undefined;
  }
  const variant = parts[1];
  return variant === "original" || variant === "preview"
    ? { artifactId: parts[0]!, variant }
    : undefined;
}

export function createStoryboardVisualRouteHandler(
  getRuntime: () => StoryboardVisualRouteRuntime | undefined,
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return finish(res, 405);
    }
    const requestUrl = new URL(req.url ?? "/", new URL("cloudbath.invalid", "https:"));
    const reference = parsePath(requestUrl.pathname);
    if (!reference || requestUrl.search || requestUrl.hash) {
      return finish(res, 404);
    }
    const runtime = getRuntime();
    if (!runtime) {
      return finish(res, 503);
    }
    const artifact = await runtime.artifacts.lookup(
      `storyboard-visual-artifact:${reference.artifactId}`,
    );
    if (!artifact) {
      return finish(res, 404);
    }
    try {
      const objectKey =
        reference.variant === "preview" ? artifact.previewObjectKey : artifact.originalObjectKey;
      const media = await runtime.r2.fetchPrivateObject({
        bucketName: runtime.bucketName,
        objectKey,
        maxBytes: runtime.maxBytes,
        contentTypePrefix: "image/",
      });
      if (media.contentType !== "image/jpeg" && media.contentType !== "image/png") {
        return finish(res, 415);
      }
      res.statusCode = 200;
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Type", media.contentType);
      res.setHeader("Content-Length", media.bytes.byteLength);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : media.bytes);
      return true;
    } catch {
      return finish(res, 503);
    }
  };
}
