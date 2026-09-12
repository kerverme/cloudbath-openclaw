/**
 * LINE's turn-level reply presentation policy.
 *
 * Core owns the mechanism that validates a reply's script and replaces a
 * corrupted one; everything product-specific lives here. Core must not know
 * what language this deployment answers in, which proper nouns are legitimate,
 * or how to apologise in Thai — so all of that is resolved here and handed over
 * as plain data.
 *
 * `allowIntentionalMultilingual` is decided from the USER's request, never from
 * the reply. A user who asks for a translation has declared a multilingual
 * turn; a reply that drifted into another language on its own is the bug being
 * caught, and letting the output vouch for itself is exactly the hole that let
 * a wholly Russian answer pass.
 */
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type {
  ChannelReplyPresentationContext,
  TurnPresentationPolicy,
} from "openclaw/plugin-sdk/channel-contract";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { resolveLineReplyLanguage } from "./reply-language.js";
import type { LineConfig } from "./types.js";

/**
 * Wording used only when a reply cannot be repaired. It states that the reply
 * failed and asks for a retry; it must never claim anything was saved, sent,
 * completed or updated, because at this point nothing is known to have been.
 */
const FALLBACK_TEXT: Readonly<Record<string, string>> = Object.freeze({
  th: "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง",
});

const DEFAULT_FALLBACK_TEXT = "Sorry — that reply came out malformed. Please ask again.";

/**
 * Requests that declare a multilingual turn.
 *
 * Deliberately a handful of explicit instructions rather than an intent
 * classifier: a translation or "answer in <language>" request is stated
 * outright, and anything subtler is better left validated than guessed at.
 */
const MULTILINGUAL_REQUEST_PATTERNS: readonly RegExp[] = Object.freeze([
  /แปล/u,
  /ทับศัพท์/u,
  /(?:ตอบ|เขียน|พูด|อ่าน)\s*(?:กลับ\s*)?เป็นภาษา/u,
  /\btransliterate\b/iu,
  /\btranslat(?:e|ion)\b/iu,
  /\b(?:reply|answer|respond|write|say)\s+(?:it\s+|this\s+|that\s+)?in\s+\p{Script=Latin}{3,}/iu,
]);

export function requestDeclaresMultilingualTurn(requestText: string | null | undefined): boolean {
  const text = requestText?.trim();
  if (!text) {
    return false;
  }
  return MULTILINGUAL_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

/** Account-level terms plus this group's, de-duplicated and trimmed. */
function resolveAllowedTerms(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  groupId: string | null | undefined,
  roomId: string | null | undefined,
): string[] {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  if (!lineConfig) {
    return [];
  }
  const account = resolveAccountEntry(lineConfig.accounts, normalizeAccountId(accountId));
  const groups = account?.groups ?? lineConfig.groups;
  const groupEntry = resolveLineGroupConfigEntry(groups, {
    groupId: groupId ?? null,
    roomId: roomId ?? null,
  });
  const terms = new Set<string>();
  for (const term of [
    ...(lineConfig.replyLanguageAllowedTerms ?? []),
    ...(account?.replyLanguageAllowedTerms ?? []),
    ...(groupEntry?.replyLanguageAllowedTerms ?? []),
  ]) {
    const trimmed = term.trim();
    if (trimmed) {
      terms.add(trimmed);
    }
  }
  return [...terms];
}

/**
 * The policy for one LINE turn, or undefined when nothing is configured.
 *
 * Returning undefined matters: with no expected language the validator asserts
 * nothing and every surface behaves exactly as it did before this existed.
 */
export function resolveLineReplyPresentation(
  params: ChannelReplyPresentationContext,
): TurnPresentationPolicy | undefined {
  const resolution = resolveLineReplyLanguage({
    cfg: params.cfg,
    accountId: params.accountId,
    groupId: params.groupId,
    roomId: params.groupSpace,
  });
  if (!resolution.language) {
    return undefined;
  }
  const allowedTerms = resolveAllowedTerms(
    params.cfg,
    params.accountId,
    params.groupId,
    params.groupSpace,
  );
  const multilingual = requestDeclaresMultilingualTurn(params.requestText);
  return {
    expectedReplyLanguage: resolution.language,
    expectedReplyLanguageSource: resolution.source,
    fallbackText: FALLBACK_TEXT[resolution.language] ?? DEFAULT_FALLBACK_TEXT,
    ...(allowedTerms.length > 0 ? { allowedTerms } : {}),
    ...(multilingual ? { allowIntentionalMultilingual: true } : {}),
  };
}
