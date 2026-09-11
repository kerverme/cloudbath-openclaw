/**
 * Tool surface for LINE group conversations.
 *
 * Group tool policy is opt-in everywhere else in OpenClaw: when a group has no
 * `tools` entry, `resolveChannelGroupToolsPolicy` returns undefined and the
 * session keeps the agent's FULL tool surface. For a channel whose groups are
 * created by anyone who can add the bot, that default is backwards — a brand
 * new LINE group inherited the main agent's shell, cross-session history,
 * workspace memory search and host status tools before an operator had ever
 * seen the group id, which is how ordinary messages in a fresh group ended up
 * running `exec` and reading another group's transcript.
 *
 * So an unbound LINE group starts from the baseline below instead of from
 * everything. Conversation, media and plugin tools are untouched; the denied
 * set is the part that reaches outside this one conversation, or outside the
 * product, into the host. An operator who wants a privileged tool in a
 * particular group says so in config, and that entry wins whole.
 */
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveChannelGroupToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";

/**
 * Tools an unbound LINE group does not get.
 *
 * Grouped by what each one reaches, because that is the rule being applied —
 * not a list of tools anyone happened to see misused. Plugin tools
 * (`cloudbath_storyboard`, image/video generation, `message`) are deliberately
 * absent: they are scoped to the conversation that invokes them.
 */
export const LINE_UNBOUND_GROUP_DENIED_TOOLS: readonly string[] = Object.freeze([
  // Host: shell, process control and the filesystem the agent runs on.
  "exec",
  "process",
  "code_execution",
  "read",
  "write",
  "edit",
  "apply_patch",
  // Other conversations: session transcripts, fan-out and sub-agents.
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "spawn_task",
  // Agent-wide memory. Scoped per agent, not per conversation, so an
  // unrestricted group searches every other group's indexed material.
  "memory_search",
  "memory_get",
  // Agent-wide goal/plan state, shared across every conversation.
  "get_goal",
  "create_goal",
  "update_goal",
  "update_plan",
  // Operator surfaces: runtime status, scheduling, gateway and node admin.
  "session_status",
  "cron",
  "gateway",
  "nodes",
  "agents_list",
  "skill_workshop",
  // Remote control of a real machine.
  "browser",
  "canvas",
  "computer",
]);

/**
 * The effective tool policy for a LINE group.
 *
 * A configured policy wins entirely rather than merging with the baseline: an
 * operator who writes `tools` for a group (or for `*`) has stated the surface
 * they want, and silently re-denying part of it would make the config lie.
 */
export function resolveLineGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const configured = resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "line",
    groupId: params.groupId,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  return configured ?? { deny: [...LINE_UNBOUND_GROUP_DENIED_TOOLS] };
}
