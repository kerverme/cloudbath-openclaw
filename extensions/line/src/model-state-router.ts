/**
 * Deterministic answers to an owner's questions about the LINE model state.
 *
 * "ตอนนี้ใช้โมเดลอะไร", "มี GPT-6 Luna ไหม", "GPT-5.6 Luna มาจากค่ายไหน" and
 * "มีโมเดล OpenAI อะไรบ้าง" are questions about THIS deployment. Only the
 * session's canonical model selection, the account's OpenRouter catalog and
 * the configured aliases know the answers. Left to the agent, they were
 * answered from model memory or web_search, and a model that is not in the
 * catalog was described as available. This handler answers them before the
 * agent runs and never switches anything; switching stays with
 * model-switch-router.ts.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSessionModelRef } from "openclaw/plugin-sdk/model-session-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  listCatalogFamily,
  lookupCatalogModel,
  modelFamilyWords,
  modelVendor,
  namesKnownModelWord,
  normalizeCatalogText,
  readLineModelAliases,
  type LineCatalogLookup,
  type LineModelAlias,
} from "./model-catalog-lookup.js";
import { loadOpenRouterAccountModels, type OpenRouterAccountModel } from "./model-catalog-tool.js";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";

type LineBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderIsOwner?: boolean;
};

type LineBeforeDispatchContext = {
  sessionKey?: string;
  agentId?: string;
};

export type LineModelStateQuestion =
  | { kind: "current" }
  | { kind: "exists" | "provider" | "list"; targets: string[] };

export type LineModelStateClassification = {
  question: LineModelStateQuestion;
  /** The wording itself is about models ("model", "โมเดล", "provider"). */
  explicit: boolean;
};

const MAX_TARGETS = 3;
const MAX_LISTED_MODELS = 10;
// A model-state question is short. A longer message that also mentions the
// model ("write this email -- and which model are you on?") carries another
// request that claiming the turn would drop, so it stays with the agent.
const MAX_QUESTION_CHARS = 80;
// Vendor/family words of the last catalog read. Only decides whether an
// unmarked question ("มี Foo ไหม") is about models at all; answers always
// re-read the catalog.
const CATALOG_WORDS_TTL_MS = 10 * 60 * 1000;
// A read made only to recognize an unmarked question must not stall ordinary
// chat while OpenRouter is slow or down: it is short, and after a failure such
// turns skip the read for a while and go to the agent as before.
const RECOGNITION_READ_TIMEOUT_MS = 3_000;
const RECOGNITION_RETRY_MS = 60_000;

const THAI_SCRIPT = /\p{Script=Thai}/u;
const MODEL_WORD = /\b(?:models?|llms?)\b|โมเดล/iu;
const PROVIDER_WORD = /\bproviders?\b|ผู้ให้บริการ/iu;
// Video, image and character models belong to other LINE and Cloudbath flows.
const OTHER_DOMAIN =
  /วิดีโอ|วีดีโอ|คลิป|ภาพ|ตัวละคร|สตอรี่บอร์ด|\b(?:videos?|images?|pictures?|photos?|characters?|storyboards?)\b/iu;
// Which model to USE is a request for advice, not a question about state.
const ADVICE = /อะไรดี|ไหนดี|ดีกว่า|ดีไหม|ดีมั้ย|แนะนำ|ควร|เหมาะ|\b(?:should|recommend|better|best)\b/iu;
// Switch commands and picker numbers stay with model-switch-router.ts.
const SWITCH_COMMAND = /^(?:เปลี่ยนเป็น|switch\s+to\b|change\s+to\b|\d+$)/iu;

const THAI_QUESTION = /ไหม|มั้ย|มั๊ย|ป่ะ|ปะ|เปล่า|หรือไม่|รึยัง|หรือยัง/u;
const THAI_LIST = /อะไรบ้าง|ไหนบ้าง|กี่รุ่น|กี่ตัว|ทั้งหมด/u;
const THAI_PROVIDER =
  /ผู้ให้บริการ|ค่ายไหน|ค่ายอะไร|ของค่าย|ของใคร|บริษัทไหน|บริษัทอะไร|มาจากไหน|มาจากค่าย|ใครทำ|ใครพัฒนา|ผ่านอะไร|ผ่านไหน|\bproviders?\b/iu;
