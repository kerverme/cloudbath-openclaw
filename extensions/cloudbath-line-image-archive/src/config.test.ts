import { describe, expect, it } from "vitest";
import { resolveArchiveConfig } from "./config.js";

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLOUDBATH_IMAGE_ARCHIVE_ENABLED: "true",
    CLOUDBATH_IMAGE_ANALYSIS_ENABLED: "false",
    LINE_ALLOWED_GROUP_IDS: "C123,C456",
    IMAGE_MAX_MB: "12",
    R2_ACCOUNT_ID: "account-placeholder",
    R2_ACCESS_KEY_ID: "access-placeholder",
    R2_SECRET_ACCESS_KEY: "secret-placeholder",
    R2_BUCKET_NAME: "bucket-placeholder",
    R2_KEY_PREFIX: "cloudbath/images",
    NOTION_API_KEY: "notion-placeholder",
    NOTION_DATABASE_ID: "database-placeholder",
    ...overrides,
  };
}

describe("resolveArchiveConfig", () => {
  it("is disabled by default without requiring credentials", () => {
    const config = resolveArchiveConfig({});
    expect(config.enabled).toBe(false);
    expect(config.analysisEnabled).toBe(false);
  });

  it("normalizes enabled configuration without exposing credential values", () => {
    const config = resolveArchiveConfig(enabledEnv());
    expect(config.enabled).toBe(true);
    expect(config.allowedGroupIds).toEqual(new Set(["C123", "C456"]));
    expect(config.imageMaxBytes).toBe(12 * 1024 * 1024);
    expect(config.r2.endpoint).toBe("https://account-placeholder.r2.cloudflarestorage.com");
    expect(config.r2.keyPrefix).toBe("cloudbath/images");
  });

  it("rejects enabled operation without an allowlist", () => {
    expect(() => resolveArchiveConfig(enabledEnv({ LINE_ALLOWED_GROUP_IDS: "" }))).toThrow(
      "LINE_ALLOWED_GROUP_IDS",
    );
  });

  it("rejects non-HTTPS R2 endpoints", () => {
    expect(() =>
      resolveArchiveConfig(enabledEnv({ R2_ENDPOINT: "http://example.invalid" })),
    ).toThrow("HTTPS");
  });
});
