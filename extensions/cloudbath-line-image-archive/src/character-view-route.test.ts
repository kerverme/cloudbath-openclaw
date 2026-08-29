import type { IncomingMessage } from "node:http";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  createCharacterViewRouteHandler,
  type CharacterAssetViewRuntime,
} from "./character-view-route.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CAPABILITIES = {
  PRODUCT_LIBRARY: { databaseId: "1".repeat(32), dataSourceId: "2".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "3".repeat(32), dataSourceId: "4".repeat(32) },
  UGC_PROJECTS: { databaseId: "5".repeat(32), dataSourceId: "6".repeat(32) },
  UGC_SHOTS: { databaseId: "7".repeat(32), dataSourceId: "8".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "9".repeat(32), dataSourceId: "a".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "c".repeat(32) },
} as const;

function request(url: string, method = "GET"): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function runtime() {
  const notion = {
    resolveCharacterViewAsset: vi.fn(async () => ({
      objectKey: "ugc/characters/kerver/sha256/aa/asset.png",
    })),
  };
  const r2 = {
    fetchPrivateObject: vi.fn(async () => ({ bytes: PNG_BYTES, contentType: "image/png" })),
  };
  return {
    value: {
      notion,
      r2,
      capabilities: CAPABILITIES,
      publicAssetBaseUrl: "https://cloudbath.example",
      bucketName: "private-cloudbath",
      maxBytes: 10 * 1024 * 1024,
    } satisfies CharacterAssetViewRuntime,
    notion,
    r2,
  };
}

describe("private Character view route", () => {
  it("authorizes by the stored Character capability and proxies the private R2 bytes", async () => {
    const active = runtime();
    const handler = createCharacterViewRouteHandler(() => active.value);
    const response = createMockServerResponse();

    await handler(request("/c/CHAR-5/abcdefghijklmnop"), response);

    expect(response.statusCode).toBe(200);
    expect(response.getHeader("Content-Type")).toBe("image/png");
    expect(response.getHeader("Location")).toBeUndefined();
    expect(Buffer.from(response.body as unknown as Uint8Array)).toEqual(PNG_BYTES);
    expect(active.notion.resolveCharacterViewAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "CHAR-5",
        token: "abcdefghijklmnop",
      }),
    );
    expect(active.r2.fetchPrivateObject).toHaveBeenCalledWith({
      bucketName: "private-cloudbath",
      objectKey: "ugc/characters/kerver/sha256/aa/asset.png",
      maxBytes: 10 * 1024 * 1024,
      contentTypePrefix: "image/",
    });
  });

  it("fails closed for invalid, archived, unauthorized, or unavailable Characters", async () => {
    const active = runtime();
    active.notion.resolveCharacterViewAsset.mockRejectedValue(new Error("unavailable"));
    const handler = createCharacterViewRouteHandler(() => active.value);
    for (const url of ["/c/CHAR-5/ponmlkjihgfedcba", "/c/CHAR-404/abcdefghijklmnop"]) {
      const response = createMockServerResponse();
      await handler(request(url), response);
      expect(response.statusCode).toBe(404);
    }
    expect(active.r2.fetchPrivateObject).not.toHaveBeenCalled();

    const malformed = createMockServerResponse();
    await handler(request("/c/../../private-key"), malformed);
    expect(malformed.statusCode).toBe(404);
  });

  it("rejects an error document even when an upstream header claims it is an image", async () => {
    const active = runtime();
    active.r2.fetchPrivateObject.mockResolvedValue({
      bytes: Buffer.from("<html>private object error</html>"),
      contentType: "image/png",
    });
    const response = createMockServerResponse();

    await createCharacterViewRouteHandler(() => active.value)(
      request("/c/CHAR-5/abcdefghijklmnop"),
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBeUndefined();
  });

  it("does not expose a route until the active gateway runtime is installed", async () => {
    const response = createMockServerResponse();
    await createCharacterViewRouteHandler(() => undefined)(
      request("/c/CHAR-5/abcdefghijklmnop"),
      response,
    );
    expect(response.statusCode).toBe(503);
  });
});
