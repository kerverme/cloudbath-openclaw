/**
 * Content-free trace of the chat payloads one session projects to the UI.
 *
 * The Control UI has shown the same answer twice, and the shipped logs cannot
 * say whether the gateway broadcast one final or two, nor under which run ids.
 * That is the whole question: two finals for the SAME run is a projection
 * defect, two finals for DIFFERENT runs lands in the UI's one non-deduping
 * append branch, and one final means the duplicate was never on the wire.
 *
 * The field set below is CLOSED on purpose. Message content, deltas and
 * payload bodies have no representable field here, so a caller holding a whole
 * chat payload cannot leak it through this seam even by casting past the type.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("chat-projection-trace");

/** Which lifecycle state the projected payload carried. */
export type ChatProjectionState = "delta" | "final" | "aborted" | "error" | "unknown";

/**
 * How the Control UI's chat state handles a final for this session.
 *
 * Mirrors the branches in `ui/src/pages/chat/chat-gateway.ts` so a trace line
 * names the code path rather than leaving a reader to infer it. `appended`
 * marks the branch that adds a message without reconciling against what is
 * already rendered — the one that can show an answer twice.
 */
export type ChatFinalBranch =
  /** Final for the run the UI is already rendering; reconciled against the stream. */
  | "reconciled_active_run"
  /** Final for a DIFFERENT run in this session; appended with no dedupe. */
  | "appended_foreign_run"
  /** Final for a session the UI is not viewing; cached, not rendered. */
  | "cached_other_session";

export type ChatProjectionTraceFields = Readonly<{
  state?: ChatProjectionState;
  /** The run id on the payload, which is what the UI matches against. */
  runId?: string;
  /** The agent run the payload came from, when it differs from `runId`. */
  sourceRunId?: string;
  seq?: number;
  sessionKey?: string;
  agentId?: string;
  branch?: ChatFinalBranch;
  /** Whether the payload was delivered to every Control UI client. */
  broadcast?: boolean;
}>;

const TRACE_FIELD_KEYS = [
  "state",
  "runId",
  "sourceRunId",
  "seq",
  "sessionKey",
  "agentId",
  "branch",
  "broadcast",
] as const satisfies ReadonlyArray<keyof ChatProjectionTraceFields>;

/**
 * Exported so the no-content guarantee is asserted against the real payload
 * rather than against a stubbed logger.
 */
export function buildChatProjectionTraceRecord(
  fields: ChatProjectionTraceFields = {},
): Record<string, unknown> {
  // Copied key by key, never spread: a caller that reaches this seam holding a
  // whole chat payload cannot leak its message into the log, so the closed
  // field set holds at runtime and not merely in the type.
  const record: Record<string, unknown> = { event: "chat_projection" };
  for (const key of TRACE_FIELD_KEYS) {
    const value = fields[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

/** Reads the lifecycle state off a payload without reading anything else. */
export function resolveChatProjectionState(payload: unknown): ChatProjectionState {
  const state = (payload as { state?: unknown })?.state;
  return state === "delta" || state === "final" || state === "aborted" || state === "error"
    ? state
    : "unknown";
}

export function traceChatProjection(fields: ChatProjectionTraceFields = {}): void {
  log.info("chat projection", buildChatProjectionTraceRecord(fields));
}
