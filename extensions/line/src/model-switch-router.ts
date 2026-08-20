import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
/**
 * Deterministic LINE model-switch intent router.
 *
 * Registered on the shared `before_dispatch` hook so an owner's natural-language
 * model-control request ("เปลี่ยนเป็น gemini หน่อย", "switch to Claude") is routed
 * to the existing catalog-validated picker (`model-catalog-tool.ts`) before the
 * normal main agent ever runs — instead of depending on the active LLM deciding
 * to call the AI-facing picker tool. Ordinary model discussion ("Gemini ดีไหม",
 * "Claude กับ Gemini ต่างกันยังไง") never matches the deterministic classifier
 * below and falls through to the normal agent unchanged.
 *
 * This module does not implement a second picker: it builds and calls the same
 * `createLineModelCatalogTool` used by the AI-facing tool, so catalog search,
 * exact-match switching, numbered pending choices, TTL, fresh catalog
 * revalidation, and session/owner isolation are identical on both paths.
 */
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createLineModelCatalogTool,
  createLineSessionModelApplier,
  type LinePendingModelSelection,
} from "./model-catalog-tool.js";

/** Minimal structural shape of the shared `before_dispatch` hook event this router reads. */
type LineBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

/** Minimal structural shape of the shared `before_dispatch` hook context this router reads. */
type LineBeforeDispatchContext = {
  sessionKey?: string;
  agentId?: string;
};

/** Minimal structural shape of the shared `before_dispatch` hook result this router returns. */
type LineBeforeDispatchResult = {
  handled: boolean;
  text?: string;
};

export type LineModelControlIntent =
  | { kind: "switch"; query: string; explicit: boolean }
  | { kind: "numeric"; selection: number }
  | { kind: "none" };

