import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import { NOTION_API_VERSION } from "./notion-schema.js";
import { isRetryableStatus, withBoundedRetry } from "./retry.js";
import type {
  ArchiveConfig,
  ActiveUgcLineSession,
  FrozenUgcVideoScope,
  NotionTarget,
  PendingUgcVideoScope,
  UgcCharacterLock,
  UgcProjectCharacterLock,
  UgcSceneContinuity,
  SafeLogger,
  UgcCapabilityId,
  UgcReferenceAsset,
  WorkspacePolicyConfig,
} from "./types.js";
import {
  allocateSceneReferences,
  freezeCharacterLock,
  normalizeCharacterCodes,
  PRODUCT_REFERENCE_PROPERTIES,
  PRODUCT_STYLE_PROPERTIES,
} from "./ugc-character-lock.js";

const NOTION_BASE_URL = "https://api.notion.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUERY_PAGES = 10;
const MAX_MATCHES = 20;
const MAX_REFERENCE_ASSETS = 8;
const PENDING_TTL_MS = 15 * 60 * 1_000;
const UGC_R2_PREFIX = "outbound/line-video" as const;

export const CLOUDBATH_UGC_VIDEO_PREPARE_TOOL_NAME = "cloudbath_ugc_video_prepare";
export const CLOUDBATH_UGC_PENDING_NAMESPACE = "ugc-video-pending-v1";
export const CLOUDBATH_UGC_DRAFT_SCOPE_NAMESPACE = "ugc-video-draft-scopes-v1";
export const CLOUDBATH_UGC_ACTIVE_SESSION_NAMESPACE = "ugc-video-active-sessions-v1";
export const CLOUDBATH_UGC_PROJECT_LOCK_NAMESPACE = "ugc-project-character-lock-v1";
export const CLOUDBATH_UGC_SCOPE_MAX_ENTRIES = 20_000;

type NotionPropertySchema = {
  type?: string;
  relation?: { data_source_id?: string };
  select?: { options?: Array<{ name?: string }> };
};

type NotionPropertyValue = {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  number?: number | null;
  relation?: Array<{ id?: string }>;
  url?: string | null;
  files?: Array<{
    type?: string;
    external?: { url?: string };
    file?: { url?: string };
  }>;
};

type NotionDataSource = {
  object?: string;
  id?: string;
  parent?: { type?: string; database_id?: string };
  properties?: Record<string, NotionPropertySchema>;
};

type NotionPage = {
  object?: string;
  id?: string;
  last_edited_time?: string;
  parent?: { type?: string; data_source_id?: string };
  properties?: Record<string, NotionPropertyValue>;
};

type NotionQueryResponse = {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type UgcPrepareInput = {
  productName: string;
  characterNames: string[];
  /** Scene to prepare. Omitted means "next scene in this project". */
  sceneNumber?: number;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
};

type UgcPrepareToolContext = {
  messageChannel?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  sessionKey?: string;
  accountId?: string;
  nativeConversationId?: string;
};

/**
 * Status options the live UGC databases actually offer. Writing anything else
 * makes Notion reject the update, so the set is validated at startup rather
 * than discovered when a paid scene tries to report its result.
 */
export const UGC_STATUS_OPTIONS = ["Draft", "Ready", "Generating", "Completed", "Failed"] as const;
export type UgcStatus = (typeof UGC_STATUS_OPTIONS)[number];

/**
 * Contract against the LIVE production schemas. Names here are the real column
 * names -- `Shot Order`, `Duration`, `Generated R2 Object Key` -- not the
 * invented ones an earlier draft assumed. Neither UGC_PROJECTS nor UGC_SHOTS
 * has a `Record ID`, so create-or-reuse identity comes from live relations
 * (see findProjectByCast / findSceneByOrder) instead of a synthetic column.
 */
const CAPABILITY_SCHEMAS: Readonly<
  Record<
    UgcCapabilityId,
    Readonly<
      Record<
        string,
        { type: string; relationTarget?: UgcCapabilityId; statusOptions?: readonly string[] }
      >
    >
  >
> = {
  PRODUCT_LIBRARY: { Name: { type: "title" } },
  CHARACTER_LIBRARY: { Name: { type: "title" } },
  UGC_PROJECTS: {
    Name: { type: "title" },
    Status: { type: "select", statusOptions: UGC_STATUS_OPTIONS },
    Product: { type: "relation", relationTarget: "PRODUCT_LIBRARY" },
    Character: { type: "relation", relationTarget: "CHARACTER_LIBRARY" },
    "Estimated Cost USD": { type: "number" },
    "Actual Cost USD": { type: "number" },
  },
  UGC_SHOTS: {
    Name: { type: "title" },
    Status: { type: "select", statusOptions: UGC_STATUS_OPTIONS },
    Project: { type: "relation", relationTarget: "UGC_PROJECTS" },
    "Shot Order": { type: "number" },
    Prompt: { type: "rich_text" },
  },
  AI_VIDEO_LIBRARY: {
    Name: { type: "title" },
    Status: { type: "select" },
    "Video Job ID": { type: "rich_text" },
    "UGC Project": { type: "relation", relationTarget: "UGC_PROJECTS" },
  },
  AI_IMAGE_LIBRARY: {
    Name: { type: "title" },
    Project: { type: "relation", relationTarget: "UGC_PROJECTS" },
    Product: { type: "relation", relationTarget: "PRODUCT_LIBRARY" },
    Character: { type: "relation", relationTarget: "CHARACTER_LIBRARY" },
  },
};

/** Reads `Shot Order` from a live UGC_SHOTS row. */
function sceneOrder(page: NotionPage): number | undefined {
  const property = page.properties?.["Shot Order"];
  return property?.type === "number" && typeof property.number === "number"
    ? property.number
    : undefined;
}

function canonicalNotionId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "");
  return normalized && /^[0-9a-f]{32}$/u.test(normalized) ? normalized : undefined;
}

