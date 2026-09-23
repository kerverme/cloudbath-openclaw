/**
 * Deterministic answers to an owner's questions about the LINE model state.
 *
 * "ตอนนี้ใช้โมเดลอะไร", "มี GPT-6 Luna ไหม", "GPT-5.6 Luna มาจากค่ายไหน" and
 * "มีโมเดล OpenAI อะไรบ้าง" are questions about THIS deployment. Only the
 * session's canonical model selection, the account's OpenRouter catalog and
 * the configured aliases know the answers. Left to the agent, they were
 * answered from model memory or web_search, and a model that is not in the
 * catalog was described as available. This handler answers them before the
 * agent runs. Each catalog answer leaves a short-lived reference so a bare
 * follow-up ("เปลี่ยนให้หน่อย") resolves against the model it established
 * (model-reference.ts); the switch itself is model-switch-router.ts's.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSessionModelRef } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  catalogModelLabel,
  listCatalogFamily,
  lookupCatalogModel,
  modelFamilyWords,
  namesKnownModelWord,
  normalizeCatalogText,
  readLineModelAliases,
  type LineModelAlias,
} from "./model-catalog-lookup.js";
import {
  loadOpenRouterAccountModels,
  resolveLineOwnerScopeKey,
  type OpenRouterAccountModel,
} from "./model-catalog-tool.js";
import {
  classifyLineModelFollowUp,
  decideLineModelFollowUp,
  formatLineModelFollowUpReply,
  type LineModelFollowUp,
  type LineModelReference,
  type LineReferencedModel,
} from "./model-reference.js";
import {
  ENGLISH_REPLIES,
  readSelectionState,
  THAI_REPLIES,
  type Replies,
} from "./model-state-replies.js";
import {
  formatLineModelCatalogReply,
  runLineModelCatalogAction,
  type LineModelSwitchDeps,
} from "./model-switch-router.js";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";

type LineBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
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

type ReferenceDraft = Pick<LineModelReference, "status" | "models" | "asked">;

function referenced(models: readonly OpenRouterAccountModel[]): LineReferencedModel[] {
  return models.slice(0, MAX_LISTED_MODELS).map(({ id, name }) => ({ id, name }));
}

function answerFromCatalog(params: {
  question: Extract<LineModelStateQuestion, { targets: string[] }>;
  models: readonly OpenRouterAccountModel[];
  aliases: readonly LineModelAlias[];
  familyWords: ReadonlySet<string>;
  replies: Replies;
}): { text: string; reference: ReferenceDraft } {
  const { question, models, aliases, familyWords, replies } = params;
  if (question.targets.length === 0) {
    return { text: replies.summary(models), reference: { status: "ambiguous", models: [] } };
  }
  const answers = question.targets.map((target): { text: string; reference: ReferenceDraft } => {
    const lookup = lookupCatalogModel({ query: target, models, aliases });
    if (lookup.matches.length > 0) {
      return {
        text: question.kind === "provider" ? replies.provider(lookup) : replies.available(lookup),
        reference: {
          status: lookup.matches.length === 1 ? "available" : "ambiguous",
          models: referenced(lookup.matches),
        },
      };
    }
    // "มี Claude ไหม" asks about a family, which the catalog answers by
    // listing it. A digit keeps a target out of this path: listing by the
    // words of "GPT-6" would return GPT-5.6, which is the confusion this
    // handler exists to prevent.
    const targetWords = normalizeCatalogText(target).split(" ");
    const listable =
      !/\d/u.test(target) &&
      (question.kind === "list" || targetWords.every((word) => familyWords.has(word)));
    if (listable) {
      const family = listCatalogFamily(models, target);
      return {
        text: replies.family(target, family),
        reference: {
          status: family.length === 1 ? "available" : "ambiguous",
          models: referenced(family),
        },
      };
    }
    // Not in the catalog: a single similar model is only a suggestion, which
    // a follow-up must confirm before anything switches to it.
    return {
      text: replies.notAvailable(target, lookup),
      reference: {
        status: lookup.suggestions.length === 1 ? "suggested" : "ambiguous",
        asked: target,
        models: referenced(lookup.suggestions),
      },
    };
  });
  const [only] = answers;
  return {
    text: answers.map((answer) => answer.text).join("\n\n"),
    reference:
      answers.length === 1 && only
        ? only.reference
        : {
            status: "ambiguous",
            models: [
              ...new Map(
                answers
                  .flatMap((answer) => answer.reference.models)
                  .map((model) => [model.id, model]),
              ).values(),
            ],
          },
  };
}

function switchReply(
  details: Record<string, unknown> | undefined,
  model: LineReferencedModel,
  thai: boolean,
): string {
  if (thai) {
    // The typed-switch wording, so every LINE switch reads the same.
    return formatLineModelCatalogReply(details ?? {}, {
      kind: "switch",
      query: model.id,
      explicit: true,
    });
  }
  return details?.resolution === "switched"
    ? `Switched to ${catalogModelLabel(model)}.`
    : `Switching to ${model.name} did not go through. Please try again.`;
}

/**
 * Builds the `before_dispatch` handler that answers owner model-state
 * questions from canonical state, and their follow-ups from the reference the
 * answer left. It must run before Cloudbath's referent arbitration (see the
 * priority in index.ts), so these turns pay for no model call at all.
 */
