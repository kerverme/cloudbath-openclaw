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
  SafeLogger,
  UgcCapabilityId,
  UgcReferenceAsset,
  WorkspacePolicyConfig,
} from "./types.js";

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
  characterName?: string;
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

const CAPABILITY_SCHEMAS: Readonly<
  Record<
    UgcCapabilityId,
    Readonly<Record<string, { type: string; relationTarget?: UgcCapabilityId }>>
  >
> = {
  PRODUCT_LIBRARY: { Name: { type: "title" } },
  CHARACTER_LIBRARY: { Name: { type: "title" } },
  UGC_PROJECTS: {
    Name: { type: "title" },
    "Record ID": { type: "rich_text" },
    Status: { type: "select" },
    Product: { type: "relation", relationTarget: "PRODUCT_LIBRARY" },
    Character: { type: "relation", relationTarget: "CHARACTER_LIBRARY" },
    Prompt: { type: "rich_text" },
    "Estimated Cost USD": { type: "number" },
    "Actual Cost USD": { type: "number" },
  },
  UGC_SHOTS: {
    Name: { type: "title" },
    "Record ID": { type: "rich_text" },
    Status: { type: "select" },
    Project: { type: "relation", relationTarget: "UGC_PROJECTS" },
    "Shot Number": { type: "number" },
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

function freezeReferences(product: NotionPage, character?: NotionPage): UgcReferenceAsset[] {
  const identity = character
    ? propertyReferences(
        character,
        ["Identity References", "Identity Reference", "R2 Object Keys"],
        "identity",
      )
    : [];
  const productReferences = propertyReferences(
    product,
    ["Reference Images", "Reference Assets", "R2 Object Keys"],
    "product",
  );
  const styles = [
    ...propertyReferences(product, ["Style References"], "style"),
    ...(character ? propertyReferences(character, ["Style References"], "style") : []),
  ];
  const unique = new Map<string, UgcReferenceAsset>();
  for (const item of [...identity, ...productReferences, ...styles]) {
    unique.set(`${item.kind}\0${item.source}\0${item.locator}`, item);
  }
  return Array.from(unique.values()).slice(0, MAX_REFERENCE_ASSETS);
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

  private async findByRecordId(target: NotionTarget, id: string): Promise<NotionPage | undefined> {
    const pages = await this.queryAll(target, {
      filter: { property: "Record ID", rich_text: { equals: id } },
    });
    if (pages.length > 1) {
      throw new Error("Notion record identity is duplicated");
    }
    return pages[0];
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

  async createOrReuseProject(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    accountId: string;
    groupId: string;
    product: NotionPage;
    character?: NotionPage;
    prompt: string;
  }): Promise<{ page: NotionPage; recordId: string }> {
    const target = params.capabilities.UGC_PROJECTS;
    await this.schema("UGC_PROJECTS", target, params.capabilities);
    const id = recordId({
      accountId: params.accountId,
      groupId: params.groupId,
      productPageId: params.product.id!,
      characterPageId: params.character?.id,
    });
    const existing = await this.findByRecordId(target, id);
    if (existing) {
      return { page: existing, recordId: id };
    }
    const productName = plainText(params.product.properties?.Name);
    const characterName = params.character
      ? plainText(params.character.properties?.Name)
      : undefined;
    const page = await this.createPage(target, {
      Name: title(`${productName}${characterName ? ` × ${characterName}` : ""}`),
      "Record ID": richText(id),
      Status: { select: { name: "Draft" } },
      Product: relation(params.product.id),
      Character: relation(params.character?.id),
      Prompt: richText(params.prompt),
      "Estimated Cost USD": { number: null },
      "Actual Cost USD": { number: null },
    });
    return { page, recordId: id };
  }

  async createOrReuseShots(params: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    projectPageId: string;
    projectRecordId: string;
    prompt: string;
  }): Promise<NotionPage[]> {
    const target = params.capabilities.UGC_SHOTS;
    await this.schema("UGC_SHOTS", target, params.capabilities);
    const shots = [
      { name: "Hook", prompt: `Opening hook: ${params.prompt}` },
      { name: "Product", prompt: `Product demonstration: ${params.prompt}` },
      { name: "Close", prompt: `Closing call to action: ${params.prompt}` },
    ];
    const pages: NotionPage[] = [];
    for (const [index, shot] of shots.entries()) {
      const id = hashKey("ugc-shot-v1", params.projectRecordId, String(index + 1));
      const existing = await this.findByRecordId(target, id);
      if (existing) {
        pages.push(existing);
        continue;
      }
      pages.push(
        await this.createPage(target, {
          Name: title(`${index + 1}. ${shot.name}`),
          "Record ID": richText(id),
          Status: { select: { name: "Draft" } },
          Project: relation(params.projectPageId),
          "Shot Number": { number: index + 1 },
          Prompt: richText(shot.prompt),
        }),
      );
    }
    return pages;
  }

  async markAwaitingConfirmation(params: {
    scope: FrozenUgcVideoScope;
    estimatedCostUsd: number;
  }): Promise<void> {
    await this.request(`/v1/pages/${encodeURIComponent(params.scope.projectPageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          Status: { select: { name: "Awaiting Confirmation" } },
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
  return {
    productName,
    ...(typeof input.characterName === "string" && input.characterName.trim()
      ? { characterName: input.characterName.trim() }
      : {}),
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
        "OWNER-ONLY. In a LINE group paired to UGC, resolves configured Product/Character records, creates or reuses one UGC Project and deterministic shot plan, and freezes scope before line_video_draft. This never performs paid generation.",
      parameters: Type.Object({
        productName: Type.String(),
        characterName: Type.Optional(Type.String()),
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
        const character = input.characterName
          ? await this.notion.resolveNamedRecord({
              capabilityId: "CHARACTER_LIBRARY",
              target: this.config.capabilities.CHARACTER_LIBRARY,
              capabilities: this.config.capabilities,
              name: input.characterName,
            })
          : undefined;
        const project = await this.notion.createOrReuseProject({
          capabilities: this.config.capabilities,
          accountId,
          groupId,
          product,
          ...(character ? { character } : {}),
          prompt: input.prompt,
        });
        const shots = await this.notion.createOrReuseShots({
          capabilities: this.config.capabilities,
          projectPageId: project.page.id!,
          projectRecordId: project.recordId,
          prompt: input.prompt,
        });
        const frozen: PendingUgcVideoScope = Object.freeze({
          version: 1,
          policyId: "UGC",
          accountId,
          lineGroupId: groupId,
          ownerSenderId,
          productPageId: product.id!,
          ...(character?.id ? { characterPageId: character.id } : {}),
          projectPageId: project.page.id!,
          shotPageIds: Object.freeze(shots.map((shot) => shot.id!)),
          referenceAssets: Object.freeze(freezeReferences(product, character)),
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
