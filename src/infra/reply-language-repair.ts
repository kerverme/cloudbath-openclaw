/**
 * The one authoritative final text for a turn.
 *
 * Every user-visible surface must show the SAME string. Before this, the UI
 * streamed the provider's raw text while LINE received an independently
 * repaired version, so the same turn existed in two different wordings and the
 * transcript agreed with neither. So repair happens once, deterministically,
 * and is memoized per run: whichever surface finalizes first decides, and the
 * others read that decision rather than repairing again with their own rules.
 *
 * The hierarchy is deliberate and it never strips characters:
 *
 *   1. structured regeneration — deterministic text rebuilt from state
 *   2. segment rewrite — drop whole violating lines/sentences, but only when
 *      what remains still carries the reply
 *   3. a short honest fallback supplied by the owning layer
 *
 * Nothing here invents a claim. The fallback says the reply failed; it never
 * says anything was saved, sent, completed or updated.
 */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  isTechnicalToken,
  validateReplyLanguage,
  type ReplyLanguageValidation,
  type TurnPresentationPolicy,
} from "./reply-language-policy.js";

/** What happened to the text. `unrepaired` means we could not fix it and said so. */
export type FinalReplyOutcome = "unchecked" | "valid" | "repaired" | "fallback" | "unrepaired";

export type FinalReplyRepairKind = "none" | "regenerated" | "rewritten" | "fallback";

export type FinalizedReply = Readonly<{
  text: string;
  outcome: FinalReplyOutcome;
  repairKind: FinalReplyRepairKind;
  validation: ReplyLanguageValidation;
}>;

/**
 * A rewrite must keep most of the reply to count as meaning-preserving. Below
 * this the remainder is a fragment pretending to be an answer, and the honest
 * fallback is better than a confident half-sentence.
 */
const MIN_KEPT_RATIO = 0.5;

type Segment = Readonly<{ text: string; start: number; end: number }>;

/**
 * Lines first, then sentence ends, with offsets. Never sub-word: dropping words
 * is the character-stripping this module exists to avoid.
 *
 * Offsets are kept so a rewrite can cut the violating spans out of the ORIGINAL
 * text and leave every surviving byte, including its line breaks, exactly as
 * the model wrote it.
 */
function segments(text: string): Segment[] {
  const found: Segment[] = [];
  let cursor = 0;
  for (const line of text.split(/\r?\n/u)) {
    for (const piece of line.split(/(?<=[.!?;:。！？])\s+/u)) {
      const trimmed = piece.trim();
      if (trimmed) {
        const start = text.indexOf(trimmed, cursor);
        if (start >= 0) {
          found.push({ text: trimmed, start, end: start + trimmed.length });
          cursor = start + trimmed.length;
        }
      }
    }
  }
  return found;
}

function hasTechnicalToken(text: string): boolean {
  return text.split(/\s+/u).some((token) => token && isTechnicalToken(token));
}

