import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import type { VideoGenerationSourceAsset } from "openclaw/plugin-sdk/video-generation";

const NOTION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_ASSETS = 8;
/** Deterministic submission order, applied after per-character fairness. */
const KIND_PRIORITY = { identity: 0, product: 1, style: 2 } as const;
const REFERENCE_FETCH_TIMEOUT_MS = 30_000;
const REFERENCE_FETCH_POLICY: SsrFPolicy = { allowPrivateNetwork: false };

export type LineVideoUgcCapabilityId =
  | "PRODUCT_LIBRARY"
  | "CHARACTER_LIBRARY"
  | "UGC_PROJECTS"
  | "UGC_SHOTS"
  | "AI_VIDEO_LIBRARY"
  | "AI_IMAGE_LIBRARY";

export type LineVideoNotionTarget = {
  databaseId: string;
  dataSourceId: string;
};

export type LineVideoUgcReference = Readonly<{
  kind: "identity" | "product" | "style";
  source: "r2" | "https";
  locator: string;
}>;

/**
 * One character frozen into the project at preparation time. The paid path
 * consumes these assets verbatim and never reads the Character Library.
 */
export type LineVideoUgcCharacterLock = Readonly<{
  code: string;
  pageId: string;
  contentIdentity?: string;
  identityReferences: readonly LineVideoUgcReference[];
  styleReferences: readonly LineVideoUgcReference[];
  frozenAt: string;
}>;

export type LineVideoUgcSceneContinuity = Readonly<{
  sceneNumber: number;
  previousScenePageId?: string;
  characterPageIds: readonly string[];
  characterCodes: readonly string[];
  prompt: string;
  durationSeconds?: number;
  outputR2Key?: string;
  previousSceneFrameR2Key?: string;
}>;

export type LineVideoUgcScope = Readonly<{
  version: 1;
  policyId: "UGC";
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  productPageId: string;
  characterPageId?: string;
  characterLocks: readonly LineVideoUgcCharacterLock[];
  /** Application-owned project identity; the same product and cast may run several. */
  projectInstanceId: string;
  projectPageId: string;
  projectRecordId: string;
  scene: LineVideoUgcSceneContinuity;
  scenePageId: string;
  shotPageIds: readonly string[];
  referenceAssets: readonly LineVideoUgcReference[];
  frozenPrompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  capabilities: Readonly<Record<LineVideoUgcCapabilityId, LineVideoNotionTarget>>;
  r2Prefix: "outbound/line-video";
  createdAt: string;
}>;

export type LineGroupPolicyBinding = {
  accountId: string;
  groupId: string;
  policyId: "UGC" | "KEEP_WATCHING";
  boundByOwnerId: string;
  boundAt: string;
};

function canonicalNotionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replaceAll("-", "");
  return NOTION_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveCloudbathUgcCapabilities(
  cfg: OpenClawConfig,
): Readonly<Record<LineVideoUgcCapabilityId, LineVideoNotionTarget>> | undefined {
  const plugin = objectValue(cfg.plugins?.entries?.["cloudbath-line-image-archive"]?.config);
  const policies = objectValue(plugin?.groupWorkspacePolicies);
  const ugc = objectValue(policies?.ugc);
  const capabilities = objectValue(ugc?.capabilities);
  if (!capabilities) {
    return undefined;
  }
  const ids: LineVideoUgcCapabilityId[] = [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ];
  const result = {} as Record<LineVideoUgcCapabilityId, LineVideoNotionTarget>;
  for (const id of ids) {
    const target = objectValue(capabilities[id]);
    const databaseId = canonicalNotionId(target?.databaseId);
    const dataSourceId = canonicalNotionId(target?.dataSourceId);
    if (!databaseId || !dataSourceId) {
      return undefined;
    }
    result[id] = { databaseId, dataSourceId };
  }
  return result;
}

export function hasCloudbathLineGroupWorkspacePolicies(cfg: OpenClawConfig): boolean {
  const plugin = objectValue(cfg.plugins?.entries?.["cloudbath-line-image-archive"]?.config);
  const policies = objectValue(plugin?.groupWorkspacePolicies);
  return Boolean(policies?.ugc || policies?.keepWatching);
}