const THAI_NOW = /ใช้|อยู่|ตอนนี้|ปัจจุบัน/u;
const ROUTING = /อัตโนมัติ|เลือกเอง|\b(?:auto|routing|fallback|manual)\b/iu;

// Model names are written in Latin script inside Thai sentences.
const LATIN_RUN = /[A-Za-z0-9][\w.:/+-]*(?:\s+[A-Za-z0-9][\w.:/+-]*)*/gu;
const EDGE_WORDS =
  /^(?:(?:the|an?|this|that|models?|llms?|providers?)\s+)+|(?:\s+(?:models?|llms?|providers?))+$/giu;
const NOT_A_TARGET = /^(?:models?|llms?|providers?|ai|this|that|it|one)$/iu;

const ENGLISH_CURRENT = [
  /^(?:what|which)(?:'s|\s+is)?\s+(?:the\s+|your\s+|my\s+)?(?:current(?:ly)?\s+)?(?:selected\s+|active\s+)?(?:ai\s+)?model(?:\s+(?:are|am|is|do)\s+(?:you|i|we)\s+(?:using|on|running|use))?(?:\s+(?:now|right\s+now|currently))?$/iu,
  /\bcurrent(?:ly)?\s+(?:selected\s+|active\s+)?model\b/iu,
  /\b(?:auto(?:matic)?|manual)\s+(?:model\s+)?(?:selection|routing)\b/iu,
];
const ENGLISH_EXISTS = [
  /^(?:is|are)\s+(?:there\s+)?(?:an?\s+)?(?<t>.+?)\s+(?:available|supported|there|in\s+(?:the|your|my)\s+catalog)$/iu,
  /^(?:do|does)\s+(?:you|we|it|this\s+account|openrouter|the\s+catalog)\s+(?:have|support|offer|include)\s+(?<t>.+)$/iu,
  /^is\s+there\s+(?:an?\s+)?(?<t>.+)$/iu,
  /^can\s+(?:i|we|you)\s+use\s+(?<t>.+)$/iu,
];
const ENGLISH_PROVIDER = [
  /^(?:which|what|who)(?:'s|\s+is)?\s+(?:the\s+)?providers?\s+(?:for|of|behind)\s+(?<t>.+)$/iu,
  /^(?:which|what)\s+providers?\s+(?:supplies|serves|provides|hosts|runs)\s+(?<t>.+)$/iu,
  /^(?:which|what)\s+providers?\s+(?:does|is)\s+(?<t>.+?)(?:\s+(?:use|using|from|on))?$/iu,
  /^who\s+(?:provides|supplies|serves|hosts|makes|runs)\s+(?<t>.+)$/iu,
];
const ENGLISH_LIST = [
  /^(?:list|show)(?:\s+(?:me|all|the))*\s+(?:(?<t>.+?)\s+)?models$/iu,
  /^(?:which|what)\s+(?:(?<t>.+?)\s+)?models\s+(?:are|do|does|can|have|you)\b/iu,
];

function cleanTarget(raw: string): string | undefined {
  const target = raw
    .replace(EDGE_WORDS, "")
    .replace(/[.:,;]+$/u, "")
    .trim();
  return target && !NOT_A_TARGET.test(target) ? target : undefined;
}

function latinTargets(text: string): string[] {
  return [...text.matchAll(LATIN_RUN)]
    .flatMap((match) => cleanTarget(match[0]) ?? [])
    .slice(0, MAX_TARGETS);
}

function classifyThai(text: string): LineModelStateClassification | undefined {
  const targets = latinTargets(text);
  const explicit = MODEL_WORD.test(text);
  if (THAI_PROVIDER.test(text)) {
    const aboutModels = explicit || PROVIDER_WORD.test(text);
    return aboutModels || targets.length > 0
      ? { question: { kind: "provider", targets }, explicit: aboutModels }
      : undefined;
  }
  if (THAI_LIST.test(text) && (explicit || targets.length > 0)) {
    return { question: { kind: "list", targets }, explicit };
  }
  if (text.includes("มี") && THAI_QUESTION.test(text) && targets.length > 0) {
    return { question: { kind: "exists", targets }, explicit };
  }
  const asksWhich = /อะไร|ไหน/u.test(text) && THAI_NOW.test(text);
  if (explicit && targets.length === 0 && (asksWhich || ROUTING.test(text))) {
    return { question: { kind: "current" }, explicit };
  }
  return undefined;
}

function matchTarget(patterns: readonly RegExp[], text: string): string[] | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const target = match.groups?.t ? cleanTarget(match.groups.t) : undefined;
      return target ? [target] : [];
    }
  }
  return undefined;
}

