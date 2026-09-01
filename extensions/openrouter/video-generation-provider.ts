// Openrouter provider module implements model/runtime integration.
import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";
import {
  fetchOpenRouterVideoGet,
  resolveOpenRouterVideoUrl,
  type OpenRouterVideoDispatcherPolicy,
} from "./video-http.js";
import { resolveOpenRouterVideoModelCapabilities } from "./video-model-catalog.js";

export { listOpenRouterVideoModelCatalog } from "./video-model-catalog.js";

const DEFAULT_MODEL = "google/veo-3.1-fast";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const SUPPORTED_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const OPENROUTER_VIDEO_MALFORMED_RESPONSE = "OpenRouter video generation response malformed";
const SUPPORTED_DURATION_SECONDS = [4, 6, 8] as const;
// Runtime sets this after normalizing against live model capabilities.
const SUPPORTED_DURATIONS_HINT = Symbol.for("openclaw.videoGeneration.supportedDurations");
const SUPPORTED_RESOLUTIONS = ["720P", "1080P"] as const;
const log = createSubsystemLogger("openrouter/video");

type OpenRouterVideoResponse = {
  id?: string;
  generation_id?: string | null;
  polling_url?: string;
  status?: string;
  unsigned_urls?: string[];
  error?: string | null;
  model?: string | null;
  usage?: {
    cost?: number | null;
    is_byok?: boolean;
  };
};

type OpenRouterImagePart = {
  type: "image_url";
  image_url: { url: string };
};

type OpenRouterFrameImagePart = OpenRouterImagePart & {
  frame_type: "first_frame" | "last_frame";
};

async function readOpenRouterVideoJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await readProviderJsonResponse<unknown>(response, "OpenRouter video generation");
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": malformed JSON response")) {
      throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE, { cause: error });
    }
    throw error;
  }
  if (!isRecord(payload)) {
    throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
  }
  return payload;
}

function readOpenRouterVideoResponse(payload: Record<string, unknown>): OpenRouterVideoResponse {
  const unsignedUrls = payload.unsigned_urls;
  if (unsignedUrls !== undefined && unsignedUrls !== null && !Array.isArray(unsignedUrls)) {
    throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
  }
  const usage = payload.usage;
  if (usage !== undefined && usage !== null && !isRecord(usage)) {
    throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
  }
  return {
    id: normalizeOptionalString(payload.id),
    generation_id: normalizeOptionalString(payload.generation_id) ?? null,
    polling_url: normalizeOptionalString(payload.polling_url),
    status: normalizeOptionalString(payload.status),
    unsigned_urls: Array.isArray(unsignedUrls)
      ? unsignedUrls.map((url) => {
          const normalized = normalizeOptionalString(url);
          if (!normalized) {
            throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
          }
          return normalized;
        })
      : undefined,
    error: normalizeOptionalString(payload.error) ?? null,
    model: normalizeOptionalString(payload.model) ?? null,
    usage: isRecord(usage)
      ? {
          cost: typeof usage.cost === "number" ? usage.cost : null,
          is_byok: typeof usage.is_byok === "boolean" ? usage.is_byok : undefined,
        }
      : undefined,
  };
}

function toDataUrl(asset: VideoGenerationSourceAsset): string {
  if (asset.buffer) {
    return toImageDataUrl({ ...asset, buffer: asset.buffer, defaultMimeType: "image/png" });
  }
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return url;
  }
  throw new Error(
    "OpenRouter video generation requires image references to include a URL or buffer.",
  );
}

function toImagePart(asset: VideoGenerationSourceAsset): OpenRouterImagePart {
  return {
    type: "image_url",
    image_url: { url: toDataUrl(asset) },
  };
}

function buildImageInputs(inputImages: VideoGenerationSourceAsset[] | undefined): {
  frameImages: OpenRouterFrameImagePart[];
  inputReferences: OpenRouterImagePart[];
  frameAssets: VideoGenerationSourceAsset[];
  referenceAssets: VideoGenerationSourceAsset[];
} {
  const frameImages: OpenRouterFrameImagePart[] = [];
  const inputReferences: OpenRouterImagePart[] = [];
  const frameAssets: VideoGenerationSourceAsset[] = [];
  const referenceAssets: VideoGenerationSourceAsset[] = [];
  let hasFirstFrame = false;
  let hasLastFrame = false;

  for (const image of inputImages ?? []) {
    const role = normalizeOptionalString(image.role);
    if (role === "reference_image") {
      inputReferences.push(toImagePart(image));
      referenceAssets.push(image);
      continue;
    }

    const frameType =
      role === "last_frame"
        ? "last_frame"
        : role === "first_frame"
          ? "first_frame"
          : hasFirstFrame
            ? "last_frame"
            : "first_frame";

    if (frameType === "first_frame" && !hasFirstFrame) {
      frameImages.push({ ...toImagePart(image), frame_type: "first_frame" });
      frameAssets.push(image);
      hasFirstFrame = true;
      continue;
    }
    if (frameType === "last_frame" && !hasLastFrame) {
      frameImages.push({ ...toImagePart(image), frame_type: "last_frame" });
      frameAssets.push(image);
      hasLastFrame = true;
      continue;
    }
    inputReferences.push(toImagePart(image));
    referenceAssets.push(image);
  }

  return { frameImages, inputReferences, frameAssets, referenceAssets };
}

