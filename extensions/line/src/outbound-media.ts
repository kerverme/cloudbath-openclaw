// Line plugin module implements outbound media behavior.
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type LineOutboundMediaKind = "image" | "video" | "audio";

export type LineOutboundMediaResolved = {
  mediaUrl: string;
  mediaKind: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

type ResolveLineOutboundMediaOpts = {
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

const LINE_OUTBOUND_MEDIA_SSRF_POLICY: SsrFPolicy = {
  allowPrivateNetwork: false,
};

export async function validateLineMediaUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("LINE outbound media URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LINE outbound media URL must use HTTPS");
  }
  if (url.length > 2000) {
    throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
  }
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
  });
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function detectLineMediaKindFromUrl(url: string): LineOutboundMediaKind | undefined {
  try {
    const pathname = normalizeLowercaseStringOrEmpty(new URL(url).pathname);
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(pathname)) {
      return "image";
    }
    if (/\.(mp4|mov|m4v|webm)$/i.test(pathname)) {
      return "video";
    }
    if (/\.(mp3|m4a|aac|wav|ogg|oga)$/i.test(pathname)) {
      return "audio";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function resolveLineOutboundMedia(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts = {},
): Promise<LineOutboundMediaResolved> {
  const source = mediaUrl.trim();
  if (!source) {
    throw new Error("LINE outbound media source must be non-empty");
  }

  const sourceIsHttps = isHttpsUrl(source);
  const mediaKind =
    opts.mediaKind ??
    (typeof opts.durationMs === "number" ? "audio" : undefined) ??
    (opts.trackingId?.trim() ? "video" : undefined) ??
    (sourceIsHttps ? detectLineMediaKindFromUrl(source) : undefined) ??
    "image";
  const previewImageUrl = opts.previewImageUrl?.trim();

  if (mediaKind !== "image") {
    await validateLineMediaUrl(source);
  }
  return {
    mediaUrl: source,
    mediaKind,
    ...(previewImageUrl ? { previewImageUrl } : {}),
    ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
    ...(opts.trackingId ? { trackingId: opts.trackingId } : {}),
  };
}
