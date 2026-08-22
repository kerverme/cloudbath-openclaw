/**
 * LINE-owned OpenRouter video-model catalog client.
 *
 * Deliberately mirrors model-catalog-tool.ts's `loadOpenRouterAccountModels`
 * (direct fetch + resolveApiKeyForProvider, no provider-http dependency)
 * instead of routing through core's generic video-generation provider
 * abstraction: this module only needs read-only catalog *browsing* for the
 * owner-only deterministic picker in video-model-control.ts and the cost
 * guard in video-cost-guard.ts, and LINE already owns an equivalent OpenRouter
 * HTTP client for the chat-model catalog. Actual paid generation goes through
 * core's `generateVideo()` (openclaw/plugin-sdk/video-generation-runtime),
 * never through this module — see video-confirmation.ts.
 */
const OPENROUTER_VIDEO_MODELS_URL = "https://openrouter.ai/api/v1/videos/models";
const OPENROUTER_VIDEO_CATALOG_TIMEOUT_MS = 10_000;

export type OpenRouterVideoModel = {
  id: string;
  name: string;
  supportedDurationSeconds: number[];
  supportedAspectRatios: string[];
  supportedResolutions: string[];
  /**
   * Concrete output pixel sizes ("1280x720"). Required for token-priced models:
   * OpenRouter bills those by output pixel area, so a resolution label alone
   * cannot produce an estimate. See video-cost-guard.ts.
   */
  supportedSizes: string[];
  supportsFrameImages: boolean;
  supportsAudio?: boolean;
  /** Raw provider pricing SKUs, e.g. {"per-video-second": "0.50"}. Units vary by model. */
  pricingSkus?: Record<string, string>;
};

type FetchLike = typeof fetch;

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function normalizeNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
}

function normalizePricingSkus(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim()) {
      record[key] = raw.trim();
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      record[key] = String(raw);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function toVideoModel(raw: unknown): OpenRouterVideoModel | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) {
    return null;
  }
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
  const frameImages = normalizeStringArray(item.supported_frame_images);
  return {
    id,
    name,
    supportedDurationSeconds: normalizeNumberArray(item.supported_durations),
    supportedAspectRatios: normalizeStringArray(item.supported_aspect_ratios),
    supportedResolutions: normalizeStringArray(item.supported_resolutions),
    supportedSizes: normalizeStringArray(item.supported_sizes),
    supportsFrameImages: frameImages.length > 0,
    ...(typeof item.generate_audio === "boolean" ? { supportsAudio: item.generate_audio } : {}),
    ...(normalizePricingSkus(item.pricing_skus)
      ? { pricingSkus: normalizePricingSkus(item.pricing_skus) }
      : {}),
  };
}

/** Fetches OpenRouter's live video-model catalog. Read-only; never used for submission. */
export async function loadOpenRouterVideoModels(params: {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OpenRouterVideoModel[]> {
  if (!params.apiKey.trim()) {
    throw new Error("OPENROUTER_VIDEO_CATALOG_AUTH_UNAVAILABLE");
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? OPENROUTER_VIDEO_CATALOG_TIMEOUT_MS,
  );
  timeout.unref?.();

  try {
    const response = await (params.fetchImpl ?? fetch)(OPENROUTER_VIDEO_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OPENROUTER_VIDEO_CATALOG_HTTP_${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data)) {
      throw new Error("OPENROUTER_VIDEO_CATALOG_INVALID_RESPONSE");
    }
    const models = payload.data
      .map(toVideoModel)
      .filter((entry): entry is OpenRouterVideoModel => entry !== null);
    return models.toSorted((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OPENROUTER_VIDEO_CATALOG_")) {
      throw error;
    }
    throw new Error("OPENROUTER_VIDEO_CATALOG_REQUEST_FAILED", { cause: error });
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
  }
}