function targetsEqual(
  left: Readonly<Record<LineVideoUgcCapabilityId, LineVideoNotionTarget>>,
  right: Readonly<Record<LineVideoUgcCapabilityId, LineVideoNotionTarget>>,
): boolean {
  return (Object.keys(left) as LineVideoUgcCapabilityId[]).every(
    (id) =>
      left[id].databaseId === right[id].databaseId &&
      left[id].dataSourceId === right[id].dataSourceId,
  );
}

export function validateLineVideoUgcScope(params: {
  scope: LineVideoUgcScope;
  cfg: OpenClawConfig;
  binding: LineGroupPolicyBinding | undefined;
  accountId: string;
  groupId: string;
  ownerSenderId: string;
  frozenPrompt: string;
}): boolean {
  const capabilities = resolveCloudbathUgcCapabilities(params.cfg);
  if (!capabilities || !targetsEqual(params.scope.capabilities, capabilities)) {
    return false;
  }
  // Scene and cast identity are part of what confirmation approves: the owner
  // confirmed THIS scene with THIS cast, so a scope whose lock and scene no
  // longer agree must not reach the paid call.
  const scene = params.scope.scene;
  const locks = params.scope.characterLocks ?? [];
  const sceneMatchesLock =
    scene !== undefined &&
    Number.isInteger(scene.sceneNumber) &&
    scene.sceneNumber >= 1 &&
    scene.prompt === params.scope.frozenPrompt &&
    scene.characterPageIds.length === locks.length &&
    scene.characterCodes.length === locks.length &&
    locks.every(
      (lock, index) =>
        scene.characterPageIds[index] === lock.pageId &&
        scene.characterCodes[index] === lock.code &&
        lock.identityReferences.length > 0,
    );
  if (!sceneMatchesLock || typeof params.scope.scenePageId !== "string") {
    return false;
  }
  return (
    params.scope.version === 1 &&
    params.scope.policyId === "UGC" &&
    params.scope.accountId === params.accountId &&
    params.scope.lineGroupId === params.groupId &&
    params.scope.ownerSenderId === params.ownerSenderId &&
    params.scope.frozenPrompt === params.frozenPrompt &&
    params.scope.r2Prefix === "outbound/line-video" &&
    params.binding?.policyId === "UGC" &&
    params.binding.accountId === params.accountId &&
    params.binding.groupId === params.groupId &&
    params.binding.boundByOwnerId === params.ownerSenderId
  );
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error("UGC reference archive is not configured");
  }
  return value;
}

function resolveR2Config(env: NodeJS.ProcessEnv) {
  const accountId = requiredEnv(env, "R2_ACCOUNT_ID");
  const endpointRaw = env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  const endpoint = new URL(endpointRaw);
  if (endpoint.protocol !== "https:") {
    throw new Error("UGC reference archive endpoint is invalid");
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    bucketName: requiredEnv(env, "R2_BUCKET_NAME"),
    accessKeyId: requiredEnv(env, "R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "R2_SECRET_ACCESS_KEY"),
  };
}

function assertImageBytes(bytes: Buffer): Buffer {
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!png && !jpeg && !webp) {
    throw new Error("UGC reference asset is not a supported image");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("UGC reference asset size is invalid");
  }
  return bytes;
}

type R2Body = {
  transformToByteArray?: () => Promise<Uint8Array>;
};

export type LineVideoUgcReferenceDependencies = {
  env?: NodeJS.ProcessEnv;
  s3Client?: { send(command: GetObjectCommand): Promise<unknown> };
  guardedFetch?: typeof fetchWithSsrFGuard;
};

async function readR2Reference(
  objectKey: string,
  dependencies: LineVideoUgcReferenceDependencies,
): Promise<Buffer> {
  const config = resolveR2Config(dependencies.env ?? process.env);
  const client =
    dependencies.s3Client ??
    new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  const result = (await client.send(
    new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
  )) as { Body?: R2Body; ContentLength?: number };
  if (result.ContentLength !== undefined && result.ContentLength > MAX_REFERENCE_BYTES) {
    throw new Error("UGC reference asset size is invalid");
  }
  const bytes = await result.Body?.transformToByteArray?.();
  if (!bytes) {
    throw new Error("UGC reference asset is unavailable");
  }
  return assertImageBytes(Buffer.from(bytes));
}