function sameNotionId(left: string | undefined, right: string): boolean {
  return canonicalNotionId(left) === right;
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function plainText(property: NotionPropertyValue | undefined): string {
  const parts = property?.type === "title" ? property.title : property?.rich_text;
  return (parts ?? [])
    .map((item) => item.plain_text ?? "")
    .join("")
    .trim();
}

function richText(value: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content: value.slice(0, 1_900) } }] };
}

function title(value: string): Record<string, unknown> {
  return { title: [{ type: "text", text: { content: value.slice(0, 1_900) } }] };
}

function relation(pageId: string | undefined): Record<string, unknown> {
  return { relation: pageId ? [{ id: pageId }] : [] };
}

function hashKey(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

export function ugcPendingKey(sessionKey: string): string {
  return hashKey("ugc-pending", sessionKey);
}

export /** Durable key for a project's frozen cast. */
function ugcProjectLockKey(projectRecordId: string): string {
  return `ugc-project-lock:${projectRecordId}`;
}

export function ugcDraftScopeKey(draftId: string): string {
  return hashKey("ugc-draft", draftId);
}

function recordId(params: {
  accountId: string;
  groupId: string;
  productPageId: string;
  characterPageId?: string;
}): string {
  return hashKey(
    "ugc-project-v1",
    params.accountId,
    params.groupId,
    params.productPageId,
    params.characterPageId ?? "",
  );
}

function safeR2Key(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.includes("..") || normalized.startsWith("http")) {
    return undefined;
  }
  return normalized;
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function propertyReferences(
  page: NotionPage,
  names: readonly string[],
  kind: UgcReferenceAsset["kind"],
): UgcReferenceAsset[] {
  const references: UgcReferenceAsset[] = [];
  for (const name of names) {
    const property = page.properties?.[name];
    if (!property) {
      continue;
    }
    const textValues = property.type === "rich_text" ? [plainText(property)] : [];
    const urlValues = property.type === "url" && property.url ? [property.url] : [];
    const fileValues = (property.files ?? []).flatMap((file) => [
      file.external?.url,
      file.file?.url,
    ]);
    for (const raw of [...textValues, ...urlValues, ...fileValues]) {
      if (!raw) {
        continue;
      }
      const https = safeHttpsUrl(raw);
      if (https) {
        references.push({ kind, source: "https", locator: https });
        continue;
      }
      const objectKey = safeR2Key(raw);
      if (objectKey) {
        references.push({ kind, source: "r2", locator: objectKey });
      }
    }
  }
  return references;
}

/**
 * Builds one scene's submission set from the project's frozen cast plus the
 * product's own references. Character references come from the lock, never from
 * a fresh Character Library read -- that is what keeps scene 2 identical to
 * scene 1.
 */
function freezeSceneReferences(
  characterLocks: readonly UgcCharacterLock[],
  product: NotionPage,
): UgcReferenceAsset[] {
  const productReferences = [
    ...propertyReferences(product, PRODUCT_REFERENCE_PROPERTIES, "product"),
    ...propertyReferences(product, PRODUCT_STYLE_PROPERTIES, "style"),
  ];
  if (characterLocks.length === 0) {
    const unique = new Map<string, UgcReferenceAsset>();
    for (const item of productReferences) {
      unique.set(`${item.kind}\0${item.source}\0${item.locator}`, item);
    }
    return [...unique.values()].slice(0, MAX_REFERENCE_ASSETS);
  }
  return [
    ...allocateSceneReferences({
      characterLocks,
      productReferences,
      maxAssets: MAX_REFERENCE_ASSETS,
    }).assets,
  ];
}

export class UgcNotionWorkflowClient {
  private readonly schemaCache = new Map<string, Promise<NotionDataSource>>();

  constructor(
    private readonly token: string,
    private readonly retry: ArchiveConfig["retry"],
    private readonly logger: SafeLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return await withBoundedRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${this.token}`);
        headers.set("Notion-Version", NOTION_API_VERSION);
        if (init.body !== undefined) {
          headers.set("Content-Type", "application/json");
        }
        try {
          const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
            ...init,
            headers,
            signal: controller.signal,
          });
          if (!response.ok) {
            throw Object.assign(new Error(`Notion request failed (${response.status})`), {
              status: response.status,
            });
          }
          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        ...this.retry,
        isRetryable: (error) =>
          isRetryableStatus(
            typeof error === "object" && error !== null && "status" in error
              ? Number((error as { status: unknown }).status)
              : 500,
          ),
        onRetry: (_error, attempt, delayMs) =>
          this.logger.warn("ugc_notion_retry", { attempt, delayMs }),
      },
    );
  }

  private async schema(
    capabilityId: UgcCapabilityId,
    target: NotionTarget,
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>,
  ): Promise<NotionDataSource> {
    const cacheKey = `${capabilityId}\0${target.databaseId}\0${target.dataSourceId}`;
    let pending = this.schemaCache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const source = await this.request<NotionDataSource>(
          `/v1/data_sources/${encodeURIComponent(target.dataSourceId)}`,
        );
        if (
          source.object !== "data_source" ||
          !sameNotionId(source.id, target.dataSourceId) ||
          source.parent?.type !== "database_id" ||
          !sameNotionId(source.parent.database_id, target.databaseId)
        ) {
          throw new Error(`${capabilityId} Notion target identity is incompatible`);
        }
        const expected = CAPABILITY_SCHEMAS[capabilityId];
        for (const [name, contract] of Object.entries(expected)) {
          const property = source.properties?.[name];
          if (property?.type !== contract.type) {
            throw new Error(`${capabilityId} Notion schema is incompatible at ${name}`);
          }
          if (contract.relationTarget) {
            const related = capabilities[contract.relationTarget];
            if (!sameNotionId(property.relation?.data_source_id, related.dataSourceId)) {
              throw new Error(`${capabilityId} Notion relation is incompatible at ${name}`);
            }
          }
          if (contract.statusOptions) {
            // Every status this workflow writes must exist as an option, or a
            // completed paid scene would fail to record its own result.
            const available = new Set(
              (property.select?.options ?? []).map((option) => option.name),
            );
            const missing = contract.statusOptions.filter((option) => !available.has(option));
            if (missing.length > 0) {
              throw new Error(
                `${capabilityId} Notion status options are incompatible at ${name}: missing ${missing.join(", ")}`,
              );
            }
          }
        }
        return source;
      })();
      this.schemaCache.set(cacheKey, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.schemaCache.get(cacheKey) === pending) {
        this.schemaCache.delete(cacheKey);
      }
      throw error;
    }
  }

  async validateCapabilities(
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>,
  ): Promise<void> {
    await Promise.all(
      (Object.keys(CAPABILITY_SCHEMAS) as UgcCapabilityId[]).map(
        async (id) => await this.schema(id, capabilities[id], capabilities),
      ),
    );
  }

  private assertPage(page: NotionPage, target: NotionTarget): NotionPage {
    if (
      page.object !== "page" ||
      !page.id ||
      page.parent?.type !== "data_source_id" ||
      !sameNotionId(page.parent.data_source_id, target.dataSourceId)
    ) {
      throw new Error("Notion record escaped its configured capability target");
    }
    return page;
  }

  private async queryAll(
    target: NotionTarget,
    body: Record<string, unknown>,
  ): Promise<NotionPage[]> {
    const records: NotionPage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      const response = await this.request<NotionQueryResponse>(
        `/v1/data_sources/${encodeURIComponent(target.dataSourceId)}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            ...body,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
      );
      for (const record of response.results ?? []) {
        records.push(this.assertPage(record, target));
        if (records.length > MAX_MATCHES) {
          throw new Error("Notion lookup returned too many records");
        }
      }
      if (!response.has_more) {
        return records;
      }
      cursor = response.next_cursor?.trim() || undefined;
      if (!cursor) {
        throw new Error("Notion pagination cursor is missing");
      }
    }
    throw new Error("Notion pagination exceeded its safety limit");
  }

  async resolveNamedRecord(params: {
    capabilityId: "PRODUCT_LIBRARY" | "CHARACTER_LIBRARY";
    target: NotionTarget;
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    name: string;
  }): Promise<NotionPage> {
    await this.schema(params.capabilityId, params.target, params.capabilities);
    const records = await this.queryAll(params.target, {
      filter: { property: "Name", title: { contains: params.name.trim() } },
    });
    const wanted = normalizedName(params.name);
    const exact = records.filter(
      (record) => normalizedName(plainText(record.properties?.Name)) === wanted,
    );
    if (exact.length !== 1) {
      throw new Error(
        exact.length === 0
          ? `${params.capabilityId} record was not found`
          : `${params.capabilityId} record is ambiguous`,
      );
    }
    return exact[0]!;
  }

  private async createPage(
    target: NotionTarget,
    properties: Record<string, unknown>,
  ): Promise<NotionPage> {
    const page = await this.request<NotionPage>("/v1/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: target.dataSourceId },
        properties,
      }),
    });
    return this.assertPage(page, target);
  }

  /**
   * Finds the project for this exact cast.
   *
   * Live UGC_PROJECTS has no `Record ID`, and `Project ID` is a Notion-managed
   * unique_id we cannot write, so identity comes from what the database
   * actually stores: the Product relation plus the exact set of Character
   * relations. F1+F2 is therefore a different project from F1 alone, and a
   * replayed preparation reuses the same row instead of forking one.
   */
  private async findProjectByCast(params: {
    target: NotionTarget;
    productPageId: string;
    characterPageIds: readonly string[];
  }): Promise<NotionPage | undefined> {
    const wanted = [...params.characterPageIds].toSorted().join("|");
    const pages = await this.queryAll(params.target, {
      filter: { property: "Product", relation: { contains: params.productPageId } },
    });
    return pages.find((page) => {
      const cast = (page.properties?.Character?.relation ?? [])
        .map((entry) => entry.id ?? "")
        .filter(Boolean)
        .toSorted()
        .join("|");
      return cast === wanted;
    });
  }

  async createOrReuseProject(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    accountId: string;
    groupId: string;
    product: NotionPage;
    characterPageIds: readonly string[];
    characterLabel?: string;
  }): Promise<{ page: NotionPage; recordId: string }> {
    const target = params.capabilities.UGC_PROJECTS;
    await this.schema("UGC_PROJECTS", target, params.capabilities);
    // Durable-state key only (character lock, scene scope). Never written to
    // Notion -- the live schema has no column for it.
    const id = recordId({
      accountId: params.accountId,
      groupId: params.groupId,
      productPageId: params.product.id!,
      characterPageId: [...params.characterPageIds].toSorted().join("|") || undefined,
    });
    const existing = await this.findProjectByCast({
      target,
      productPageId: params.product.id!,
      characterPageIds: params.characterPageIds,
    });
    if (existing) {
      return { page: existing, recordId: id };
    }
    const productName = plainText(params.product.properties?.Name);
    const page = await this.createPage(target, {
      Name: title(`${productName}${params.characterLabel ? ` × ${params.characterLabel}` : ""}`),
      Status: { select: { name: "Draft" satisfies UgcStatus } },
      Product: relation(params.product.id),
      // The whole frozen cast, not just the first character: a project running
      // F1 and F2 must relate to both library pages.
      Character: { relation: params.characterPageIds.map((pageId) => ({ id: pageId })) },
      "Estimated Cost USD": { number: null },
      "Actual Cost USD": { number: null },
    });
    return { page, recordId: id };
  }

  /** Read-only scene lookup by order. Never creates. */
  async findSceneByOrder(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    projectPageId: string;
    sceneNumber: number;
  }): Promise<NotionPage | undefined> {
    const pages = await this.queryAll(params.capabilities.UGC_SHOTS, {
      filter: { property: "Project", relation: { contains: params.projectPageId } },
    });
    return pages.find((page) => sceneOrder(page) === params.sceneNumber);
  }

  /**
   * One UGC_SHOTS row per scene, identified by its Project relation plus
   * `Shot Order`, so a replayed preparation reuses the row.
   */
  async createOrReuseScene(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    projectPageId: string;
    sceneNumber: number;
    prompt: string;
    durationSeconds?: number;
  }): Promise<NotionPage> {
    const target = params.capabilities.UGC_SHOTS;
    await this.schema("UGC_SHOTS", target, params.capabilities);
    const existing = await this.findSceneByOrder(params);
    if (existing) {
      return existing;
    }
    return await this.createPage(target, {
      Name: title(`Scene ${params.sceneNumber}`),
      Status: { select: { name: "Draft" satisfies UgcStatus } },
      Project: relation(params.projectPageId),
      "Shot Order": { number: params.sceneNumber },
      Prompt: richText(params.prompt),
      ...(params.durationSeconds !== undefined
        ? { Duration: { number: params.durationSeconds } }
        : {}),
    });
  }

  /** Highest scene order already recorded for a project, 0 when none. */
  async latestSceneNumber(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    projectPageId: string;
  }): Promise<number> {
    const pages = await this.queryAll(params.capabilities.UGC_SHOTS, {
      filter: { property: "Project", relation: { contains: params.projectPageId } },
    });
    return pages.reduce((highest, page) => {
      const value = sceneOrder(page);
      return value !== undefined && value > highest ? value : highest;
    }, 0);
  }

  async markAwaitingConfirmation(params: {
    scope: FrozenUgcVideoScope;
    estimatedCostUsd: number;
  }): Promise<void> {
    // "Ready" is the live option for prepared-and-awaiting-owner; the database
    // has no "Awaiting Confirmation".
    await this.request(`/v1/pages/${encodeURIComponent(params.scope.projectPageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          Status: { select: { name: "Ready" satisfies UgcStatus } },
          "Estimated Cost USD": { number: params.estimatedCostUsd },
        },
      }),
    });
    await this.request(`/v1/pages/${encodeURIComponent(params.scope.scenePageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          Status: { select: { name: "Ready" satisfies UgcStatus } },
          "Estimated Cost USD": { number: params.estimatedCostUsd },
        },
      }),
    });
  }
}