function classifyEnglish(rawText: string): LineModelStateClassification | undefined {
  const text = rawText.replace(/[\s?!.]+$/u, "").replace(/\s+please$/iu, "");
  const explicit = MODEL_WORD.test(text);
  if (ENGLISH_CURRENT.some((pattern) => pattern.test(text))) {
    return { question: { kind: "current" }, explicit: true };
  }
  const provider = matchTarget(ENGLISH_PROVIDER, text);
  if (provider) {
    return { question: { kind: "provider", targets: provider }, explicit: true };
  }
  const list = matchTarget(ENGLISH_LIST, text);
  if (list) {
    return { question: { kind: "list", targets: list }, explicit: true };
  }
  const exists = matchTarget(ENGLISH_EXISTS, text);
  return exists && exists.length > 0
    ? { question: { kind: "exists", targets: exists }, explicit }
    : undefined;
}

/**
 * Deterministically classifies a LINE message as a question about the model
 * state. Never maps wording to a model: the targets are the owner's literal
 * text, resolved only against the catalog and configured aliases.
 */
export function classifyLineModelStateQuestion(
  rawText: string,
): LineModelStateClassification | undefined {
  const text = rawText.trim();
  if (
    !text ||
    text.length > MAX_QUESTION_CHARS ||
    SWITCH_COMMAND.test(text) ||
    OTHER_DOMAIN.test(text) ||
    ADVICE.test(text)
  ) {
    return undefined;
  }
  return THAI_SCRIPT.test(text) ? classifyThai(text) : classifyEnglish(text);
}

type SelectedModel = { provider: string; model: string };

function label(model: OpenRouterAccountModel): string {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}

function bulletList(models: readonly OpenRouterAccountModel[]): string {
  const shown = models.slice(0, MAX_LISTED_MODELS).map((model) => `• ${label(model)}`);
  return shown.join("\n");
}

function vendorOf(selected: SelectedModel): string | undefined {
  return selected.provider === "openrouter" ? modelVendor(selected.model) : undefined;
}

type SelectionState = {
  source: "manual" | "auto" | "default";
  fallbackFrom?: string;
  pending: boolean;
  locked: boolean;
  lastRun?: string;
};

function readSelectionState(
  selected: SelectedModel,
  entry: SessionEntry | undefined,
): SelectionState {
  // Same condition resolveSessionModelRef treats as a session selection.
  const hasOverride = Boolean(entry?.modelOverride?.trim());
  const origin =
    entry?.modelOverrideFallbackOriginProvider && entry.modelOverrideFallbackOriginModel
      ? `${entry.modelOverrideFallbackOriginProvider}/${entry.modelOverrideFallbackOriginModel}`
      : undefined;
  const lastRun =
    entry?.modelProvider && entry.model ? `${entry.modelProvider}/${entry.model}` : undefined;
  return {
    source: !hasOverride ? "default" : entry?.modelOverrideSource === "auto" ? "auto" : "manual",
    ...(origin ? { fallbackFrom: origin } : {}),
    pending: entry?.liveModelSwitchPending === true,
    locked: entry?.modelSelectionLocked === true,
    ...(lastRun && lastRun !== `${selected.provider}/${selected.model}` ? { lastRun } : {}),
  };
}

type Replies = {
  current(selected: SelectedModel, state: SelectionState): string;
  currentProvider(selected: SelectedModel): string;
  available(lookup: LineCatalogLookup): string;
  provider(lookup: LineCatalogLookup): string;
  notAvailable(target: string, lookup: LineCatalogLookup): string;
  family(target: string, models: readonly OpenRouterAccountModel[]): string;
  summary(models: readonly OpenRouterAccountModel[]): string;
  catalogUnavailable(): string;
};

