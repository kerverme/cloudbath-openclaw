/**
 * Which turns may drive deterministic model control, and whose state they use.
 *
 * Model control acts on the session a turn belongs to, so the only thing a
 * surface decides is WHO is speaking and whether they own it. LINE names its
 * owner by sender id. A Control UI send carries no sender id at all (chat.send
 * omits it for operator UI clients) and is owner only through the gateway's
 * operator.admin scope, so the operator is its principal. Picker and reference
 * state is keyed by session + principal, which keeps one group's (or one
 * owner's) pending choices from ever answering another's turn.
 */
import { resolveLineOwnerScopeKey } from "./model-catalog-tool.js";

type ModelControlDispatchEvent = {
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

type ModelControlDispatchContext = {
  sessionKey?: string;
  agentId?: string;
};

export type ModelControlTurn = {
  /** The canonical session key being viewed; every read and write targets it. */
  sessionKey: string;
  agentId?: string;
  principal: string;
  scopeKey: string;
};

const WEBCHAT_OPERATOR_PRINCIPAL = "webchat:operator";

function resolvePrincipal(event: ModelControlDispatchEvent): string | undefined {
  const senderId = event.senderId?.trim();
  if (event.channel === "line") {
    return senderId;
  }
  if (event.channel === "webchat") {
    return senderId ? `webchat:${senderId}` : WEBCHAT_OPERATOR_PRINCIPAL;
  }
  return undefined;
}

/** Undefined unless the turn is an owner's, on a surface model control serves. */
export function resolveModelControlTurn(
  event: ModelControlDispatchEvent,
  ctx: ModelControlDispatchContext,
): ModelControlTurn | undefined {
  if (event.senderIsOwner !== true) {
    return undefined;
  }
  const principal = resolvePrincipal(event);
  const sessionKey = (ctx.sessionKey ?? event.sessionKey)?.trim();
  if (!principal || !sessionKey) {
    return undefined;
  }
  const scopeKey = resolveLineOwnerScopeKey({
    sessionId: sessionKey,
    requesterSenderId: principal,
  });
  return scopeKey ? { sessionKey, agentId: ctx.agentId, principal, scopeKey } : undefined;
}
