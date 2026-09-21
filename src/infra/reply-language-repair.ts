import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
import { traceReplyDelivery } from "./reply-delivery-trace.js";
import {
  validateReplyLanguage,
  type ReplyLanguageValidation,
  type TurnPresentationPolicy,
} from "./reply-language-policy.js";
import { currentTurnLatencyLedger } from "./turn-latency-ledger.js";

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
 * A colon or semicolon ends a clause, not a sentence, so it is not a boundary:
 * splitting there made `เดือน 1-2:` its own segment, and dropping the text
 * after it left the label behind promising content that was no longer in the
 * reply. A label and what it introduces stand or fall together.
 *
 * Offsets are kept so a rewrite can cut the violating spans out of the ORIGINAL
 * text and leave every surviving byte, including its line breaks, exactly as
 * the model wrote it.
 */
function segments(text: string): Segment[] {
  const found: Segment[] = [];
  let cursor = 0;
  for (const line of text.split(/\r?\n/u)) {
    for (const piece of line.split(/(?<=[.!?。！？])\s+/u)) {
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

/**
 * A critical exact span is a token whose loss changes the operation: a link, a
 * path or address, an opaque or confirmation id, a machine identifier.
 *
 * This is NOT the validator's `isTechnicalToken`, and the difference is the
 * whole point. That predicate answers "is this prose I should count towards the
 * language expectation?", where being generous is free — a bare `5` is not a
 * word. Repair asks a different question, "would the reply be broken without
 * this exact string?", where being generous is destructive: every number and
 * range in the reply counted as critical, so one contaminated line could
 * neither be dropped nor repaired, and the fallback trailed a meaningless dump
 * of the reply's numbers.
 */
const VIDEO_CODE = /\bVIDEO\s+[A-Za-z0-9]{3,}\b/gu;
/** Counts, ranges, percentages, decimals, times, fractions, dates. */
const ORDINARY_NUMBER = /^[0-9]+(?:[.:/-][0-9]+)*%?$/u;
const IDENTIFIER_CHARS = /^[A-Za-z0-9._:/@+~#?&=%-]+$/u;
/** Punctuation that separates or locates; a full stop alone does not qualify. */
const STRUCTURAL_PUNCTUATION = /[_:/@#?&=~]/u;
/** Dotted labels ending in a real TLD, so `example.com` is a link and `i.e.` is prose. */
const DOMAIN_LIKE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;
const LEADING_PROSE_PUNCTUATION = /^[([{"'\u00ab\u201c\u2018]+/u;
const TRAILING_PROSE_PUNCTUATION = /[)\]}"'\u00bb\u201d\u2019.,;:!?\u2026]+$/u;

/** The identifier inside a prose token, or undefined when the token is prose. */
function criticalExactSpan(token: string): string | undefined {
  const span = token.replace(LEADING_PROSE_PUNCTUATION, "").replace(TRAILING_PROSE_PUNCTUATION, "");
  if (!span || !IDENTIFIER_CHARS.test(span) || ORDINARY_NUMBER.test(span)) {
    return undefined;
  }
  const carriesAnOperation =
    /[A-Za-z]/u.test(span) && (STRUCTURAL_PUNCTUATION.test(span) || /[0-9]/u.test(span));
  return carriesAnOperation || DOMAIN_LIKE.test(span) ? span : undefined;
}

function hasCriticalExactSpan(text: string): boolean {
  return (
    text.match(VIDEO_CODE) !== null ||
    text.split(/\s+/u).some((token) => criticalExactSpan(token) !== undefined)
  );
}

function criticalExactSpans(text: string): string[] {
  const videoCodes = text.match(VIDEO_CODE) ?? [];
  const codeParts = new Set(videoCodes.flatMap((code) => code.split(/\s+/u)));
  const spans = text.split(/\s+/u).flatMap((token) => {
    const span = criticalExactSpan(token);
    // A code's own id is already carried by the whole `VIDEO 4821` span.
    return span && !codeParts.has(span) ? [span] : [];
  });
  return [...new Set([...videoCodes, ...spans])];
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
    if (hasCriticalExactSpan(part.text)) {
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
    const protectedSpans = criticalExactSpans(params.text);
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
  currentTurnLatencyLedger()?.mark("authoritative.finalize");
  traceReplyDelivery("authoritative_finalized", {
    runId,
    policyPresent: Boolean(params.policy),
    ...(params.policy?.multilingualOverride
      ? {
          multilingualAllowed: params.policy.multilingualOverride.allowed,
          ...(params.policy.multilingualOverride.language
            ? { multilingualLanguage: params.policy.multilingualOverride.language }
            : {}),
        }
      : {}),
    lifecyclePhase: finalized.outcome,
  });
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
  traceReplyDelivery("authoritative_cleared", {
    runId,
    authoritativeFound: finalizedByRun().has(runId),
  });
  finalizedByRun().delete(runId);
  preparedByRun().delete(runId);
}

/** Test seam: the memo is process-local run state with no other owner. */
export function resetAuthoritativeReplyTextForTest(): void {
  finalizedByRun().clear();
  preparedByRun().clear();
}
