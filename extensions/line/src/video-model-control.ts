/**
 * Deterministic, owner-only LINE video-model switch control.
 *
 * Unlike the chat-model router (model-switch-router.ts), which treats bare
 * verbs like "เปลี่ยน"/"ใช้"/"ลอง" as tentative switch intent, video-model
 * control only ever fires on wording that explicitly names "video model" /
 * "โมเดลวิดีโอ" / "วิดีโอโมเดล" — e.g. "เปลี่ยน video model เป็น seedance 2.5",
 * "video model". This keeps the trigger surface fully disjoint from the chat
 * router (registered after this one in index.ts's before_dispatch chain, and
 * hooks are first-claim-wins), so the same message can never be claimed by
 * both, and ordinary chat-model requests are never mistaken for video-model
 * requests or vice versa.
 *
 * Uses its own pending-selection store (LINE_VIDEO_MODEL_SELECTION_NAMESPACE)
 * so a numbered choice here can never collide with, or be resolved by, the
 * chat-model picker's pending state (model-catalog-tool.ts).
 */
import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";
import { loadOpenRouterVideoModels, type OpenRouterVideoModel } from "./video-model-catalog.js";
import {
  buildLineVideoConversationKey,
  resolveLineVideoModelPreference,
  setLineVideoModelPreference,
  type LineVideoModelPreferenceStore,
} from "./video-model-preference.js";
import {
  formatIncompatibilityQuestion,
  formatRequotedDraft,
  parseRequoteAnswer,
  requotePendingKey,
  type LinePendingRequoteStore,
  type LineRequoteOverrides,
  type LineRequoteResult,
  LINE_VIDEO_REQUOTE_PENDING_TTL_MS,
} from "./video-model-requote.js";
import {
  formatVideoModelCapabilities,
  searchVideoModels,
  type RankedVideoModel,
} from "./video-model-search.js";

export const LINE_VIDEO_MODEL_SELECTION_NAMESPACE = "video-model-selection-v1";
export const LINE_VIDEO_MODEL_SELECTION_TTL_MS = 10 * 60 * 1000;
export const LINE_VIDEO_MODEL_SELECTION_MAX_ENTRIES = 5_000;

export type LinePendingVideoModelSelection = {
  version: 1;
  scopeKey: string;
  query: string;
  candidates: Array<{ id: string; name: string; capabilities?: string }>;
  createdAt: number;
};

export type LinePendingVideoModelSelectionStore =
  PluginStateKeyedStore<LinePendingVideoModelSelection>;

// "โมเดลสร้างวิดีโอ" ("the model that generates videos") is a natural Thai
// phrasing distinct from the "video model"/"โมเดลวิดีโอ"/"วิดีโอโมเดล" word
// order, needed so status wording like "เช็กโมเดลสร้างวิดีโอ" is recognized
// at all instead of falling through to the chat router or the main LLM.
const VIDEO_MODEL_TRIGGER_WORDS = ["video model", "โมเดลวิดีโอ", "วิดีโอโมเดล", "โมเดลสร้างวิดีโอ"];
const NUMERIC_SELECTION_PATTERN = /^\d+$/u;
const MAX_LISTED_CANDIDATES = 20;

// Substrings that, once found in the wording left over after stripping the
// video-model trigger and ordinary switch connectors, mark a "what's the
// current model" question rather than a switch target. Checked as plain
// substrings (not tokenized) because Thai is often written without spaces
// between words, so a token-boundary match would miss real examples like
// "ตอนนี้ใช้" (no space between "ตอนนี้" and "ใช้"). Bare "video model" (empty
// remainder) never matches any of these, so it is unaffected and keeps
// showing the live catalog.
const STATUS_REMAINDER_MARKERS = [
  "ตอนนี้",
  "ปัจจุบัน",
  "รุ่นไหน",
  "อยู่",
  "อะไร",
  "คือ",
  "เช็ก",
  "เช็ค",
  "status",
  "current",
];

export type LineVideoModelControlIntent =
  | { kind: "switch"; query: string }
  | { kind: "status" }
  | { kind: "numeric"; selection: number }
  | { kind: "none" };

