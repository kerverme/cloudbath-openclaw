import { createHash } from "node:crypto";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";

const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
const OPENROUTER_CATALOG_MAX_PAGES = 50;
const DEFAULT_CATALOG_PAGE_SIZE = 8;
const MAX_CATALOG_PAGE_SIZE = 20;
const MAX_PENDING_CANDIDATES = 250;

export const LINE_MODEL_CATALOG_TOOL_NAME = "openrouter_account_models";
export const LINE_MODEL_SELECTION_NAMESPACE = "model-selection-v1";
export const LINE_MODEL_SELECTION_TTL_MS = 10 * 60 * 1000;
export const LINE_MODEL_SELECTION_MAX_ENTRIES = 5_000;

export type OpenRouterAccountModel = {
  id: string;
  name: string;
  ref: string;
  supportsTools?: boolean;
};

type PendingModelCandidate = Omit<OpenRouterAccountModel, "ref">;

type LineModelChoice = {
  selection: number;
  name: string;
  supportsTools?: boolean;
};

export type LinePendingModelSelection = {
  version: 1;
  scopeKey: string;
  query: string;
  candidates: PendingModelCandidate[];
  offset: number;
  pageSize: number;
  createdAt: number;
};

type FetchLike = typeof fetch;

type CreateLineModelCatalogToolParams = {
  messageChannel?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  sessionId?: string;
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  /** Overrides canonical LINE OpenRouter credential resolution (tests/routers). */
  resolveApiKey?: (providerId: string) => Promise<string | undefined>;
  applySessionModel?: (model: OpenRouterAccountModel) => Promise<boolean>;
  fetchImpl?: FetchLike;
  now?: () => number;
};

type AgentRunContext = {
  channel?: string;
  runId?: string;
  sessionId?: string;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

const CatalogQuerySchema = Type.Object(
  {
    action: Type.Optional(
      Type.Union(
        [
          Type.Literal("search"),
          Type.Literal("select"),
          Type.Literal("page"),
          Type.Literal("cancel"),
        ],
        {
          description:
            "search switches only a unique exact catalog match or creates a numbered candidate selection when multiple matches remain; select freshly validates and switches a numbered pending choice; page changes the displayed candidate page; cancel clears it.",
        },
      ),
    ),
    query: Type.Optional(
      Type.String({
        description:
          "Literal terms chosen by the agent to match against canonical catalog IDs and display names. Required for search unless listing the account catalog.",
        maxLength: 200,
      }),
    ),
    selection: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_PENDING_CANDIDATES,
        description: "One-based choice number from the active pending list.",
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CATALOG_PAGE_SIZE })),
  },
  { additionalProperties: false },
);

function isCanonicalOpenRouterModelId(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || /\s/u.test(value)) {
    return false;
  }
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

function agentRunContextKeys(ctx: AgentRunContext): string[] {
  return [
    ctx.runId ? `run:${ctx.runId}` : "",
    ctx.sessionId ? `session:${ctx.sessionId}` : "",
  ].filter(Boolean);
}

// The gateway tool's config.apply/config.patch actions allow a narrow set of
// agent-tunable paths, and "agents.list[].model" is one of them (see
// ALLOWED_GATEWAY_CONFIG_PATHS in gateway-tool.ts) — a real path for an LLM to
// persist a model change to global config, bypassing the validated LINE
// picker's session-only mutation entirely. Block any gateway config mutation
// that touches a model-shaped path/key while a LINE agent run is active; every
// other allowed path (thinkingDefault, reasoningDefault, requireMention,
// visibleReplies, ...) has no "model" substring, so this check cannot
// false-positive against the tool's own allowlist.
const GATEWAY_CONFIG_MUTATION_ACTIONS = new Set(["config.apply", "config.patch"]);
const MODEL_PATH_PATTERN = /model/iu;

function gatewayCallTouchesModelConfig(params: Record<string, unknown>): boolean {
  if (!GATEWAY_CONFIG_MUTATION_ACTIONS.has(String(params.action))) {
    return false;
  }
  const raw = typeof params.raw === "string" ? params.raw : "";
  const replacePaths = Array.isArray(params.replacePaths) ? params.replacePaths : [];
  return (
    MODEL_PATH_PATTERN.test(raw) ||
    replacePaths.some((path) => typeof path === "string" && MODEL_PATH_PATTERN.test(path))
  );
}