function parseInput(value: unknown): UgcPrepareInput {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const productName = typeof input.productName === "string" ? input.productName.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!productName || !prompt) {
    throw new Error("productName and prompt are required");
  }
  // characterNames is canonical; the single-character field stays accepted so
  // an owner's existing one-character phrasing keeps working.
  const rawNames = Array.isArray(input.characterNames)
    ? input.characterNames.filter((entry): entry is string => typeof entry === "string")
    : typeof input.characterName === "string"
      ? [input.characterName]
      : [];
  const characterNames = rawNames.length > 0 ? normalizeCharacterCodes(rawNames) : [];
  const sceneNumber =
    typeof input.sceneNumber === "number" && Number.isInteger(input.sceneNumber)
      ? input.sceneNumber
      : undefined;
  if (sceneNumber !== undefined && sceneNumber < 1) {
    throw new Error("sceneNumber must be 1 or greater");
  }
  return {
    productName,
    characterNames,
    ...(sceneNumber !== undefined ? { sceneNumber } : {}),
    prompt,
    ...(typeof input.durationSeconds === "number"
      ? { durationSeconds: input.durationSeconds }
      : {}),
    ...(typeof input.aspectRatio === "string" ? { aspectRatio: input.aspectRatio.trim() } : {}),
    ...(typeof input.resolution === "string" ? { resolution: input.resolution.trim() } : {}),
    ...(typeof input.audio === "boolean" ? { audio: input.audio } : {}),
  };
}

