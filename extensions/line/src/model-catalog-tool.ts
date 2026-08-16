import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";

const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
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
  validatedSelectionId?: string;
};

type FetchLike = typeof fetch;

type CreateLineModelCatalogToolParams = {
  messageChannel?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  sessionId?: string;
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  resolveApiKey?: (providerId: string) => Promise<string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
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
          Type.Literal("complete"),
        ],
        {
          description:
            "search starts or replaces a candidate selection; select resolves and freshly validates a numbered pending choice; page changes the displayed candidate page; complete clears a validated choice only after session_status verifies the switch; cancel clears it.",
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
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PENDING_CANDIDATES - 1 })),
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

function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
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
    const response = await (params.fetchImpl ?? fetch)(OPENROUTER_USER_MODELS_URL, {
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

    const models = new Map<string, OpenRouterAccountModel>();
    for (const raw of payload.data) {
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

  const pendingKey = resolvePendingSelectionKey(params);

  return {
    name: LINE_MODEL_CATALOG_TOOL_NAME,
    label: "OpenRouter Account Models",
    description:
      "OWNER-ONLY OpenRouter catalog and pending-choice adapter for LINE model control. Semantically interpret the owner's wording yourself. For a new switch request call action=search with literal model-family terms. A single match is safe to pass to native session_status(model=...); multiple matches are stored for this exact LINE session and owner and returned as numbered, paginated choices. For a numeric reply call action=select only when the conversation has an active picker; no_pending means treat the number as ordinary chat. Use action=page with the returned offset for more choices and action=cancel for cancellation. Selection re-fetches the authenticated catalog before returning a canonical modelRef. Never construct a model ID from user text. After session_status changes the model, call session_status again and confirm only when authoritative session state matches, then call action=complete. Do not complete after a failed or unverified switch. This tool never changes session model state.",
    parameters: CatalogQuerySchema,
    execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
      const input =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      const action =
        input.action === "select" ||
        input.action === "page" ||
        input.action === "cancel" ||
        input.action === "complete"
          ? input.action
          : "search";

      if (action === "cancel") {
        const cleared = Boolean(
          params.pendingStore && pendingKey && (await params.pendingStore.delete(pendingKey)),
        );
        return jsonResult({ resolution: "cancelled", pendingSelection: false, cleared });
      }

      if (action === "complete") {
        const pending = await readScopedPendingSelection({
          pendingStore: params.pendingStore,
          pendingKey,
          now: params.now ?? Date.now,
        });
        if (!pending || !params.pendingStore || !pendingKey) {
          return jsonResult({ resolution: "no_pending", pendingSelection: false });
        }
        if (!pending.validatedSelectionId) {
          return jsonResult({ resolution: "completion_not_ready", pendingSelection: true });
        }
        await params.pendingStore.delete(pendingKey);
        return jsonResult({ resolution: "completed", pendingSelection: false });
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
        const { validatedSelectionId: _validatedSelectionId, ...unvalidatedPending } = pending;
        const nextPending = { ...unvalidatedPending, offset: requestedOffset };
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
          const { validatedSelectionId: _validatedSelectionId, ...unvalidatedPending } = pending;
          await params.pendingStore.register(pendingKey, unvalidatedPending);
          return jsonResult({
            ...pendingPageResult(unvalidatedPending),
            resolution: "invalid_selection",
            pendingSelection: true,
            validSelectionRange: [1, pending.candidates.length],
          });
        }

        const apiKey = await params.resolveApiKey?.("openrouter");
        if (!apiKey?.trim()) {
          throw new Error("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
        }

        // A pending index is only a remembered mapping. Re-fetch the authenticated
        // account catalog immediately before handing a canonical ref to session_status.
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
        await params.pendingStore.register(pendingKey, {
          ...pending,
          validatedSelectionId: freshSelected.id,
        });
        return jsonResult({
          resolution: "selected",
          pendingSelection: true,
          pendingCompletionAfterVerifiedSwitch: true,
          selection,
          freshCatalogValidated: true,
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

      const apiKey = await params.resolveApiKey?.("openrouter");
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

      if (matching.length === 1) {
        return jsonResult({
          source: "openrouter-user-account",
          authoritativeForCandidateIds: true,
          currentModelAuthoritativeSource: "session_status",
          resolution: "exact",
          pendingSelection: false,
          totalCatalogModels: models.length,
          totalMatches: 1,
          models: matching,
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
          models: candidatePage(matching, offset, limit),
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
