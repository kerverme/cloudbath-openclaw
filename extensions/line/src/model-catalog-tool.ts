import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";

const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
const MAX_CATALOG_PAGE_SIZE = 100;

export const LINE_MODEL_CATALOG_TOOL_NAME = "openrouter_account_models";

export type OpenRouterAccountModel = {
  id: string;
  name: string;
  ref: string;
  supportsTools?: boolean;
};

type FetchLike = typeof fetch;

type CreateLineModelCatalogToolParams = {
  messageChannel?: string;
  senderIsOwner?: boolean;
  resolveApiKey?: (providerId: string) => Promise<string | undefined>;
  fetchImpl?: FetchLike;
};

const CatalogQuerySchema = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        description:
          "Optional literal terms chosen by the agent to match against canonical catalog IDs and display names.",
        maxLength: 200,
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
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
  key: "offset" | "limit",
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
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

  return {
    name: LINE_MODEL_CATALOG_TOOL_NAME,
    label: "OpenRouter Account Models",
    description:
      "OWNER-ONLY read-only catalog adapter for LINE model control. Semantically interpret the owner's wording yourself. Use this tool to obtain legitimate canonical modelRef values visible to the authenticated OpenRouter account; never construct a model ID from user text. To switch, pass one returned modelRef to native session_status(model=...), then call session_status again and confirm only after the authoritative session state matches. For ambiguous matches, present choices and keep the selection in the current conversation. This tool never changes session state.",
    parameters: CatalogQuerySchema,
    execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
      const input =
        rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      const query = typeof input.query === "string" ? normalizeCatalogText(input.query) : "";
      const offset = readInteger(input, "offset", 0);
      const limit = readInteger(input, "limit", 25);
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
      const page = matching.slice(offset, offset + limit);

      return jsonResult({
        source: "openrouter-user-account",
        authoritativeForCandidateIds: true,
        currentModelAuthoritativeSource: "session_status",
        totalCatalogModels: models.length,
        totalMatches: matching.length,
        offset,
        nextOffset: offset + page.length < matching.length ? offset + page.length : null,
        models: page,
      });
    },
  };
}
