/**
 * Owner-only LINE video-generation cost guard.
 *
 * OpenRouter's `pricing_skus` units are heterogeneous across models/providers.
 * Three families are recognized, each only when it can be interpreted
 * unambiguously:
 *
 *   1. Per-output-token  ("video_tokens", "video_tokens_without_audio", ...)
 *   2. Per-video-second  (any key containing "second")
 *   3. Flat per video    ("default", "per-video", "flat")
 *
 * Every other shape returns `undefined` ("cannot estimate") rather than
 * guessing, and callers fail closed on an unknown estimate instead of
 * submitting an unbounded paid job.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenRouterVideoModel } from "./video-model-catalog.js";

/** Safe conservative default when the operator has not configured a limit. */
export const DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD = 2;

/**
 * Frames per second in OpenRouter's published video-token formula:
 *   tokens = (height * width * duration * 24) / 1024
 * Quoted from OpenRouter's own model documentation (verified 2026-08-22 against
 * https://openrouter.ai/bytedance/seedance-2.0 and the live
 * https://openrouter.ai/api/v1/videos/models catalog). The 24 is part of the
 * billing formula itself, not an assumption about a model's real frame rate.
 */
const VIDEO_TOKEN_FPS = 24;
const VIDEO_TOKEN_DIVISOR = 1024;

const PER_SECOND_SKU_PATTERN = /second/iu;
const TOKEN_SKU_PATTERN = /token/iu;
const FLAT_SKU_KEYS = new Set(["default", "per-video", "flat"]);

/** Pricing dimensions that change which SKU variant applies. */
export type LineVideoPricingSelector = {
  durationSeconds: number;
  /** Chosen output size, e.g. "1280x720". Required for token-priced models. */
  size?: string;
  /** Chosen resolution label, e.g. "720p" / "4K". Selects labelled SKU variants. */
  resolution?: string;
  audio?: boolean;
  /** True when the request conditions on an input VIDEO (not a still image). */
  videoInput?: boolean;
};

type ParsedSize = { width: number; height: number };