function readCorrelationId(inputImages: VideoGenerationSourceAsset[] | undefined): string {
  for (const image of inputImages ?? []) {
    const value = normalizeOptionalString(image.metadata?.correlationId);
    if (value) {
      return value;
    }
  }
  return "unavailable";
}

function buildSafePayloadSummary(
  req: VideoGenerationRequest,
  model: string,
  body: Record<string, unknown>,
) {
  const { frameImages, frameAssets, referenceAssets } = buildImageInputs(req.inputImages);
  const identityReferences = referenceAssets.filter(
    (asset) => normalizeOptionalString(asset.role) === "reference_image",
  );
  const identityFrames = frameAssets.filter(
    (asset) => normalizeOptionalString(asset.role) === "reference_image",
  );
  return {
    correlationId: readCorrelationId(req.inputImages),
    model,
    duration: body.duration,
    resolution: body.resolution,
    aspectRatio: body.aspect_ratio,
    inputReferencesCount: referenceAssets.length,
    inputReferences: referenceAssets.map((asset, index) => ({
      index,
      mimeType: asset.mimeType,
      role: asset.role,
      source:
        normalizeOptionalString(asset.metadata?.source) ??
        (asset.buffer ? "buffer" : asset.url ? "url" : "unknown"),
      characterCode: asset.metadata?.characterCode,
      characterPageId: asset.metadata?.characterPageId,
    })),
    firstFramePresent: frameImages.some((image) => image.frame_type === "first_frame"),
    lastFramePresent: frameImages.some((image) => image.frame_type === "last_frame"),
    frameImagesCount: frameImages.length,
    characterIdentityInputReferencesCount: identityReferences.length,
    characterIdentityFrameImagesCount: identityFrames.length,
  };
}

function readProviderErrorDiagnostic(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) {
    return {};
  }
  const error = isRecord(payload.error) ? payload.error : payload;
  const metadata = isRecord(error.metadata) ? error.metadata : undefined;
  const raw = normalizeOptionalString(metadata?.raw);
  if (raw) {
    try {
      const nested = readProviderErrorDiagnostic(JSON.parse(raw));
      if (nested.code || nested.message) {
        return nested;
      }
    } catch {
      // The provider-owned raw field is optional diagnostic data, not the response contract.
    }
  }
  const code =
    normalizeOptionalString(error.code) ??
    (typeof error.code === "number" && Number.isFinite(error.code)
      ? String(error.code)
      : undefined);
  const message = normalizeOptionalString(error.message);
  return {
    ...(code ? { code } : {}),
    ...(message ? { message: message.slice(0, 1_000) } : {}),
  };
}

function resolveDurationSeconds(
  durationSeconds: number | undefined,
  supportedDurations: readonly number[] = SUPPORTED_DURATION_SECONDS,
): number | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const effectiveDurations =
    supportedDurations.length > 0 ? supportedDurations : SUPPORTED_DURATION_SECONDS;
  const rounded = Math.max(1, Math.round(durationSeconds));
  if (durationSeconds === rounded && effectiveDurations.includes(rounded)) {
    return rounded;
  }
  return effectiveDurations.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

function resolveResolution(resolution: VideoGenerationRequest["resolution"]): string | undefined {
  const normalized = normalizeOptionalString(resolution);
  return normalized ? normalized.toLowerCase() : undefined;
}

/** Extracts the numeric "P" tier from a resolution string ("720p" -> 720). */
function resolutionTierFromResolution(resolution: string): number | undefined {
  const match = resolution.trim().match(/^(\d+(?:\.\d+)?)p$/iu);
  return match ? Number(match[1]) : undefined;
}

/** Extracts the effective "P" tier from a WIDTHxHEIGHT size ("1920x1080" -> 1080). */
function resolutionTierFromSize(size: string): number | undefined {
  const match = size.trim().match(/^(\d+)\s*x\s*(\d+)$/iu);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return Math.min(width, height);
}