/** Blocks AI-facing LINE model mutation outside the catalog-validated picker tool. */
export function createLineModelSwitchGuard() {
  const activeLineContexts = new Set<string>();
  return {
    beforeAgentRun: (_event: unknown, ctx: AgentRunContext): void => {
      if (ctx.channel !== "line") {
        return;
      }
      for (const key of agentRunContextKeys(ctx)) {
        activeLineContexts.add(key);
      }
    },
    beforeToolCall: (event: BeforeToolCallEvent, ctx: AgentRunContext) => {
      const isActiveLineContext = agentRunContextKeys(ctx).some((key) =>
        activeLineContexts.has(key),
      );
      if (!isActiveLineContext) {
        return undefined;
      }
      if (event.toolName === "session_status" && typeof event.params.model === "string") {
        return {
          block: true,
          blockReason: "LINE session model changes require the validated model picker.",
        };
      }
      if (event.toolName === "gateway" && gatewayCallTouchesModelConfig(event.params)) {
        return {
          block: true,
          blockReason:
            "LINE session model changes require the validated model picker; global config model mutation is blocked from this session.",
        };
      }
      return undefined;
    },
    agentEnd: (_event: unknown, ctx: AgentRunContext): void => {
      for (const key of agentRunContextKeys(ctx)) {
        activeLineContexts.delete(key);
      }
    },
  };
}

/**
 * Builds a session-only model applier for one LINE conversation. Shared by the
 * AI-facing catalog tool and the deterministic model-switch intent router so
 * both apply verified catalog selections through the exact same session-store
 * mutation — never global config, never a Gateway restart.
 */
export function createLineSessionModelApplier(params: {
  agentId?: string;
  sessionKey?: string;
}): (model: OpenRouterAccountModel) => Promise<boolean> {
  return async (model) => {
    const sessionKey = params.sessionKey?.trim();
    if (!sessionKey) {
      return false;
    }
    const updated = await patchSessionEntry({
      agentId: params.agentId,
      sessionKey,
      readConsistency: "latest",
      replaceEntry: true,
      requireWriteSuccess: true,
      update: (entry) => {
        applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: "openrouter", model: model.id, isDefault: false },
          markLiveSwitchPending: true,
        });
        return entry;
      },
    });
    return updated?.providerOverride === "openrouter" && updated.modelOverride === model.id;
  };
}

function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function isExactCatalogMatch(model: OpenRouterAccountModel, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return false;
  }
  const slug = model.id.slice(model.id.indexOf("/") + 1);
  return [model.id, model.ref, slug, model.name].some(
    (value) => normalizeCatalogText(value) === normalizedQuery,
  );
}

