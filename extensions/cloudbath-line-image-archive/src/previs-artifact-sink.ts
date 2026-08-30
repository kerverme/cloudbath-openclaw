import type { PrevisArtifactSink } from "./previs-store.js";
import type { R2ArchiveClient } from "./r2.js";

/**
 * Private-R2 sink for `.cclayproject` artifacts.
 *
 * The bucket stays private. The durable content-addressed object key is the
 * artifact's canonical identity; a signed URL is never minted here and never
 * stored, because it expires and could not address the object later.
 */
export function createPrevisArtifactSink(params: {
  r2: Pick<R2ArchiveClient, "ensureObject">;
  bucketName: string;
}): PrevisArtifactSink {
  if (!params.bucketName.trim()) {
    throw new Error("Previs artifact sink requires a private R2 bucket name");
  }
  return {
    putPrivateArtifact: async ({ objectKey, body, contentType, sha256 }) => {
      await params.r2.ensureObject({
        body,
        bucketName: params.bucketName,
        objectKey,
        contentType,
        contentLength: body.byteLength,
        sha256,
      });
    },
  };
}
