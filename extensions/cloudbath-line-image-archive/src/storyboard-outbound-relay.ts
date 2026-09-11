/**
 * Applies the outbound language guard to the two hooks LINE actually sends
 * through.
 *
 * Both are needed, and neither is optional: LINE's reply-token delivery stays
 * on the provider-native reply path and reaches `reply_payload_sending`
 * WITHOUT reaching `message_sending`, while durable and message-tool delivery
 * reaches `message_sending`. Hooking only one leaves the model's paraphrase
 * reaching the owner by the other. This mirrors the arrangement
 * `video-draft-reply-relay.ts` already uses for the same class of problem.
 */
import { STORYBOARD_PRODUCT_TERMS, validateThaiText } from "./storyboard-language.js";
import {
  guardThaiOutboundText,
  outboundReplacementText,
  type OutboundLanguageDecision,
} from "./storyboard-outbound-language.js";

export type OutboundRelayContext = Readonly<{
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
}>;

type MessageSendingEvent = Readonly<{ content?: string; to?: string }>;
type ReplyPayloadSendingEvent = Readonly<{
  payload?: ({ text?: string } & Record<string, unknown>) | undefined;
  channel?: string;
  sessionKey?: string;
}>;

export type StoryboardOutboundRelayDeps = Readonly<{
  /**
   * The deterministic Thai summary and allowed proper nouns for this
   * conversation, or undefined when it owns no storyboard. Resolved per send so
   * a rebuild always reflects the CURRENT version.
   */
  resolve(
    ctx: OutboundRelayContext,
  ): Promise<
    Readonly<{ summary: string | undefined; allowedTerms: readonly string[] }> | undefined
  >;
  logger?: Readonly<{
    info?(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  }>;
}>;

export type StoryboardOutboundRelay = Readonly<{
  messageSending(
    event: MessageSendingEvent,
    ctx: OutboundRelayContext,
  ): Promise<{ content: string } | undefined>;
  replyPayloadSending(
    event: ReplyPayloadSendingEvent,
    ctx: OutboundRelayContext,
  ): Promise<{ payload: Record<string, unknown> } | undefined>;
}>;

export function createStoryboardOutboundRelay(
  deps: StoryboardOutboundRelayDeps,
): StoryboardOutboundRelay {
  /**
   * Decides the replacement text for one outbound string, or undefined to send
   * it unchanged. Every early return is a case this layer refuses to judge.
   */
  const decide = async (
    text: string | undefined,
    ctx: OutboundRelayContext,
    channel: string | undefined,
  ): Promise<string | undefined> => {
    const value = text?.trim();
    if (!value || (channel ?? ctx.channelId) !== "line") {
      return undefined;
    }
    // Allowed terms only ever PERMIT more text, so anything clean against the
    // static product vocabulary is clean against the fuller list too. The
    // product terms need no store read, so ordinary replies — including the
    // shipped Thai copy that names Storyboard, Model or draft — settle here and
    // this gate costs a read only when something actually looks wrong.
    if (validateThaiText(value, { allowedTerms: STORYBOARD_PRODUCT_TERMS }).kind === "clean") {
      return undefined;
    }
    const storyboard = await deps.resolve(ctx).catch(() => undefined);
    const decision = guardThaiOutboundText({
      text: value,
      ...(storyboard?.allowedTerms ? { allowedTerms: storyboard.allowedTerms } : {}),
      ...(storyboard ? { rebuild: () => storyboard.summary } : {}),
    });
    report(decision, ctx);
    return outboundReplacementText(decision);
  };

  const report = (decision: OutboundLanguageDecision, ctx: OutboundRelayContext): void => {
    if (decision.kind === "pass") {
      return;
    }
    deps.logger?.warn("storyboard_outbound_language_repaired", {
      outcome: decision.kind,
      fragments: decision.fragments,
      conversationId: ctx.conversationId,
      sessionKey: ctx.sessionKey,
    });
  };

  return {
    messageSending: async (event, ctx) => {
      const replacement = await decide(event.content, ctx, undefined);
      return replacement ? { content: replacement } : undefined;
    },
    replyPayloadSending: async (event, ctx) => {
      const replacement = await decide(event.payload?.text, ctx, event.channel);
      return replacement ? { payload: { ...event.payload, text: replacement } } : undefined;
    },
  };
}