function readInteger(
  params: Record<string, unknown>,
  key: "offset" | "limit" | "selection",
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function resolvePendingSelectionKey(params: {
  sessionId?: string;
  requesterSenderId?: string;
}): string | null {
  const sessionId = params.sessionId?.trim();
  const requesterSenderId = params.requesterSenderId?.trim();
  if (!sessionId || !requesterSenderId) {
    return null;
  }
  // Hash trusted route identities so provider-specific identifiers never become
  // unbounded or unsafe SQLite keys while still isolating every session and owner.
  return createHash("sha256").update(`${sessionId}\0${requesterSenderId}`).digest("hex");
}

function candidatePage(
  candidates: PendingModelCandidate[],
  offset: number,
  limit: number,
): LineModelChoice[] {
  return candidates.slice(offset, offset + limit).map((candidate, index) =>
    candidate.supportsTools === undefined
      ? {
          name: candidate.name,
          selection: offset + index + 1,
        }
      : {
          name: candidate.name,
          supportsTools: candidate.supportsTools,
          selection: offset + index + 1,
        },
  );
}

function pendingPageResult(pending: LinePendingModelSelection) {
  const models = candidatePage(pending.candidates, pending.offset, pending.pageSize);
  return {
    resolution: "choices",
    pendingSelection: true,
    pendingSelectionTtlMs: LINE_MODEL_SELECTION_TTL_MS,
    query: pending.query,
    totalMatches: pending.candidates.length,
    displayedCount: models.length,
    displayedFrom: models.length > 0 ? pending.offset + 1 : 0,
    displayedTo: pending.offset + models.length,
    previousOffset: pending.offset > 0 ? Math.max(0, pending.offset - pending.pageSize) : null,
    nextOffset:
      pending.offset + models.length < pending.candidates.length
        ? pending.offset + models.length
        : null,
    models,
  };
}

function statelessPageResult(candidates: PendingModelCandidate[], offset: number, limit: number) {
  const safeOffset = offset < candidates.length ? offset : 0;
  const models = candidatePage(candidates, safeOffset, limit);
  return {
    displayedCount: models.length,
    displayedFrom: models.length > 0 ? safeOffset + 1 : 0,
    displayedTo: safeOffset + models.length,
    previousOffset: safeOffset > 0 ? Math.max(0, safeOffset - limit) : null,
    nextOffset: safeOffset + models.length < candidates.length ? safeOffset + models.length : null,
    models,
  };
}

async function readScopedPendingSelection(params: {
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  pendingKey: string | null;
  now: () => number;
}): Promise<LinePendingModelSelection | undefined> {
  if (!params.pendingStore || !params.pendingKey) {
    return undefined;
  }
  const pending = await params.pendingStore.lookup(params.pendingKey);
  if (!pending) {
    return undefined;
  }
  if (
    pending.version !== 1 ||
    pending.scopeKey !== params.pendingKey ||
    pending.createdAt + LINE_MODEL_SELECTION_TTL_MS <= params.now()
  ) {
    await params.pendingStore.delete(params.pendingKey);
    return undefined;
  }
  return pending;
}

function resolveNextCatalogPageUrl(response: Response, currentUrl: string): string | null {
  const link = response.headers.get("link");
  if (!link) {
    return null;
  }
  const nextTarget = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /;\s*rel\s*=\s*"?next"?\s*(?:;|$)/iu.test(part))
    ?.match(/^<([^>]+)>/u)?.[1];
  if (!nextTarget) {
    return null;
  }

  const nextUrl = new URL(nextTarget, currentUrl);
  const allowedUrl = new URL(OPENROUTER_USER_MODELS_URL);
  if (
    nextUrl.protocol !== allowedUrl.protocol ||
    nextUrl.host !== allowedUrl.host ||
    nextUrl.pathname !== allowedUrl.pathname
  ) {
    throw new Error("OPENROUTER_ACCOUNT_CATALOG_INVALID_PAGINATION");
  }
  return nextUrl.toString();
}

function addCatalogPageModels(models: Map<string, OpenRouterAccountModel>, data: unknown[]): void {
  for (const raw of data) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const item = raw as {
      id?: unknown;
      name?: unknown;
      supported_parameters?: unknown;
    };
    if (!isCanonicalOpenRouterModelId(item.id)) {
      continue;
    }
    const supportedParameters = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter((value): value is string => typeof value === "string")
      : undefined;
    models.set(item.id, {
      id: item.id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id,
      ref: `openrouter/${item.id}`,
      ...(supportedParameters ? { supportsTools: supportedParameters.includes("tools") } : {}),
    });
  }
}

