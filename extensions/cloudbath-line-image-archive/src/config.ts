import { validateProfileConfiguration } from "./profiles.js";
import type {
  ArchiveConfig,
  NotionTarget,
  UgcCapabilityId,
  WorkspacePolicyConfig,
} from "./types.js";

const DEFAULT_IMAGE_MAX_MB = 10;
const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
const NOTION_ID_PATTERN = /^[0-9a-f]{32}$/;
const UGC_CAPABILITY_IDS = [
  "PRODUCT_LIBRARY",
  "CHARACTER_LIBRARY",
  "UGC_PROJECTS",
  "UGC_SHOTS",
  "AI_VIDEO_LIBRARY",
  "AI_IMAGE_LIBRARY",
] as const satisfies readonly UgcCapabilityId[];

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

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizedNotionId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a Notion ID`);
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "");
  if (!NOTION_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a valid Notion ID`);
  }
  return normalized;
}

function notionTarget(value: unknown, label: string): NotionTarget {
  const input = objectValue(value, label);
  return {
    databaseId: normalizedNotionId(input.databaseId, `${label}.databaseId`),
    dataSourceId: normalizedNotionId(input.dataSourceId, `${label}.dataSourceId`),
  };
}

export function resolveWorkspacePolicyConfig(
  pluginConfig: Record<string, unknown> = {},
): WorkspacePolicyConfig {
  const raw = pluginConfig.groupWorkspacePolicies;
  if (raw === undefined) {
    return { pairingTtlMs: DEFAULT_PAIRING_TTL_MS };
  }
  const input = objectValue(raw, "groupWorkspacePolicies");
  const pairingTtlMs = readPositiveNumber(
    typeof input.pairingTtlMs === "number" ? String(input.pairingTtlMs) : undefined,
    DEFAULT_PAIRING_TTL_MS,
    "groupWorkspacePolicies.pairingTtlMs",
  );
  if (pairingTtlMs > 24 * 60 * 60 * 1_000) {
    throw new Error("groupWorkspacePolicies.pairingTtlMs must not exceed 24 hours");
  }

  let keepWatching: WorkspacePolicyConfig["keepWatching"];
  if (input.keepWatching !== undefined) {
    const keepWatchingInput = objectValue(
      input.keepWatching,
      "groupWorkspacePolicies.keepWatching",
    );
    const r2Prefix = normalizeKeyPrefix(
      typeof keepWatchingInput.r2Prefix === "string" ? keepWatchingInput.r2Prefix : undefined,
    );
    if (!r2Prefix) {
      throw new Error("groupWorkspacePolicies.keepWatching.r2Prefix is required");
    }
    keepWatching = {
      notion: notionTarget(keepWatchingInput.notion, "groupWorkspacePolicies.keepWatching.notion"),
      r2Prefix,
    };
  }

  let ugc: WorkspacePolicyConfig["ugc"];
  if (input.ugc !== undefined) {
    const ugcInput = objectValue(input.ugc, "groupWorkspacePolicies.ugc");
    const capabilitiesInput = objectValue(
      ugcInput.capabilities,
      "groupWorkspacePolicies.ugc.capabilities",
    );
    const capabilities = Object.fromEntries(
      UGC_CAPABILITY_IDS.map((id) => [
        id,
        notionTarget(capabilitiesInput[id], `groupWorkspacePolicies.ugc.capabilities.${id}`),
      ]),
    ) as Record<UgcCapabilityId, NotionTarget>;
    ugc = { capabilities };
  }

  return { pairingTtlMs, keepWatching, ugc };
}

export function resolveArchiveConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig: Record<string, unknown> = {},
): ArchiveConfig {
  const enabled = readBoolean(env.CLOUDBATH_IMAGE_ARCHIVE_ENABLED, false);
  const analysisEnabled = readBoolean(env.CLOUDBATH_IMAGE_ANALYSIS_ENABLED, false);
  const imageMaxMb = readPositiveNumber(env.IMAGE_MAX_MB, DEFAULT_IMAGE_MAX_MB, "IMAGE_MAX_MB");
  if (imageMaxMb > 100) {
    throw new Error("IMAGE_MAX_MB must not exceed 100");
  }

  const profileInput = {
    version: pluginConfig.version ?? 1,
    agentProfiles: pluginConfig.agentProfiles ?? [],
    schemaProfiles: pluginConfig.schemaProfiles ?? [],
  };
  const profiles = validateProfileConfiguration(profileInput);
  if (enabled && profiles.activeProfilesByGroupId.size === 0) {
    throw new Error("At least one active Agent Profile is required when archiving is enabled");
  }
  const accountId = enabled ? readRequired(env, "R2_ACCOUNT_ID") : env.R2_ACCOUNT_ID?.trim() || "";
  return {
    enabled,
    analysisEnabled,
    imageMaxBytes: Math.floor(imageMaxMb * 1024 * 1024),
    profiles,
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
      apiKey: enabled
        ? readRequired(env, "OPENCLAW_NOTION_WRITE_TOKEN")
        : env.OPENCLAW_NOTION_WRITE_TOKEN?.trim() || "",
    },
    retry: {
      maxAttempts: DEFAULT_RETRY_ATTEMPTS,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    },
  };
}