function protectedTechnicalTokens(text: string): string[] {
  const videoCodes = text.match(/\bVIDEO\s+[A-Za-z0-9]{3,}\b/gu) ?? [];
  const codeParts = new Set(videoCodes.flatMap((code) => code.split(/\s+/u)));
  const technical = text
    .split(/\s+/u)
    .filter(
      (token) =>
        token &&
        !codeParts.has(token) &&
        isTechnicalToken(token) &&
        (/[_:/@+#?&=%~-]/u.test(token) || (/[A-Za-z]/u.test(token) && /[0-9]/u.test(token))),
    );
  return [...new Set([...videoCodes, ...technical])];
}

/**
 * Drops whole violating segments, or returns undefined when that would lose
 * meaning or lose an exact span (a confirmation code, a link) that the reply
 * was carrying. A dropped code cannot be silently replaced by a shorter reply
 * that looks complete.
 */
function rewriteWithoutViolatingSegments(
  text: string,
  policy: TurnPresentationPolicy,
): string | undefined {
  const parts = segments(text);
  if (parts.length < 2) {
    return undefined;
  }
  let rewritten = "";
  let cursor = 0;
  let keptCount = 0;
  for (const part of parts) {
    if (validateReplyLanguage(part.text, policy).valid) {
      // Everything since the last kept segment comes along, so separators and
      // line breaks between survivors are the model's own.
      rewritten += text.slice(cursor, part.end);
      cursor = part.end;
      keptCount += 1;
      continue;
    }
    if (hasTechnicalToken(part.text)) {
      return undefined;
    }
    cursor = part.end;
  }
  if (keptCount === 0) {
    return undefined;
  }
  // Cutting a segment leaves the whitespace that surrounded it on both sides.
  const collapsed = rewritten
    .replaceAll(/[ \t]*\r?\n(?:[ \t]*\r?\n)+/gu, "\n")
    .replaceAll(/[ \t]{2,}/gu, " ")
    .trim();
  const trimmedLength = text.trim().length;
  if (trimmedLength > 0 && collapsed.length / trimmedLength < MIN_KEPT_RATIO) {
    return undefined;
  }
  return validateReplyLanguage(collapsed, policy).valid ? collapsed : undefined;
}

/**
 * Decides the authoritative text for one reply.
 *
 * With no expectation configured this returns the text untouched and reports
 * `unchecked`, so an unconfigured deployment behaves exactly as before.
 */
export function finalizeReplyText(params: {
  text: string;
  policy: TurnPresentationPolicy | undefined;
  /** Deterministic rebuild from structured state, when the caller owns one. */
  regenerate?: () => string | undefined;
}): FinalizedReply {
  const validation = validateReplyLanguage(params.text, params.policy);
  if (validation.reason === "no_expectation" || validation.reason === "multilingual_allowed") {
    return { text: params.text, outcome: "unchecked", repairKind: "none", validation };
  }
  const policy = params.policy as TurnPresentationPolicy;
  if (validation.valid) {
    return { text: params.text, outcome: "valid", repairKind: "none", validation };
  }
  const regenerated = params.regenerate?.()?.trim();
  if (regenerated) {
    const regeneratedValidation = validateReplyLanguage(regenerated, policy);
    if (regeneratedValidation.valid) {
      return {
        text: regenerated,
        outcome: "repaired",
        repairKind: "regenerated",
        validation: regeneratedValidation,
      };
    }
  }
  const rewritten = rewriteWithoutViolatingSegments(params.text, policy);
  if (rewritten) {
    return {
      text: rewritten,
      outcome: "repaired",
      repairKind: "rewritten",
      validation: validateReplyLanguage(rewritten, policy),
    };
  }
  const fallback = policy.fallbackText?.trim();
  if (fallback) {
    const protectedSpans = protectedTechnicalTokens(params.text);
    const fallbackText =
      protectedSpans.length > 0 ? `${fallback}\n${protectedSpans.join(" ")}` : fallback;
    return {
      text: fallbackText,
      outcome: "fallback",
      repairKind: "fallback",
      validation: validateReplyLanguage(fallbackText, policy),
    };
  }
  // No rebuild, no safe rewrite, and the owning layer supplied no wording we
  // could honestly send instead. Report it rather than pretend it is fixed.
  return { text: params.text, outcome: "unrepaired", repairKind: "none", validation };
}

/**
 * Per-run memo so every surface reads one decision.
 *
 * Single slot per run. The first finalization is authoritative even if a later
 * surface still holds different raw bytes; recomputing there would create a
 * second final answer. Cleared with the run.
 */
type PreparedRegeneration = { sourceText: string; regeneratedText: string };
const FINALIZED_BY_RUN_KEY = Symbol.for("openclaw.replyLanguage.finalizedByRun");
const PREPARED_BY_RUN_KEY = Symbol.for("openclaw.replyLanguage.preparedByRun");

function finalizedByRun(): Map<string, FinalizedReply> {
  return resolveGlobalSingleton(FINALIZED_BY_RUN_KEY, () => new Map<string, FinalizedReply>());
}

function preparedByRun(): Map<string, PreparedRegeneration> {
  return resolveGlobalSingleton(PREPARED_BY_RUN_KEY, () => new Map<string, PreparedRegeneration>());
}

/** Supplies trusted structured text before any UI, transcript, or delivery finalizes the run. */
export function prepareAuthoritativeReplyRegeneration(params: {
  runId: string;
  sourceText: string;
  regeneratedText: string;
}): void {
  const regeneratedText = params.regeneratedText.trim();
  if (params.sourceText && regeneratedText) {
    preparedByRun().set(params.runId, { sourceText: params.sourceText, regeneratedText });
  }
}

export function resolveAuthoritativeReplyText(params: {
  runId: string | undefined;
  text: string;
  policy: TurnPresentationPolicy | undefined;
  regenerate?: () => string | undefined;
}): FinalizedReply {
  const runId = params.runId;
  if (!runId) {
    return finalizeReplyText(params);
  }
  const existing = finalizedByRun().get(runId);
  if (existing) {
    return existing;
  }
  const prepared = preparedByRun().get(runId);
  const regenerate =
    prepared?.sourceText === params.text ? () => prepared.regeneratedText : params.regenerate;
  const finalized = finalizeReplyText({ ...params, ...(regenerate ? { regenerate } : {}) });
  finalizedByRun().set(runId, finalized);
  return finalized;
}

/** True when active run finalization already chose these exact bytes. */
export function isAuthoritativeReplyText(text: string, runId?: string): boolean {
  if (runId) {
    return finalizedByRun().get(runId)?.text === text;
  }
  return [...finalizedByRun().values()].some((finalized) => finalized.text === text);
}

export function clearAuthoritativeReplyText(runId: string): void {
  finalizedByRun().delete(runId);
  preparedByRun().delete(runId);
}

/** Test seam: the memo is process-local run state with no other owner. */
export function resetAuthoritativeReplyTextForTest(): void {
  finalizedByRun().clear();
  preparedByRun().clear();
}
