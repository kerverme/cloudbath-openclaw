/**
 * Which branch of the chat state handles one `state:"final"` payload.
 *
 * The Control UI has shown the same answer twice, and the three branches in
 * `handleChatEvent` behave differently: two of them reconcile the final
 * against what is already rendered, and one appends it with no dedupe at all.
 * Naming them makes a duplicate reproducible from a trace instead of a
 * reading of the conditions, and the gateway emits the same vocabulary from
 * `src/infra/chat-projection-trace.ts`.
 *
 * Pure and diagnostic: this decides nothing. `handleChatEvent` keeps its own
 * conditions, and this reports which of them applied.
 */
export type ChatFinalBranch =
  /** Final for the run being rendered; reconciled against the live stream. */
  | "reconciled_active_run"
  /** Final for a DIFFERENT run in this session; appended with no dedupe. */
  | "appended_foreign_run"
  /** Final for a session that is not open; cached, not rendered. */
  | "cached_other_session";

export function classifyChatFinalBranch(params: {
  sessionMatches: boolean;
  activeRunMatches: boolean;
  activeRunId: string | null;
  payloadRunId?: string;
}): ChatFinalBranch {
  if (!params.sessionMatches && !params.activeRunMatches) {
    return "cached_other_session";
  }
  // An adopted run (the UI had none and took the payload's) matches from here
  // on, so only a final whose run differs from the one being rendered lands in
  // the append branch.
  return params.activeRunId && params.payloadRunId !== params.activeRunId
    ? "appended_foreign_run"
    : "reconciled_active_run";
}