export async function loadOpenRouterAccountModels(params: {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OpenRouterAccountModel[]> {
  if (!params.apiKey.trim()) {
    throw new Error("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? OPENROUTER_CATALOG_TIMEOUT_MS,
  );
  timeout.unref?.();

  try {
    const models = new Map<string, OpenRouterAccountModel>();
    const visitedUrls = new Set<string>();
    let pageUrl: string | null = OPENROUTER_USER_MODELS_URL;
    for (let page = 0; page < OPENROUTER_CATALOG_MAX_PAGES && pageUrl; page += 1) {
      if (visitedUrls.has(pageUrl)) {
        throw new Error("OPENROUTER_ACCOUNT_CATALOG_PAGINATION_LOOP");
      }
      visitedUrls.add(pageUrl);

      const response = await (params.fetchImpl ?? fetch)(pageUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OPENROUTER_ACCOUNT_CATALOG_HTTP_${response.status}`);
      }

      const payload = (await response.json()) as { data?: unknown };
      if (!Array.isArray(payload.data)) {
        throw new Error("OPENROUTER_ACCOUNT_CATALOG_INVALID_RESPONSE");
      }
      addCatalogPageModels(models, payload.data);
      pageUrl = resolveNextCatalogPageUrl(response, pageUrl);
    }
    if (pageUrl) {
      throw new Error("OPENROUTER_ACCOUNT_CATALOG_PAGINATION_LIMIT");
    }
    return [...models.values()].toSorted((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OPENROUTER_ACCOUNT_CATALOG_")) {
      throw error;
    }
    throw new Error("OPENROUTER_ACCOUNT_CATALOG_REQUEST_FAILED", { cause: error });
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function createLineModelCatalogTool(params: CreateLineModelCatalogToolParams) {
  // LINE ingress has already enforced sender access. The trusted owner bit adds the
  // privileged boundary for account catalog discovery and subsequent native switching.
  if (params.messageChannel !== "line" || params.senderIsOwner !== true) {
    return null;
  }

  // Canonical LINE OpenRouter credential resolution by default. Previously the
  // AI-facing registration in index.ts injected ctx.resolveApiKeyForProvider,
  // which only reads saved auth profiles and yields undefined on a deployment
  // holding OpenRouter credentials in env/config -- the same narrow path that
  // broke the video draft in production. The switch router still injects its
  // own resolver, so model-switch routing semantics are unchanged.
  const resolveApiKey = params.resolveApiKey ?? resolveLineProviderApiKey;

  const pendingKey = resolvePendingSelectionKey(params);

  const applyVerifiedCatalogModel = async (model: OpenRouterAccountModel): Promise<boolean> => {
    if (!params.applySessionModel) {
      return false;
    }
    try {
      return await params.applySessionModel(model);
    } catch (error) {
      throw new Error("LINE_MODEL_SWITCH_FAILED", { cause: error });
    }
  };

  return {
    name: LINE_MODEL_CATALOG_TOOL_NAME,
    label: "OpenRouter Account Models",
    description:
      "OWNER-ONLY OpenRouter catalog and session model picker for LINE. Semantically interpret the owner's wording yourself, but do not treat model comparisons, opinions, or ordinary discussion as a switch request. For a new clear switch request call action=search with literal model-family terms. Only a unique exact catalog match is switched directly; multiple matches are stored for this exact LINE session and owner and returned as numbered, paginated choices. A sole partial match requires clarification and cannot switch. For a numeric reply call action=select only when the conversation has an active picker; no_pending means treat the number as ordinary chat. Use action=page with the returned offset for more choices and action=cancel for cancellation. This tool re-fetches the authenticated catalog before a numbered switch and is the only AI-facing LINE model mutation path. Never construct or pass a model ID yourself.",
    parameters: CatalogQuerySchema,
    execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
      const input =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      const action =
        input.action === "select" || input.action === "page" || input.action === "cancel"
          ? input.action
          : "search";

      if (action === "cancel") {
        const cleared = Boolean(
          params.pendingStore && pendingKey && (await params.pendingStore.delete(pendingKey)),
        );
        return jsonResult({ resolution: "cancelled", pendingSelection: false, cleared });
      }

      if (action === "page") {
        const pending = await readScopedPendingSelection({
          pendingStore: params.pendingStore,
          pendingKey,
          now: params.now ?? Date.now,
        });
        if (!pending || !params.pendingStore || !pendingKey) {
          return jsonResult({ resolution: "no_pending", pendingSelection: false });
        }
        const requestedOffset = readInteger(input, "offset", pending.offset);
        if (requestedOffset >= pending.candidates.length) {
          return jsonResult({
            ...pendingPageResult(pending),
            resolution: "invalid_page",
            pendingSelection: true,
            validOffsetRange: [0, Math.max(0, pending.candidates.length - 1)],
          });
        }
        const nextPending = { ...pending, offset: requestedOffset };
        await params.pendingStore.register(pendingKey, nextPending);
        return jsonResult(pendingPageResult(nextPending));
      }

      if (action === "select") {
        const pending = await readScopedPendingSelection({
          pendingStore: params.pendingStore,
          pendingKey,
          now: params.now ?? Date.now,
        });
        if (!pending || !params.pendingStore || !pendingKey) {
          return jsonResult({ resolution: "no_pending", pendingSelection: false });
        }
        const selection = readInteger(input, "selection", 0);
        const selected = pending.candidates[selection - 1];
        if (!selected) {
          return jsonResult({
            ...pendingPageResult(pending),
            resolution: "invalid_selection",
            pendingSelection: true,
            validSelectionRange: [1, pending.candidates.length],
          });
        }

        const apiKey = await resolveApiKey("openrouter");
        if (!apiKey?.trim()) {
          throw new Error("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
        }

        // A pending index is only a remembered mapping. Re-fetch the authenticated
        // account catalog immediately before the picker performs the session mutation.
        const freshModels = await loadOpenRouterAccountModels({
          apiKey,
          fetchImpl: params.fetchImpl,
          signal,
        });
        const freshSelected = freshModels.find((model) => model.id === selected.id);
        if (!freshSelected) {
          await params.pendingStore.delete(pendingKey);
          return jsonResult({
            resolution: "stale_selection",
            pendingSelection: false,
            selectedModelStillAvailable: false,
            freshCatalogValidated: true,
          });
        }
        const switched = await applyVerifiedCatalogModel(freshSelected);
        if (!switched) {
          return jsonResult({
            resolution: "switch_failed",
            pendingSelection: true,
            freshCatalogValidated: true,
            sessionModelVerified: false,
          });
        }
        await params.pendingStore.delete(pendingKey);
        return jsonResult({
          resolution: "switched",
          pendingSelection: false,
          selection,
          freshCatalogValidated: true,
          sessionModelVerified: true,
          model: freshSelected,
        });
      }

      const query = typeof input.query === "string" ? normalizeCatalogText(input.query) : "";
      const offset = readInteger(input, "offset", 0);
      const limit = readInteger(input, "limit", DEFAULT_CATALOG_PAGE_SIZE);
      if (params.pendingStore && pendingKey) {
        // A new clear model-control request replaces any older pending picker.
        await params.pendingStore.delete(pendingKey);
      }

      const apiKey = await resolveApiKey("openrouter");
      if (!apiKey?.trim()) {
        throw new Error("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
      }

      const models = await loadOpenRouterAccountModels({
        apiKey,
        fetchImpl: params.fetchImpl,
        signal,
      });
      const queryTokens = query ? query.split(" ") : [];
      const matching = queryTokens.length
        ? models.filter((model) => {
            const searchable = normalizeCatalogText(`${model.id} ${model.name}`);
            return queryTokens.every((token) => searchable.includes(token));
          })
        : models;
      const exactMatches = matching.filter((model) => isExactCatalogMatch(model, query));

      if (matching.length === 0) {
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          currentModelAuthoritativeSource: "session_status",
          resolution: "no_match",
          pendingSelection: false,
          totalCatalogModels: models.length,
          totalMatches: 0,
          models: [],
        });
      }

      const directMatch = exactMatches.length === 1 ? exactMatches[0] : undefined;
      if (directMatch) {
        const switched = await applyVerifiedCatalogModel(directMatch);
        if (!switched) {
          return jsonResult({
            source: "openrouter-user-account",
            authoritativeForCandidateIds: true,
            resolution: "switch_failed",
            pendingSelection: false,
            sessionModelVerified: false,
          });
        }
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          resolution: "switched",
          match: "exact",
          pendingSelection: false,
          totalCatalogModels: models.length,
          totalMatches: matching.length,
          sessionModelVerified: true,
          models: [directMatch],
        });
      }

      if (matching.length === 1) {
        const soleMatch = matching[0];
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          currentModelAuthoritativeSource: "session_status",
          resolution: "clarification_required",
          pendingSelection: false,
          totalCatalogModels: models.length,
          totalMatches: 1,
          models: [
            soleMatch.supportsTools === undefined
              ? { name: soleMatch.name }
              : { name: soleMatch.name, supportsTools: soleMatch.supportsTools },
          ],
        });
      }

      if (!params.pendingStore || !pendingKey || !params.sessionId || !params.requesterSenderId) {
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          currentModelAuthoritativeSource: "session_status",
          resolution: "choices_unavailable",
          pendingSelection: false,
          reason: "trusted LINE session or sender context unavailable",
          totalCatalogModels: models.length,
          totalMatches: matching.length,
          models: candidatePage(matching, offset, limit),
        });
      }

      if (matching.length > MAX_PENDING_CANDIDATES) {
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          currentModelAuthoritativeSource: "session_status",
          resolution: "refine_query",
          pendingSelection: false,
          totalCatalogModels: models.length,
          totalMatches: matching.length,
          maximumSafePendingCandidates: MAX_PENDING_CANDIDATES,
          ...statelessPageResult(matching, offset, limit),
        });
      }

      const safeOffset = offset < matching.length ? offset : 0;
      const pending: LinePendingModelSelection = {
        version: 1,
        scopeKey: pendingKey,
        query,
        candidates: matching.map(({ id, name, supportsTools }) =>
          supportsTools === undefined ? { id, name } : { id, name, supportsTools },
        ),
        offset: safeOffset,
        pageSize: limit,
        createdAt: (params.now ?? Date.now)(),
      };
      await params.pendingStore.register(pendingKey, pending);
      return jsonResult({
        source: "openrouter-user-account",
        authoritativeForCandidateIds: true,
        currentModelAuthoritativeSource: "session_status",
        totalCatalogModels: models.length,
        ...pendingPageResult(pending),
      });
    },
  };
}
