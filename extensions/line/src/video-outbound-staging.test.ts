import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LineVideoOutboundStagingError,
  stageLineOutboundVideo,
  stageLineVideoPreviewImage,
} from "./video-outbound-staging.js";

const R2_ENV = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "bucket",
} as NodeJS.ProcessEnv;

// Minimal valid MP4 magic bytes: 4-byte box size + "ftyp".
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

function fakeS3Client(overrides?: { headThrows?: boolean }) {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "HeadObjectCommand" && overrides?.headThrows !== false) {
        throw Object.assign(new Error("not found"), { name: "NotFound" });
      }
      if (name === "HeadObjectCommand") {
        return {
          Metadata: { sha256: createHash("sha256").update(MP4_BYTES).digest("hex") },
          ContentLength: MP4_BYTES.byteLength,
          ContentType: "video/mp4",
        };
      }
      return {};
    }),
  };
}

describe("stageLineOutboundVideo", () => {
  it("1: refuses when R2 is not configured", async () => {
    await expect(
      stageLineOutboundVideo(MP4_BYTES, { env: {} as NodeJS.ProcessEnv }),
    ).rejects.toThrow(LineVideoOutboundStagingError);
  });

  it("2: rejects bytes that are not a recognized video format", async () => {
    const client = fakeS3Client();
    await expect(
      stageLineOutboundVideo(Buffer.from("not a video"), {
        env: R2_ENV,
        s3Client: client,
        presign: vi.fn(async () => "https://signed.example/video.mp4"),
      }),
    ).rejects.toThrow(LineVideoOutboundStagingError);
  });

  it("3: uploads MP4 bytes and returns a signed HTTPS URL", async () => {
    const client = fakeS3Client();
    const presign = vi.fn(async () => "https://signed.example/video.mp4");
    const staged = await stageLineOutboundVideo(MP4_BYTES, {
      env: R2_ENV,
      s3Client: client,
      presign,
    });

    expect(staged.url).toBe("https://signed.example/video.mp4");
    expect(staged.contentType).toBe("video/mp4");
    expect(
      client.sent.some(
        (c) => (c as { constructor: { name: string } }).constructor.name === "PutObjectCommand",
      ),
    ).toBe(true);
  });

  it("4: skips re-upload when the content-addressed object already exists", async () => {
    const client = fakeS3Client({ headThrows: false });
    const presign = vi.fn(async () => "https://signed.example/video.mp4");
    await stageLineOutboundVideo(MP4_BYTES, { env: R2_ENV, s3Client: client, presign });

    expect(
      client.sent.some(
        (c) => (c as { constructor: { name: string } }).constructor.name === "PutObjectCommand",
      ),
    ).toBe(false);
  });

  it("downloads a transient provider URL through the SSRF guard and archives those bytes in the existing R2 bucket", async () => {
    const client = fakeS3Client();
    const release = vi.fn(async () => {});
    const guardedFetch = vi.fn(async () => ({
      response: new Response(Uint8Array.from(MP4_BYTES), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
      release,
    }));

    const staged = await stageLineOutboundVideo("https://provider.example/transient.mp4", {
      env: R2_ENV,
      s3Client: client,
      presign: vi.fn(async () => "https://signed.example/video.mp4?signature=redacted"),
      guardedFetch: guardedFetch as never,
    });

    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://provider.example/transient.mp4",
        requireHttps: true,
        auditContext: "line-generated-video-source",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(staged.objectKey).toMatch(/^outbound\/line-video\/sha256\//u);
    const put = client.sent.find(
      (command) =>
        (command as { constructor: { name: string } }).constructor.name === "PutObjectCommand",
    ) as { input?: { Bucket?: string; Body?: Buffer } } | undefined;
    expect(put?.input?.Bucket).toBe("bucket");
    expect(Buffer.from(put?.input?.Body ?? [])).toEqual(MP4_BYTES);
  });

  it("rejects a provider response that is not a successful video asset", async () => {
    const release = vi.fn(async () => {});
    const guardedFetch = vi.fn(async () => ({
      response: new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      release,
    }));

    await expect(
      stageLineOutboundVideo("https://provider.example/not-video", {
        env: R2_ENV,
        s3Client: fakeS3Client(),
        presign: vi.fn(async () => "https://signed.example/video.mp4"),
        guardedFetch: guardedFetch as never,
      }),
    ).rejects.toMatchObject({ code: "provider_content_type_invalid" });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("stageLineVideoPreviewImage", () => {
  it("reuses the existing image-staging pipeline for the required LINE video thumbnail", async () => {
    const stageImage = vi.fn(async (path: string) => ({
      url: "https://signed.example/preview.jpg",
      objectKey: "outbound/line/preview.jpg",
      contentType: "image/jpeg",
      contentLength: 10,
      sha256: "abc",
      _path: path,
    }));
    const staged = await stageLineVideoPreviewImage(stageImage as never);

    expect(staged.url).toBe("https://signed.example/preview.jpg");
    expect(stageImage).toHaveBeenCalledTimes(1);
    expect(stageImage.mock.calls[0]?.[0]).toMatch(/^\/tmp\/line-video-thumb-/u);
  });
});
