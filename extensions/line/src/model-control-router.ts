/**
 * Deterministic model control for an owner's turn, on LINE and in the Control UI.
 *
 * "ตอนนี้ใช้โมเดลอะไร", "มี GPT-6 Luna ไหม", "เปลี่ยนเป็น openai luna หน่อย" and
 * "use Luna" are about THIS deployment. Only the session's canonical model
 * selection, the account's OpenRouter catalog and the configured aliases know
 * the answers. Left to the agent, they were answered from model memory or
 * web_search, a model that is not in the catalog was described as available,
 * and a Control UI switch request cost two model calls and changed nothing.
 * This router answers and switches before any model runs, through the one
 * session applier the Control UI picker shares. Each answer that names a model
 * leaves a short-lived reference, so a bare follow-up ("เปลี่ยนให้หน่อย",
 * "ใช่") resolves against the model it established (model-reference.ts).
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSessionModelRef } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  catalogNameWords,
  letteredWords,
  listCatalogFamily,
  lookupCatalogModel,
  modelFamilyWords,
  namesKnownModelWord,
  normalizeCatalogText,
  readLineModelAliases,
  resolveCatalogSwitchTarget,
  type LineModelAlias,
} from "./model-catalog-lookup.js";
import {
  createLineSessionModelApplier,
  LINE_MODEL_MAX_PENDING_CANDIDATES,
  loadOpenRouterAccountModels,
  registerLineModelChoices,
  type OpenRouterAccountModel,
} from "./model-catalog-tool.js";
import { resolveModelControlTurn, type ModelControlTurn } from "./model-control-surface.js";
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
  type SelectedModel,
} from "./model-state-replies.js";
import {
  classifyLineModelControlIntent,
  formatLineModelCatalogReply,
  runLineModelCatalogAction,
  type LineModelControlIntent,
  type LineModelSwitchDeps,
} from "./model-switch-router.js";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";

type ModelControlDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

type ModelControlDispatchContext = {
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  conversationId?: string;
};

type Handled = { handled: true; text: string };

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
// Switch commands and picker numbers are this router's switch path, not questions.
const SWITCH_COMMAND = /^(?:เปลี่ยนเป็น|switch\s+to\b|change\s+to\b|\d+$)/iu;

const THAI_QUESTION = /ไหม|มั้ย|มั๊ย|ป่ะ|ปะ|เปล่า|หรือไม่|รึยัง|หรือยัง/u;
const THAI_LIST = /อะไรบ้าง|ไหนบ้าง|กี่รุ่น|กี่ตัว|ทั้งหมด/u;
const THAI_PROVIDER =
  /ผู้ให้บริการ|ค่ายไหน|ค่ายอะไร|ของค่าย|ของใคร|บริษัทไหน|บริษัทอะไร|มาจากไหน|มาจากค่าย|ใครทำ|ใครพัฒนา|ผ่านอะไร|ผ่านไหน|\bproviders?\b/iu;
const THAI_NOW = /ใช้|อยู่|ตอนนี้|ปัจจุบัน/u;
const ROUTING = /อัตโนมัติ|เลือกเอง|\b(?:auto|routing|fallback|manual)\b/iu;
// Colloquial "ไร" (for อะไร) counts only right after the noun it asks about:
// bare, it sits inside "ไม่เป็นไร" and "กำไร".
const COLLOQUIAL_WHICH = /(?:โมเดล|\bmodels?\b|ตัว|รุ่น)\s*ไร(?![\u0E48-\u0E4B])/iu;
// With no model word, only a whole message asking which one is running NOW
// ("ใช้ตัวไหนอยู่", "ตอนนี้รันตัวไหน"); "ใช้ตัวไหน" alone asks for advice, and
// "ครีมกันแดดใช้ตัวไหนอยู่" is about something else.
const THAI_RUNNING_WHICH =
  /^(?:ตอนนี้\s*)?(?:ใช้|รัน)\s*ตัว\s*(?:ไหน|ไร|อะไร)\s*(?:อยู่)?\s*(?:ตอนนี้)?\s*(?:ครับ|คะ|ค่ะ|นะ)?\s*[?？]*$/u;
const THAI_CURRENT_MARKER = /อยู่|ตอนนี้|ปัจจุบัน/u;

// Model names are written in Latin script inside Thai sentences.
const LATIN_RUN = /[A-Za-z0-9][\w.:/+-]*(?:\s+[A-Za-z0-9][\w.:/+-]*)*/gu;
const EDGE_WORDS =
  /^(?:(?:the|an?|this|that|models?|llms?|providers?)\s+)+|(?:\s+(?:models?|llms?|providers?))+$/giu;
