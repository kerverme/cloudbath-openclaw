/**
 * Applies the turn's authoritative text to the payloads that will be delivered.
 *
 * Delivery and the Control UI are separate paths: the UI observes the streamed
 * buffer while a channel receives these payloads. Before this, each repaired
 * independently — the UI showed the provider's raw text and LINE showed a
 * differently repaired version of the same turn. Both now read the same per-run
 * decision, so one turn has one wording everywhere it is shown or stored.
 *
 * Error and reasoning payloads are left alone: they are runtime reporting, not
 * the assistant's reply to the user.
 */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { resolveAuthoritativeReplyText } from "../infra/reply-language-repair.js";

export function finalizeDeliveryPayloadsLanguage(params: {
  runId: string | undefined;
  payloads: ReplyPayload[] | undefined;
}): ReplyPayload[] | undefined {
  const payloads = params.payloads;
  const runId = params.runId;
  if (!payloads?.length || !runId) {
    return payloads;
  }
  const policy = getAgentRunContext(runId)?.replyPresentation;
  if (!policy) {
    return payloads;
  }
  let changed = false;
  const finalized = payloads.map((payload) => {
    const text = payload?.text;
    if (!text || payload.isError === true || payload.isReasoning === true) {
      return payload;
    }
    const authoritative = resolveAuthoritativeReplyText({ runId, text, policy });
    if (authoritative.text === text) {
      return payload;
    }
    changed = true;
    return { ...payload, text: authoritative.text };
  });
  return changed ? finalized : payloads;
}
