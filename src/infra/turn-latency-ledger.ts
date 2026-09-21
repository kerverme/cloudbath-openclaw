/**
 * One correlated latency record per inbound channel event.
 *
 * Production reported "simple requests feel very slow" with no way to say which
 * stage was responsible. What existed was provider fetch logging, and its
 * `elapsedMs` is time to response HEADERS — neither the user-visible wait nor
 * a true time-to-first-token, since an SSE stream opens before it emits
 * anything. Reading one as the other is how a latency investigation reaches
 * the wrong conclusion, so the two are separate fields here.
 *
 * This ledger records the stages between receiving an event and finishing
 * delivery, then emits ONE structured line when the turn ends. It is
 * diagnostic: it measures, it does not change routing, batching or retries.
 *
 * Three rules hold everywhere in here:
 *
 * - Durations are monotonic (`performance.now()`). Wall-clock deltas go
 *   backwards across NTP steps and would silently produce negative phases.
 * - Nothing accepts message text. Only stage names, ids, counts and
 *   durations — so no reply body, prompt or user content can reach a log.
 * - Off by default, and free when off: an inert ledger allocates no spans and
 *   takes no timestamps, so an ordinary turn pays nothing for the option.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/** A completed stage, in the order it closed. */
export type TurnLatencyPhase = Readonly<{
  name: string;
  durationMs: number;
  /** Offset from turn open, so phases can be placed on a timeline. */
  atMs: number;
}>;

/** One provider request inside the turn. */
export type TurnLatencyModelCall = Readonly<{
  index: number;
  provider?: string;
  model?: string;
  /**
   * Time until the provider's response STARTS: headers for a streamed
   * completion, full body otherwise. Wired from the transport today.
   */
  responseStartMs?: number;
  /**
   * Time to the first content token. Distinct from `responseStartMs` because
   * an SSE stream opens before it emits anything, so headers-time flatters
   * TTFT. Only set once a stream reader reports it; absent means not measured,
   * never zero.
   */
  ttftMs?: number;
  /** Start to completion of the whole provider response. */
  totalMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  outcome: "completed" | "error" | "abandoned";
}>;

export type TurnLatencyRecord = Readonly<{
  /** Correlates every row of one inbound event. */
  turnId: string;
  traceId?: string;
  channel: string;
  /** Channel-native event id. An id, never content. */
  inboundMessageId?: string;
  /** Scoped conversation id, as the session key already encodes it. */
  conversationId?: string;
  sessionKey?: string;
  deliveryAttemptId?: string;
  buildSha?: string;
  outcome: string;
  /** Open to finish: the latency a person actually waited. */
  userVisibleMs: number;
  /** Summed waits the turn spent queued or holding for a lock. */
  waitMs: number;
  modelCallCount: number;
  /** Summed provider durations; exceeds userVisibleMs only if calls overlap. */
  modelTotalMs: number;
  /** Response-start of the FIRST provider call. */
  firstResponseStartMs?: number;
  /** True first-token of the FIRST provider call, when measured. */
  firstTtftMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  phases: readonly TurnLatencyPhase[];
  modelCalls: readonly TurnLatencyModelCall[];
}>;

/** Handle for one in-flight provider request. */
export type TurnLatencyModelCallHandle = Readonly<{
  /** The provider's response has started (headers). Ignored if called twice. */
  responseStarted(): void;
  /** The first content token arrived. Ignored if called twice. */
  firstByte(): void;
  complete(totals?: { promptTokens?: number; outputTokens?: number }): void;
  fail(): void;
}>;

export type TurnLatencyLedger = Readonly<{
  readonly enabled: boolean;
  readonly turnId: string;
  /** Times an awaited stage. Returns the callee's value untouched. */
  phase<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  /** Records a zero-length checkpoint, for stages with no closure of their own. */
  mark(name: string): void;
  /** Opens a wait (queue, session lock). The returned function closes it. */
  beginWait(name: string): () => void;
  modelCall(params?: { provider?: string; model?: string }): TurnLatencyModelCallHandle;
  /** Closes the turn and returns the record, or undefined when inert. */
  finish(params: { outcome: string; deliveryAttemptId?: string }): TurnLatencyRecord | undefined;
}>;