const NOT_A_TARGET = /^(?:models?|llms?|providers?|ai|this|that|it|one)$/iu;

const ENGLISH_CURRENT = [
  /^(?:what|which)(?:'s|\s+is)?\s+(?:the\s+|your\s+|my\s+)?(?:current(?:ly)?\s+)?(?:selected\s+|active\s+)?(?:ai\s+)?model(?:\s+(?:are|am|is|do)\s+(?:you|i|we)\s+(?:using|on|running|use))?(?:\s+(?:now|right\s+now|currently))?$/iu,
  /\bcurrent(?:ly)?\s+(?:selected\s+|active\s+)?model\b/iu,
  /^what(?:'re|\s+are)\s+you\s+running(?:\s+(?:on|now|right\s+now|currently))?$/iu,
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
  if (THAI_RUNNING_WHICH.test(text) && THAI_CURRENT_MARKER.test(text)) {
    return { question: { kind: "current" }, explicit: true };
  }
  const asksWhich = (/อะไร|ไหน/u.test(text) || COLLOQUIAL_WHICH.test(text)) && THAI_NOW.test(text);
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

type SwitchIntent = Extract<LineModelControlIntent, { kind: "switch" }>;

// Catalog model names are Latin script, so a switch target without a Latin
// letter ("เปลี่ยนเป็นภาษาอังกฤษ", "ใช้คำนี้แทน") names no model.
const LATIN_LETTER = /[A-Za-z]/u;
const ASKS = new RegExp(`${THAI_QUESTION.source}|\\?`, "u");

/** Vendor/family words of the models this deployment is configured around. */
function configuredModelWords(
  cfg: OpenClawConfig,
  aliases: readonly LineModelAlias[],
  selected: SelectedModel,
): Set<string> {
  return modelFamilyWords([
    `${selected.provider}/${selected.model}`,
    ...aliases.map((alias) => `${alias.provider}/${alias.model}`),
    ...Object.keys(cfg.agents?.defaults?.models ?? {}),
  ]);
}

export type LineModelControlDeps = LineModelSwitchDeps & {
  referenceStore?: PluginStateKeyedStore<LineModelReference>;
  readConfig?: () => OpenClawConfig;
  /**
   * True while this LINE conversation has a video-model picker open. Its
   * free-text refinements ("MiniMax H3") read like chat-model switches, and the
   * video router -- registered after Cloudbath -- must see them first.
   */
  videoModelPickerOpen?: (ctx: ModelControlDispatchContext) => Promise<boolean>;
};

/**
 * Builds the two `before_dispatch` handlers of deterministic model control.
 *
 * `early` runs above Cloudbath's referent arbitration (see the priority in
 * index.ts), so follow-ups, switch requests and model-state questions pay for
 * no model call at all. `late` runs where numbered replies always have: after
 * Cloudbath and the video gates, whose own numbered questions come first. It
 * also takes a typed switch `early` deferred while a video picker was open.
 */
export function createLineModelControlRouter(params: LineModelControlDeps = {}) {
  const resolveApiKey = params.resolveApiKey ?? resolveLineProviderApiKey;
  const readConfig = params.readConfig ?? getRuntimeConfig;
  const now = params.now ?? Date.now;
  const videoModelPickerOpen = params.videoModelPickerOpen ?? (async () => false);
  let catalogWords:
    | { at: number; family: ReadonlySet<string>; names: ReadonlySet<string> }
    | undefined;
  let recognitionReadFailedAt: number | undefined;

  const freshCatalogWords = () =>
    catalogWords && now() - catalogWords.at < CATALOG_WORDS_TTL_MS ? catalogWords : undefined;
  const recognitionBackingOff = () =>
    recognitionReadFailedAt !== undefined && now() - recognitionReadFailedAt < RECOGNITION_RETRY_MS;

  /**
   * One authoritative read of the account catalog, which also teaches which
   * words name models. A read made only to recognize unmarked wording is
   * short, and its failure pauses such reads so ordinary chat never stalls.
   */
  const readCatalog = async (
    recognized: boolean,
  ): Promise<OpenRouterAccountModel[] | undefined> => {
    let models: OpenRouterAccountModel[] | undefined;
    try {
      const apiKey = await resolveApiKey("openrouter");
      models = apiKey?.trim()
        ? await loadOpenRouterAccountModels({
            apiKey,
            fetchImpl: params.fetchImpl,
            ...(recognized ? {} : { timeoutMs: RECOGNITION_READ_TIMEOUT_MS }),
          })
        : undefined;
    } catch {
      models = undefined;
    }
    if (!models) {
      if (!recognized) {
        recognitionReadFailedAt = now();
      }
      return undefined;
    }
    recognitionReadFailedAt = undefined;
    catalogWords = {
      at: now(),
      family: modelFamilyWords(models.map((model) => model.id)),
      names: catalogNameWords(models),
    };
    return models;
  };

  const remember = async (turn: ModelControlTurn, reference: ReferenceDraft): Promise<void> => {
    await params.referenceStore?.register(turn.scopeKey, {
      version: 1,
      scopeKey: turn.scopeKey,
      ...reference,
      createdAt: now(),
    });
  };

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

  /** The one switch every path makes: the shared session applier on this turn's session. */
  const switchTo = async (
    turn: ModelControlTurn,
    model: OpenRouterAccountModel,
    replies: Replies,
  ): Promise<{ ok: boolean; text: string }> => {
    // A new switch replaces any listing the owner could still answer by number.
    await params.pendingStore?.delete(turn.scopeKey);
    const apply = (params.buildSessionModelApplier ?? createLineSessionModelApplier)({
      agentId: turn.agentId,
      sessionKey: turn.sessionKey,
      config: readConfig(),
    });
    const ok = await apply(model).catch(() => false);
    return { ok, text: ok ? replies.switched(model) : replies.switchFailed(model) };
  };

  const offerChoices = async (
    turn: ModelControlTurn,
    query: string,
    models: readonly OpenRouterAccountModel[],
    replies: Replies,
    thai: boolean,
  ): Promise<string> => {
    const label = normalizeCatalogText(query);
    if (models.length > LINE_MODEL_MAX_PENDING_CANDIDATES) {
      return replies.tooManyChoices(label, models.length);
    }
    // A bare "เปลี่ยนให้หน่อย" after a listing asks which one instead of guessing.
    await remember(turn, { status: "ambiguous", models: referenced(models) });
    if (!params.pendingStore) {
      return formatLineModelFollowUpReply({ kind: "clarify", models: referenced(models) }, thai);
    }
    const listing = await registerLineModelChoices({
      pendingStore: params.pendingStore,
      scopeKey: turn.scopeKey,
      query: label,
      candidates: models,
      now: now(),
    });
    return replies.choices(label, listing.models);
  };

  /**
   * A typed switch request, resolved against the fresh account catalog.
   * Undefined leaves the turn to the other handlers.
   */
  const handleSwitch = async (
    turn: ModelControlTurn,
    intent: SwitchIntent,
    text: string,
    thai: boolean,
  ): Promise<string | undefined> => {
    const { query } = intent;
    // A question ("ใช้ X ได้ไหม") and other-domain wording (video, image,
    // character) belong to other handlers, and pointer words alone ("switch to
    // it") need a reference this conversation no longer has.
    if (
      text.length > MAX_QUESTION_CHARS ||
      !LATIN_LETTER.test(query) ||
      ASKS.test(query) ||
      OTHER_DOMAIN.test(text) ||
      classifyLineModelFollowUp(text)
    ) {
      return undefined;
    }
    const replies = thai ? THAI_REPLIES : ENGLISH_REPLIES;
    const cfg = readConfig();
    const aliases = readLineModelAliases(cfg, turn.agentId);
    const entry = getSessionEntry({
      agentId: turn.agentId,
      sessionKey: turn.sessionKey,
      readConsistency: "latest",
    });
    const known = new Set([
      ...configuredModelWords(cfg, aliases, resolveSessionModelRef(cfg, entry, turn.agentId)),
      ...aliases.flatMap((alias) => letteredWords(alias.alias)),
      ...(freshCatalogWords()?.names ?? []),
    ]);
    const recognized = intent.explicit || letteredWords(query).some((word) => known.has(word));
    // After a bare verb ("ใช้", "เอา", "use"), wording that shares no word
    // with any catalog model cannot name one: no read is needed to know that.
    if (!recognized && (freshCatalogWords() || recognitionBackingOff())) {
      return undefined;
    }
    const models = await readCatalog(recognized);
    if (!models) {
      // A recognized request fails closed: the agent would only guess or search.
      return recognized ? replies.switchCatalogUnavailable() : undefined;
    }
    const target = resolveCatalogSwitchTarget({ query, models, aliases });
    // After a bare verb, only the catalog itself makes the wording a model request.
    if (!intent.explicit && target.kind === "none") {
      return undefined;
    }
    // A new request replaces any listing the owner could still answer by number.
    await params.pendingStore?.delete(turn.scopeKey);
    if (target.kind === "switch") {
      return (await switchTo(turn, target.model, replies)).text;
    }
    if (target.kind === "choose") {
      return await offerChoices(turn, query, target.models, replies, thai);
    }
    if (target.kind === "confirm") {
      // Never a silent substitute: the nearby model is only offered, and a
      // plain "ใช่" confirms exactly it (see decideLineModelFollowUp).
      const model = { id: target.model.id, name: target.model.name };
      await remember(turn, { status: "offered", asked: query, models: [model] });
      return formatLineModelFollowUpReply({ kind: "offer", model, asked: query }, thai);
    }
    if (target.kind === "clarify") {
      await remember(turn, {
        status: "ambiguous",
        asked: query,
        models: referenced(target.lookup.suggestions),
      });
      return `${replies.notAvailable(query, target.lookup)}\n${formatLineModelFollowUpReply({ kind: "clarify", models: [] }, thai)}`;
    }
    return replies.switchNotFound(query);
  };

  const answerFollowUp = async (turn: {
    store: PluginStateKeyedStore<LineModelReference>;
    control: ModelControlTurn;
    reference: LineModelReference;
    followUp: LineModelFollowUp;
    thai: boolean;
  }): Promise<string> => {
    const { store, control, thai } = turn;
    const replies = thai ? THAI_REPLIES : ENGLISH_REPLIES;
    const decision = decideLineModelFollowUp({
      reference: turn.reference,
      followUp: turn.followUp,
      now: now(),
    });
    if (decision.kind === "switch") {
      // The reference may be minutes old: the fresh account catalog decides.
      const models = await readCatalog(true);
      if (!models) {
        return replies.switchCatalogUnavailable();
      }
      const model = models.find((candidate) => candidate.id === decision.model.id);
      if (!model) {
        await store.delete(control.scopeKey);
        return replies.modelGone(decision.model);
      }
      const result = await switchTo(control, model, replies);
      if (result.ok) {
        await store.delete(control.scopeKey);
      }
      return result.text;
    }
    if (decision.kind === "offer") {
      await remember(control, { status: "offered", models: [decision.model] });
    } else if (decision.kind === "decline" || decision.models.length === 0) {
      await store.delete(control.scopeKey);
    }
    return formatLineModelFollowUpReply(decision, thai);
  };

  const answerQuestion = async (
    turn: ModelControlTurn,
    text: string,
    thai: boolean,
  ): Promise<string | undefined> => {
    const classified = classifyLineModelStateQuestion(text);
    if (!classified) {
      return undefined;
    }
    const replies = thai ? THAI_REPLIES : ENGLISH_REPLIES;
    const cfg = readConfig();
    const entry = getSessionEntry({
      agentId: turn.agentId,
      sessionKey: turn.sessionKey,
      readConsistency: "latest",
    });
    // The same resolver the Control UI's session views use for the selected model.
    const selected = resolveSessionModelRef(cfg, entry, turn.agentId);
    const { question } = classified;
    if (question.kind === "current") {
      return replies.current(selected, readSelectionState(selected, entry));
    }
    if (question.kind === "provider" && question.targets.length === 0) {
      return replies.currentProvider(selected);
    }

    const aliases = readLineModelAliases(cfg, turn.agentId);
    const knownWords = configuredModelWords(cfg, aliases, selected);
    const cachedFamilyWords = freshCatalogWords()?.family;
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
      (cachedFamilyWords !== undefined && aboutModels(cachedFamilyWords));
    if (!recognized && (cachedFamilyWords || recognitionBackingOff())) {
      return undefined;
    }
    const models = await readCatalog(recognized);
    if (!models) {
      // A recognized model question fails closed: falling through would hand
      // it back to an agent that answers from memory or the web.
      return recognized ? replies.catalogUnavailable() : undefined;
    }
    const familyWords = modelFamilyWords(models.map((model) => model.id));
    if (!recognized && !aboutModels(familyWords)) {
      return undefined;
    }
    const answer = answerFromCatalog({ question, models, aliases, familyWords, replies });
    await remember(turn, answer.reference);
    return answer.text;
  };

  const early = async (
    event: ModelControlDispatchEvent,
    ctx: ModelControlDispatchContext,
  ): Promise<Handled | undefined> => {
    const turn = resolveModelControlTurn(event, ctx);
    if (!turn) {
      return undefined;
    }
    const text = event.body ?? event.content ?? "";
    const thai = THAI_SCRIPT.test(text);
    const store = params.referenceStore;
    if (store) {
      const reference = await readReference(store, turn.scopeKey);
      const followUp = reference ? classifyLineModelFollowUp(text) : undefined;
      if (reference && followUp) {
        return {
          handled: true,
          text: await answerFollowUp({ store, control: turn, reference, followUp, thai }),
        };
      }
      if (reference) {
        // Any other turn moves the conversation on: a later bare
        // "เปลี่ยนให้หน่อย" must not reach back past it to a stale model.
        await store.delete(turn.scopeKey);
      }
    }

    const intent = classifyLineModelControlIntent(text);
    if (intent.kind === "switch" && !(await videoModelPickerOpen(ctx))) {
      const reply = await handleSwitch(turn, intent, text, thai);
      if (reply) {
        return { handled: true, text: reply };
      }
    }
    const answer = await answerQuestion(turn, text, thai);
    return answer ? { handled: true, text: answer } : undefined;
  };

  const late = async (
    event: ModelControlDispatchEvent,
    ctx: ModelControlDispatchContext,
  ): Promise<Handled | undefined> => {
    const turn = resolveModelControlTurn(event, ctx);
    if (!turn) {
      return undefined;
    }
    const text = event.body ?? event.content ?? "";
    const intent = classifyLineModelControlIntent(text);
    if (intent.kind === "numeric") {
      const details = await runLineModelCatalogAction(
        params,
        {
          sessionKey: turn.sessionKey,
          agentId: turn.agentId,
          senderId: turn.principal,
          config: readConfig(),
        },
        { action: "select", selection: intent.selection },
      );
      // No listing open for this owner in this session: the number is ordinary chat.
      if (!details || details.resolution === "no_pending") {
        return undefined;
      }
      return { handled: true, text: formatLineModelCatalogReply(details, intent) };
    }
    // The video router has had its turn; what it left is a chat-model switch.
    if (intent.kind === "switch" && (await videoModelPickerOpen(ctx))) {
      const reply = await handleSwitch(turn, intent, text, THAI_SCRIPT.test(text));
      return reply ? { handled: true, text: reply } : undefined;
    }
    return undefined;
  };

  return { early, late };
}
