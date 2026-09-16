/**
 * How much operational detail the system prompt may name for one conversation.
 *
 * `buildRuntimeLine` renders `host=`, `os=`, `arch=`, `node=`, `shell=` and
 * `repo=` into the system prompt for every run. None of that changes how the
 * agent answers a chat turn, but all of it sits in the model's context, so an
 * ordinary group can simply ask for it and be told. Production showed exactly
 * that AFTER shell and status tools were removed from unbound LINE groups: the
 * reply correctly said exec was unavailable and then recited the container
 * hostname, kernel string, Node version and workspace path anyway. Restricting
 * tools could not have helped, because the data never came from a tool.
 *
 * Values are dropped from the PROMPT only. The runtime keeps its real host,
 * paths and environment, so tools that need them keep working — this decides
 * what the model is told, not what the process knows.
 */
import type { ChatType } from "../channels/chat-type.js";

export type RuntimeDisclosureScope = "operator" | "restricted";

/**
 * Infrastructure fields withheld from a restricted conversation.
 *
 * Deliberately only the host/deployment facts. Agent id, session key, channel,
 * capabilities and the model-identity line stay: they shape how the agent
 * behaves and answers, and are not deployment secrets.
 */
const RESTRICTED_RUNTIME_FIELDS = ["host", "os", "arch", "node", "shell", "repoRoot"] as const;

type RestrictedRuntimeField = (typeof RESTRICTED_RUNTIME_FIELDS)[number];

/**
 * Operational detail follows OWNER IDENTITY in a private chat, never chat
 * shape alone.
 *
 * A group is restricted even when the owner is the one speaking: the reply is
 * visible to everyone else in it, so owner presence is not consent to publish
 * the deployment's hostname to the room.
 */
export function resolveRuntimeDisclosureScope(params: {
  chatType?: ChatType | null;
  senderIsOwner?: boolean;
}): RuntimeDisclosureScope {
  return params.chatType === "direct" && params.senderIsOwner === true ? "operator" : "restricted";
}

/**
 * Strips the withheld fields for a restricted conversation.
 *
 * Returns the input unchanged for an operator scope so owner diagnostics keep
 * every value they have today.
 */
export function applyRuntimeDisclosureScope<
  T extends Partial<Record<RestrictedRuntimeField, unknown>>,
>(runtime: T, scope: RuntimeDisclosureScope): T {
  if (scope === "operator") {
    return runtime;
  }
  const restricted = { ...runtime };
  for (const field of RESTRICTED_RUNTIME_FIELDS) {
    delete restricted[field];
  }
  return restricted;
}

export { RESTRICTED_RUNTIME_FIELDS };