// Leading verb phrases that mark a tentative switch request. Longest-first so
// "เปลี่ยนเป็น" is matched whole instead of leaving a stray "เป็น" behind after
// the shorter "เปลี่ยน" prefix consumes part of it.
const THAI_SWITCH_PREFIXES = ["เปลี่ยนเป็น", "เปลี่ยน", "ลองใช้", "ลอง", "ใช้"].toSorted(
  (a, b) => b.length - a.length,
);
const ENGLISH_SWITCH_PREFIXES = ["switch to", "change to"].toSorted((a, b) => b.length - a.length);
// "เปลี่ยนเป็น"/"switch to"/"change to" are unambiguous "become X" constructions
// with low false-positive risk on their own (see explicit-vs-tentative below).
// The bare verbs "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้" are extremely common Thai words
// used constantly outside any model-control context ("ลองคิดดูหน่อย" = "try to
// think about it", "ใช้เวลานานไหม" = "does it take long") — NOT in this set.
const STRONG_THAI_SWITCH_PREFIXES = new Set(["เปลี่ยนเป็น"]);
// Connector words between the verb and the model term ("เปลี่ยน model เป็น GPT").
const LEADING_CONNECTOR_WORDS = ["model", "โมเดล", "เป็น"];
// A connector that is itself the word "model"/"โมเดล" is explicit switch intent
// even behind a bare/tentative verb ("เปลี่ยน model เป็น claude").
const MODEL_CONNECTOR_WORDS = new Set(["model", "โมเดล"]);
// Thai softeners/fillers the user tacks on around the model term.
const TRAILING_FILLER_PHRASES = ["ให้หน่อย", "ตัวใหม่", "ให้ที", "ดูหน่อย", "หน่อย", "เลย"].toSorted(
  (a, b) => b.length - a.length,
);
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
  const lower = text.toLowerCase();
  for (const prefix of ENGLISH_SWITCH_PREFIXES) {
    if (lower.startsWith(prefix)) {
      // "switch to"/"change to" are as unambiguous in English as "เปลี่ยนเป็น" is in Thai.
      return { remainder: text.slice(prefix.length), strong: true };
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
  let remainder = text.trim();
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
  const query = stripTrailingFillers(afterConnectors);
  return query.length > 0 ? { query, explicit: prefixMatch.strong || sawModelWord } : null;
}

/**
 * Deterministically classifies a LINE message as a (tentative or explicit)
 * model-switch request, a numeric picker reply, or ordinary chat. Only
 * messages that START with a recognized switch verb count as a switch
 * request, so comparisons and questions that merely mention a model name
 * ("Gemini ดีไหม", "Grok เก่งกว่า Claude ไหม") never match and continue to the
 * normal agent unchanged.
 *
 * The leading verb alone is not proof of intent: "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้"
 * are ordinary Thai words used constantly outside any model context, so a
 * match through one of those bare verbs is only `explicit: false` — tentative
 * — and the caller must corroborate it against the live catalog before
 * claiming the message (see createLineModelSwitchIntentRouter). Only the
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

async function resolveLineOpenRouterApiKey(providerId: string): Promise<string | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg: getRuntimeConfig(),
    agentDir: resolveOpenClawAgentDir(),
  });
  return auth.apiKey;
}

type FetchLike = typeof fetch;

/**
 * Builds the `before_dispatch` handler that deterministically routes owner
 * model-switch intents to the validated LINE catalog picker before the normal
 * agent runs. Shares the same pending-selection store as the AI-facing tool so
 * a numbered choice created by either path resolves the same way.
 *
 * `resolveApiKey`, `applySessionModel`, `fetchImpl`, and `now` default to the
 * live plugin-sdk/session-store implementations; tests inject fakes here
 * instead of reaching into module internals.
 */
export function createLineModelSwitchIntentRouter(params: {
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  resolveApiKey?: (providerId: string) => Promise<string | undefined>;
  buildSessionModelApplier?: typeof createLineSessionModelApplier;
  fetchImpl?: FetchLike;
  now?: () => number;
}) {
  const resolveApiKey = params.resolveApiKey ?? resolveLineOpenRouterApiKey;
  const buildSessionModelApplier = params.buildSessionModelApplier ?? createLineSessionModelApplier;
  return async (
    event: LineBeforeDispatchEvent,
    ctx: LineBeforeDispatchContext,
  ): Promise<LineBeforeDispatchResult | undefined> => {
    if (event.channel !== "line") {
      return undefined;
    }
    // Owner-only privileged control: any other sender's message — including
    // one that reads like a switch request — falls straight through to
    // ordinary agent chat, matching the AI-facing picker's own owner gate.
    if (event.senderIsOwner !== true) {
      return undefined;
    }

    const intent = classifyLineModelControlIntent(event.body ?? event.content ?? "");
    if (intent.kind === "none") {
      return undefined;
    }

    const sessionKey = (ctx.sessionKey ?? event.sessionKey)?.trim();
    const requesterSenderId = event.senderId?.trim();
    if (!sessionKey || !requesterSenderId) {
      return undefined;
    }

    const tool = createLineModelCatalogTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId,
      sessionId: sessionKey,
      pendingStore: params.pendingStore,
      resolveApiKey,
      applySessionModel: buildSessionModelApplier({ agentId: ctx.agentId, sessionKey }),
      fetchImpl: params.fetchImpl,
      now: params.now,
    });
    if (!tool) {
      return undefined;
    }

    const input =
      intent.kind === "numeric"
        ? { action: "select" as const, selection: intent.selection }
        : { action: "search" as const, query: intent.query };

    let toolResult: { details?: unknown };
    try {
      toolResult = await tool.execute("line-model-switch-router", input);
    } catch {
      // Catalog/auth failures fail safe: fall through to ordinary chat rather
      // than surfacing a raw error outside the normal agent reply contract.
      return undefined;
    }

    const details = (toolResult.details ?? {}) as Record<string, unknown>;
    if (intent.kind === "numeric" && details.resolution === "no_pending") {
      // No active pending selection for this session+owner: treat the bare
      // number as ordinary chat instead of a picker reply.
      return undefined;
    }
    if (intent.kind === "switch" && !intent.explicit && details.resolution === "no_match") {
      // A tentative match (bare "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้", no "model"/"โมเดล"
      // wording) found zero credible evidence in the live catalog that the
      // extracted text names a real model — e.g. "ลองคิดดูหน่อย" ("try to think
      // about it") vs "ลอง gemini". Fall through to ordinary chat instead of
      // hijacking the message with an irrelevant "model not found" reply.
      // Explicit wording ("เปลี่ยนเป็น X", "เปลี่ยน model เป็น X") still reports
      // no_match normally, since the user unambiguously asked to switch.
      return undefined;
    }

    return { handled: true, text: formatLineModelCatalogReply(details, intent) };
  };
}