function nativeGroupId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const groupId = normalized.match(/^line:group:([A-Za-z0-9_-]+)$/u)?.[1] ?? normalized;
  return /^C[A-Za-z0-9_-]+$/u.test(groupId) ? groupId : undefined;
}

export class CloudbathUgcVideoWorkflow {
  constructor(
    private readonly config: NonNullable<WorkspacePolicyConfig["ugc"]>,
    private readonly registry: LineGroupWorkspacePolicyRegistry,
    private readonly notion: UgcNotionWorkflowClient,
    private readonly pending: PluginStateKeyedStore<PendingUgcVideoScope>,
    private readonly draftScopes: PluginStateKeyedStore<FrozenUgcVideoScope>,
    private readonly activeSessions: PluginStateKeyedStore<ActiveUgcLineSession>,
    /**
     * Durable per-project cast. No TTL: a project's scene 7 must submit the
     * same references scene 1 did, however long the gap.
     */
    private readonly projectLocks: PluginStateKeyedStore<UgcProjectCharacterLock>,
    private readonly now: () => number = Date.now,
  ) {}

  async observeTurn(params: {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    senderId?: string;
    senderIsOwner?: boolean;
  }): Promise<void> {
    if (!params.sessionKey?.trim()) {
      return;
    }
    const groupId = nativeGroupId(params.conversationId);
    const accountId = params.accountId?.trim();
    const senderId = params.senderId?.trim();
    const binding =
      params.channelId?.trim().toLowerCase() === "line" && groupId
        ? await this.registry.lookup(accountId, groupId)
        : null;
    if (
      !accountId ||
      !groupId ||
      !senderId ||
      params.senderIsOwner !== true ||
      binding?.policyId !== "UGC" ||
      binding.boundByOwnerId !== senderId
    ) {
      await this.activeSessions.delete(ugcPendingKey(params.sessionKey));
      return;
    }
    await this.activeSessions.register(
      ugcPendingKey(params.sessionKey),
      { accountId, lineGroupId: groupId, ownerSenderId: senderId },
      { ttlMs: PENDING_TTL_MS },
    );
  }

