import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyModelOverrideToSessionEntry,
  loadSessionStore,
  type SessionEntry,
  updateSessionStore,
} from "openclaw/plugin-sdk/model-session-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth";

const OPENROUTER_PROVIDER = "openrouter";
const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
const MAX_CLARIFICATION_CHOICES = 5;
export const LINE_PENDING_MODEL_SELECTION_TTL_MS = 5 * 60 * 1000;
const LINE_PENDING_MODEL_SELECTION_FIELD = "linePendingModelSelection";

export type OpenRouterUserModel = {
  id: string;
  name: string;
  supportsTools?: boolean;
};

export type OpenRouterCatalogCandidate = OpenRouterUserModel & {
  ref: string;
  score: number;
  source: "openrouter-user-catalog";
};

export type OpenRouterCatalogLoader = (
  cfg: OpenClawConfig,
  agentId?: string,
) => Promise<OpenRouterUserModel[]>;

export type LineNaturalModelAction =
  | { kind: "none" }
  | { kind: "blocked" }
  | { kind: "directive"; command: string }
  | {
      kind: "switch";
      candidate: OpenRouterCatalogCandidate;
      locale: "en" | "th";
      pendingSelectionCreatedAt?: number;
    }
  | {
      kind: "reply";
      text: string;
      pendingSelection?: {
        candidates: OpenRouterCatalogCandidate[];
        locale: "en" | "th";
      };
    };

export type LineNaturalModelSwitchResult =
  | { ok: true; activeRef: string }
  | {
      ok: false;
      reason: "catalog" | "session" | "persistence" | "provider";
      rolledBack: boolean;
    };

type SwitchIntent = {
  kind: "switch";
  query: string;
  confirmed: boolean;
  preferBase: boolean;
  locale: "en" | "th";
};

type NaturalModelIntent =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "default" }
  | SwitchIntent;

export type LineNaturalModelSessionStore = {
  read: (storePath: string, sessionKey: string) => Promise<SessionEntry | undefined>;
  update: (
    storePath: string,
    sessionKey: string,
    mutate: (entry: SessionEntry) => void,
  ) => Promise<SessionEntry | undefined>;
};

export type LinePendingModelSelection = {
  version: 1;
  ownerSenderId: string;
  locale: "en" | "th";
  candidates: OpenRouterCatalogCandidate[];
  createdAt: number;
  expiresAt: number;
};

export type LinePendingModelSelectionReply =
  | { kind: "none" }
  | { kind: "cancel" }
  | { kind: "selection"; index: number };

const SESSION_SWITCH_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "model",
  "modelProvider",
  "contextTokens",
  "contextBudgetStatus",
  "liveModelSwitchPending",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

type SessionSwitchSnapshot = Partial<Record<(typeof SESSION_SWITCH_FIELDS)[number], unknown>>;

const defaultSessionStore: LineNaturalModelSessionStore = {
  read: async (storePath, sessionKey) => {
    const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    return entry ? structuredClone(entry) : undefined;
  },
  update: async (storePath, sessionKey, mutate) =>
    await updateSessionStore(storePath, (store) => {
      const entry = store[sessionKey];
      if (!entry) {
        return undefined;
      }
      mutate(entry);
      return structuredClone(entry);
    }),
};

function hasThaiText(value: string): boolean {
  return /[\u0e00-\u0e7f]/u.test(value);
}

