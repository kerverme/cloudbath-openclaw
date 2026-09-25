import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
/**
 * Deterministic model-switch wording and the numbered-picker action.
 *
 * `classifyLineModelControlIntent` reads an owner's switch request
 * ("เปลี่ยนเป็น gemini หน่อย", "เอา Luna", "switch to Claude") or a numbered
 * picker reply out of the literal text; model-control-router.ts resolves it
 * against the catalog and answers before the main agent ever runs. Ordinary
 * model discussion ("Gemini ดีไหม", "Claude กับ Gemini ต่างกันยังไง") never
 * matches and falls through to the normal agent unchanged.
 *
 * Numbered replies run through the same `createLineModelCatalogTool` the
 * AI-facing picker uses, so pending choices, TTL, fresh catalog revalidation
 * and session/owner isolation are identical on both paths.
 */
import {
  createLineModelCatalogTool,
  createLineSessionModelApplier,
  type LinePendingModelSelection,
} from "./model-catalog-tool.js";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";

export type LineModelControlIntent =
  | { kind: "switch"; query: string; explicit: boolean }
  | { kind: "numeric"; selection: number }
  | { kind: "none" };

// Leading verb phrases that mark a tentative switch request. Longest-first so
// "เปลี่ยนเป็น" is matched whole instead of leaving a stray "เป็น" behind after
// the shorter "เปลี่ยน" prefix consumes part of it ("เอาตัว" before "เอา").
const THAI_SWITCH_PREFIXES = ["เปลี่ยนเป็น", "เปลี่ยน", "ลองใช้", "ลอง", "ใช้", "เอาตัว", "เอา"].toSorted(
  (a, b) => b.length - a.length,
);
// English verbs are whole words: "user profile" must not read as "use r profile".
const ENGLISH_SWITCH_PREFIXES: ReadonlyArray<{ pattern: RegExp; strong: boolean }> = [
  { pattern: /^(?:switch|change)\s+to\s+/iu, strong: true },
  { pattern: /^use\s+/iu, strong: false },
];
// "เปลี่ยนเป็น"/"switch to"/"change to" are unambiguous "become X" constructions
// with low false-positive risk on their own (see explicit-vs-tentative below).
// The bare verbs "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้"/"เอา"/"use" are extremely common
// words used constantly outside any model-control context ("ลองคิดดูหน่อย" =
// "try to think about it", "เอาไว้ก่อน" = "leave it for now") — NOT in this set.
const STRONG_THAI_SWITCH_PREFIXES = new Set(["เปลี่ยนเป็น"]);
// Connector words between the verb and the model term ("เปลี่ยน model เป็น GPT").
const LEADING_CONNECTOR_WORDS = ["model", "โมเดล", "เป็น"];
// A connector that is itself the word "model"/"โมเดล" is explicit switch intent
// even behind a bare/tentative verb ("เปลี่ยน model เป็น claude").
const MODEL_CONNECTOR_WORDS = new Set(["model", "โมเดล"]);
// Thai softeners/fillers the user tacks on around the model term.
const TRAILING_FILLER_PHRASES = [
  "ให้หน่อย",
  "ตัวใหม่",
  "ให้ที",
  "ดูหน่อย",
  "หน่อย",
  "เลย",
  "ครับ",
  "ค่ะ",
  "คะ",
  "นะ",
  "จ้า",
  "จ้ะ",
].toSorted((a, b) => b.length - a.length);
// "เปลี่ยนเป็น X ได้ไหม" is the polite form of the command, not a question
// about X. Only an explicit switch sheds it; after a bare verb ("ใช้ X ได้ไหม")
// it stays, and the router leaves that question alone.
const POLITE_REQUEST_TAILS = ["ได้ไหม", "ได้มั้ย", "ได้มั๊ย", "ได้ป่ะ", "ได้ปะ", "ได้หรือเปล่า"];
const NUMERIC_SELECTION_PATTERN = /^\d+$/u;
const MAX_CLASSIFIER_STRIP_ITERATIONS = 4;

type PrefixMatch = { remainder: string; strong: boolean };

function matchLeadingSwitchPrefix(text: string): PrefixMatch | null {
  // Thai has no case; English is matched case-insensitively.
  for (const prefix of THAI_SWITCH_PREFIXES) {
    if (text.startsWith(prefix)) {
      return {
        remainder: text.slice(prefix.length),
        strong: STRONG_THAI_SWITCH_PREFIXES.has(prefix),
      };
    }
  }
  for (const { pattern, strong } of ENGLISH_SWITCH_PREFIXES) {
    const match = pattern.exec(text);
    if (match) {
      // "switch to"/"change to" are as unambiguous in English as "เปลี่ยนเป็น" is in Thai.
      return { remainder: text.slice(match[0].length), strong };
    }
  }
  return null;
}