  createTool(context: UgcPrepareToolContext) {
    if (
      context.messageChannel !== "line" ||
      context.senderIsOwner !== true ||
      !context.requesterSenderId?.trim() ||
      !context.sessionKey?.trim() ||
      !context.accountId?.trim() ||
      !nativeGroupId(context.nativeConversationId)
    ) {
      return null;
    }
    return {
      name: CLOUDBATH_UGC_VIDEO_PREPARE_TOOL_NAME,
      label: "Cloudbath UGC Video Preparation",
      description:
        "OWNER-ONLY. In a LINE group paired to UGC, resolves configured Product/Character records by name, freezes one project-level character identity lock, creates or reuses the requested scene, and freezes scope before line_video_draft. Later scenes in the same project reuse the frozen cast. This never performs paid generation.",
      parameters: Type.Object({
        productName: Type.String(),
        characterNames: Type.Optional(Type.Array(Type.String())),
        characterName: Type.Optional(Type.String()),
        sceneNumber: Type.Optional(Type.Integer({ minimum: 1 })),
        prompt: Type.String(),
        durationSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
        aspectRatio: Type.Optional(Type.String()),
        resolution: Type.Optional(Type.String()),
        audio: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId: string, rawInput: unknown) => {
        const input = parseInput(rawInput);
        const accountId = context.accountId!.trim();
        const groupId = nativeGroupId(context.nativeConversationId)!;
        const ownerSenderId = context.requesterSenderId!.trim();
        const binding = await this.registry.requirePolicy(accountId, groupId, "UGC");
        if (binding.boundByOwnerId !== ownerSenderId) {
          throw new Error("UGC workflow is restricted to the owner who paired this group");
        }
        await this.notion.validateCapabilities(this.config.capabilities);
        const product = await this.notion.resolveNamedRecord({
          capabilityId: "PRODUCT_LIBRARY",
          target: this.config.capabilities.PRODUCT_LIBRARY,
          capabilities: this.config.capabilities,
          name: input.productName,
        });
        // Every requested code must resolve to exactly one library row before
        // anything is created; a partial cast never reaches a scene.
        const characterPages = [];
        for (const code of input.characterNames) {
          characterPages.push({
            code,
            page: await this.notion.resolveNamedRecord({
              capabilityId: "CHARACTER_LIBRARY",
              target: this.config.capabilities.CHARACTER_LIBRARY,
              capabilities: this.config.capabilities,
              name: code,
            }),
          });
        }
        const characterPageIds = characterPages.map((entry) => entry.page.id!);
        const project = await this.notion.createOrReuseProject({
          capabilities: this.config.capabilities,
          accountId,
          groupId,
          product,
          characterPageIds,
          ...(input.characterNames.length > 0
            ? { characterLabel: input.characterNames.join(" × ") }
            : {}),
        });

        // The cast is frozen once per project. A later scene reuses the stored
        // lock verbatim rather than re-reading the Character Library, so edits
        // to a library row cannot reach an in-flight project.
        const lockKey = ugcProjectLockKey(project.recordId);
        const existingLock = await this.projectLocks.lookup(lockKey);
        const frozenAt = new Date(this.now()).toISOString();
        let characterLocks: readonly UgcCharacterLock[];
        if (existingLock) {
          characterLocks = existingLock.characterLocks;
          const requested = input.characterNames.map((code) => code.toLowerCase()).toSorted();
          const locked = characterLocks.map((lock) => lock.code.toLowerCase()).toSorted();
          if (requested.length > 0 && requested.join("|") !== locked.join("|")) {
            throw new Error(
              `This project is already locked to ${characterLocks
                .map((lock) => lock.code)
                .join(", ")}; start a new project to change its cast`,
            );
          }
        } else {
          characterLocks = Object.freeze(
            characterPages.map((entry) =>
              freezeCharacterLock({
                code: entry.code,
                page: entry.page,
                readReferences: propertyReferences,
                frozenAt,
              }),
            ),
          );
          await this.projectLocks.register(lockKey, {
            version: 1,
            projectPageId: project.page.id!,
            projectRecordId: project.recordId,
            accountId,
            lineGroupId: groupId,
            ownerSenderId,
            characterLocks,
            frozenAt,
          });
        }

        const sceneNumber =
          input.sceneNumber ??
          (await this.notion.latestSceneNumber({
            capabilities: this.config.capabilities,
            projectPageId: project.page.id!,
          })) + 1;
        // Read-only. Creating the previous scene here would mint a phantom
        // Scene 1 carrying Scene 2's prompt, so a missing predecessor fails
        // closed instead.
        const previousScene =
          sceneNumber > 1
            ? await this.notion.findSceneByOrder({
                capabilities: this.config.capabilities,
                projectPageId: project.page.id!,
                sceneNumber: sceneNumber - 1,
              })
            : undefined;
        if (sceneNumber > 1 && !previousScene) {
          throw new Error(
            `Scene ${sceneNumber} cannot be prepared because scene ${sceneNumber - 1} does not exist in this project`,
          );
        }
        const scenePage = await this.notion.createOrReuseScene({
          capabilities: this.config.capabilities,
          projectPageId: project.page.id!,
          sceneNumber,
          prompt: input.prompt,
          ...(input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
        });
        const scene: UgcSceneContinuity = Object.freeze({
          sceneNumber,
          ...(previousScene?.id ? { previousScenePageId: previousScene.id } : {}),
          characterPageIds: Object.freeze(characterLocks.map((lock) => lock.pageId)),
          characterCodes: Object.freeze(characterLocks.map((lock) => lock.code)),
          prompt: input.prompt,
          ...(input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
        });
        const shots = [scenePage];
        const frozen: PendingUgcVideoScope = Object.freeze({
          version: 1,
          policyId: "UGC",
          accountId,
          lineGroupId: groupId,
          ownerSenderId,
          productPageId: product.id!,
          ...(characterLocks[0] ? { characterPageId: characterLocks[0].pageId } : {}),
          characterLocks: Object.freeze(characterLocks),
          projectPageId: project.page.id!,
          projectRecordId: project.recordId,
          shotPageIds: Object.freeze(shots.map((shot) => shot.id!)),
          scene,
          scenePageId: scenePage.id!,
          referenceAssets: Object.freeze(freezeSceneReferences(characterLocks, product)),
          frozenPrompt: input.prompt,
          ...(input.durationSeconds !== undefined
            ? { durationSeconds: input.durationSeconds }
            : {}),
          ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.audio !== undefined ? { audio: input.audio } : {}),
          capabilities: Object.freeze(structuredClone(this.config.capabilities)),
          r2Prefix: UGC_R2_PREFIX,
          createdAt: new Date(this.now()).toISOString(),
          sessionKeyHash: hashKey(context.sessionKey!),
        });
        await this.pending.register(ugcPendingKey(context.sessionKey!), frozen, {
          ttlMs: PENDING_TTL_MS,
        });
        return jsonResult({
          resolution: "ugc_scope_prepared",
          nextTool: "line_video_draft",
          frozenPrompt: frozen.frozenPrompt,
          settings: {
            ...(frozen.durationSeconds !== undefined
              ? { durationSeconds: frozen.durationSeconds }
              : {}),
            ...(frozen.aspectRatio ? { aspectRatio: frozen.aspectRatio } : {}),
            ...(frozen.resolution ? { resolution: frozen.resolution } : {}),
            ...(frozen.audio !== undefined ? { audio: frozen.audio } : {}),
          },
          sceneNumber: frozen.scene.sceneNumber,
          characters: frozen.characterLocks.map((lock) => lock.code),
          identityReferenceCount: frozen.referenceAssets.filter(
            (asset) => asset.kind === "identity",
          ).length,
          referenceCount: frozen.referenceAssets.length,
        });
      },
    };
  }

  async beforeToolCall(params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    sessionKey?: string;
  }): Promise<{ block?: boolean; blockReason?: string } | undefined> {
    if (params.toolName !== "line_video_draft" || !params.sessionKey) {
      return undefined;
    }
    const activeSession = await this.activeSessions.lookup(ugcPendingKey(params.sessionKey));
    const pending = await this.pending.lookup(ugcPendingKey(params.sessionKey));
    if (!pending) {
      return activeSession
        ? {
            block: true,
            blockReason: "UGC video drafts must be prepared through cloudbath_ugc_video_prepare",
          }
        : undefined;
    }
    if (
      !activeSession ||
      activeSession.accountId !== pending.accountId ||
      activeSession.lineGroupId !== pending.lineGroupId ||
      activeSession.ownerSenderId !== pending.ownerSenderId
    ) {
      return { block: true, blockReason: "UGC video draft session scope is invalid" };
    }
    const same =
      params.toolParams.prompt === pending.frozenPrompt &&
      (pending.durationSeconds === undefined ||
        params.toolParams.durationSeconds === pending.durationSeconds) &&
      (pending.aspectRatio === undefined ||
        params.toolParams.aspectRatio === pending.aspectRatio) &&
      (pending.resolution === undefined || params.toolParams.resolution === pending.resolution) &&
      (pending.audio === undefined || params.toolParams.audio === pending.audio);
    return same
      ? undefined
      : { block: true, blockReason: "UGC video draft does not match its frozen workspace scope" };
  }

  async afterToolCall(params: {
    toolName: string;
    result?: unknown;
    sessionKey?: string;
  }): Promise<void> {
    if (params.toolName !== "line_video_draft" || !params.sessionKey) {
      return;
    }
    const pendingKey = ugcPendingKey(params.sessionKey);
    const pending = await this.pending.lookup(pendingKey);
    if (!pending) {
      return;
    }
    const result = params.result as
      | { details?: { resolution?: unknown; draftId?: unknown; estimatedCostUsd?: unknown } }
      | undefined;
    if (
      result?.details?.resolution !== "draft_created" ||
      typeof result.details.draftId !== "string" ||
      typeof result.details.estimatedCostUsd !== "number"
    ) {
      return;
    }
    const frozen: FrozenUgcVideoScope = Object.freeze({
      ...pending,
      shotPageIds: Object.freeze([...pending.shotPageIds]),
      characterLocks: Object.freeze([...pending.characterLocks]),
      referenceAssets: Object.freeze([...pending.referenceAssets]),
      capabilities: Object.freeze(structuredClone(pending.capabilities)),
    });
    await this.draftScopes.register(ugcDraftScopeKey(result.details.draftId), frozen, {
      ttlMs: PENDING_TTL_MS,
    });
    await this.pending.delete(pendingKey);
    await this.notion.markAwaitingConfirmation({
      scope: frozen,
      estimatedCostUsd: result.details.estimatedCostUsd,
    });
  }
}
