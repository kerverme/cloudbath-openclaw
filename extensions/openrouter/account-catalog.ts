// OpenRouter account catalog: projects the authenticated /models/user list into provider rows.
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
  parseStrictFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

// Account-scoped on purpose: the public /models list includes models this key
// cannot call, and LINE's model switch already trusts this same endpoint.
const OPENROUTER_ACCOUNT_MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models/user`;
// The TTL collapses back-to-back catalog runs into one request; the timeout matches
// LINE's account-catalog budget for the same ~1 MB response.
const OPENROUTER_ACCOUNT_MODELS_CACHE_TTL_MS = 60_000;
const OPENROUTER_ACCOUNT_MODELS_TIMEOUT_MS = 10_000;
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => normalizeOptionalString(entry) ?? []) : [];
}

/** Explicit modality lists win; the legacy `text+image->text` string is the fallback. */
function readModalities(
  architecture: Record<string, unknown> | undefined,
  direction: "input" | "output",
): string[] {
  const explicit = readStringList(architecture?.[`${direction}_modalities`]);
  if (explicit.length > 0) {
    return explicit;
  }
  const modality = normalizeOptionalString(architecture?.modality) ?? "";
  const [input = "", output = ""] = modality.split("->", 2);
  return (direction === "input" ? input : output).split("+").filter(Boolean);
}

// Same contract as the gateway's OpenRouter pricing parser: per-token USD strings
// scaled to per-million, and negative sentinels (openrouter/auto's "-1") read as 0.
function readPricePerMillion(value: unknown): number {
  const perToken = parseStrictFiniteNumber(value);
  return perToken !== undefined && perToken > 0 ? perToken * 1_000_000 : 0;
}

function readCost(value: unknown): ModelDefinitionConfig["cost"] {
  const pricing = asOptionalRecord(value);
  return {
    input: readPricePerMillion(pricing?.prompt),
    output: readPricePerMillion(pricing?.completion),
    cacheRead: readPricePerMillion(pricing?.input_cache_read),
    cacheWrite: readPricePerMillion(pricing?.input_cache_write),
  };
}

/** One /models/user row as a provider model; undefined for rows that cannot produce text. */
export function projectOpenRouterAccountModel(row: unknown): ModelDefinitionConfig | undefined {
  const record = asOptionalRecord(row);
  const id = normalizeOptionalString(record?.id);
  const architecture = asOptionalRecord(record?.architecture);
  if (!id || !readModalities(architecture, "output").includes("text")) {
    return undefined;
  }
  const supportedParameters = readStringList(record?.supported_parameters);
  const topProvider = asOptionalRecord(record?.top_provider);
  const reasoning =
    supportedParameters.includes("reasoning") ||
    supportedParameters.includes("include_reasoning") ||
    asOptionalRecord(record?.reasoning) !== undefined;
  return {
    id,
    name: normalizeOptionalString(record?.name) ?? id,
    reasoning: reasoning && !isOpenRouterProxyReasoningUnsupportedModel(id),
    input: readModalities(architecture, "input").includes("image") ? ["text", "image"] : ["text"],
    // Absent parameter metadata means unknown, not "no tools"; only a listed set can deny.
    ...(Array.isArray(record?.supported_parameters)
      ? { compat: { supportsTools: supportedParameters.includes("tools") } }
      : {}),
    cost: readCost(record?.pricing),
    contextWindow:
      asPositiveSafeInteger(topProvider?.context_length) ??
      asPositiveSafeInteger(record?.context_length) ??
      OPENROUTER_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(topProvider?.max_completion_tokens) ??
      asPositiveSafeInteger(record?.max_completion_tokens) ??
      OPENROUTER_DEFAULT_MAX_TOKENS,
  };
}

/**
 * The static OpenRouter provider plus every text model on the key's account.
 * Static rows keep their curated metadata on id collisions; any discovery
 * failure returns the static provider so the picker never loses its baseline.
 */
export async function buildOpenrouterAccountProvider(params: {
  apiKey: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  const provider = { ...buildOpenrouterProvider(), apiKey: params.apiKey };
  let rows: readonly unknown[];
  try {
    rows = await getCachedLiveProviderModelRows({
      providerId: "openrouter",
      endpoint: OPENROUTER_ACCOUNT_MODELS_ENDPOINT,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      timeoutMs: OPENROUTER_ACCOUNT_MODELS_TIMEOUT_MS,
      ttlMs: OPENROUTER_ACCOUNT_MODELS_CACHE_TTL_MS,
      auditContext: "openrouter-model-discovery",
      shouldCacheRows: (liveRows) => liveRows.length > 0,
    });
  } catch {
    return provider;
  }
  const models = new Map(provider.models.map((model) => [model.id, model]));
  // Sorted so the persisted catalog does not churn with OpenRouter's response order.
  const accountModels = rows
    .flatMap((row) => projectOpenRouterAccountModel(row) ?? [])
    .toSorted((left, right) => left.id.localeCompare(right.id));
  for (const model of accountModels) {
    if (!models.has(model.id)) {
      models.set(model.id, model);
    }
  }
  return { ...provider, models: [...models.values()] };
}
