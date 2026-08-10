// Line tests cover the canonical R2-only outbound image staging path.
import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LineOutboundImageStagingError,
  stageLineOutboundImage,
  stageLineOutboundMessageImages,
  type LineOutboundImageStagingDependencies,
} from "./outbound-media-staging.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("canonical-line-image"),
]);
const SHA256 = createHash("sha256").update(PNG).digest("hex");
const SIGNED_URL = "https://r2.example/outbound/line/test.png?X-Amz-Signature=unit-test-credential";
const ENV = {
  R2_ACCOUNT_ID: "unit-account",
  R2_ACCESS_KEY_ID: "unit-access-key",
  R2_SECRET_ACCESS_KEY: "unit-secret-key",
  R2_BUCKET_NAME: "unit-bucket",
  R2_ENDPOINT: "https://unit-account.r2.cloudflarestorage.com",
  IMAGE_MAX_MB: "10",
};

function imageResponse(status = 200, contentType = "image/png", body: BodyInit = PNG): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(PNG.byteLength),
    },
  });
}

function guardedResult(response: Response) {
  return {
    response,
    finalUrl: response.url,
    release: vi.fn(),
  } as never;
}

function createHarness(
  options: {
    guardedFetch?: LineOutboundImageStagingDependencies["guardedFetch"];
    presignedUrl?: string;
    readLocalFile?: LineOutboundImageStagingDependencies["readLocalFile"];
  } = {},
) {
  let exists = false;
  const commands: string[] = [];
  const putInputs: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (command: HeadObjectCommand | PutObjectCommand) => {
    commands.push(command.constructor.name);
    if (command instanceof HeadObjectCommand) {
      if (!exists) {
        throw Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        ContentLength: PNG.byteLength,
        ContentType: "image/png",
        Metadata: { sha256: SHA256 },
      };
    }
    exists = true;
    putInputs.push(command.input as Record<string, unknown>);
    return {};
  });
  const guardedFetch =
    options.guardedFetch ??
    (vi.fn(async () => guardedResult(imageResponse())) as NonNullable<
      LineOutboundImageStagingDependencies["guardedFetch"]
    >);
  const presign = vi.fn(async () => options.presignedUrl ?? SIGNED_URL);
  const readLocalFile = options.readLocalFile ?? vi.fn(async () => PNG);

  return {
    dependencies: {
      env: ENV,
      s3Client: { send },
      guardedFetch,
      presign,
      readLocalFile,
    } satisfies LineOutboundImageStagingDependencies,
    commands,
    guardedFetch,
    presign,
    putInputs,
    readLocalFile,
  };
}

