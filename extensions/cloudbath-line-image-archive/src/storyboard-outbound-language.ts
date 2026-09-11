/**
 * Last-gate language check on the text LINE is about to send.
 *
 * The storyboard document and the tool result are already clean, and the tool
 * result carries a ready-made Thai `summary`. None of that binds the model: the
 * visible reply is composed by the agent AFTER the tool returns, so it can
 * paraphrase the summary into something the owner never asked for — the
 * production symptom was a reply reading "ไม่มีตัวอักษรp", a model-authored
 * sentence with a stray Latin letter welded on. An instruction to relay
 * verbatim is advice; this is the enforcement.
 *
 * Repair here is REBUILD, not strip. Stripping "p" from "ไม่มีตัวอักษรp"
 * leaves "ไม่มีตัวอักษร" — grammatical Thai that still tells the owner
 * nothing true about their storyboard. The clean text already exists as
 * structured fields, so the fix is to send that instead of salvaging prose.
 */
import { validateThaiText, type ThaiValidationOptions } from "./storyboard-language.js";

/**
 * Minimal, deterministic Thai used when there is nothing structured to rebuild
 * from. It states only what the system can always know.
 */
export const STORYBOARD_SAFE_THAI_FALLBACK = "อัปเดต Storyboard เรียบร้อยแล้ว";

/**
 * A paid-confirmation code in outbound text.
 *
 * Text carrying one is never rewritten: the code is the owner's only way to
 * authorise a billable render, and replacing the message that carries it would
 * either drop it or, worse, surface a stale one. A contaminated confirmation is
 * reported and passed through unchanged rather than repaired.
 */
const VIDEO_CONFIRMATION_CODE = /\bVIDEO\s+[A-Za-z0-9]{3,}\b/u;

export type OutboundLanguageDecision =
  | Readonly<{ kind: "pass" }>
  | Readonly<{ kind: "rebuilt"; text: string; fragments: readonly string[] }>
  | Readonly<{ kind: "fallback"; text: string; fragments: readonly string[] }>
  | Readonly<{ kind: "skipped_paid_confirmation"; fragments: readonly string[] }>;

export type OutboundLanguageParams = ThaiValidationOptions &
  Readonly<{
    text: string;
    /**
     * The deterministic summary for this conversation's storyboard, when one
     * exists. Called only on failure, so a clean reply costs nothing.
     */
    rebuild?: () => string | undefined;
    fallback?: string;
  }>;

/**
 * Decides what LINE should actually send.
 *
 * Returns `pass` for everything it does not positively judge wrong, so a reply
 * this layer does not understand is never altered.
 */
export function guardThaiOutboundText(params: OutboundLanguageParams): OutboundLanguageDecision {
  const text = params.text;
  const options: ThaiValidationOptions = params.allowedTerms
    ? { allowedTerms: params.allowedTerms }
    : {};
  const verdict = validateThaiText(text, options);
  if (verdict.kind === "clean") {
    return { kind: "pass" };
  }
  if (VIDEO_CONFIRMATION_CODE.test(text)) {
    return { kind: "skipped_paid_confirmation", fragments: verdict.fragments };
  }
  const rebuilt = params.rebuild?.()?.trim();
  if (rebuilt && validateThaiText(rebuilt, options).kind === "clean") {
    return { kind: "rebuilt", text: rebuilt, fragments: verdict.fragments };
  }
  // Nothing structured to fall back on, or the rebuild is contaminated too.
  // Either way the owner gets short, true, deterministic Thai rather than
  // prose assembled from a corrupted sentence.
  return {
    kind: "fallback",
    text: params.fallback?.trim() || STORYBOARD_SAFE_THAI_FALLBACK,
    fragments: verdict.fragments,
  };
}

/** The replacement text a decision implies, or undefined to send as-is. */
export function outboundReplacementText(decision: OutboundLanguageDecision): string | undefined {
  return decision.kind === "rebuilt" || decision.kind === "fallback" ? decision.text : undefined;
}