function isStatusRemainder(remainder: string): boolean {
  if (!remainder) {
    return false;
  }
  const lower = remainder.toLowerCase();
  return STATUS_REMAINDER_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Deterministically classifies a LINE message as a video-model status
 * question, a switch request, or a numeric picker reply. Only messages that
 * literally contain a recognized video-model reference count at all; every
 * other message — including ordinary chat-model requests and unrelated
 * conversation — is "none" and falls through unchanged.
 *
 * Status is checked BEFORE the remainder is ever used as a search query, so
 * question wording ("ตอนนี้", "อะไร", "รุ่นไหนอยู่") is never passed to the
 * catalog matcher as if it were a model name.
 */
export function classifyLineVideoModelControlIntent(rawText: string): LineVideoModelControlIntent {
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
  const lower = trimmed.toLowerCase();
  const trigger = VIDEO_MODEL_TRIGGER_WORDS.find((word) => lower.includes(word.toLowerCase()));
  if (!trigger) {
    return { kind: "none" };
  }
  // Strip the trigger phrase and common connector words, leaving the model
  // query. An empty remainder ("video model" alone) means "show the current
  // picker" rather than a specific target — search with an empty query lists
  // the live catalog instead of matching nothing.
  const query = trimmed
    .replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"), " ")
    .replace(/เปลี่ยน|เป็น|ใช้|ลอง/gu, " ")
    .replace(/\bchange to\b|\bswitch to\b|\buse\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (isStatusRemainder(query)) {
    return { kind: "status" };
  }
  return { kind: "switch", query };
}

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
  accountId?: string;
  conversationId?: string;
};

type LineBeforeDispatchResult = { handled: boolean; text?: string };

function resolvePendingKey(scopeKey: string): string {
  // Hash the trusted conversation scope key so it never becomes an unbounded
  // or unsafe SQLite key, matching model-catalog-tool.ts's precedent.
  return createHash("sha256").update(scopeKey).digest("hex");
}

const COMBINING_DIACRITICS_PATTERN = new RegExp("[̀-ͯ]", "gu");

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(COMBINING_DIACRITICS_PATTERN, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** One candidate per line; the capability summary is indented under its name. */
function formatCandidateList(candidates: Array<{ name: string; capabilities?: string }>): string {
  return candidates
    .map((entry, index) =>
      entry.capabilities
        ? `${index + 1}. ${entry.name}\n   ${entry.capabilities}`
        : `${index + 1}. ${entry.name}`,
    )
    .join("\n");
}

/**
 * A failure while refining leaves the picker open and the turn unclaimed: the
 * owner was answering a question, not issuing a video-model command, so an
 * error reply here would swallow ordinary chat.
 */
function refinementAware(
  isRefinement: boolean,
  result: LineBeforeDispatchResult,
): LineBeforeDispatchResult | undefined {
  return isRefinement ? undefined : result;
}

/**
 * The exact paid confirmation, mirrored here only to REFUSE it.
 *
 * A pending picker or capability question must never swallow "ยืนยัน VIDEO
 * ####": that turn belongs to the confirmation gate and nothing else.
 */
const PAID_CONFIRMATION_PATTERN = /^ยืนยัน\s+VIDEO\s+\d{4}$/iu;

function toCandidate(entry: RankedVideoModel): { id: string; name: string; capabilities?: string } {
  const capabilities = formatVideoModelCapabilities(entry.model);
  return {
    id: entry.model.id,
    name: entry.model.name,
    ...(capabilities ? { capabilities } : {}),
  };
}

type FetchLike = typeof fetch;

/**
 * Builds the before_dispatch handler that deterministically routes an
 * owner's video-model switch/select request. Register this BEFORE the chat
 * model-switch router in index.ts — before_dispatch is first-claim-wins, so
 * this must see "video model"-scoped messages first.
 */
export function createLineVideoModelControlRouter(params: {
  preferenceStore: LineVideoModelPreferenceStore;
  pendingStore: LinePendingVideoModelSelectionStore;
  /**
   * Holds the ONE open capability question while the owner answers it. Absent,
   * a model change simply never re-quotes, which is the pre-seam behaviour.
   */
  requotePendingStore?: LinePendingRequoteStore;
  /**
   * The archive seam. Absent (or with no storyboard flow installed) a model
   * change is a preference change only.
   */
  requoteActiveDraft?: (request: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    overrides?: LineRequoteOverrides;
  }) => Promise<LineRequoteResult>;
  resolveApiKey?: () => Promise<string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
}) {
  const resolveApiKey = params.resolveApiKey ?? (() => resolveLineProviderApiKey());
  const now = params.now ?? Date.now;

  return async (
    event: LineBeforeDispatchEvent,
    ctx: LineBeforeDispatchContext,
  ): Promise<LineBeforeDispatchResult | undefined> => {
    if (event.channel !== "line") {
      return undefined;
    }
    // Owner-only privileged control, matching the chat model-switch router
    // and group-owner-control.ts's exact-command gates.
    if (event.senderIsOwner !== true) {
      return undefined;
    }

    const rawText = (event.body ?? event.content ?? "").trim();
    const intent = classifyLineVideoModelControlIntent(rawText);
    // "none" is not necessarily the end: while THIS conversation has a picker
    // open, untriggered wording ("MiniMax: H3") is a refinement of the question
    // the bot just asked. The pending lookup below is what scopes that, so with
    // no picker open the message still falls through to ordinary chat.
    const mayRefine = intent.kind === "none";
    if (mayRefine && !rawText) {
      return undefined;
    }

    const accountId = ctx.accountId?.trim();
    // Model preference shares the same native LINE conversation key as video
    // drafts, confirmations, jobs, and delivery ownership. Never fall back to
    // ephemeral OpenClaw session identities here.
    const conversationId = ctx.conversationId?.trim();
    if (!accountId || !conversationId) {
      return undefined;
    }
    const scopeKey = buildLineVideoConversationKey({ accountId, conversationId });
    if (!scopeKey) {
      return undefined;
    }
    const pendingKey = resolvePendingKey(scopeKey);
    const requoteKey = requotePendingKey(scopeKey);

    /**
     * Saves the chosen model, then tries to re-quote the active storyboard.
     *
     * Order matters: the preference is persisted FIRST, so it holds even when
     * there is nothing to re-quote or the re-quote is refused. Nothing here
     * retires the previous code — only a successfully allocated replacement
     * does, inside the allocator.
     */
    const applySelectedModel = async (
      selected: { id: string; name: string },
      overrides?: LineRequoteOverrides,
    ): Promise<string> => {
      await setLineVideoModelPreference({
        store: params.preferenceStore,
        key: scopeKey,
        model: selected.id,
        now,
      });
      await params.pendingStore.delete(pendingKey);
      const changed = `เปลี่ยน Video Model เป็น ${selected.name} แล้ว`;
      if (!params.requoteActiveDraft) {
        return changed;
      }
      const result = await params
        .requoteActiveDraft({
          accountId,
          conversationId,
          ownerSenderId: event.senderId?.trim() ?? "",
          ...(overrides ? { overrides } : {}),
        })
        .catch((): LineRequoteResult => ({ kind: "unavailable", reason: "seam_unavailable" }));

      if (result.kind === "created") {
        await params.requotePendingStore?.delete(requoteKey);
        return `${changed}\n\n${formatRequotedDraft({
          modelName: selected.name,
          result,
          overrides: overrides ?? {},
        })}`;
      }
      if (result.kind === "incompatible") {
        // The previous code stays valid: nothing was allocated and nothing was
        // superseded. Only the one unusable field is put to the owner.
        await params.requotePendingStore?.register(requoteKey, {
          version: 1,
          modelId: selected.id,
          modelName: selected.name,
          field: result.incompatibility.kind,
          supported: result.incompatibility.supported,
          overrides: overrides ?? {},
          createdAt: now(),
        });
        return `${changed}\n\n${formatIncompatibilityQuestion({
          modelName: selected.name,
          incompatibility: result.incompatibility,
        })}`;
      }
      if (result.kind === "no_active_storyboard") {
        return changed;
      }
      return `${changed}\n(ยังคำนวณราคาสำหรับ Storyboard ปัจจุบันไม่ได้ รหัส VIDEO เดิมยังใช้ได้อยู่)`;
    };

    // An open capability question is the most recent thing asked, so it is
    // answered before the picker. The exact paid confirmation is never taken.
    const requotePending = PAID_CONFIRMATION_PATTERN.test(rawText)
      ? undefined
      : await params.requotePendingStore?.lookup(requoteKey);
    if (requotePending) {
      if (requotePending.createdAt + LINE_VIDEO_REQUOTE_PENDING_TTL_MS <= now()) {
        await params.requotePendingStore?.delete(requoteKey);
      } else {
        const answer = parseRequoteAnswer({
          field: requotePending.field,
          supported: requotePending.supported,
          text: rawText,
        });
        if (answer) {
          return {
            handled: true,
            text: await applySelectedModel(
              { id: requotePending.modelId, name: requotePending.modelName },
              { ...requotePending.overrides, ...answer },
            ),
          };
        }
        // Not an answer: leave the question open and let the turn fall through
        // to ordinary chat rather than swallowing it.
        if (intent.kind === "none") {
          return undefined;
        }
      }
    }

    if (intent.kind === "status") {
      // Read-only: never mutates the preference store, never touches
      // pendingStore, never calls the catalog search/matching path below.
      const modelId = await resolveLineVideoModelPreference({
        store: params.preferenceStore,
        key: scopeKey,
      });
      let modelName = modelId;
      try {
        const apiKey = await resolveApiKey();
        if (apiKey?.trim()) {
          const models = await loadOpenRouterVideoModels({ apiKey, fetchImpl: params.fetchImpl });
          modelName = models.find((model) => model.id === modelId)?.name ?? modelId;
        }
      } catch {
        // Best-effort friendly name only; the persisted/default id itself is
        // always the source of truth and never depends on the catalog being
        // reachable, so a lookup failure degrades gracefully instead of
        // erroring the status query out.
      }
      const lines = [
        "🎬 Video model ปัจจุบัน",
        ...(modelName !== modelId ? [modelName] : []),
        modelId,
      ];
      return { handled: true, text: lines.join("\n") };
    }

    if (intent.kind === "numeric") {
      const pending = await params.pendingStore.lookup(pendingKey);
      if (!pending || pending.createdAt + LINE_VIDEO_MODEL_SELECTION_TTL_MS <= now()) {
        if (pending) {
          await params.pendingStore.delete(pendingKey);
        }
        return undefined;
      }
      const selected = pending.candidates[intent.selection - 1];
      if (!selected) {
        return {
          handled: true,
          text: `หมายเลขนี้ไม่อยู่ในตัวเลือก:\n${formatCandidateList(pending.candidates)}\nต้องการใช้รุ่นไหน?`,
        };
      }
      return { handled: true, text: await applySelectedModel(selected) };
    }

    // A refinement only means something while THIS conversation has a picker
    // open. With none open the turn is not ours, so it falls through to chat.
    const pendingForRefinement = mayRefine
      ? await params.pendingStore.lookup(pendingKey)
      : undefined;
    const isRefinement = mayRefine && pendingForRefinement !== undefined;
    if (mayRefine) {
      if (
        !pendingForRefinement ||
        pendingForRefinement.createdAt + LINE_VIDEO_MODEL_SELECTION_TTL_MS <= now()
      ) {
        return undefined;
      }
      // An exact candidate name answers the open question directly, without
      // needing the catalog at all.
      const named = pendingForRefinement.candidates.find(
        (candidate) =>
          normalizeSearchText(candidate.name) === normalizeSearchText(rawText) ||
          normalizeSearchText(candidate.id) === normalizeSearchText(rawText),
      );
      if (named) {
        return {
          handled: true,
          text: await applySelectedModel({ id: named.id, name: named.name }),
        };
      }
    }

    const query = intent.kind === "switch" ? intent.query : rawText;

    let apiKey: string | undefined;
    try {
      apiKey = await resolveApiKey();
    } catch {
      return refinementAware(isRefinement, {
        handled: true,
        text: "ขอโทษค่ะ เชื่อมต่อ OpenRouter ไม่ได้ตอนนี้ ลองใหม่อีกครั้งได้ไหม?",
      });
    }
    if (!apiKey?.trim()) {
      return refinementAware(isRefinement, {
        handled: true,
        text: "ยังไม่ได้ตั้งค่า OpenRouter API key",
      });
    }

    let models: OpenRouterVideoModel[];
    try {
      models = await loadOpenRouterVideoModels({ apiKey, fetchImpl: params.fetchImpl });
    } catch {
      return refinementAware(isRefinement, {
        handled: true,
        text: "ดึงรายการ video model ไม่สำเร็จ ลองใหม่อีกครั้งได้ไหม?",
      });
    }

    const result = searchVideoModels(models, query);

    if (result.candidates.length === 0) {
      // A refinement that matches nothing is probably not about models at all,
      // so the picker stays open and the message goes back to ordinary chat.
      return isRefinement
        ? undefined
        : { handled: true, text: `ไม่เจอ video model ที่ตรงกับ "${query}"` };
    }

    if (result.autoApply) {
      const selected = result.autoApply.model;
      return { handled: true, text: await applySelectedModel(selected) };
    }

    // Ambiguous: never auto-apply a guess onto a paid path. Show the numbered
    // choices and keep the picker open for a number or a further refinement.
    const candidates = result.candidates.slice(0, MAX_LISTED_CANDIDATES).map(toCandidate);
    await params.pendingStore.register(pendingKey, {
      version: 1,
      scopeKey: pendingKey,
      query,
      candidates,
      createdAt: now(),
    });
    return {
      handled: true,
      text: `เจอรุ่นที่ใกล้เคียงกับ "${query}":\n${formatCandidateList(candidates)}\nตอบหมายเลขที่ต้องการใช้`,
    };
  };
}