export function createLineModelStateRouter(
  params: LineModelSwitchDeps & {
    referenceStore?: PluginStateKeyedStore<LineModelReference>;
    readConfig?: () => OpenClawConfig;
  } = {},
) {
  const resolveApiKey = params.resolveApiKey ?? resolveLineProviderApiKey;
  const readConfig = params.readConfig ?? getRuntimeConfig;
  const now = params.now ?? Date.now;
  let catalogWords: { at: number; words: ReadonlySet<string> } | undefined;
  let recognitionReadFailedAt: number | undefined;

  const readReference = async (
    store: PluginStateKeyedStore<LineModelReference>,
    scopeKey: string,
  ): Promise<LineModelReference | undefined> => {
    const reference = await store.lookup(scopeKey);
    if (reference && (reference.version !== 1 || reference.scopeKey !== scopeKey)) {
      await store.delete(scopeKey);
      return undefined;
    }
    return reference;
  };

  const answerFollowUp = async (turn: {
    store: PluginStateKeyedStore<LineModelReference>;
    scopeKey: string;
    reference: LineModelReference;
    followUp: LineModelFollowUp;
    target: { sessionKey: string; agentId?: string; senderId: string };
    thai: boolean;
  }): Promise<string> => {
    const { store, scopeKey, target, thai } = turn;
    const decision = decideLineModelFollowUp({
      reference: turn.reference,
      followUp: turn.followUp,
      now: now(),
    });
    if (decision.kind === "switch") {
      // The typed switch's own path: fresh account catalog, exact match on the
      // canonical id, and the session-only OpenRouter applier.
      const details = await runLineModelCatalogAction(params, target, {
        action: "search",
        query: decision.model.id,
      });
      if (details?.resolution === "switched") {
        await store.delete(scopeKey);
      }
      return switchReply(details, decision.model, thai);
    }
    if (decision.kind === "offer") {
      await store.register(scopeKey, {
        version: 1,
        scopeKey,
        status: "offered",
        models: [decision.model],
        createdAt: now(),
      });
    } else if (decision.kind === "decline" || decision.models.length === 0) {
      await store.delete(scopeKey);
    }
    return formatLineModelFollowUpReply(decision, thai);
  };

  return async (
    event: LineBeforeDispatchEvent,
    ctx: LineBeforeDispatchContext,
  ): Promise<{ handled: true; text: string } | undefined> => {
    if (event.channel !== "line" || event.senderIsOwner !== true) {
      return undefined;
    }
    const sessionKey = (ctx.sessionKey ?? event.sessionKey)?.trim();
    if (!sessionKey) {
      return undefined;
    }
    const text = event.body ?? event.content ?? "";
    const thai = THAI_SCRIPT.test(text);
    const senderId = event.senderId?.trim();
    const scopeKey = senderId
      ? resolveLineOwnerScopeKey({ sessionId: sessionKey, requesterSenderId: senderId })
      : null;
    const store = params.referenceStore;
    if (store && scopeKey && senderId) {
      const reference = await readReference(store, scopeKey);
      const followUp = reference ? classifyLineModelFollowUp(text) : undefined;
      if (reference && followUp) {
        return {
          handled: true,
          text: await answerFollowUp({
            store,
            scopeKey,
            reference,
            followUp,
            target: { sessionKey, agentId: ctx.agentId, senderId },
            thai,
          }),
        };
      }
      if (reference) {
        // Any other turn moves the conversation on: a later bare
        // "เปลี่ยนให้หน่อย" must not reach back past it to a stale model.
        await store.delete(scopeKey);
      }
    }

    const classified = classifyLineModelStateQuestion(text);
    if (!classified) {
      return undefined;
    }
    const replies = thai ? THAI_REPLIES : ENGLISH_REPLIES;
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
    const answer = answerFromCatalog({ question, models, aliases, familyWords, replies });
    if (store && scopeKey) {
      await store.register(scopeKey, {
        version: 1,
        scopeKey,
        ...answer.reference,
        createdAt: now(),
      });
    }
    return { handled: true, text: answer.text };
  };
}