/** Parses an OpenRouter size string ("1280x720"). */
export function parseVideoSize(value: string | undefined): ParsedSize | undefined {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/iu.exec(value?.trim() ?? "");
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/** Short-side pixel height implied by a resolution label, e.g. "720p" -> 720. */
function resolutionShortSide(resolution: string | undefined): number | undefined {
  const normalized = resolution?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "4k") {
    return 2160;
  }
  const match = /^(\d+)p$/u.exec(normalized);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function aspectRatioValue(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u.exec(value?.trim() ?? "");
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return Number.isFinite(width) && Number.isFinite(height) && height > 0
    ? width / height
    : undefined;
}

/**
 * Picks the catalog output size the request will actually be billed at.
 *
 * Token-priced models bill by output pixel area, so a resolution label alone is
 * not enough; this resolves the label plus aspect ratio to one of the model's
 * declared `supported_sizes`. Returns undefined when nothing matches, which
 * keeps the estimate unknown rather than inventing pixel dimensions.
 */
export function resolveLineVideoOutputSize(params: {
  supportedSizes: readonly string[];
  resolution?: string;
  aspectRatio?: string;
}): string | undefined {
  const shortSide = resolutionShortSide(params.resolution);
  const targetRatio = aspectRatioValue(params.aspectRatio);
  const candidates = params.supportedSizes
    .map((size) => ({ size, parsed: parseVideoSize(size) }))
    .filter((entry): entry is { size: string; parsed: ParsedSize } => entry.parsed !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  const atResolution =
    shortSide === undefined
      ? candidates
      : candidates.filter(
          (entry) => Math.min(entry.parsed.width, entry.parsed.height) === shortSide,
        );
  if (atResolution.length === 0) {
    return undefined;
  }
  if (targetRatio === undefined) {
    return atResolution[0]?.size;
  }
  return atResolution.toSorted((left, right) => {
    const leftDelta = Math.abs(left.parsed.width / left.parsed.height - targetRatio);
    const rightDelta = Math.abs(right.parsed.width / right.parsed.height - targetRatio);
    return leftDelta - rightDelta;
  })[0]?.size;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Scores how well a SKU key matches the request among one pricing family.
 *
 * OpenRouter encodes the billing dimensions in the key itself
 * ("video_tokens_without_audio", "video_tokens_1080p",
 * "duration_seconds_with_audio_4k"). A key that names a dimension the request
 * does not match is rejected outright, so an audio-off request can never be
 * priced with an audio-on SKU, and a 720p request can never be priced with a 4K
 * SKU. Among the survivors the most specific key wins; the bare family key is
 * the fallback.
 */
function scoreSkuKey(key: string, selector: LineVideoPricingSelector): number | undefined {
  const normalized = key.toLowerCase();
  let score = 0;

  const mentionsVideoInput = normalized.includes("with_video_input");
  if (mentionsVideoInput !== (selector.videoInput === true)) {
    return undefined;
  }
  if (mentionsVideoInput) {
    score += 4;
  }

  const mentionsWithoutAudio = normalized.includes("without_audio");
  const mentionsWithAudio = !mentionsWithoutAudio && normalized.includes("with_audio");
  if (mentionsWithoutAudio) {
    if (selector.audio === true) {
      return undefined;
    }
    score += 2;
  }
  if (mentionsWithAudio) {
    if (selector.audio !== true) {
      return undefined;
    }
    score += 2;
  }

  // Resolution-labelled variants ("_4k", "_1080p") only apply at that label.
  const labelMatch = /_(\d+p|4k)(?:_|$)/u.exec(normalized);
  const label = labelMatch?.[1];
  if (label) {
    const requested = resolutionShortSide(selector.resolution);
    if (requested === undefined || requested !== resolutionShortSide(label)) {
      return undefined;
    }
    score += 1;
  }

  return score;
}

/** Chooses the best-matching SKU value within one pricing family. */
function selectFamilySku(
  skus: Record<string, string>,
  family: RegExp,
  selector: LineVideoPricingSelector,
): number | undefined {
  let best: { score: number; value: number } | undefined;
  for (const [key, raw] of Object.entries(skus)) {
    if (!family.test(key)) {
      continue;
    }
    const value = positiveNumber(raw);
    const score = scoreSkuKey(key, selector);
    if (value === undefined || score === undefined) {
      continue;
    }
    if (!best || score > best.score) {
      best = { score, value };
    }
  }
  return best?.value;
}

/**
 * Estimates USD cost for one video, or `undefined` when the model's pricing SKU
 * shape cannot be safely interpreted for this exact request.
 */
export function estimateOpenRouterVideoCostUsd(params: {
  model: Pick<OpenRouterVideoModel, "pricingSkus">;
  selector: LineVideoPricingSelector;
}): number | undefined {
  const skus = params.model.pricingSkus;
  if (!skus) {
    return undefined;
  }
  const selector = params.selector;
  const durationSeconds = Math.max(1, selector.durationSeconds);

  // 1. Per-output-token pricing (Seedance and friends). Needs real pixel
  //    dimensions; without them the cost stays unknown rather than guessed.
  const tokenRate = selectFamilySku(skus, TOKEN_SKU_PATTERN, selector);
  if (tokenRate !== undefined) {
    const size = parseVideoSize(selector.size);
    if (!size) {
      return undefined;
    }
    const tokens =
      (size.width * size.height * durationSeconds * VIDEO_TOKEN_FPS) / VIDEO_TOKEN_DIVISOR;
    return tokens * tokenRate;
  }

  const perSecond = selectFamilySku(skus, PER_SECOND_SKU_PATTERN, selector);
  if (perSecond !== undefined) {
    return perSecond * durationSeconds;
  }

  for (const [key, raw] of Object.entries(skus)) {
    const value = positiveNumber(raw);
    if (value !== undefined && FLAT_SKU_KEYS.has(key.toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

/** Resolves the configured cost ceiling, falling back to the safe built-in default. */
export function resolveLineVideoMaxEstimatedCostUsd(cfg: {
  videoGeneration?: { maxEstimatedCostUsd?: number };
}): number {
  const configured = cfg.videoGeneration?.maxEstimatedCostUsd;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD;
}

export type LineVideoCostGuardDecision =
  | { allowed: true; estimatedCostUsd: number }
  | { allowed: false; reason: "unknown_cost" }
  | { allowed: false; reason: "over_limit"; estimatedCostUsd: number; maxAllowedUsd: number };

/** Fails closed: an unestimable cost is treated as unsafe to submit, never as "free". */
export function evaluateLineVideoCostGuard(params: {
  model: Pick<OpenRouterVideoModel, "pricingSkus">;
  selector: LineVideoPricingSelector;
  cfg: Pick<OpenClawConfig, never> & { videoGeneration?: { maxEstimatedCostUsd?: number } };
}): LineVideoCostGuardDecision {
  const estimatedCostUsd = estimateOpenRouterVideoCostUsd({
    model: params.model,
    selector: params.selector,
  });
  if (estimatedCostUsd === undefined) {
    return { allowed: false, reason: "unknown_cost" };
  }
  const maxAllowedUsd = resolveLineVideoMaxEstimatedCostUsd(params.cfg);
  if (estimatedCostUsd > maxAllowedUsd) {
    return { allowed: false, reason: "over_limit", estimatedCostUsd, maxAllowedUsd };
  }
  return { allowed: true, estimatedCostUsd };
}