function vendorCounts(models: readonly OpenRouterAccountModel[]): string {
  const counts = new Map<string, number>();
  for (const model of models) {
    const vendor = modelVendor(model.id) ?? model.id;
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(
      ([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName),
    )
    .slice(0, MAX_LISTED_MODELS)
    .map(([vendor, count]) => `• ${vendor} (${count})`)
    .join("\n");
}

function aliasNote(alias: LineModelAlias | undefined, thai: boolean): string {
  if (!alias) {
    return "";
  }
  return thai
    ? `\n("${alias.alias}" คือชื่อเรียกที่ตั้งไว้ของ ${alias.provider}/${alias.model})`
    : `\n("${alias.alias}" is the configured alias for ${alias.provider}/${alias.model})`;
}

const THAI_REPLIES: Replies = {
  current: (selected, state) =>
    [
      `ตอนนี้ใช้โมเดล ${selected.model} ผ่าน ${selected.provider}`,
      state.source === "manual"
        ? "การเลือก: เลือกเอง"
        : state.source === "auto"
          ? `การเลือก: สลับอัตโนมัติ (fallback)${state.fallbackFrom ? ` จาก ${state.fallbackFrom}` : ""}`
          : "การเลือก: ค่าเริ่มต้นของระบบ",
      ...(state.pending ? ["การเปลี่ยนโมเดลจะมีผลในคำตอบถัดไป"] : []),
      ...(state.locked ? ["การเลือกโมเดลถูกล็อกไว้"] : []),
      ...(state.lastRun ? [`คำตอบล่าสุดใช้ ${state.lastRun}`] : []),
    ].join("\n"),
  currentProvider: (selected) => {
    const vendor = vendorOf(selected);
    return `โมเดลที่ใช้อยู่ (${selected.model}) ให้บริการผ่าน ${selected.provider}${vendor ? ` · ผู้พัฒนา: ${vendor}` : ""}`;
  },
  available: (lookup) =>
    `มี ${lookup.matches.map(label).join(", ")} ในแคตตาล็อก OpenRouter ของบัญชีนี้${aliasNote(lookup.alias, true)}\nพิมพ์ "เปลี่ยนเป็น ${lookup.matches[0]!.id}" ถ้าต้องการใช้`,
  provider: (lookup) =>
    lookup.matches
      .map(
        (model) => `${label(model)} ให้บริการผ่าน OpenRouter · ผู้พัฒนา: ${modelVendor(model.id) ?? "-"}`,
      )
      .join("\n") + aliasNote(lookup.alias, true),
  notAvailable: (target, lookup) =>
    [
      `ไม่มี "${target}" ในแคตตาล็อก OpenRouter ของบัญชีนี้`,
      ...(lookup.alias
        ? [
            `("${lookup.alias.alias}" คือชื่อเรียกที่ตั้งไว้ของ ${lookup.alias.provider}/${lookup.alias.model} ซึ่งไม่อยู่ในแคตตาล็อกนี้)`,
          ]
        : []),
      ...(lookup.suggestions.length > 0
        ? [`รุ่นอื่นที่มีชื่อคล้ายกัน (ไม่ใช่รุ่นที่ถาม): ${lookup.suggestions.map(label).join(", ")}`]
        : []),
    ].join("\n"),
  family: (target, models) =>
    models.length === 0
      ? `ไม่มีโมเดล "${target}" ในแคตตาล็อก OpenRouter ของบัญชีนี้`
      : `ในแคตตาล็อก OpenRouter ของบัญชีนี้มี ${target} ${models.length} รุ่น:\n${bulletList(models)}${models.length > MAX_LISTED_MODELS ? `\nและอีก ${models.length - MAX_LISTED_MODELS} รุ่น` : ""}`,
  summary: (models) =>
    `ในแคตตาล็อก OpenRouter ของบัญชีนี้มีทั้งหมด ${models.length} รุ่น:\n${vendorCounts(models)}`,
  catalogUnavailable: () =>
    "ตอนนี้อ่านแคตตาล็อกโมเดลของ OpenRouter ไม่ได้ จึงยังยืนยันไม่ได้ว่ามีรุ่นนี้หรือไม่ ลองถามใหม่อีกครั้งภายหลัง",
};

const ENGLISH_REPLIES: Replies = {
  current: (selected, state) =>
    [
      `Current model: ${selected.model} via ${selected.provider}`,
      state.source === "manual"
        ? "Selection: chosen manually"
        : state.source === "auto"
          ? `Selection: automatic fallback${state.fallbackFrom ? ` from ${state.fallbackFrom}` : ""}`
          : "Selection: configured default",
      ...(state.pending ? ["A model switch takes effect from the next reply"] : []),
      ...(state.locked ? ["Model selection is locked"] : []),
      ...(state.lastRun ? [`The last reply used ${state.lastRun}`] : []),
    ].join("\n"),
  currentProvider: (selected) => {
    const vendor = vendorOf(selected);
    return `The current model (${selected.model}) is served by ${selected.provider}${vendor ? ` · developer: ${vendor}` : ""}`;
  },
  available: (lookup) =>
    `${lookup.matches.map(label).join(", ")} is in this account's OpenRouter catalog${aliasNote(lookup.alias, false)}\nSend "switch to ${lookup.matches[0]!.id}" to use it`,
  provider: (lookup) =>
    lookup.matches
      .map(
        (model) =>
          `${label(model)} is served by OpenRouter · developer: ${modelVendor(model.id) ?? "-"}`,
      )
      .join("\n") + aliasNote(lookup.alias, false),
  notAvailable: (target, lookup) =>
    [
      `"${target}" is not in this account's OpenRouter catalog`,
      ...(lookup.alias
        ? [
            `("${lookup.alias.alias}" is the configured alias for ${lookup.alias.provider}/${lookup.alias.model}, which is not in this catalog)`,
          ]
        : []),
      ...(lookup.suggestions.length > 0
        ? [
            `Other models with similar names (not the one asked for): ${lookup.suggestions.map(label).join(", ")}`,
          ]
        : []),
    ].join("\n"),
  family: (target, models) =>
    models.length === 0
      ? `No "${target}" models are in this account's OpenRouter catalog`
      : `This account's OpenRouter catalog has ${models.length} ${target} models:\n${bulletList(models)}${models.length > MAX_LISTED_MODELS ? `\nand ${models.length - MAX_LISTED_MODELS} more` : ""}`,
  summary: (models) =>
    `This account's OpenRouter catalog has ${models.length} models:\n${vendorCounts(models)}`,
  catalogUnavailable: () =>
    "I can't read the OpenRouter model catalog right now, so I can't confirm whether that model is available. Please ask again shortly.",
};

function answerFromCatalog(params: {
  question: Extract<LineModelStateQuestion, { targets: string[] }>;
  models: readonly OpenRouterAccountModel[];
  aliases: readonly LineModelAlias[];
  familyWords: ReadonlySet<string>;
  replies: Replies;
}): string {
  const { question, models, aliases, familyWords, replies } = params;
  if (question.targets.length === 0) {
    return replies.summary(models);
  }
  return question.targets
    .map((target) => {
      const lookup = lookupCatalogModel({ query: target, models, aliases });
      if (lookup.matches.length > 0) {
        return question.kind === "provider" ? replies.provider(lookup) : replies.available(lookup);
      }
      // "มี Claude ไหม" asks about a family, which the catalog answers by
      // listing it. A digit keeps a target out of this path: listing by the
      // words of "GPT-6" would return GPT-5.6, which is the confusion this
      // handler exists to prevent.
      const targetWords = normalizeCatalogText(target).split(" ");
      const listable =
        !/\d/u.test(target) &&
        (question.kind === "list" || targetWords.every((word) => familyWords.has(word)));
      return listable
        ? replies.family(target, listCatalogFamily(models, target))
        : replies.notAvailable(target, lookup);
    })
    .join("\n\n");
}

/**
 * Builds the `before_dispatch` handler that answers owner model-state
 * questions from canonical state. It must run before Cloudbath's referent
 * arbitration (see the priority in index.ts), so these turns pay for no
 * model call at all.
 */
export function createLineModelStateRouter(
  params: {
    resolveApiKey?: (providerId: string) => Promise<string | undefined>;
    fetchImpl?: typeof fetch;
    readConfig?: () => OpenClawConfig;
    now?: () => number;
  } = {},
) {
  const resolveApiKey = params.resolveApiKey ?? resolveLineProviderApiKey;
  const readConfig = params.readConfig ?? getRuntimeConfig;
  const now = params.now ?? Date.now;
  let catalogWords: { at: number; words: ReadonlySet<string> } | undefined;
  let recognitionReadFailedAt: number | undefined;

  return async (
    event: LineBeforeDispatchEvent,
    ctx: LineBeforeDispatchContext,
  ): Promise<{ handled: true; text: string } | undefined> => {
    if (event.channel !== "line" || event.senderIsOwner !== true) {
      return undefined;
    }
    const text = event.body ?? event.content ?? "";
    const classified = classifyLineModelStateQuestion(text);
    const sessionKey = (ctx.sessionKey ?? event.sessionKey)?.trim();
    if (!classified || !sessionKey) {
      return undefined;
    }
    const replies = THAI_SCRIPT.test(text) ? THAI_REPLIES : ENGLISH_REPLIES;
    const cfg = readConfig();
    const entry = getSessionEntry({ agentId: ctx.agentId, sessionKey, readConsistency: "latest" });
    // The same resolver the Control UI's session views use for the selected model.
    const selected = resolveSessionModelRef(cfg, entry, ctx.agentId);
    const { question } = classified;
    if (question.kind === "current") {
      return {
        handled: true,
        text: replies.current(selected, readSelectionState(selected, entry)),
      };
    }
    if (question.kind === "provider" && question.targets.length === 0) {
      return { handled: true, text: replies.currentProvider(selected) };
    }

    const aliases = readLineModelAliases(cfg, ctx.agentId);
    const knownWords = modelFamilyWords([
      `${selected.provider}/${selected.model}`,
      ...aliases.map((alias) => `${alias.provider}/${alias.model}`),
      ...Object.keys(cfg.agents?.defaults?.models ?? {}),
    ]);
    const freshCatalogWords =
      catalogWords && now() - catalogWords.at < CATALOG_WORDS_TTL_MS
        ? catalogWords.words
        : undefined;
    const aboutModels = (words: ReadonlySet<string>) =>
      question.targets.some(
        (target) =>
          namesKnownModelWord(target, words) ||
          aliases.some(
            (alias) => normalizeCatalogText(alias.alias) === normalizeCatalogText(target),
          ),
      );
    const recognized =
      classified.explicit ||
      aboutModels(knownWords) ||
      (freshCatalogWords !== undefined && aboutModels(freshCatalogWords));
    const recognitionBackingOff =
      recognitionReadFailedAt !== undefined &&
      now() - recognitionReadFailedAt < RECOGNITION_RETRY_MS;
    if (!recognized && (freshCatalogWords || recognitionBackingOff)) {
      return undefined;
    }

    let models: OpenRouterAccountModel[];
    try {
      const apiKey = await resolveApiKey("openrouter");
      if (!apiKey?.trim()) {
        throw new Error("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
      }
      models = await loadOpenRouterAccountModels({
        apiKey,
        fetchImpl: params.fetchImpl,
        ...(recognized ? {} : { timeoutMs: RECOGNITION_READ_TIMEOUT_MS }),
      });
    } catch {
      // A recognized model question fails closed: falling through would hand
      // it back to an agent that answers from memory or the web.
      if (recognized) {
        return { handled: true, text: replies.catalogUnavailable() };
      }
      recognitionReadFailedAt = now();
      return undefined;
    }
    recognitionReadFailedAt = undefined;
    const familyWords = modelFamilyWords(models.map((model) => model.id));
    catalogWords = { at: now(), words: familyWords };
    if (!recognized && !aboutModels(familyWords)) {
      return undefined;
    }
    return {
      handled: true,
      text: answerFromCatalog({ question, models, aliases, familyWords, replies }),
    };
  };
}
