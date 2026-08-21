// Video generation normalization helpers map user inputs to provider requests.
import {
  hasMediaNormalizationEntry,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "../media-generation/runtime-shared.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
} from "./duration-support.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationProvider,
  VideoGenerationResolution,
} from "./types.js";

const VIDEO_RESOLUTION_ORDER: readonly VideoGenerationResolution[] = [
  "360P",
  "480P",
  "540P",
  "720P",
  "768P",
  "1080P",
];

/**
 * Synthesizes a "WIDTHxHEIGHT" candidate from a resolution tier (e.g. "720P")
 * and an aspect ratio (e.g. "16:9"), so a model that only exposes a fixed
 * `sizes` list -- not a resolution enum -- can still honor the requested
 * resolution tier via resolveClosestSize's existing area-closeness matching,
 * instead of silently dropping the user's choice to the model's own default.
 * Defaults to 16:9 when no aspect ratio is available, matching this module's
 * only other implicit-ratio default (video-draft-tool.ts's DEFAULT_ASPECT_RATIO).
 */
function deriveSizeFromResolution(
  resolution: string,
  aspectRatio: string | undefined,
): string | undefined {
  const resolutionMatch = resolution.trim().match(/^(\d+(?:\.\d+)?)p$/iu);
  const shortEdge = resolutionMatch ? Number(resolutionMatch[1]) : undefined;
  if (!shortEdge || !Number.isFinite(shortEdge) || shortEdge <= 0) {
    return undefined;
  }
  const ratioMatch = (aspectRatio ?? "16:9")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u);
  const ratioWidth = ratioMatch ? Number(ratioMatch[1]) : 16;
  const ratioHeight = ratioMatch ? Number(ratioMatch[2]) : 9;
  if (![ratioWidth, ratioHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return undefined;
  }
  const isPortrait = ratioWidth < ratioHeight;
  const longEdge = Math.round(
    shortEdge * (Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight)),
  );
  const width = Math.round(isPortrait ? shortEdge : longEdge);
  const height = Math.round(isPortrait ? longEdge : shortEdge);
  return `${width}x${height}`;
}

type ResolvedVideoGenerationOverrides = {
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  audio?: boolean;
  watermark?: boolean;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
  normalization?: VideoGenerationNormalization;
};