function stripLeadingConnectors(text: string): { remainder: string; sawModelWord: boolean } {
  let remainder = text.trim();
  let sawModelWord = false;
  for (let guard = 0; guard < MAX_CLASSIFIER_STRIP_ITERATIONS; guard += 1) {
    const before = remainder;
    for (const word of LEADING_CONNECTOR_WORDS) {
      if (remainder.toLowerCase().startsWith(word.toLowerCase())) {
        if (MODEL_CONNECTOR_WORDS.has(word.toLowerCase())) {
          sawModelWord = true;
        }
        remainder = remainder.slice(word.length).trim();
      }
    }
    if (remainder === before) {
      break;
    }
  }
  return { remainder, sawModelWord };
}

function stripTrailingFillers(text: string): string {
  let remainder = text
    .trim()
    .replace(/[.!]+$/u, "")
    .trim();
  for (let guard = 0; guard < MAX_CLASSIFIER_STRIP_ITERATIONS; guard += 1) {
    const before = remainder;
    for (const filler of TRAILING_FILLER_PHRASES) {
      if (remainder.endsWith(filler)) {
        remainder = remainder.slice(0, remainder.length - filler.length).trim();
      }
    }
    if (remainder === before) {
      break;
    }
  }
  return remainder;
}

/**
 * Extracts the user's literal switch-target wording, stripped of the leading
 * verb/connector and trailing filler words, plus whether the wording itself
 * was explicit enough to trust without catalog corroboration. Never maps the
 * extracted text to a model ID — that resolution is entirely the existing
 * catalog picker's job.
 */
function extractSwitchQuery(rawText: string): { query: string; explicit: boolean } | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }
  const prefixMatch = matchLeadingSwitchPrefix(trimmed);
  if (!prefixMatch) {
    return null;
  }
  const { remainder: afterConnectors, sawModelWord } = stripLeadingConnectors(
    prefixMatch.remainder,
  );
  const explicit = prefixMatch.strong || sawModelWord;
  const filled = stripTrailingFillers(afterConnectors);
  const tail = explicit
    ? POLITE_REQUEST_TAILS.find((phrase) => filled.endsWith(phrase))
    : undefined;
  const query = tail ? stripTrailingFillers(filled.slice(0, -tail.length)) : filled;
  return query.length > 0 ? { query, explicit } : null;
}

/**
 * Deterministically classifies a LINE message as a (tentative or explicit)
 * model-switch request, a numeric picker reply, or ordinary chat. Only
 * messages that START with a recognized switch verb count as a switch
 * request, so comparisons and questions that merely mention a model name
 * ("Gemini ดีไหม", "Grok เก่งกว่า Claude ไหม") never match and continue to the
 * normal agent unchanged.
 *
 * The leading verb alone is not proof of intent: "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้"/
 * "เอา"/"use" are ordinary words used constantly outside any model context, so
 * a match through one of those bare verbs is only `explicit: false` —
 * tentative — and the caller must corroborate it against the live catalog
 * before claiming the message (see model-control-router.ts). Only the
 * unambiguous "เปลี่ยนเป็น"/"switch to"/"change to" constructions, or wording
 * that explicitly names "model"/"โมเดล", are trusted as `explicit: true`.
 */
export function classifyLineModelControlIntent(rawText: string): LineModelControlIntent {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { kind: "none" };
  }
  if (NUMERIC_SELECTION_PATTERN.test(trimmed)) {
    const selection = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(selection) && selection >= 1
      ? { kind: "numeric", selection }
      : { kind: "none" };
  }
  const extracted = extractSwitchQuery(trimmed);
  return extracted
    ? { kind: "switch", query: extracted.query, explicit: extracted.explicit }
    : { kind: "none" };
}

function formatModelChoiceLines(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter(
      (entry): entry is { selection: number; name: string } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as { selection?: unknown }).selection === "number" &&
        typeof (entry as { name?: unknown }).name === "string",
    )
    .map((entry) => `${entry.selection}. ${entry.name}`)
    .join("\n");
}

