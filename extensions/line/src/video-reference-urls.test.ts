import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { resolveLineVideoReferenceUrls } from "./video-reference-urls.js";
import type { LineVideoUgcScope } from "./video-ugc-scope.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const ENV = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "test-access",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET_NAME: "existing-bucket",
};

function scope(overrides: Partial<LineVideoUgcScope> = {}): LineVideoUgcScope {
  return {
    version: 1,
    policyId: "UGC",
    accountId: "primary",
    lineGroupId: "C-ugc",
    ownerSenderId: "U-owner",
    productPageId: "product-page",
    characterPageId: "char-6-page",
    characterLocks: [
      {
        code: "CHAR-6",
        pageId: "char-6-page",
        identityReferences: [
          { kind: "identity", source: "r2", locator: "workspace/ugc/char-6.png" },
        ],
        styleReferences: [],
        frozenAt: "2026-08-23T00:00:00.000Z",
      },
      {
        code: "CHAR-10",
        pageId: "char-10-page",
        identityReferences: [
          { kind: "identity", source: "r2", locator: "workspace/ugc/char-10.jpg" },
        ],
        styleReferences: [],
        frozenAt: "2026-08-23T00:00:00.000Z",
      },
    ],
    projectInstanceId: "project-instance",
    projectPageId: "project-page",
    projectRecordId: "project-record",
    scene: {
      sceneNumber: 1,
      characterPageIds: ["char-6-page", "char-10-page"],
      characterCodes: ["CHAR-6", "CHAR-10"],
      prompt: "walk in the garden",
    },
    scenePageId: "shot-1",
    shotPageIds: ["shot-1"],
    referenceAssets: [
      { kind: "identity", source: "r2", locator: "workspace/ugc/char-6.png" },
      { kind: "identity", source: "r2", locator: "workspace/ugc/char-10.jpg" },
    ],
    frozenPrompt: "walk in the garden",
    capabilities: {
      PRODUCT_LIBRARY: { databaseId: "1".repeat(32), dataSourceId: "a".repeat(32) },
      CHARACTER_LIBRARY: { databaseId: "2".repeat(32), dataSourceId: "b".repeat(32) },
      UGC_PROJECTS: { databaseId: "3".repeat(32), dataSourceId: "c".repeat(32) },
      UGC_SHOTS: { databaseId: "4".repeat(32), dataSourceId: "d".repeat(32) },
      AI_VIDEO_LIBRARY: { databaseId: "5".repeat(32), dataSourceId: "e".repeat(32) },
      AI_IMAGE_LIBRARY: { databaseId: "6".repeat(32), dataSourceId: "f".repeat(32) },
    },
    r2Prefix: "outbound/line-video",
    createdAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  } as LineVideoUgcScope;
}

function harness() {
  const bytesByKey = new Map([
    ["workspace/ugc/char-6.png", PNG],
    ["workspace/ugc/char-10.jpg", JPEG],
  ]);
  const puts: PutObjectCommand[] = [];
  const s3Client = {
    send: vi.fn(async (command: { input: Record<string, unknown> }) => {
      if (command instanceof PutObjectCommand) {
        puts.push(command);
        return {};
      }
      const key = String(command.input.Key);
      const bytes = bytesByKey.get(key);
      return {
        ContentLength: bytes?.byteLength,
        Body: { transformToByteArray: async () => bytes },
      };
    }),
  };
  const presign = vi.fn(
    async (
      _client: unknown,
      command: { input: Record<string, unknown> },
      options: { expiresIn: number },
    ) =>
      `https://account.r2.cloudflarestorage.com/existing-bucket/${String(command.input.Key)}?X-Amz-Signature=sig&X-Amz-Expires=${options.expiresIn}`,
  );
  return { s3Client, presign, puts };
}

describe("signed R2 reference URLs for fal", () => {
  it("publishes every frozen identity reference as a signed HTTPS URL", async () => {
    const { s3Client, presign } = harness();
    const references = await resolveLineVideoReferenceUrls(scope(), {
      env: ENV,
      s3Client: s3Client as never,
      s3ClientForSigning: s3Client as never,
      presign: presign as never,
    });
    expect(references).toHaveLength(2);
    for (const reference of references) {
      expect(new URL(reference.url).protocol).toBe("https:");
      expect(reference.url).toContain("X-Amz-Signature=");
    }
  });

  it("preserves Character Library ordering, so @Image1 stays the same subject", async () => {
    const { s3Client, presign } = harness();
    const references = await resolveLineVideoReferenceUrls(scope(), {
      env: ENV,
      s3Client: s3Client as never,
      s3ClientForSigning: s3Client as never,
      presign: presign as never,
    });
    expect(references.map((reference) => reference.characterCode)).toEqual(["CHAR-6", "CHAR-10"]);
    expect(references.map((reference) => reference.index)).toEqual([0, 1]);
  });

  it("carries the MIME type derived from the bytes, not from the file name", async () => {
    const { s3Client, presign } = harness();
    const references = await resolveLineVideoReferenceUrls(scope(), {
      env: ENV,
      s3Client: s3Client as never,
      s3ClientForSigning: s3Client as never,
      presign: presign as never,
    });
    expect(references.map((reference) => reference.mimeType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("signs a SHORT-LIVED URL and never hands out a permanent private R2 URL", async () => {
    const { s3Client, presign } = harness();
    const references = await resolveLineVideoReferenceUrls(scope(), {
      env: ENV,
      s3Client: s3Client as never,
      s3ClientForSigning: s3Client as never,
      presign: presign as never,
      expirySeconds: 900,
    });
    for (const call of presign.mock.calls) {
      expect((call[2] as { expiresIn: number }).expiresIn).toBe(900);
    }
    for (const reference of references) {
      expect(reference.url).toContain("X-Amz-Expires=900");
    }
  });

  it("never makes the bucket public: every object is written with no public ACL", async () => {
    const { s3Client, presign, puts } = harness();
    await resolveLineVideoReferenceUrls(scope(), {
      env: ENV,
      s3Client: s3Client as never,
      s3ClientForSigning: s3Client as never,
      presign: presign as never,
    });
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) {
      expect(put.input.ACL).toBeUndefined();
      expect(put.input.Bucket).toBe("existing-bucket");
      expect(String(put.input.Key)).toMatch(/^outbound\/line-video-reference\//u);
    }
  });

  it("returns nothing, and publishes nothing, for a scope with no references", async () => {
    const { s3Client, presign, puts } = harness();
    const references = await resolveLineVideoReferenceUrls(
      scope({ characterLocks: [], referenceAssets: [] }),
      {
        env: ENV,
        s3Client: s3Client as never,
        s3ClientForSigning: s3Client as never,
        presign: presign as never,
      },
    );
    expect(references).toEqual([]);
    expect(puts).toEqual([]);
  });
});
