/**
 * Content-free trace of one run's reply decision and its delivery window.
 *
 * A LINE translation turn reaches the Control UI correctly and LINE incorrectly,
 * and the shipped logs carry neither run identity nor lifecycle ordering, so the
 * two surfaces cannot be lined up against one turn. This records who decided,
 * when the window opened and closed, and what each delivery hook saw.
 *
 * The field set below is CLOSED on purpose. Reply text, prompt text, payloads,
 * tokens and secrets have no representable field here, so a caller cannot log
 * them through this seam even by accident — which is the property the tests
 * pin. Callers pass ids and booleans; everything else is refused by the type.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("reply-delivery-trace");

/** Stages of one run's reply decision, in the order a healthy turn passes them. */
export type ReplyDeliveryTraceEvent =
  /** The run recorded (or reused) its authoritative reply text. */
  | "authoritative_finalized"
  /** The turn opened the window that keeps the decision readable for delivery. */
  | "delivery_window_claimed"
  /** Delivery finished; the window closed and the run may be released. */
  | "delivery_window_released"
  /** Something asked for the run to be cleared — possibly mid-delivery. */
  | "run_context_clear_requested"
  /** The run's authoritative text was actually released. */
  | "authoritative_cleared"
  /** A channel delivery hook is about to decide whether to rewrite the reply. */
  | "delivery_hook_examined";

/** Which delivery seam a channel reply arrived on. */
export type ReplyDeliveryHook = "reply_payload_sending" | "message_sending";

/**
 * Every field this trace may carry. Ids, booleans and short enums only.
 *
 * `runId` is the id the emitting site itself holds; `eventRunId` and `ctxRunId`
 * are recorded separately at delivery because a mismatch between them is one of
 * the things this trace exists to detect.
 */
export type ReplyDeliveryTraceFields = Readonly<{
  runId?: string;
  eventRunId?: string;
  ctxRunId?: string;
  sessionKey?: string;
  conversationId?: string;
  channelId?: string;
  hook?: ReplyDeliveryHook;
  /** What `isAuthoritativeReplyText` answered at this point. */
  authoritativeFound?: boolean;
  /** Whether a delivery window was open for this run. */
  deliveryWindowClaimed?: boolean;
  /** Whether a clear was requested while the window was still open. */
  clearRequested?: boolean;
  /** Lifecycle marker, e.g. the run's lifecycle generation or terminal phase. */
  lifecyclePhase?: string;
  /** Whether the turn carried an expected-language policy at all. */
  policyPresent?: boolean;
  /** Whether the turn declared a multilingual override, and for which language. */
  multilingualAllowed?: boolean;
  multilingualLanguage?: string;
  provider?: string;
  model?: string;
}>;

/**
 * The exact record that reaches the log, with absent fields dropped so one
 * turn's lines stay comparable and short.
 *
 * Exported so the no-content guarantee is asserted against the real payload
 * rather than against a stubbed logger.
 */
const TRACE_FIELD_KEYS = [
  "runId",
  "eventRunId",
  "ctxRunId",
  "sessionKey",
  "conversationId",
  "channelId",
  "hook",
  "authoritativeFound",
  "deliveryWindowClaimed",
  "clearRequested",
  "lifecyclePhase",
  "policyPresent",
  "multilingualAllowed",
  "multilingualLanguage",
  "provider",
  "model",
] as const satisfies ReadonlyArray<keyof ReplyDeliveryTraceFields>;

export function buildReplyDeliveryTraceRecord(
  event: ReplyDeliveryTraceEvent,
  fields: ReplyDeliveryTraceFields = {},
): Record<string, unknown> {
  // Copied key by key, never spread. A caller that reaches this seam holding a
  // wider object — a payload, an event, a whole context — cannot leak the extra
  // keys into the log, so the closed field set holds at runtime and not merely
  // in the type.
  const record: Record<string, unknown> = { event };
  for (const key of TRACE_FIELD_KEYS) {
    const value = fields[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

/**
 * Emits one trace line.
 *
 * Info level: this is a production incident trace that must survive a single
 * real turn without the operator turning anything on first, which is exactly
 * what the previous round of logs failed to do.
 */
export function traceReplyDelivery(
  event: ReplyDeliveryTraceEvent,
  fields: ReplyDeliveryTraceFields = {},
): void {
  log.info(`reply-delivery ${event}`, buildReplyDeliveryTraceRecord(event, fields));
}