/** Builds the natural-language LINE reply for one catalog-tool action result. */
export function formatLineModelCatalogReply(
  details: Record<string, unknown>,
  intent: LineModelControlIntent,
): string {
  const resolution = typeof details.resolution === "string" ? details.resolution : undefined;
  const detailsQuery = typeof details.query === "string" ? details.query : undefined;
  const query = detailsQuery || (intent.kind === "switch" ? intent.query : undefined);

  switch (resolution) {
    case "switched": {
      const directModel = details.model as { name?: unknown } | undefined;
      const listedModel = Array.isArray(details.models)
        ? (details.models[0] as { name?: unknown } | undefined)
        : undefined;
      const name = directModel?.name ?? listedModel?.name;
      return typeof name === "string" && name ? `เปลี่ยนเป็น ${name} แล้ว` : "เปลี่ยนโมเดลแล้ว";
    }
    case "choices":
    case "choices_unavailable":
    case "refine_query": {
      const lines = formatModelChoiceLines(details.models);
      const label = query ? `เจอ ${query} หลายรุ่น` : "เจอโมเดลหลายรุ่น";
      return lines ? `${label}:\n${lines}\nต้องการใช้รุ่นไหน?` : `${label} แต่แสดงตัวเลือกไม่ได้ตอนนี้`;
    }
    case "clarification_required": {
      const first = Array.isArray(details.models)
        ? (details.models[0] as { name?: unknown } | undefined)
        : undefined;
      const name = typeof first?.name === "string" ? first.name : undefined;
      return name
        ? `เจอโมเดลที่ใกล้เคียงคือ "${name}" ต้องการใช้รุ่นนี้ไหม? พิมพ์ชื่อให้ตรงมากขึ้นเพื่อยืนยัน`
        : "เจอโมเดลที่ใกล้เคียงแต่ไม่ชัดเจน กรุณาพิมพ์ชื่อรุ่นให้ตรงมากขึ้น";
    }
    case "no_match":
      return query
        ? `ไม่เจอโมเดลที่ตรงกับ "${query}" ในบัญชี OpenRouter ลองพิมพ์ชื่อรุ่นให้ชัดขึ้นได้ไหม?`
        : "ไม่เจอโมเดลที่ตรงกันในบัญชี OpenRouter";
    case "invalid_selection":
    case "invalid_page": {
      const lines = formatModelChoiceLines(details.models);
      return lines
        ? `หมายเลขนี้ไม่อยู่ในตัวเลือก:\n${lines}\nต้องการใช้รุ่นไหน?`
        : "หมายเลขนี้ไม่อยู่ในตัวเลือกที่แสดงไว้";
    }
    case "stale_selection":
      return "ตัวเลือกที่เลือกไม่มีในบัญชีแล้ว กรุณาค้นหาใหม่อีกครั้ง";
    case "switch_failed":
      return "เปลี่ยนโมเดลไม่สำเร็จ ลองใหม่อีกครั้งได้ไหม?";
    default:
      return "ขอโทษค่ะ ดำเนินการคำขอเปลี่ยนโมเดลไม่สำเร็จ ลองใหม่อีกครั้งได้ไหม?";
  }
}

type FetchLike = typeof fetch;

/**
 * `resolveApiKey`, `applySessionModel`, `fetchImpl`, and `now` default to the
 * live plugin-sdk/session-store implementations; tests inject fakes here
 * instead of reaching into module internals.
 */
export type LineModelSwitchDeps = {
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  resolveApiKey?: (providerId: string) => Promise<string | undefined>;
  buildSessionModelApplier?: typeof createLineSessionModelApplier;
  fetchImpl?: FetchLike;
  now?: () => number;
};

/**
 * Resolves a numbered reply against the owner's pending listing through the
 * same `createLineModelCatalogTool` the AI-facing picker uses, so it gets the
 * fresh account catalog and the shared session applier. Undefined when the
 * action could not run (no tool, catalog or auth failure).
 */
export async function runLineModelCatalogAction(
  deps: LineModelSwitchDeps,
  target: { sessionKey: string; agentId?: string; senderId: string; config?: OpenClawConfig },
  input: { action: "select"; selection: number },
): Promise<Record<string, unknown> | undefined> {
  const tool = createLineModelCatalogTool({
    // The tool's own gate guards its AI-facing registration; this caller has
    // already admitted the turn through resolveModelControlTurn, on any surface.
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: target.senderId,
    sessionId: target.sessionKey,
    pendingStore: deps.pendingStore,
    resolveApiKey: deps.resolveApiKey ?? resolveLineProviderApiKey,
    applySessionModel: (deps.buildSessionModelApplier ?? createLineSessionModelApplier)({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      config: target.config,
    }),
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  if (!tool) {
    return undefined;
  }
  try {
    const result = await tool.execute("line-model-switch-router", input);
    return (result.details ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
