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