describe("LINE outbound R2 image staging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a /tmp image and uploads it before returning the LINE URL", async () => {
    const harness = createHarness();

    const result = await stageLineOutboundImage("/tmp/example.png", harness.dependencies);

    expect(harness.readLocalFile).toHaveBeenCalledWith("/tmp/example.png", 10 * 1024 * 1024);
    expect(harness.commands).toEqual(["HeadObjectCommand", "PutObjectCommand"]);
    expect(harness.putInputs[0]).toMatchObject({
      Bucket: "unit-bucket",
      Key: `outbound/line/sha256/${SHA256.slice(0, 2)}/${SHA256}.png`,
      Body: PNG,
      ContentLength: PNG.byteLength,
      ContentType: "image/png",
      IfNoneMatch: "*",
      Metadata: { sha256: SHA256 },
    });
    expect(result.url).toBe(SIGNED_URL);
    expect(result.objectKey).toMatch(/^outbound\/line\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(harness.guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: SIGNED_URL,
        requireHttps: true,
        maxRedirects: 0,
      }),
    );
  });

  it("reads and stages a /data image through the same canonical path", async () => {
    const harness = createHarness();

    const result = await stageLineOutboundImage("/data/generated/site.png", harness.dependencies);

    expect(harness.readLocalFile).toHaveBeenCalledWith(
      "/data/generated/site.png",
      10 * 1024 * 1024,
    );
    expect(result.objectKey).toContain("outbound/line/sha256/");
    expect(harness.commands).toContain("PutObjectCommand");
  });

  it("downloads an external image server-side and never forwards its URL to LINE", async () => {
    const source = "https://quickchart.io/chart?c=unit-test";
    const guardedFetch = vi
      .fn()
      .mockResolvedValueOnce(guardedResult(imageResponse()))
      .mockResolvedValueOnce(guardedResult(imageResponse()));
    const harness = createHarness({
      guardedFetch: guardedFetch as LineOutboundImageStagingDependencies["guardedFetch"],
    });

    const staged = await stageLineOutboundMessageImages(
      [
        {
          type: "image",
          originalContentUrl: source,
          previewImageUrl: source,
        },
      ],
      (value) => stageLineOutboundImage(value, harness.dependencies),
    );

    expect(guardedFetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: source,
        requireHttps: true,
        auditContext: "line-outbound-image-source",
      }),
    );
    expect(harness.commands).toContain("PutObjectCommand");
    expect(staged).toEqual([
      {
        type: "image",
        originalContentUrl: SIGNED_URL,
        previewImageUrl: SIGNED_URL,
      },
    ]);
    expect(staged[0]?.originalContentUrl).not.toBe(source);
  });

  it("rejects a non-HTTPS generated URL before LINE delivery", async () => {
    const harness = createHarness({ presignedUrl: "http://r2.example/staged.png" });

    await expect(
      stageLineOutboundImage("/tmp/example.png", harness.dependencies),
    ).rejects.toMatchObject({
      code: "signed_url_invalid",
    });
  });

  it.each([
    [404, "image/png", "signed_url_http_status_invalid"],
    [200, "text/html", "signed_url_content_type_invalid"],
    [200, "application/xml", "signed_url_content_type_invalid"],
  ])(
    "requires HTTP 200 and an image MIME before delivery (%s, %s)",
    async (status, contentType, expectedCode) => {
      const guardedFetch = vi.fn(async () =>
        guardedResult(imageResponse(status, contentType, Buffer.from("<Error>denied</Error>"))),
      );
      const harness = createHarness({
        guardedFetch: guardedFetch as LineOutboundImageStagingDependencies["guardedFetch"],
      });

      await expect(
        stageLineOutboundImage("/tmp/example.png", harness.dependencies),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );

  it("rejects an image-labelled XML/HTML error body", async () => {
    const guardedFetch = vi.fn(async () =>
      guardedResult(imageResponse(200, "image/png", Buffer.from("<html>denied</html>"))),
    );
    const harness = createHarness({
      guardedFetch: guardedFetch as LineOutboundImageStagingDependencies["guardedFetch"],
    });

    await expect(
      stageLineOutboundImage("/tmp/example.png", harness.dependencies),
    ).rejects.toMatchObject({ code: "image_type_invalid" });
  });

  it("never exposes signed credentials or filesystem paths in errors or logs", async () => {
    const signedSecret = "must-never-appear";
    const signedUrl = `https://r2.example/outbound/line/test.png?X-Amz-Credential=${signedSecret}`;
    const guardedFetch = vi.fn(async () =>
      guardedResult(imageResponse(403, "application/xml", Buffer.from("<Error/>"))),
    );
    const harness = createHarness({
      guardedFetch: guardedFetch as LineOutboundImageStagingDependencies["guardedFetch"],
      presignedUrl: signedUrl,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let caught: unknown;
    try {
      await stageLineOutboundImage("/tmp/private/image.png", harness.dependencies);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(LineOutboundImageStagingError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(signedSecret);
    expect(message).not.toContain("/tmp/private/image.png");
    expect(
      [log, warn, error]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .join(" "),
    ).not.toContain(signedSecret);
  });

  it("stages nested Flex, template, and quick-reply image fields", async () => {
    const sources: string[] = [];
    const stage = vi.fn(async (source: string) => {
      sources.push(source);
      return {
        url: `https://r2.example/outbound/line/${sources.length}.png`,
        objectKey: `outbound/line/${sources.length}.png`,
        contentType: "image/png",
        contentLength: PNG.byteLength,
        sha256: SHA256,
      };
    });

    const messages = await stageLineOutboundMessageImages(
      [
        {
          type: "flex",
          altText: "chart",
          contents: {
            type: "bubble",
            hero: { type: "image", url: "https://quickchart.io/chart?c=flex" },
          },
          quickReply: {
            items: [
              {
                type: "action",
                imageUrl: "/tmp/quick-reply.png",
                action: { type: "message", label: "Open", text: "Open" },
              },
            ],
          },
        },
        {
          type: "template",
          altText: "template",
          template: {
            type: "buttons",
            text: "Status",
            thumbnailImageUrl: "/data/template.png",
            actions: [],
          },
        },
      ],
      stage,
    );

    expect(sources).toEqual([
      "https://quickchart.io/chart?c=flex",
      "/tmp/quick-reply.png",
      "/data/template.png",
    ]);
    expect(JSON.stringify(messages)).not.toContain("quickchart.io");
    expect(JSON.stringify(messages)).not.toContain("/tmp/");
    expect(JSON.stringify(messages)).not.toContain("/data/");
  });

  it("fails closed for imagemaps that cannot use one canonical object URL", async () => {
    await expect(
      stageLineOutboundMessageImages([
        {
          type: "imagemap",
          baseUrl: "https://example.com/imagemap",
          altText: "map",
          baseSize: { width: 1040, height: 1040 },
          actions: [],
        },
      ]),
    ).rejects.toMatchObject({ code: "imagemap_not_supported" });
  });

  it("leaves existing LINE text messages unchanged", async () => {
    const stage = vi.fn();

    await expect(
      stageLineOutboundMessageImages([{ type: "text", text: "unchanged" }], stage),
    ).resolves.toEqual([{ type: "text", text: "unchanged" }]);
    expect(stage).not.toHaveBeenCalled();
  });

  it("fails safely when outbound R2 credentials are absent", async () => {
    const harness = createHarness();
    harness.dependencies.env = {};

    await expect(
      stageLineOutboundImage("/tmp/example.png", harness.dependencies),
    ).rejects.toMatchObject({ code: "r2_not_configured" });
    expect(harness.commands).toEqual([]);
  });
});
