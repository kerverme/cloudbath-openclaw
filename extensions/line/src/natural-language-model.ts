// Resolves owner-authorized natural-language LINE model controls through the existing /model path.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import {
  buildModelsProviderData,
  type ModelsProviderData,
} from "openclaw/plugin-sdk/models-provider-runtime";

const OPENROUTER_PROVIDER = "openrouter";
const MAX_CLARIFICATION_CHOICES = 5;

type CatalogLoader = (
  cfg: OpenClawConfig,
  agentId?: string,
) => Promise<ModelsProviderData>;

export type LineNaturalModelAction =
  | { kind: "none" }
  | { kind: "directive"; command: string }
  | { kind: "reply"; text: string };

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

type OpenRouterModelCandidate = {
  id: string;
  name: string;
  ref: string;
  supportsTools?: boolean;
  score: number;
};

function hasThaiText(value: string): boolean {
  return /[\u0e00-\u0e7f]/u.test(value);
}

function stripTrailingPoliteness(value: string): string {
  return value
    .replace(/\s+(?:หน่อย|ที|ครับ|ค่ะ|คะ|นะ|please)\s*[.!?]*$/iu, "")
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

  const thaiConfirmation = trimmed.match(
    /^ยืนยัน(?:ใช้|เปลี่ยนเป็น)?\s+(.+)$/iu,
  );
  const englishConfirmation = trimmed.match(
    /^confirm\s+(?:use|switch\s+to)\s+(.+)$/iu,
  );
  const thai = trimmed.match(
    /^(?:เปลี่ยน(?:กลับ)?เป็น|เปลี่ยนไป(?:ใช้)?|กลับไป(?:ใช้)?|ใช้|ลอง)\s*(.+)$/iu,
  );
  const english = trimmed.match(
    /^(?:switch(?:\s+back)?\s+to|use|try)\s+(.+)$/iu,
  );
  const rawQuery =
    thaiConfirmation?.[1] ?? englishConfirmation?.[1] ?? thai?.[1] ?? english?.[1];
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
  data: ModelsProviderData,
  intent: SwitchIntent,
): OpenRouterModelCandidate[] {
  const ids = [...(data.byProvider.get(OPENROUTER_PROVIDER) ?? [])];
  return ids
    .map((id) => {
      const ref = `${OPENROUTER_PROVIDER}/${id}`;
      const name = data.modelNames.get(ref) ?? id;
      return {
        id,
        name,
        ref,
        supportsTools: data.modelCapabilities?.get(ref)?.supportsTools,
        score: scoreCandidate({
          id,
          name,
          query: intent.query,
          preferBase: intent.preferBase,
        }),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function resolveUniqueCandidate(
  candidates: OpenRouterModelCandidate[],
): OpenRouterModelCandidate | undefined {
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

function formatAmbiguous(
  intent: SwitchIntent,
  candidates: OpenRouterModelCandidate[],
): string {
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
  candidate: OpenRouterModelCandidate,
): string {
  return intent.locale === "th"
    ? `โมเดลนี้คุยได้ แต่ข้อมูล catalog ระบุว่าไม่รองรับ tools เช่น Notion พิมพ์ “ยืนยันใช้ ${candidate.name}” หากต้องการเปลี่ยนต่อ`
    : `This model can chat, but catalog metadata says it does not support tools such as Notion. Say “confirm use ${candidate.name}” to continue.`;
}

export async function resolveLineNaturalLanguageModelAction(params: {
  text: string;
  cfg: OpenClawConfig;
  agentId?: string;
  ownerAuthorized: boolean;
  loadCatalog?: CatalogLoader;
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

  let data: ModelsProviderData;
  try {
    data = await (params.loadCatalog ?? buildModelsProviderData)(params.cfg, params.agentId);
  } catch {
    return {
      kind: "reply",
      text:
        intent.locale === "th"
          ? "ไม่สามารถโหลดรายการโมเดลได้ในตอนนี้"
          : "The model catalog is unavailable right now.",
    };
  }

  const candidates = listOpenRouterCandidates(data, intent);
  if (candidates.length === 0) {
    return { kind: "reply", text: formatNoMatch(intent) };
  }
  const selected = resolveUniqueCandidate(candidates);
  if (!selected) {
    return { kind: "reply", text: formatAmbiguous(intent, candidates) };
  }
  if (selected.supportsTools === false && !intent.confirmed) {
    return { kind: "reply", text: formatCapabilityWarning(intent, selected) };
  }
  return { kind: "directive", command: `/model ${selected.ref}` };
}

export async function resolveAuthorizedLineNaturalModelAction(params: {
  text: string;
  cfg: OpenClawConfig;
  agentId?: string;
  ctx: Parameters<typeof resolveCommandAuthorization>[0]["ctx"];
  commandAuthorized: boolean;
  loadCatalog?: CatalogLoader;
}): Promise<LineNaturalModelAction> {
  const authorization = resolveCommandAuthorization({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.commandAuthorized,
  });
  return resolveLineNaturalLanguageModelAction({
    text: params.text,
    cfg: params.cfg,
    agentId: params.agentId,
    ownerAuthorized: authorization.senderIsOwner && authorization.isAuthorizedSender,
    loadCatalog: params.loadCatalog,
  });
}