const INERT_MODEL_CALL: TurnLatencyModelCallHandle = Object.freeze({
  responseStarted() {},
  firstByte() {},
  complete() {},
  fail() {},
});

function inertLedger(turnId: string): TurnLatencyLedger {
  return Object.freeze({
    enabled: false,
    turnId,
    async phase(_name, run) {
      return await run();
    },
    mark() {},
    beginWait() {
      return () => {};
    },
    modelCall() {
      return INERT_MODEL_CALL;
    },
    finish() {
      return undefined;
    },
  });
}

export type TurnLatencyLedgerOptions = Readonly<{
  enabled?: boolean;
  channel: string;
  turnId: string;
  traceId?: string;
  inboundMessageId?: string;
  conversationId?: string;
  sessionKey?: string;
  buildSha?: string;
  /** Injectable for tests; defaults to the monotonic clock. */
  now?: () => number;
}>;

export function createTurnLatencyLedger(options: TurnLatencyLedgerOptions): TurnLatencyLedger {
  if (!options.enabled) {
    return inertLedger(options.turnId);
  }
  const now = options.now ?? (() => performance.now());
  const openedAt = now();
  const round = (value: number) => Math.max(0, Math.round(value));
  const sinceOpen = () => round(now() - openedAt);

  const phases: TurnLatencyPhase[] = [];
  const modelCalls: TurnLatencyModelCall[] = [];
  let waitMs = 0;
  let finished = false;

  const pushPhase = (name: string, startedAt: number) => {
    phases.push({ name, durationMs: round(now() - startedAt), atMs: sinceOpen() });
  };

  return Object.freeze({
    enabled: true,
    turnId: options.turnId,
    async phase(name, run) {
      const startedAt = now();
      try {
        return await run();
      } finally {
        pushPhase(name, startedAt);
      }
    },
    mark(name) {
      phases.push({ name, durationMs: 0, atMs: sinceOpen() });
    },
    beginWait(name) {
      const startedAt = now();
      let closed = false;
      return () => {
        if (closed) {
          return;
        }
        closed = true;
        const durationMs = round(now() - startedAt);
        waitMs += durationMs;
        phases.push({ name, durationMs, atMs: sinceOpen() });
      };
    },
    modelCall(params) {
      const index = modelCalls.length;
      const startedAt = now();
      let responseStartMs: number | undefined;
      let ttftMs: number | undefined;
      let settled = false;
      // Recorded immediately as `abandoned` so a call that never returns still
      // appears in the record. A hung provider request is exactly the shape a
      // latency investigation must not lose.
      modelCalls.push({
        index,
        ...(params?.provider ? { provider: params.provider } : {}),
        ...(params?.model ? { model: params.model } : {}),
        outcome: "abandoned",
      });
      const settle = (
        outcome: TurnLatencyModelCall["outcome"],
        totals?: { promptTokens?: number; outputTokens?: number },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        modelCalls[index] = {
          ...modelCalls[index],
          index,
          outcome,
          totalMs: round(now() - startedAt),
          ...(responseStartMs === undefined ? {} : { responseStartMs }),
          ...(ttftMs === undefined ? {} : { ttftMs }),
          ...(totals?.promptTokens === undefined ? {} : { promptTokens: totals.promptTokens }),
          ...(totals?.outputTokens === undefined ? {} : { outputTokens: totals.outputTokens }),
        };
      };
      return Object.freeze({
        responseStarted() {
          responseStartMs ??= round(now() - startedAt);
        },
        firstByte() {
          ttftMs ??= round(now() - startedAt);
        },
        complete(totals) {
          settle("completed", totals);
        },
        fail() {
          settle("error");
        },
      });
    },
    finish(params) {
      if (finished) {
        return undefined;
      }
      finished = true;
      const sumTokens = (key: "promptTokens" | "outputTokens") => {
        const total = modelCalls.reduce((sum, call) => sum + (call[key] ?? 0), 0);
        return total > 0 ? total : undefined;
      };
      const promptTokens = sumTokens("promptTokens");
      const outputTokens = sumTokens("outputTokens");
      return Object.freeze({
        turnId: options.turnId,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        channel: options.channel,
        ...(options.inboundMessageId ? { inboundMessageId: options.inboundMessageId } : {}),
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
        ...(params.deliveryAttemptId ? { deliveryAttemptId: params.deliveryAttemptId } : {}),
        ...(options.buildSha ? { buildSha: options.buildSha } : {}),
        outcome: params.outcome,
        userVisibleMs: sinceOpen(),
        waitMs,
        modelCallCount: modelCalls.length,
        modelTotalMs: modelCalls.reduce((sum, call) => sum + (call.totalMs ?? 0), 0),
        ...(modelCalls[0]?.responseStartMs === undefined
          ? {}
          : { firstResponseStartMs: modelCalls[0].responseStartMs }),
        ...(modelCalls[0]?.ttftMs === undefined ? {} : { firstTtftMs: modelCalls[0].ttftMs }),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        phases: Object.freeze([...phases]),
        modelCalls: Object.freeze([...modelCalls]),
      });
    },
  });
}

