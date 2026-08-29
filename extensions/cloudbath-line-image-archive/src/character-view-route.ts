import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { parseCharacterViewPath } from "./character-view-url.js";
import { detectCanonicalImageExtensionFromBytes } from "./r2.js";
import type { NotionTarget, UgcCapabilityId } from "./types.js";

type CharacterViewNotionClient = {
  resolveCharacterViewAsset(params: {
    target: NotionTarget;
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    characterId: string;
    token: string;
    publicAssetBaseUrl: string;
  }): Promise<{ objectKey: string }>;
};

type CharacterViewR2Client = {
  fetchPrivateObject(params: {
    bucketName: string;
    objectKey: string;
    maxBytes: number;
    contentTypePrefix: string;
  }): Promise<{ bytes: Uint8Array; contentType: string }>;
};

export type CharacterAssetViewRuntime = Readonly<{
  notion: CharacterViewNotionClient;
  r2: CharacterViewR2Client;
  capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  publicAssetBaseUrl: string;
  bucketName: string;
  maxBytes: number;
}>;

function finish(res: Parameters<OpenClawPluginHttpRouteHandler>[1], statusCode: number): true {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end();
  return true;
}

export function createCharacterViewRouteHandler(
  getRuntime: () => CharacterAssetViewRuntime | undefined,
): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return finish(res, 405);
    }
    const requestUrl = new URL(req.url ?? "/", "https://cloudbath.invalid");
    const reference = parseCharacterViewPath(requestUrl.pathname);
    if (!reference || requestUrl.search || requestUrl.hash) {
      return finish(res, 404);
    }
    const runtime = getRuntime();
    if (!runtime) {
      return finish(res, 503);
    }
    try {
      const asset = await runtime.notion.resolveCharacterViewAsset({
        target: runtime.capabilities.CHARACTER_LIBRARY,
        capabilities: runtime.capabilities,
        characterId: reference.characterId,
        token: reference.token,
        publicAssetBaseUrl: runtime.publicAssetBaseUrl,
      });
      const privateObject = await runtime.r2.fetchPrivateObject({
        bucketName: runtime.bucketName,
        objectKey: asset.objectKey,
        maxBytes: runtime.maxBytes,
        contentTypePrefix: "image/",
      });
      if (detectCanonicalImageExtensionFromBytes(privateObject.bytes) === ".bin") {
        throw new Error("Character private asset is not an image");
      }
      res.statusCode = 200;
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", privateObject.contentType);
      res.setHeader("Content-Length", privateObject.bytes.byteLength);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : Buffer.from(privateObject.bytes));
      return true;
    } catch {
      return finish(res, 404);
    }
  };
}
