import crypto from "node:crypto";

/**
 * Stable private review URLs for previs projects.
 *
 * Same philosophy as the Character view URL (`character-view-url.ts`): Cloudbath
 * owns a permanent path plus an unguessable capability token, and the URL
 * resolves the LATEST version at read time. Raw CozyClay editor URLs, localhost
 * endpoints and signed R2 URLs are never handed out as identity — they expire
 * or leak the private bucket.
 */
export const CLOUDBATH_PREVIS_VIEW_ROUTE = "/previs";

const REVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const PREVIS_PROJECT_ID_PATTERN = /^PREVIS-[0-9A-HJKMNP-TV-Z]{10,26}$/u;
/** Read-only review surfaces the stable URL exposes. `timeline` is the default. */
const PREVIS_CAPABILITIES = ["timeline", "cast", "camera", "artifact"] as const;

export type PrevisViewCapability = (typeof PREVIS_CAPABILITIES)[number];

export type PrevisViewReference = Readonly<{
  previsProjectId: string;
  token: string;
  capability: PrevisViewCapability;
  /** Absent means "latest"; a number pins the URL to one historical version. */
  versionNumber?: number;
}>;

function normalizePrevisProjectId(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return PREVIS_PROJECT_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function isCapability(value: string): value is PrevisViewCapability {
  return (PREVIS_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Parses `/previs/<PREVIS-ID>/<token>/<capability>[/v<n>]`.
 *
 * The token sits ahead of the capability so a capability segment can never be
 * mistaken for the secret, and so adding a surface later cannot widen an
 * already-issued URL's authority.
 */
export function parsePrevisViewPath(pathname: string): PrevisViewReference | null {
  const match = pathname.match(/^\/previs\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/v([0-9]{1,9}))?$/u);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  let previsProjectId: string;
  let token: string;
  let capabilitySegment: string;
  try {
    previsProjectId = decodeURIComponent(match[1]);
    token = decodeURIComponent(match[2]);
    capabilitySegment = match[3] ? decodeURIComponent(match[3]) : "timeline";
  } catch {
    return null;
  }
  const normalizedId = normalizePrevisProjectId(previsProjectId);
  if (!normalizedId || !REVIEW_TOKEN_PATTERN.test(token) || !isCapability(capabilitySegment)) {
    return null;
  }
  if (match[4] === undefined) {
    return { previsProjectId: normalizedId, token, capability: capabilitySegment };
  }
  const versionNumber = Number(match[4]);
  // Version 0 is not a version; rejecting it here keeps the route from asking
  // the store for a record that can never exist.
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    return null;
  }
  return { previsProjectId: normalizedId, token, capability: capabilitySegment, versionNumber };
}

export function createPrevisReviewToken(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildPrevisViewUrl(params: {
  publicAssetBaseUrl: string;
  previsProjectId: string;
  token: string;
  capability?: PrevisViewCapability;
  versionNumber?: number;
}): string {
  const previsProjectId = normalizePrevisProjectId(params.previsProjectId);
  if (!previsProjectId) {
    throw new Error("Previs project ID is invalid");
  }
  if (!REVIEW_TOKEN_PATTERN.test(params.token)) {
    throw new Error("Previs review capability is invalid");
  }
  const capability = params.capability ?? "timeline";
  const base = new URL(params.publicAssetBaseUrl);
  const suffix =
    params.versionNumber === undefined ? "" : `/v${requireVersionNumber(params.versionNumber)}`;
  return new URL(
    `${CLOUDBATH_PREVIS_VIEW_ROUTE}/${previsProjectId}/${params.token}/${capability}${suffix}`,
    base.origin,
  ).toString();
}

function requireVersionNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Previs version number is invalid");
  }
  return value;
}

/**
 * Mints a previs project id. Crockford-style alphabet (no I/L/O/U) keeps the id
 * readable when an owner reads it back off a LINE message.
 */
export function createPrevisProjectId(
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(16);
  let id = "";
  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }
  return `PREVIS-${id}`;
}