function stripTrailingPoliteness(value: string): string {
  return value
    .replace(/\s*(?:ได้ไหม|ได้หรือไม่)\s*[.!?]*$/iu, "")
    .replace(/\s+(?:แทน|หน่อย|ที|ครับ|ค่ะ|คะ|นะ|please)\s*[.!?]*$/iu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
}

function stripModelNoun(value: string): string {
  return value.replace(/^(?:โมเดล|model)\s+/iu, "").trim();
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function isExactOpenRouterModelId(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || /\s/u.test(value)) {
    return false;
  }
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

export function toOpenClawOpenRouterRef(modelId: string): string | null {
  return isExactOpenRouterModelId(modelId) ? `${OPENROUTER_PROVIDER}/${modelId}` : null;
}

function parseSwitchQuery(raw: string): {
  query: string;
  confirmed: boolean;
  preferBase: boolean;
} {
  let query = stripTrailingPoliteness(stripModelNoun(raw));
  let confirmed = false;
  const confirmation = query.match(
    /^(?:ยืนยัน(?:ใช้|เปลี่ยนเป็น)?|confirm(?:\s+(?:use|switch\s+to))?)\s+(.+)$/iu,
  );
  if (confirmation?.[1]) {
    confirmed = true;
    query = stripTrailingPoliteness(stripModelNoun(confirmation[1]));
  }
  const baseMatch = query.match(/\s+(?:ธรรมดา|รุ่นปกติ|regular|base)$/iu);
  const preferBase = Boolean(baseMatch);
  if (baseMatch) {
    query = query.slice(0, baseMatch.index).trim();
  }
  return { query, confirmed, preferBase };
}

export function parseLineNaturalModelIntent(text: string): NaturalModelIntent {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return { kind: "none" };
  }

  if (
    /^(?:ตอนนี้(?:กำลัง)?ใช้โมเดลอะไร|ใช้โมเดลอะไรอยู่|what(?:'s| is) (?:the )?(?:current |active )?model|what model are you using)\??$/iu.test(
      trimmed,
    )
  ) {
    return { kind: "current" };
  }

  const thaiConfirmation = trimmed.match(/^ยืนยัน(?:ใช้|เปลี่ยนเป็น)?\s+(.+)$/iu);
  const englishConfirmation = trimmed.match(/^confirm\s+(?:use|switch\s+to)\s+(.+)$/iu);
  const thai = trimmed.match(
    /^(?:เปลี่ยน(?:กลับ)?เป็น|เปลี่ยนไป(?:ใช้)?|เปลี่ยน(?:โมเดล|ตัว\s*AI)\s*เป็น|สลับ(?:ไปใช้|เป็น|โมเดล\s*เป็น)|กลับ(?:ไป|มา)(?:ใช้)?|ขอ(?:เปลี่ยนเป็น|ใช้)|เอาเป็น|ใช้|อยากลอง(?:เปลี่ยนเป็น|ใช้)?|ลอง(?:เปลี่ยนเป็น|ใช้)?)\s*(.+)$/iu,
  );
  const english = trimmed.match(/^(?:switch(?:\s+back)?\s+to|use|try)\s+(.+)$/iu);
  const rawQuery = thaiConfirmation?.[1] ?? englishConfirmation?.[1] ?? thai?.[1] ?? english?.[1];
  if (!rawQuery) {
    return { kind: "none" };
  }

  const parsed = parseSwitchQuery(rawQuery);
  parsed.confirmed ||= Boolean(thaiConfirmation || englishConfirmation);
  const normalizedQuery = normalizeSearchText(parsed.query);
  if (
    normalizedQuery === "default" ||
    normalizedQuery === "ค่าเริ่มต้น" ||
    normalizedQuery === "ค่าปริยาย"
  ) {
    return { kind: "default" };
  }
  if (!parsed.query) {
    return { kind: "none" };
  }
  return {
    kind: "switch",
    query: parsed.query,
    confirmed: parsed.confirmed,
    preferBase: parsed.preferBase,
    locale: hasThaiText(trimmed) ? "th" : "en",
  };
}

export function isLineNaturalModelControlLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }
  if (parseLineNaturalModelIntent(trimmed).kind !== "none") {
    return true;
  }

  const hasExplicitControlSubject = /(?:โมเดล|model|provider|openrouter|ตัว\s*AI)/iu.test(trimmed);
  const hasSwitchVerb =
    /(?:สลับ|เปลี่ยน|กลับ(?:ไป|มา)|ขอ(?:ใช้|เปลี่ยน)|เอาเป็น|switch|change|return|go\s+back)/iu.test(
      trimmed,
    );
  const asksCurrentModel =
    /(?:โมเดล|model).*(?:ปัจจุบัน|ตอนนี้|current|active).*(?:อะไร|ไหน|what|which)|(?:what|which).*(?:current|active).*(?:โมเดล|model)/iu.test(
      trimmed,
    );
  return asksCurrentModel || (hasExplicitControlSubject && hasSwitchVerb);
}

