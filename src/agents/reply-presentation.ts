import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
/**
 * Reads one conversation's reply-presentation policy from its channel plugin.
 *
 * Core asks; it never decides. Expected reply language, allowed proper nouns
 * and fallback wording are product knowledge owned by the channel, so they
 * arrive here as data and core only carries them to the validator. A channel
 * that declares nothing yields undefined, and every surface then behaves
 * exactly as it did before. Mirrors how `resolveGroupToolPolicy` asks
 * `plugin.groups.resolveToolPolicy` rather than keeping channel rules in core.
 */
import type { ChannelAgentPromptAdapter } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TurnPresentationPolicy } from "../infra/reply-language-policy.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export function resolveChannelReplyPresentation(params: {
  cfg: OpenClawConfig;
  channel: string | undefined;
  accountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  senderId?: string | null;
  /** The user's message for this turn. Never model output. */
  requestText?: string | null;
}): TurnPresentationPolicy | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let resolve: NonNullable<ChannelAgentPromptAdapter["replyPresentation"]>;
  try {
    const plugin = getLoadedChannelPlugin(channel);
    const declared = plugin?.agentPrompt?.replyPresentation;
    if (!declared) {
      return undefined;
    }
    resolve = declared;
  } catch {
    return undefined;
  }
  try {
    return resolve({
      cfg: params.cfg,
      accountId: params.accountId ?? null,
      groupId: params.groupId ?? null,
      groupChannel: params.groupChannel ?? null,
      groupSpace: params.groupSpace ?? null,
      senderId: params.senderId ?? null,
      requestText: params.requestText ?? null,
    });
  } catch {
    // A policy that cannot be read must not take the turn down with it. The
    // turn then runs unvalidated, which is the pre-existing behaviour.
    return undefined;
  }
}
