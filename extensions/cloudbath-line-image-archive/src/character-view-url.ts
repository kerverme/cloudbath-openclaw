import crypto from "node:crypto";

export const CLOUDBATH_CHARACTER_VIEW_ROUTE = "/c";
const VIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const CHARACTER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}-[1-9][0-9]{0,18}$/u;

export type CharacterViewReference = Readonly<{
  characterId: string;
  token: string;
}>;

function normalizeCharacterId(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim();
  return CHARACTER_ID_PATTERN.test(normalized) ? normalized : undefined;
}

export function parseCharacterViewPath(pathname: string): CharacterViewReference | null {
  const match = pathname.match(/^\/c\/([^/]+)\/([^/]+)$/u);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  let characterId: string;
  let token: string;
  try {
    characterId = decodeURIComponent(match[1]);
    token = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const normalizedId = normalizeCharacterId(characterId);
  if (!normalizedId || !VIEW_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return { characterId: normalizedId, token };
}

export function buildCharacterViewUrl(params: {
  publicAssetBaseUrl: string;
  characterId: string;
  token?: string;
}): string {
  const characterId = normalizeCharacterId(params.characterId);
  if (!characterId) {
    throw new Error("Character view ID is invalid");
  }
  const token = params.token ?? crypto.randomBytes(12).toString("base64url");
  if (!VIEW_TOKEN_PATTERN.test(token)) {
    throw new Error("Character view capability is invalid");
  }
  const base = new URL(params.publicAssetBaseUrl);
  return new URL(
    `${CLOUDBATH_CHARACTER_VIEW_ROUTE}/${encodeURIComponent(characterId)}/${token}`,
    base.origin,
  ).toString();
}

export function isMatchingCharacterViewUrl(params: {
  url: string;
  publicAssetBaseUrl: string;
  characterId: string;
  token?: string;
}): boolean {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(params.url);
    base = new URL(params.publicAssetBaseUrl);
  } catch {
    return false;
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.origin !== base.origin ||
    candidate.search ||
    candidate.hash
  ) {
    return false;
  }
  const parsed = parseCharacterViewPath(candidate.pathname);
  return (
    parsed?.characterId === params.characterId &&
    (params.token === undefined || parsed.token === params.token)
  );
}