export function parseLinePendingModelSelectionReply(text: string): LinePendingModelSelectionReply {
  const normalized = text.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
  if (!normalized) {
    return { kind: "none" };
  }
  if (/^(?:ยกเลิก|ไม่เอาแล้ว|cancel|never mind)$/iu.test(normalized)) {
    return { kind: "cancel" };
  }

  const numeric = normalized.match(
    /^(?:(?:เลือก|เอา|ใช้)(?:\s*(?:รุ่น|ตัว|อัน))?\s*|(?:รุ่น|ตัว|อัน)(?:ที่)?\s*|(?:option|choose|use)\s*)?(\d+)$/iu,
  );
  if (numeric?.[1]) {
    return { kind: "selection", index: Number.parseInt(numeric[1], 10) - 1 };
  }

  if (
    /^(?:ตัวแรก|อันแรก|เอาตัวแรก|เลือกตัวแรก|first|the first one|choose the first one)$/iu.test(
      normalized,
    )
  ) {
    return { kind: "selection", index: 0 };
  }
  if (
    /^(?:ตัว(?:ที่)?\s*สอง|อัน(?:ที่)?\s*สอง|เอาตัวสอง|เลือกตัวสอง|second|the second one|choose the second one)$/iu.test(
      normalized,
    )
  ) {
    return { kind: "selection", index: 1 };
  }
  return { kind: "none" };
}

function parsePendingCandidate(value: unknown): OpenRouterCatalogCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<OpenRouterCatalogCandidate>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const score = typeof candidate.score === "number" ? candidate.score : Number.NaN;
  const ref = toOpenClawOpenRouterRef(id);
  if (
    !ref ||
    candidate.ref !== ref ||
    candidate.source !== "openrouter-user-catalog" ||
    !name.trim() ||
    !Number.isFinite(score) ||
    (candidate.supportsTools !== undefined && typeof candidate.supportsTools !== "boolean")
  ) {
    return null;
  }
  return {
    id,
    name,
    ref,
    score,
    source: "openrouter-user-catalog",
    ...(candidate.supportsTools === undefined ? {} : { supportsTools: candidate.supportsTools }),
  };
}