async function readHttpsReference(
  url: string,
  guardedFetch: typeof fetchWithSsrFGuard,
): Promise<Buffer> {
  const guarded = await guardedFetch({
    url,
    requireHttps: true,
    maxRedirects: 3,
    timeoutMs: REFERENCE_FETCH_TIMEOUT_MS,
    policy: REFERENCE_FETCH_POLICY,
    auditContext: "line-ugc-reference-source",
  });
  try {
    if (guarded.response.status !== 200) {
      throw new Error("UGC reference asset request failed");
    }
    const declared = Number(guarded.response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REFERENCE_BYTES) {
      throw new Error("UGC reference asset size is invalid");
    }
    return assertImageBytes(Buffer.from(await guarded.response.arrayBuffer()));
  } finally {
    await guarded.release();
  }
}

/**
 * Orders a scene's frozen references for submission, guaranteeing every locked
 * character is actually represented.
 *
 * Sorting by kind and truncating would let one character's references fill the
 * budget and drop another entirely -- the scene would generate without F2 in
 * it. Each locked character therefore claims one identity asset first, the rest
 * fill round-robin, and a cast that cannot fit fails closed rather than
 * shipping a silently smaller cast.
 *
 * Everything here reads the frozen lock. The Character Library is never
 * consulted after the project is locked, so scene 2 submits exactly what scene
 * 1 did.
 */
export function orderLineVideoUgcReferences(scope: LineVideoUgcScope): LineVideoUgcReference[] {
  const locks = scope.characterLocks ?? [];
  if (locks.length === 0) {
    return scope.referenceAssets
      .toSorted((left, right) => KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind])
      .slice(0, MAX_REFERENCE_ASSETS);
  }
  if (locks.length > MAX_REFERENCE_ASSETS) {
    throw new Error("UGC scene requests more characters than reference slots");
  }

  const available = new Map(
    scope.referenceAssets.map((asset) => [`${asset.source}\0${asset.locator}`, asset]),
  );
  const selected: LineVideoUgcReference[] = [];
  const claimed = new Set<string>();
  const claim = (reference: LineVideoUgcReference | undefined): boolean => {
    if (!reference) {
      return false;
    }
    const key = `${reference.source}\0${reference.locator}`;
    // Only assets frozen into this scope may be submitted; a lock entry that
    // is not in referenceAssets was never part of the confirmed scene.
    if (claimed.has(key) || !available.has(key) || selected.length >= MAX_REFERENCE_ASSETS) {
      return false;
    }
    claimed.add(key);
    selected.push(available.get(key)!);
    return true;
  };

  for (const lock of locks) {
    const claimedOne = lock.identityReferences.some((reference) => claim(reference));
    if (!claimedOne) {
      throw new Error(
        `UGC scene has no usable frozen identity reference for character "${lock.code}"`,
      );
    }
  }
  for (let depth = 1; selected.length < MAX_REFERENCE_ASSETS; depth += 1) {
    let progressed = false;
    for (const lock of locks) {
      if (claim(lock.identityReferences[depth])) {
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }
  for (const asset of scope.referenceAssets.filter((entry) => entry.kind === "product")) {
    claim(asset);
  }
  for (const asset of scope.referenceAssets.filter((entry) => entry.kind === "style")) {
    claim(asset);
  }
  return selected.toSorted((left, right) => KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]);
}

export async function materializeLineVideoUgcReferences(
  scope: LineVideoUgcScope,
  dependencies: LineVideoUgcReferenceDependencies = {},
): Promise<VideoGenerationSourceAsset[]> {
  const ordered = orderLineVideoUgcReferences(scope);
  const assets: VideoGenerationSourceAsset[] = [];
  for (const reference of ordered) {
    const buffer =
      reference.source === "r2"
        ? await readR2Reference(reference.locator, dependencies)
        : await readHttpsReference(
            reference.locator,
            dependencies.guardedFetch ?? fetchWithSsrFGuard,
          );
    assets.push({ buffer });
  }
  return assets;
}