/**
 * Refuses to submit a request whose `resolution` and `size` disagree on
 * pixel tier (e.g. resolution "720p" alongside a 1920x1080-derived size).
 * Both fields are normally resolved from the same model capability source
 * (see normalization.ts), so this should never legitimately fire -- it is a
 * last-line-of-defense check run BEFORE the paid POST is issued (as a
 * synchronous argument to postJsonRequest, so a throw here never reaches the
 * network), catching any future caller or capability-merge regression that
 * reintroduces the resolution/size conflict this module was rejected for in
 * production.
 */
function assertConsistentResolutionAndSize(
  resolution: string | undefined,
  size: string | undefined,
) {
  if (!resolution || !size) {
    return;
  }
  const resolutionTier = resolutionTierFromResolution(resolution);
  const sizeTier = resolutionTierFromSize(size);
  if (resolutionTier !== undefined && sizeTier !== undefined && resolutionTier !== sizeTier) {
    throw new Error(
      `OpenRouter video request has conflicting settings: resolution ${resolution} disagrees with size ${size}; refusing to submit`,
    );
  }
}

function resolveSeed(seed: unknown): number | undefined {
  if (seed === undefined) {
    return undefined;
  }
  if (typeof seed !== "number") {
    return undefined;
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error("OpenRouter video seed must be an integer");
  }
  return seed;
}

function buildRequestBody(req: VideoGenerationRequest, model: string): Record<string, unknown> {
  const { frameImages, inputReferences } = buildImageInputs(req.inputImages);
  const supportedDurations =
    (req as VideoGenerationRequest & { [SUPPORTED_DURATIONS_HINT]?: readonly number[] })[
      SUPPORTED_DURATIONS_HINT
    ] ?? SUPPORTED_DURATION_SECONDS;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
  };

  const duration = resolveDurationSeconds(req.durationSeconds, supportedDurations);
  if (duration != null) {
    body.duration = duration;
  }
  const resolution = resolveResolution(req.resolution);
  const size = normalizeOptionalString(req.size);
  assertConsistentResolutionAndSize(resolution, size);
  if (resolution) {
    body.resolution = resolution;
  }
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  if (size) {
    body.size = size;
  }
  if (typeof req.audio === "boolean") {
    body.generate_audio = req.audio;
  }
  if (frameImages.length > 0) {
    body.frame_images = frameImages;
  }
  if (inputReferences.length > 0) {
    body.input_references = inputReferences;
  }

  const seed = resolveSeed(req.providerOptions?.seed);
  if (seed !== undefined) {
    body.seed = seed;
  }
  const callbackUrl =
    typeof req.providerOptions?.callback_url === "string"
      ? normalizeOptionalString(req.providerOptions.callback_url)
      : undefined;
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }

  return body;
}

function isTerminalFailure(status: string | undefined): boolean {
  return status === "failed" || status === "cancelled" || status === "expired";
}

async function fetchOpenRouterJson(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
  errorContext: string;
  auditContext: string;
}): Promise<OpenRouterVideoResponse> {
  const { response, release } = await fetchOpenRouterVideoGet(params);
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return readOpenRouterVideoResponse(await readOpenRouterVideoJson(response));
  } finally {
    await release();
  }
}

async function pollOpenRouterVideo(params: {
  pollingUrl: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
}): Promise<OpenRouterVideoResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: "OpenRouter video generation",
  });

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const payload = await fetchOpenRouterJson({
      url: params.pollingUrl,
      baseUrl: params.baseUrl,
      headers: params.headers,
      timeoutMs: resolveProviderOperationTimeoutMs({
        deadline,
        defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      }),
      allowPrivateNetwork: params.allowPrivateNetwork,
      dispatcherPolicy: params.dispatcherPolicy,
      errorContext: "OpenRouter video status request failed",
      auditContext: "openrouter-video-status",
    });
    const status = normalizeOptionalString(payload.status);
    if (
      !status ||
      (!["queued", "pending", "processing", "running", "completed"].includes(status) &&
        !isTerminalFailure(status))
    ) {
      throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
    }
    if (status === "completed") {
      return payload;
    }
    if (isTerminalFailure(status)) {
      throw new Error(
        normalizeOptionalString(payload.error) ?? `OpenRouter video generation ${status}`,
      );
    }
    await waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  }

  throw new Error("OpenRouter video generation did not finish in time");
}

function resolveOpenRouterContentUrl(params: { baseUrl: string; jobId: string }): string {
  return resolveOpenRouterVideoUrl(
    `videos/${encodeURIComponent(params.jobId)}/content?index=0`,
    params.baseUrl,
  );
}