function parsePendingSelection(value: unknown): LinePendingModelSelection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const pending = value as Partial<LinePendingModelSelection>;
  if (
    pending.version !== 1 ||
    typeof pending.ownerSenderId !== "string" ||
    !pending.ownerSenderId.trim() ||
    (pending.locale !== "en" && pending.locale !== "th") ||
    typeof pending.createdAt !== "number" ||
    !Number.isFinite(pending.createdAt) ||
    typeof pending.expiresAt !== "number" ||
    !Number.isFinite(pending.expiresAt) ||
    !Array.isArray(pending.candidates) ||
    pending.candidates.length === 0 ||
    pending.candidates.length > MAX_CLARIFICATION_CHOICES
  ) {
    return null;
  }
  const candidates = pending.candidates.map(parsePendingCandidate);
  if (candidates.some((candidate) => candidate === null)) {
    return null;
  }
  return {
    version: 1,
    ownerSenderId: pending.ownerSenderId,
    locale: pending.locale,
    candidates: candidates as OpenRouterCatalogCandidate[],
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

function getPendingSelection(entry: SessionEntry | undefined): LinePendingModelSelection | null {
  if (!entry) {
    return null;
  }
  const record = entry as unknown as Record<string, unknown>;
  return parsePendingSelection(record[LINE_PENDING_MODEL_SELECTION_FIELD]);
}

export async function readLinePendingModelSelection(params: {
  storePath: string;
  sessionKey: string;
  store?: LineNaturalModelSessionStore;
}): Promise<LinePendingModelSelection | null> {
  const store = params.store ?? defaultSessionStore;
  return getPendingSelection(await store.read(params.storePath, params.sessionKey));
}

export async function saveLinePendingModelSelection(params: {
  storePath: string;
  sessionKey: string;
  ownerSenderId: string;
  candidates: OpenRouterCatalogCandidate[];
  locale: "en" | "th";
  store?: LineNaturalModelSessionStore;
  now?: number;
  ttlMs?: number;
}): Promise<LinePendingModelSelection | null> {
  const candidates = params.candidates
    .slice(0, MAX_CLARIFICATION_CHOICES)
    .map(parsePendingCandidate);
  if (
    !params.ownerSenderId.trim() ||
    candidates.length === 0 ||
    candidates.some((candidate) => candidate === null)
  ) {
    return null;
  }
  const createdAt = params.now ?? Date.now();
  const pending: LinePendingModelSelection = {
    version: 1,
    ownerSenderId: params.ownerSenderId,
    locale: params.locale,
    candidates: candidates as OpenRouterCatalogCandidate[],
    createdAt,
    expiresAt: createdAt + (params.ttlMs ?? LINE_PENDING_MODEL_SELECTION_TTL_MS),
  };
  const store = params.store ?? defaultSessionStore;
  const updated = await store.update(params.storePath, params.sessionKey, (entry) => {
    const record = entry as unknown as Record<string, unknown>;
    record[LINE_PENDING_MODEL_SELECTION_FIELD] = structuredClone(pending);
    entry.updatedAt = Date.now();
  });
  return getPendingSelection(updated);
}

export async function clearLinePendingModelSelection(params: {
  storePath: string;
  sessionKey: string;
  store?: LineNaturalModelSessionStore;
  expectedCreatedAt?: number;
}): Promise<boolean> {
  const store = params.store ?? defaultSessionStore;
  const updated = await store.update(params.storePath, params.sessionKey, (entry) => {
    const record = entry as unknown as Record<string, unknown>;
    const pending = parsePendingSelection(record[LINE_PENDING_MODEL_SELECTION_FIELD]);
    if (params.expectedCreatedAt === undefined || pending?.createdAt === params.expectedCreatedAt) {
      delete record[LINE_PENDING_MODEL_SELECTION_FIELD];
      entry.updatedAt = Date.now();
    }
  });
  return getPendingSelection(updated) === null;
}

function formatPendingSelectionCancelled(locale: "en" | "th"): string {
  return locale === "th" ? "ยกเลิกการเลือกโมเดลแล้วครับ" : "Model selection cancelled.";
}

function formatPendingSelectionExpired(locale: "en" | "th"): string {
  return locale === "th"
    ? "ตัวเลือกโมเดลหมดอายุแล้ว กรุณาขอเปลี่ยนโมเดลอีกครั้ง"
    : "Those model choices expired. Please request the model switch again.";
}

function formatInvalidPendingSelection(locale: "en" | "th", candidateCount: number): string {
  return locale === "th"
    ? `กรุณาเลือกหมายเลข 1 ถึง ${candidateCount}`
    : `Please choose a number from 1 to ${candidateCount}.`;
}

function resolveOwnerAuthorization(params: {
  ctx: Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
  cfg: OpenClawConfig;
}): { senderIsOwner: boolean; isAuthorizedSender: boolean } {
  return resolveCommandAuthorization({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: true,
  });
}

function resolveContextSenderId(
  ctx: Parameters<typeof resolveCommandAuthorization>[0]["ctx"],
): string {
  const senderId = (ctx as { SenderId?: unknown }).SenderId;
  return typeof senderId === "string" ? senderId.trim() : "";
}

function formatUnparsedModelControl(text: string): string {
  return hasThaiText(text)
    ? "กรุณาระบุชื่อโมเดลที่ต้องการเปลี่ยนให้ชัดเจน"
    : "Please specify the model you want to switch to.";
}

export async function loadOpenRouterUserModelCatalog(
  cfg: OpenClawConfig,
  agentId?: string,
  deps: {
    fetchImpl?: typeof fetch;
    resolveAuth?: typeof resolveApiKeyForProvider;
    timeoutMs?: number;
  } = {},
): Promise<OpenRouterUserModel[]> {
  void agentId;
  const resolveAuth = deps.resolveAuth ?? resolveApiKeyForProvider;
  const auth = await resolveAuth({ provider: OPENROUTER_PROVIDER, cfg });
  if (!auth.apiKey?.trim()) {
    throw new Error("OPENROUTER_USER_CATALOG_AUTH_UNAVAILABLE");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? OPENROUTER_CATALOG_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await (deps.fetchImpl ?? fetch)(OPENROUTER_USER_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OPENROUTER_USER_CATALOG_HTTP_${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown };
    if (!Array.isArray(payload.data)) {
      throw new Error("OPENROUTER_USER_CATALOG_INVALID_RESPONSE");
    }

    const models = new Map<string, OpenRouterUserModel>();
    for (const raw of payload.data) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const item = raw as {
        id?: unknown;
        name?: unknown;
        supported_parameters?: unknown;
      };
      if (!isExactOpenRouterModelId(item.id)) {
        continue;
      }
      const supportedParameters = Array.isArray(item.supported_parameters)
        ? item.supported_parameters.filter((value): value is string => typeof value === "string")
        : undefined;
      models.set(item.id, {
        id: item.id,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id,
        ...(supportedParameters ? { supportsTools: supportedParameters.includes("tools") } : {}),
      });
    }
    return [...models.values()];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OPENROUTER_USER_CATALOG_")) {
      throw error;
    }
    throw new Error("OPENROUTER_USER_CATALOG_REQUEST_FAILED", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function scoreCandidate(params: {
  id: string;
  name: string;
  query: string;
  preferBase: boolean;
}): number {
  const query = normalizeSearchText(params.query);
  const id = normalizeSearchText(params.id);
  const leafId = normalizeSearchText(params.id.split("/").at(-1) ?? params.id);
  const name = normalizeSearchText(params.name);
  if (!query) {
    return 0;
  }
  if (query === id || query === leafId || query === name) {
    return 200;
  }

  const queryTokens = query.split(" ");
  const searchable = new Set(`${id} ${name}`.split(" "));
  if (!queryTokens.every((token) => searchable.has(token))) {
    return 0;
  }

  const extraTokens = Math.max(0, searchable.size - queryTokens.length);
  let score = 100 - Math.min(extraTokens, 30);
  if (name.includes(query) || id.includes(query)) {
    score += 20;
  }
  if (params.preferBase) {
    const editionTokens = new Set(["pro", "max", "mini", "flash", "preview", "turbo"]);
    const hasEdition = [...searchable].some((token) => editionTokens.has(token));
    score += hasEdition ? -40 : 20;
  }
  return score;
}

function listOpenRouterCandidates(
  models: OpenRouterUserModel[],
  intent: SwitchIntent,
): OpenRouterCatalogCandidate[] {
  return models
    .map((model) => {
      const ref = toOpenClawOpenRouterRef(model.id);
      if (!ref) {
        return null;
      }
      return {
        ...model,
        ref,
        source: "openrouter-user-catalog" as const,
        score: scoreCandidate({
          id: model.id,
          name: model.name,
          query: intent.query,
          preferBase: intent.preferBase,
        }),
      };
    })
    .filter((candidate): candidate is OpenRouterCatalogCandidate =>
      Boolean(candidate && candidate.score > 0),
    )
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function resolveUniqueCandidate(
  candidates: OpenRouterCatalogCandidate[],
): OpenRouterCatalogCandidate | undefined {
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  if (candidates.length === 1) {
    return first;
  }
  const second = candidates[1];
  if (first.score >= 180 && first.score > (second?.score ?? 0)) {
    return first;
  }
  return first.score - (second?.score ?? 0) >= 30 ? first : undefined;
}

function formatNoMatch(intent: SwitchIntent): string {
  return intent.locale === "th"
    ? "ไม่พบโมเดล OpenRouter ที่ตรงกับชื่อนี้ในรายการที่บัญชีนี้ใช้งานได้"
    : "No matching OpenRouter model is available to this account.";
}

function formatAmbiguous(intent: SwitchIntent, candidates: OpenRouterCatalogCandidate[]): string {
  const shown = candidates.slice(0, MAX_CLARIFICATION_CHOICES);
  const lines = shown.map(
    (candidate, index) => `${index + 1}. ${candidate.name} (\`${candidate.ref}\`)`,
  );
  return intent.locale === "th"
    ? [`เจอ ${candidates.length} รุ่น:`, ...lines, "เลือกตัวไหนครับ?"].join("\n")
    : [`Found ${candidates.length} models:`, ...lines, "Which one should I use?"].join("\n");
}

function formatCapabilityWarning(
  intent: SwitchIntent,
  candidate: OpenRouterCatalogCandidate,
): string {
  return intent.locale === "th"
    ? `โมเดลนี้คุยได้ แต่ข้อมูล catalog ระบุว่าไม่รองรับ tools เช่น Notion พิมพ์ “ยืนยันใช้ ${candidate.name}” หากต้องการเปลี่ยนต่อ`
    : `This model can chat, but catalog metadata says it does not support tools such as Notion. Say “confirm use ${candidate.name}” to continue.`;
}

export function formatLineNaturalModelSwitchResult(params: {
  result: LineNaturalModelSwitchResult;
  candidate: OpenRouterCatalogCandidate;
  locale: "en" | "th";
}): string {
  if (params.result.ok && params.result.activeRef === params.candidate.ref) {
    return params.locale === "th"
      ? `เปลี่ยนเป็น ${params.candidate.name} แล้วครับ`
      : `Switched to ${params.candidate.name}.`;
  }
  return params.locale === "th"
    ? "เปลี่ยนโมเดลไม่สำเร็จ จึงคงโมเดลเดิมไว้"
    : "The model switch failed, so the previous model was kept.";
}

export async function resolveLineNaturalLanguageModelAction(params: {
  text: string;
  cfg: OpenClawConfig;
  agentId?: string;
  ownerAuthorized: boolean;
  loadCatalog?: OpenRouterCatalogLoader;
}): Promise<LineNaturalModelAction> {
  if (!params.ownerAuthorized) {
    return { kind: "none" };
  }

  const intent = parseLineNaturalModelIntent(params.text);
  if (intent.kind === "none") {
    return { kind: "none" };
  }
  if (intent.kind === "current") {
    return { kind: "directive", command: "/model status" };
  }
  if (intent.kind === "default") {
    return { kind: "directive", command: "/model default" };
  }

  let models: OpenRouterUserModel[];
  try {
    models = await (params.loadCatalog ?? loadOpenRouterUserModelCatalog)(
      params.cfg,
      params.agentId,
    );
  } catch {
    return {
      kind: "reply",
      text:
        intent.locale === "th"
          ? "ไม่สามารถโหลดรายการโมเดลได้ในตอนนี้"
          : "The model catalog is unavailable right now.",
    };
  }

  const candidates = listOpenRouterCandidates(models, intent);
  if (candidates.length === 0) {
    return { kind: "reply", text: formatNoMatch(intent) };
  }
  const selected = resolveUniqueCandidate(candidates);
  if (!selected) {
    const shown = candidates.slice(0, MAX_CLARIFICATION_CHOICES);
    return {
      kind: "reply",
      text: formatAmbiguous(intent, candidates),
      pendingSelection: { candidates: shown, locale: intent.locale },
    };
  }
  if (selected.supportsTools === false && !intent.confirmed) {
    return { kind: "reply", text: formatCapabilityWarning(intent, selected) };
  }
  return { kind: "switch", candidate: selected, locale: intent.locale };
}

export async function resolveAuthorizedLineNaturalModelAction(params: {
  text: string;
  cfg: OpenClawConfig;
  agentId?: string;
  ctx: Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
  loadCatalog?: OpenRouterCatalogLoader;
  storePath?: string;
  sessionKey?: string;
  store?: LineNaturalModelSessionStore;
  now?: number;
}): Promise<LineNaturalModelAction> {
  const now = params.now ?? Date.now();
  const senderId = resolveContextSenderId(params.ctx);
  const selectionReply = parseLinePendingModelSelectionReply(params.text);
  let pending =
    params.storePath && params.sessionKey
      ? await readLinePendingModelSelection({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          store: params.store,
        })
      : null;

  if (pending && pending.expiresAt <= now) {
    await clearLinePendingModelSelection({
      storePath: params.storePath!,
      sessionKey: params.sessionKey!,
      store: params.store,
      expectedCreatedAt: pending.createdAt,
    });
    if (selectionReply.kind !== "none") {
      const authorization = resolveOwnerAuthorization(params);
      if (
        authorization.senderIsOwner &&
        authorization.isAuthorizedSender &&
        senderId === pending.ownerSenderId
      ) {
        return { kind: "reply", text: formatPendingSelectionExpired(pending.locale) };
      }
      return { kind: "blocked" };
    }
    pending = null;
  }

  if (pending) {
    const freshIntent = parseLineNaturalModelIntent(params.text);
    const freshControl = freshIntent.kind !== "none" || isLineNaturalModelControlLike(params.text);
    if (selectionReply.kind !== "none" || freshControl) {
      const authorization = resolveOwnerAuthorization(params);
      if (
        !(authorization.senderIsOwner && authorization.isAuthorizedSender) ||
        senderId !== pending.ownerSenderId
      ) {
        return { kind: "blocked" };
      }
      if (selectionReply.kind === "cancel") {
        await clearLinePendingModelSelection({
          storePath: params.storePath!,
          sessionKey: params.sessionKey!,
          store: params.store,
          expectedCreatedAt: pending.createdAt,
        });
        return { kind: "reply", text: formatPendingSelectionCancelled(pending.locale) };
      }
      if (selectionReply.kind === "selection") {
        const candidate = pending.candidates[selectionReply.index];
        if (!candidate) {
          return {
            kind: "reply",
            text: formatInvalidPendingSelection(pending.locale, pending.candidates.length),
          };
        }
        return {
          kind: "switch",
          candidate,
          locale: pending.locale,
          pendingSelectionCreatedAt: pending.createdAt,
        };
      }

      // A new explicit model-control request supersedes the prior candidate list.
      await clearLinePendingModelSelection({
        storePath: params.storePath!,
        sessionKey: params.sessionKey!,
        store: params.store,
        expectedCreatedAt: pending.createdAt,
      });
    } else {
      // Unrelated conversation remains ordinary chat; keep the bounded choice available.
      return { kind: "none" };
    }
  }

  const intent = parseLineNaturalModelIntent(params.text);
  const isModelControl = intent.kind !== "none" || isLineNaturalModelControlLike(params.text);
  if (!isModelControl) {
    return { kind: "none" };
  }

  const authorization = resolveOwnerAuthorization(params);
  if (!(authorization.senderIsOwner && authorization.isAuthorizedSender)) {
    return { kind: "blocked" };
  }
  if (intent.kind === "none") {
    return { kind: "reply", text: formatUnparsedModelControl(params.text) };
  }
  const action = await resolveLineNaturalLanguageModelAction({
    text: params.text,
    cfg: params.cfg,
    agentId: params.agentId,
    ownerAuthorized: true,
    loadCatalog: params.loadCatalog,
  });
  if (
    action.kind === "reply" &&
    action.pendingSelection &&
    params.storePath &&
    params.sessionKey &&
    senderId
  ) {
    const saved = await saveLinePendingModelSelection({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      ownerSenderId: senderId,
      candidates: action.pendingSelection.candidates,
      locale: action.pendingSelection.locale,
      store: params.store,
      now,
    });
    if (!saved) {
      return {
        kind: "reply",
        text:
          action.pendingSelection.locale === "th"
            ? "ไม่สามารถบันทึกตัวเลือกโมเดลได้ในตอนนี้"
            : "The model choices could not be saved right now.",
      };
    }
  }
  return action;
}

function snapshotSessionModel(entry: SessionEntry): SessionSwitchSnapshot {
  const snapshot: SessionSwitchSnapshot = {};
  for (const field of SESSION_SWITCH_FIELDS) {
    if (Object.hasOwn(entry, field)) {
      snapshot[field] = entry[field];
    }
  }
  return snapshot;
}

function restoreSessionModel(entry: SessionEntry, snapshot: SessionSwitchSnapshot): void {
  const record = entry as unknown as Record<string, unknown>;
  for (const field of SESSION_SWITCH_FIELDS) {
    if (Object.hasOwn(snapshot, field)) {
      record[field] = snapshot[field];
    } else {
      delete record[field];
    }
  }
  entry.updatedAt = Date.now();
}

function sessionUsesCandidate(
  entry: SessionEntry | undefined,
  candidate: OpenRouterCatalogCandidate,
): boolean {
  return entry?.providerOverride === OPENROUTER_PROVIDER && entry.modelOverride === candidate.id;
}

async function rollbackCandidate(params: {
  store: LineNaturalModelSessionStore;
  storePath: string;
  sessionKey: string;
  candidate: OpenRouterCatalogCandidate;
  previous: SessionSwitchSnapshot;
}): Promise<boolean> {
  const restored = await params.store.update(params.storePath, params.sessionKey, (entry) => {
    if (!sessionUsesCandidate(entry, params.candidate)) {
      return;
    }
    restoreSessionModel(entry, params.previous);
  });
  return !sessionUsesCandidate(restored, params.candidate);
}

function catalogContainsExactCandidate(
  models: OpenRouterUserModel[],
  candidate: OpenRouterCatalogCandidate,
): boolean {
  return (
    candidate.source === "openrouter-user-catalog" &&
    toOpenClawOpenRouterRef(candidate.id) === candidate.ref &&
    models.some((model) => model.id === candidate.id)
  );
}

export async function applyLineNaturalModelSwitch(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  candidate: OpenRouterCatalogCandidate;
  loadCatalog?: OpenRouterCatalogLoader;
  store?: LineNaturalModelSessionStore;
}): Promise<LineNaturalModelSwitchResult> {
  const loadCatalog = params.loadCatalog ?? loadOpenRouterUserModelCatalog;
  const store = params.store ?? defaultSessionStore;

  try {
    const preflightCatalog = await loadCatalog(params.cfg, params.agentId);
    if (!catalogContainsExactCandidate(preflightCatalog, params.candidate)) {
      return { ok: false, reason: "catalog", rolledBack: false };
    }
  } catch {
    return { ok: false, reason: "catalog", rolledBack: false };
  }

  const previousEntry = await store.read(params.storePath, params.sessionKey);
  if (!previousEntry) {
    return { ok: false, reason: "session", rolledBack: false };
  }
  const previous = snapshotSessionModel(previousEntry);

  const applied = await store.update(params.storePath, params.sessionKey, (entry) => {
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: OPENROUTER_PROVIDER, model: params.candidate.id },
      selectionSource: "user",
      preserveAuthProfileOverride: true,
      markLiveSwitchPending: true,
    });
  });
  if (!sessionUsesCandidate(applied, params.candidate)) {
    const rolledBack = await rollbackCandidate({ ...params, store, previous });
    return { ok: false, reason: "persistence", rolledBack };
  }

  const persisted = await store.read(params.storePath, params.sessionKey);
  if (!sessionUsesCandidate(persisted, params.candidate)) {
    const rolledBack = await rollbackCandidate({ ...params, store, previous });
    return { ok: false, reason: "persistence", rolledBack };
  }

  try {
    const postApplyCatalog = await loadCatalog(params.cfg, params.agentId);
    if (!catalogContainsExactCandidate(postApplyCatalog, params.candidate)) {
      const rolledBack = await rollbackCandidate({ ...params, store, previous });
      return { ok: false, reason: "provider", rolledBack };
    }
  } catch {
    const rolledBack = await rollbackCandidate({ ...params, store, previous });
    return { ok: false, reason: "provider", rolledBack };
  }

  const verified = await store.read(params.storePath, params.sessionKey);
  if (!sessionUsesCandidate(verified, params.candidate)) {
    const rolledBack = await rollbackCandidate({ ...params, store, previous });
    return { ok: false, reason: "persistence", rolledBack };
  }
  return { ok: true, activeRef: params.candidate.ref };
}