/**
 * The phases this ledger expects a fully wired turn to report.
 *
 * Named here so a test can assert instrumentation COMPLETENESS rather than
 * leaving a silent gap: a missing phase is how "we measured it" becomes "we
 * measured the part that was easy to reach".
 */
export const TURN_LATENCY_PHASES = Object.freeze([
  "inbound.received",
  "inbound.debounce",
  "queue.wait",
  "session.lock_wait",
  "route.tool_policy",
  "prompt.build",
  "model.calls",
  "tools.iterations",
  "outbound.language_guard",
  "transcript.persist",
  "delivery.send",
] as const);

/** Renders one record as a single compact log message. Contains no user text. */
export function formatTurnLatencyRecord(record: TurnLatencyRecord): string {
  const phases = record.phases.map((p) => `${p.name}:${p.durationMs}ms@${p.atMs}ms`).join(",");
  const calls = record.modelCalls
    .map(
      (call) =>
        `#${call.index}${call.model ? `(${call.model})` : ""}=${call.outcome}` +
        `${call.responseStartMs === undefined ? "" : ` start=${call.responseStartMs}ms`}` +
        `${call.ttftMs === undefined ? "" : ` ttft=${call.ttftMs}ms`}` +
        `${call.totalMs === undefined ? "" : ` total=${call.totalMs}ms`}`,
    )
    .join(",");
  return (
    `turn latency turnId=${record.turnId} channel=${record.channel} outcome=${record.outcome} ` +
    `userVisibleMs=${record.userVisibleMs} waitMs=${record.waitMs} ` +
    `modelCalls=${record.modelCallCount} modelTotalMs=${record.modelTotalMs} ` +
    `firstResponseStartMs=${record.firstResponseStartMs ?? "n/a"} ` +
    `firstTtftMs=${record.firstTtftMs ?? "n/a"} ` +
    `promptTokens=${record.promptTokens ?? "n/a"} outputTokens=${record.outputTokens ?? "n/a"} ` +
    `phases=[${phases || "none"}] calls=[${calls || "none"}]`
  );
}

/**
 * Carries the active ledger to code that cannot be handed one.
 *
 * The provider transport is several layers below dispatch and takes no ledger
 * argument; threading one through every call site would touch unrelated
 * modules for a diagnostic. This mirrors how `diagnostic-trace-context.ts`
 * already propagates a trace id.
 */
const ledgerStorage = new AsyncLocalStorage<TurnLatencyLedger>();

/** Runs `fn` with `ledger` visible to `currentTurnLatencyLedger()`. */
export function runWithTurnLatencyLedger<T>(ledger: TurnLatencyLedger, fn: () => T): T {
  return ledgerStorage.run(ledger, fn);
}

/** The ledger for the turn on this async stack, when one is recording. */
export function currentTurnLatencyLedger(): TurnLatencyLedger | undefined {
  const ledger = ledgerStorage.getStore();
  return ledger?.enabled ? ledger : undefined;
}