function resolveDeliverableOpenRouterVideoUrl(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:" ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

async function downloadOpenRouterVideo(params: {
  url: string;
  deliveryUrl?: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
  maxBytes: number;
}): Promise<GeneratedVideoAsset> {
  const { response, release } = await fetchOpenRouterVideoGet({
    ...params,
    auditContext: "openrouter-video-download",
  });
  try {
    await assertOkOrThrowHttpError(response, "OpenRouter generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const fileName = `video-1.${extensionForMime(mimeType)?.slice(1) ?? "mp4"}`;
    let exceededMaxBytes = false;
    let buffer: Buffer;
    try {
      buffer = await readResponseWithLimit(response, params.maxBytes, {
        onOverflow: ({ maxBytes }) => {
          exceededMaxBytes = true;
          return new Error(`OpenRouter generated video download exceeds ${maxBytes} bytes`);
        },
      });
    } catch (error) {
      if (exceededMaxBytes && params.deliveryUrl) {
        return {
          url: params.deliveryUrl,
          mimeType,
          fileName,
        };
      }
      throw error;
    }
    return {
      buffer,
      mimeType,
      fileName,
    };
  } finally {
    await release();
  }
}

export function buildOpenRouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "openrouter", agentDir }),
    resolveModelCapabilities: resolveOpenRouterVideoModelCapabilities,
    capabilities: {
      providerOptions: {
        callback_url: "string",
        seed: "number",
      },
      generate: {
        maxVideos: 1,
        supportedDurationSeconds: [...SUPPORTED_DURATION_SECONDS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: [...SUPPORTED_RESOLUTIONS],
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 4,
        supportedDurationSeconds: [...SUPPORTED_DURATION_SECONDS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: [...SUPPORTED_RESOLUTIONS],
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("OpenRouter video generation does not support video reference inputs.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg?.models?.providers?.openrouter?.request,
          ),
          provider: "openrouter",
          capability: "video",
          transport: "http",
        });
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "OpenRouter video generation",
      });
      const body = buildRequestBody(req, model);
      const payloadSummary = buildSafePayloadSummary(req, model, body);
      log.info("OpenRouter video request serialization", payloadSummary);
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        }),
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        auditContext: "openrouter-video-submit",
      });

      try {
        if (!response.ok) {
          const providerError = await readProviderJsonResponse<unknown>(
            response.clone(),
            "OpenRouter video failure diagnostic",
          )
            .then(readProviderErrorDiagnostic)
            .catch(() => ({}));
          log.error("OpenRouter video request failed", {
            correlationId: payloadSummary.correlationId,
            httpStatus: response.status,
            providerErrorCode: providerError.code,
            providerErrorMessage: providerError.message,
            payloadSummary,
          });
        }
        await assertOkOrThrowHttpError(response, "OpenRouter video generation failed");
        const submitted = readOpenRouterVideoResponse(await readOpenRouterVideoJson(response));
        const jobId = normalizeOptionalString(submitted.id);
        const pollingUrl = normalizeOptionalString(submitted.polling_url);
        if (!jobId || !pollingUrl) {
          throw new Error("OpenRouter video generation response missing job details");
        }
        const submittedStatus = normalizeOptionalString(submitted.status);
        if (
          submittedStatus &&
          !["queued", "pending", "processing", "running", "completed"].includes(submittedStatus) &&
          !isTerminalFailure(submittedStatus)
        ) {
          throw new Error(OPENROUTER_VIDEO_MALFORMED_RESPONSE);
        }
        if (isTerminalFailure(submittedStatus)) {
          throw new Error(
            normalizeOptionalString(submitted.error) ??
              `OpenRouter video generation ${submittedStatus}`,
          );
        }
        const completed =
          submittedStatus === "completed"
            ? submitted
            : await pollOpenRouterVideo({
                pollingUrl,
                baseUrl,
                headers,
                timeoutMs: resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                }),
                allowPrivateNetwork,
                dispatcherPolicy,
              });
        const completedJobId = normalizeOptionalString(completed.id) ?? jobId;
        const unsignedUrl = completed.unsigned_urls?.find((url) => normalizeOptionalString(url));
        const videoUrl =
          unsignedUrl ?? resolveOpenRouterContentUrl({ baseUrl, jobId: completedJobId });
        const video = await downloadOpenRouterVideo({
          url: videoUrl,
          deliveryUrl: resolveDeliverableOpenRouterVideoUrl(unsignedUrl),
          baseUrl,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
          }),
          allowPrivateNetwork,
          dispatcherPolicy,
          maxBytes: resolveGeneratedVideoMaxBytes(req),
        });

        return {
          videos: [video],
          model: normalizeOptionalString(completed.model) ?? model,
          metadata: {
            jobId,
            status: completed.status,
            ...(normalizeOptionalString(completed.generation_id)
              ? { generationId: normalizeOptionalString(completed.generation_id) }
              : {}),
            ...(completed.usage ? { usage: completed.usage } : {}),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
