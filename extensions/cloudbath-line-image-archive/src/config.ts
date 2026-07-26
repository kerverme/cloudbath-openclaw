import type { ArchiveConfig } from "./types.js";

const DEFAULT_IMAGE_MAX_MB = 10;
const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${normalized}`);
}

function readPositiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when CLOUDBATH_IMAGE_ARCHIVE_ENABLED is enabled`);
  }
  return value;
}

function normalizeEndpoint(rawEndpoint: string | undefined, accountId: string): string {
  const endpoint =
    rawEndpoint?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  if (!endpoint) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("R2_ENDPOINT must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("R2_ENDPOINT must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeKeyPrefix(value: string | undefined): string {
  return (value?.trim() ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

export function resolveArchiveConfig(env: NodeJS.ProcessEnv = process.env): ArchiveConfig {
  const enabled = readBoolean(env.CLOUDBATH_IMAGE_ARCHIVE_ENABLED, false);
  const analysisEnabled = readBoolean(env.CLOUDBATH_IMAGE_ANALYSIS_ENABLED, false);
  const allowedGroupIds = new Set(
    (env.LINE_ALLOWED_GROUP_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const imageMaxMb = readPositiveNumber(env.IMAGE_MAX_MB, DEFAULT_IMAGE_MAX_MB, "IMAGE_MAX_MB");

  if (imageMaxMb > 100) {
    throw new Error("IMAGE_MAX_MB must not exceed 100");
  }
  if (enabled && allowedGroupIds.size === 0) {
    throw new Error("LINE_ALLOWED_GROUP_IDS must contain at least one group ID");
  }

  const accountId = enabled ? readRequired(env, "R2_ACCOUNT_ID") : env.R2_ACCOUNT_ID?.trim() || "";
  const config: ArchiveConfig = {
    enabled,
    analysisEnabled,
    allowedGroupIds,
    imageMaxBytes: Math.floor(imageMaxMb * 1024 * 1024),
    r2: {
      accountId,
      accessKeyId: enabled
        ? readRequired(env, "R2_ACCESS_KEY_ID")
        : env.R2_ACCESS_KEY_ID?.trim() || "",
      secretAccessKey: enabled
        ? readRequired(env, "R2_SECRET_ACCESS_KEY")
        : env.R2_SECRET_ACCESS_KEY?.trim() || "",
      bucketName: enabled ? readRequired(env, "R2_BUCKET_NAME") : env.R2_BUCKET_NAME?.trim() || "",
      endpoint: normalizeEndpoint(env.R2_ENDPOINT, accountId),
      keyPrefix: normalizeKeyPrefix(env.R2_KEY_PREFIX),
    },
    notion: {
      apiKey: enabled ? readRequired(env, "NOTION_API_KEY") : env.NOTION_API_KEY?.trim() || "",
      databaseId: enabled
        ? readRequired(env, "NOTION_DATABASE_ID")
        : env.NOTION_DATABASE_ID?.trim() || "",
    },
    retry: {
      maxAttempts: DEFAULT_RETRY_ATTEMPTS,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    },
  };

  return config;
}
