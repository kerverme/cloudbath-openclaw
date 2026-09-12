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

/** Lines first, then sentence ends. Never sub-word: dropping words is stripping. */
function segments(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?;:。！？])\s+/u))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function hasTechnicalToken(text: string): boolean {
  return text.split(/\s+/u).some((token) => token && isTechnicalToken(token));
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
  const kept: string[] = [];
  for (const part of parts) {
    if (validateReplyLanguage(part, policy).valid) {
      kept.push(part);
      continue;
    }
    if (hasTechnicalToken(part)) {
      return undefined;
    }
  }
  if (kept.length === 0) {
    return undefined;
  }
  const rewritten = kept.join(" ");
  const trimmedLength = text.trim().length;
  if (trimmedLength > 0 && rewritten.length / trimmedLength < MIN_KEPT_RATIO) {
    return undefined;
  }
  return validateReplyLanguage(rewritten, policy).valid ? rewritten : undefined;
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
    return {
      text: fallback,
      outcome: "fallback",
      repairKind: "fallback",
      validation: validateReplyLanguage(fallback, policy),
    };
  }
  // No rebuild, no safe rewrite, and the owning layer supplied no wording we
  // could honestly send instead. Report it rather than pretend it is fixed.
  return { text: params.text, outcome: "unrepaired", repairKind: "none", validation };
}

/**
 * Per-run memo so every surface reads one decision.
 *
 * Single slot per run, keyed by the source text it was computed from: a surface
 * that finalizes a DIFFERENT source text recomputes rather than inherit a
 * decision that was never about its text. Cleared with the run.
 */
type MemoEntry = { sourceText: string; finalized: FinalizedReply };
const FINALIZED_BY_RUN_KEY = Symbol.for("openclaw.replyLanguage.finalizedByRun");

function finalizedByRun(): Map<string, MemoEntry> {
  return resolveGlobalSingleton(FINALIZED_BY_RUN_KEY, () => new Map<string, MemoEntry>());
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
  if (existing?.sourceText === params.text) {
    return existing.finalized;
  }
  const finalized = finalizeReplyText(params);
  finalizedByRun().set(runId, { sourceText: params.text, finalized });
  return finalized;
}

export function clearAuthoritativeReplyText(runId: string): void {
  finalizedByRun().delete(runId);
}

/** Test seam: the memo is process-local run state with no other owner. */
export function resetAuthoritativeReplyTextForTest(): void {
  finalizedByRun().clear();
}
