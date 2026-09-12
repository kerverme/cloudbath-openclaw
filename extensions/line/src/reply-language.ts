/**
 * The language a LINE conversation's replies are expected to be written in.
 *
 * Until now nothing in the product knew this. The outbound language guard
 * decided "is this Thai?" by looking at the text the model had just produced —
 * which means a reply written entirely in Russian answered a Thai question and
 * passed, because it contained no Thai to be inconsistent with. Inferring the
 * expectation from the output cannot catch the case where the whole output is
 * wrong.
 *
 * So the expectation is configuration, resolved once per conversation:
 *
 *   channels.line.replyLanguage                  account default
 *   channels.line.groups.<id>.replyLanguage      per-group override
 *
 * `source` is part of the result on purpose. A consumer must be able to tell a
 * configured policy from an absent one and from a guess, so that "no config"
 * keeps today's behaviour instead of silently inventing an expectation.
 */
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import type { LineConfig } from "./types.js";

/**
 * Where the expectation came from.
 *
 * - `group`   an explicit per-group override
 * - `account` the account default
 * - `none`    nothing configured; callers must not invent one
 */
export type ReplyLanguageSource = "group" | "account" | "none";

export type ReplyLanguageResolution = Readonly<{
  /** Normalized language subtag, e.g. `th`. Absent when nothing is configured. */
  language?: string;
  source: ReplyLanguageSource;
}>;

const NOT_CONFIGURED: ReplyLanguageResolution = Object.freeze({ source: "none" });

/**
 * Normalizes a configured tag to its primary subtag, lowercased.
 *
 * `th`, `th-TH` and `TH` all describe the same expectation for this purpose:
 * the guard reasons about scripts, not regional variants. Returning undefined
 * for an unusable value keeps a typo from being treated as a real policy.
 */
function normalizeLanguageTag(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const primary = value.trim().split(/[-_]/u)[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/u.test(primary) ? primary : undefined;
}

/**
 * The expected reply language for one LINE conversation.
 *
 * An explicit group override wins over the account default, and neither is
 * inferred from anything the model produced. A group entry that omits
 * `replyLanguage` inherits the account default rather than clearing it: the
 * absence of a field is not a statement about language.
 */
export function resolveLineReplyLanguage(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  roomId?: string | null;
}): ReplyLanguageResolution {
  const lineConfig = params.cfg.channels?.line as LineConfig | undefined;
  if (!lineConfig) {
    return NOT_CONFIGURED;
  }
  const account = resolveAccountEntry(lineConfig.accounts, normalizeAccountId(params.accountId));
  const groups = account?.groups ?? lineConfig.groups;
  const groupEntry = resolveLineGroupConfigEntry(groups, {
    groupId: params.groupId ?? null,
    roomId: params.roomId ?? null,
  });
  const groupLanguage = normalizeLanguageTag(groupEntry?.replyLanguage);
  if (groupLanguage) {
    return Object.freeze({ language: groupLanguage, source: "group" });
  }
  const accountLanguage = normalizeLanguageTag(account?.replyLanguage ?? lineConfig.replyLanguage);
  return accountLanguage
    ? Object.freeze({ language: accountLanguage, source: "account" })
    : NOT_CONFIGURED;
}
