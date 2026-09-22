/**
 * The authoritative reply text, applied to the history the Control UI renders.
 *
 * A Thai LINE turn produced `페이스` — Hangul — inside Thai prose. The validator
 * flags it correctly, delivery replaced it, and LINE received the repaired
 * wording. The Control UI showed the Hangul anyway, and kept showing it.
 *
 * The reason is that the turn's decision reaches the surfaces that CONSUME the
 * reply and not the one that STORES it. `finalizeDeliveryPayloadsLanguage`
 * rewrites the outbound payloads at the end of the turn; the gateway repairs
 * the live chat final it projects. The transcript is written earlier, from the
 * provider's raw assistant message, and nothing revisits it — so for a LINE
 * turn, whose Control UI view is history rather than a live run, the raw text
 * is the only text the UI ever had.
 *
 * Repairing the stored transcript is not the answer: it is also the model's own
 * replay history, and rewriting what a provider said can invalidate replay
 * signatures. So the transcript keeps what the model produced, and the display
 * projection applies the same decision delivery made.
 *
 * That decision is reproducible here rather than remembered. `finalizeReplyText`
 * is deterministic in (text, policy), and the policy is configuration plus the
 * request that opened the turn — which history already contains, as the user
 * message ahead of each reply. Resolving it per assistant message is what keeps
 * a deliberately multilingual turn intact: the user who asked for a translation
 * declared the override, and their request is still right there.
 */
import { resolveChannelReplyPresentation } from "../agents/reply-presentation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { traceChatProjection } from "../infra/chat-projection-trace.js";
import {
  validateReplyLanguage,
  type TurnPresentationPolicy,
} from "../infra/reply-language-policy.js";
import { finalizeReplyText } from "../infra/reply-language-repair.js";

type DisplayMessage = Record<string, unknown>;

/** Text blocks of a projected display message, in order. */
function textBlocks(message: DisplayMessage): { text: string; write(next: string): void }[] {
  const content = message.content;
  if (typeof content === "string") {
    return [{ text: content, write: (next) => void (message.content = next) }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: { text: string; write(next: string): void }[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push({ text: record.text, write: (next) => void (record.text = next) });
    }
  }
  return blocks;
}

function joinedText(message: DisplayMessage): string {
  return textBlocks(message)
    .map((block) => block.text)
    .join("");
}

function normalizedRole(message: DisplayMessage): string {
  const role = message.role;
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

export type ChatHistoryReplyLanguageParams = Readonly<{
  messages: readonly unknown[];
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  groupId?: string | null;
  sessionKey?: string;
  /** Injected in tests; production resolves through the channel plugin. */
  resolvePolicy?: typeof resolveChannelReplyPresentation;
}>;

/**
 * Replaces assistant text the turn's policy would not have delivered.
 *
 * Returns the same array when nothing changed, so an ordinary history page —
 * which is almost all of them — allocates nothing.
 */
export function applyAuthoritativeReplyLanguageToHistory(
  params: ChatHistoryReplyLanguageParams,
): readonly unknown[] {
  const channel = params.channel?.trim();
  if (!channel || params.messages.length === 0) {
    return params.messages;
  }
  const resolvePolicy = params.resolvePolicy ?? resolveChannelReplyPresentation;
  let requestText: string | null = null;
  let changed = false;
  const repaired = params.messages.map((raw) => {
    if (!raw || typeof raw !== "object") {
      return raw;
    }
    const message = raw as DisplayMessage;
    const role = normalizedRole(message);
    if (role === "user") {
      // The request that opened the turn, which is what declares a deliberately
      // multilingual reply. Carried forward until the next one replaces it.
      requestText = joinedText(message) || null;
      return raw;
    }
    if (role !== "assistant") {
      return raw;
    }
    const blocks = textBlocks(message);
    if (blocks.length === 0) {
      return raw;
    }
    let policy: TurnPresentationPolicy | undefined;
    try {
      policy = resolvePolicy({
        cfg: params.cfg,
        channel,
        accountId: params.accountId ?? null,
        groupId: params.groupId ?? null,
        requestText,
      });
    } catch {
      // A policy that cannot be read must not take a history page down with it.
      return raw;
    }
    if (!policy) {
      return raw;
    }
    const next = { ...message, content: structuredClone(message.content) } as DisplayMessage;
    let messageChanged = false;
    for (const block of textBlocks(next)) {
      if (!block.text.trim()) {
        continue;
      }
      const finalized = finalizeReplyText({ text: block.text, policy });
      if (finalized.outcome === "valid" || finalized.outcome === "unchecked") {
        continue;
      }
      // The finalized result validates clean by construction; what an operator
      // needs is why the ORIGINAL failed.
      const rejected = validateReplyLanguage(block.text, policy);
      traceChatProjection({
        state: "final",
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        expectedLanguage: policy.expectedReplyLanguage,
        expectedLanguageSource: policy.expectedReplyLanguageSource,
        validationReason: rejected.reason,
        detectedScripts: [...rejected.detectedScripts],
        violatingScripts: [...rejected.violatingScripts],
        disposition: finalized.outcome,
      });
      if (finalized.text !== block.text) {
        block.write(finalized.text);
        messageChanged = true;
      }
    }
    if (!messageChanged) {
      return raw;
    }
    changed = true;
    return next;
  });
  return changed ? repaired : params.messages;
}