export function resolveVideoGenerationOverrides(params: {
  provider: VideoGenerationProvider;
  model: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImageCount?: number;
  inputVideoCount?: number;
}): ResolvedVideoGenerationOverrides {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = [];
  const normalization: VideoGenerationNormalization = {};
  let size = params.size;
  let aspectRatio = params.aspectRatio;
  let resolution = params.resolution;
  let audio = params.audio;
  let watermark = params.watermark;

  if (caps) {
    if (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {
      const normalizedSize = resolveClosestSize({
        requestedSize: size,
        requestedAspectRatio: aspectRatio,
        supportedSizes: caps.sizes,
      });
      if (normalizedSize && normalizedSize !== size) {
        normalization.size = {
          requested: size,
          applied: normalizedSize,
        };
      }
      size = normalizedSize;
    }

    if (!caps.supportsSize && size) {
      let translated = false;
      if (caps.supportsAspectRatio) {
        const normalizedAspectRatio = resolveClosestAspectRatio({
          requestedAspectRatio: aspectRatio,
          requestedSize: size,
          supportedAspectRatios: caps.aspectRatios,
        });
        if (normalizedAspectRatio) {
          aspectRatio = normalizedAspectRatio;
          normalization.aspectRatio = {
            applied: normalizedAspectRatio,
            derivedFrom: "size",
          };
          translated = true;
        }
      }
      if (!translated) {
        ignoredOverrides.push({ key: "size", value: size });
      }
      size = undefined;
    }

    if (aspectRatio && (caps.aspectRatios?.length ?? 0) > 0 && caps.supportsAspectRatio) {
      const normalizedAspectRatio = resolveClosestAspectRatio({
        requestedAspectRatio: aspectRatio,
        requestedSize: size,
        supportedAspectRatios: caps.aspectRatios,
      });
      if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
        normalization.aspectRatio = {
          requested: aspectRatio,
          applied: normalizedAspectRatio,
        };
      } else if (!normalizedAspectRatio) {
        // Provider-specific sentinel values like `"adaptive"` are unparseable as a
        // numeric ratio, so `resolveClosestAspectRatio` returns undefined for
        // providers that don't list the sentinel in `caps.aspectRatios`. Surface
        // the drop via `ignoredOverrides` so the tool result warning picks it up
        // instead of silently forgetting the requested value.
        ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
      }
      aspectRatio = normalizedAspectRatio;
    } else if (!caps.supportsAspectRatio && aspectRatio) {
      const derivedSize =
        caps.supportsSize && !size
          ? resolveClosestSize({
              requestedSize: params.size,
              requestedAspectRatio: aspectRatio,
              supportedSizes: caps.sizes,
            })
          : undefined;
      if (derivedSize) {
        size = derivedSize;
        normalization.size = {
          applied: derivedSize,
          derivedFrom: "aspectRatio",
        };
      } else {
        ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
      }
      aspectRatio = undefined;
    }

    if (resolution && (caps.resolutions?.length ?? 0) > 0 && caps.supportsResolution) {
      const normalizedResolution = resolveClosestResolution({
        requestedResolution: resolution,
        supportedResolutions: caps.resolutions,
        order: VIDEO_RESOLUTION_ORDER,
      });
      if (normalizedResolution && normalizedResolution !== resolution) {
        normalization.resolution = {
          requested: resolution,
          applied: normalizedResolution,
        };
      } else if (!normalizedResolution) {
        ignoredOverrides.push({ key: "resolution", value: resolution });
      }
      resolution = normalizedResolution;
    } else if (resolution && !caps.supportsResolution) {
      // Mirrors the aspectRatio->size derivation above: a model that expresses
      // sizing exclusively via a fixed `sizes` list (no resolution enum) must
      // still receive the requester's resolution choice translated to size,
      // never silently dropped -- dropping it would let the provider apply
      // its own default resolution while the draft's cost guard, pricing, and
      // owner confirmation were all computed against the requested one.
      let translated = false;
      if (caps.supportsSize && !size) {
        const syntheticSize = deriveSizeFromResolution(resolution, aspectRatio);
        const derivedSize = syntheticSize
          ? resolveClosestSize({
              requestedSize: syntheticSize,
              requestedAspectRatio: aspectRatio,
              supportedSizes: caps.sizes,
            })
          : undefined;
        if (derivedSize) {
          size = derivedSize;
          normalization.size = {
            applied: derivedSize,
            derivedFrom: "resolution",
          };
          translated = true;
        }
      }
      if (!translated) {
        ignoredOverrides.push({ key: "resolution", value: resolution });
      }
      resolution = undefined;
    }

    if (typeof audio === "boolean" && !caps.supportsAudio) {
      ignoredOverrides.push({ key: "audio", value: audio });
      audio = undefined;
    }

    if (typeof watermark === "boolean" && !caps.supportsWatermark) {
      ignoredOverrides.push({ key: "watermark", value: watermark });
      watermark = undefined;
    }
  }

  if (caps && size && !caps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }
  if (caps && aspectRatio && !caps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }
  if (caps && resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (!normalization.size && size && params.size && params.size !== size) {
    normalization.size = {
      requested: params.size,
      applied: size,
    };
  }
  if (
    !normalization.aspectRatio &&
    aspectRatio &&
    ((!params.aspectRatio && params.size) || params.aspectRatio !== aspectRatio)
  ) {
    normalization.aspectRatio = {
      applied: aspectRatio,
      ...(params.aspectRatio ? { requested: params.aspectRatio } : {}),
      ...(!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}),
    };
  }
  if (
    !normalization.resolution &&
    resolution &&
    params.resolution &&
    params.resolution !== resolution
  ) {
    normalization.resolution = {
      requested: params.resolution,
      applied: resolution,
    };
  }

  const requestedDurationSeconds =
    typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)
      ? Math.max(1, Math.round(params.durationSeconds))
      : undefined;
  const durationSeconds = normalizeVideoGenerationDuration({
    provider: params.provider,
    model: params.model,
    durationSeconds: requestedDurationSeconds,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
  });
  const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
  });

  if (
    typeof requestedDurationSeconds === "number" &&
    typeof durationSeconds === "number" &&
    requestedDurationSeconds !== durationSeconds
  ) {
    normalization.durationSeconds = {
      requested: requestedDurationSeconds,
      applied: durationSeconds,
      ...(supportedDurationSeconds?.length ? { supportedValues: supportedDurationSeconds } : {}),
    };
  }

  return {
    size,
    aspectRatio,
    resolution,
    durationSeconds,
    supportedDurationSeconds,
    audio,
    watermark,
    ignoredOverrides,
    normalization:
      hasMediaNormalizationEntry(normalization.size) ||
      hasMediaNormalizationEntry(normalization.aspectRatio) ||
      hasMediaNormalizationEntry(normalization.resolution) ||
      hasMediaNormalizationEntry(normalization.durationSeconds)
        ? normalization
        : undefined,
  };
}
