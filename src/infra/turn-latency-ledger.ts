/**
 * One correlated latency record per inbound turn.
 *
 * Production reported slow LINE replies with no way to say which stage was
 * responsible, and a call graph nobody could enumerate: a turn ran a plugin
 * helper completion before the agent, and roughly four seconds between that
 * helper returning and the main provider request were unattributed.
 *
 * This records the stages between receiving an event and finishing delivery,
 * plus every provider request inside them, and emits ONE line when the turn
 * ends. It measures; it changes no routing, batching or retry decision.
 *
 * Four rules hold throughout:
 *
 * - Durations are monotonic (`performance.now()`). Wall-clock deltas go
 *   backwards across NTP steps and would silently produce negative phases.
 * - Response-start and first-token are SEPARATE fields. An SSE stream opens
 *   before it emits anything, so reading headers-time as time-to-first-token
 *   is how a latency investigation reaches the wrong conclusion.
 * - No field accepts prose. Ids and names are sanitized to an identifier
 *   shape, and the record is copied key by key from a closed list, so a
 *   caller holding a reply, a prompt or a secret cannot route it here even by
 *   casting past the types.
 * - Off by default and free when off: an inert ledger takes no timestamps and
 *   allocates no spans, so an ordinary turn pays nothing for the option.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/**
 * Why a provider request happened.
 *
 * A closed set on purpose: "which call was that" is the question this exists
 * to answer, and a free-form string would let each call site invent its own
 * spelling for the same thing.
 */
export type LlmCallReason =
  /** Cloudbath's pre-agent referent resolver, on every non-protocol LINE turn. */
  | "cloudbath_conversation_referent"
  /** The agent turn whose output becomes the reply. */
  | "main_agent"
  | "storyboard_planner"
  /** A further agent call in the same attempt, after tool results came back. */
  | "tool_followup"
  /** A candidate the fallback chain reached after the requested model failed. */
  | "model_fallback"
  /** The restart that applies a session model switch mid-turn. */
  | "live_model_switch"
  | "context_compaction"
  /** Any other plugin-owned completion. */
  | "plugin_llm"
  | "unknown";

const CALL_REASONS = new Set<LlmCallReason>([
  "cloudbath_conversation_referent",
  "main_agent",
  "storyboard_planner",
  "tool_followup",
  "model_fallback",
  "live_model_switch",
  "context_compaction",
  "plugin_llm",
  "unknown",
]);

export type TurnLatencyPhase = Readonly<{
  name: string;
  /** Offset from turn open, so phases place on one timeline. */
  atMs: number;
  durationMs: number;
}>;

export type TurnLatencyModelCall = Readonly<{
  callIndex: number;
  provider?: string;
  model?: string;
  callReason: LlmCallReason;
  requestStartMs: number;
  /** Provider response headers. NOT first-token; see the module note. */
  responseHeadersMs?: number;
  /** First content token off the stream. Absent means not measured, never zero. */
  ttftMs?: number;
  completionMs?: number;
  totalMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  outcome: "completed" | "error" | "abandoned";
}>;

export type TurnLatencyRecord = Readonly<{
  turnId: string;
  runId?: string;
  sessionKey?: string;
  channel: string;
  outcome: string;
  /** Turn open to finish: the wait a person actually experienced. */
  userVisibleMs: number;
  modelCallCount: number;
  /** Summed provider durations; exceeds userVisibleMs only if calls overlap. */
  modelTotalMs: number;
  /** Provider requests the agent made after tool results came back. */
  toolIterations: number;
  phases: readonly TurnLatencyPhase[];
  modelCalls: readonly TurnLatencyModelCall[];
}>;

export type TurnLatencyModelCallHandle = Readonly<{
  /** Response headers arrived. Ignored after the first call. */
  responseHeaders(): void;
  /** The first content token arrived. Ignored after the first call. */
  firstContentToken(): void;
  complete(totals?: { promptTokens?: number; outputTokens?: number }): void;
  fail(): void;
}>;

export type TurnLatencyLedger = Readonly<{
  readonly enabled: boolean;
  readonly turnId: string;
  /** Times an awaited stage and returns the callee's value untouched. */
  phase<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  /** A zero-length checkpoint, for stages with no closure of their own. */
  mark(name: string): void;
  /** Opens a wait (queue, session lock); the returned function closes it. */
  beginWait(name: string): () => void;
  openModelCall(params: {
    provider?: string;
    model?: string;
    callReason?: LlmCallReason;
  }): TurnLatencyModelCallHandle;
  /** The most recent provider request still open, for a later stage to annotate. */
  openCallHandle(): TurnLatencyModelCallHandle | undefined;
  finish(params: { outcome: string; runId?: string }): TurnLatencyRecord | undefined;
}>;

/**
 * Names and ids are reduced to an identifier shape before they are stored.
 *
 * Prose carries spaces and punctuation; an id does not. Anything else is
 * dropped rather than escaped, so no phase name, session key or model ref can
 * smuggle a sentence into the log through a field that legitimately exists.
 */
const IDENTIFIER_SAFE = /[^A-Za-z0-9._:/@-]+/gu;
const MAX_IDENTIFIER_LENGTH = 128;

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replaceAll(IDENTIFIER_SAFE, "").slice(0, MAX_IDENTIFIER_LENGTH);
  return cleaned || undefined;
}

function safeCallReason(value: unknown): LlmCallReason {
  return typeof value === "string" && CALL_REASONS.has(value as LlmCallReason)
    ? (value as LlmCallReason)
    : "unknown";
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

const INERT_MODEL_CALL: TurnLatencyModelCallHandle = Object.freeze({
  responseHeaders() {},
  firstContentToken() {},
  complete() {},
  fail() {},
});

function inertLedger(turnId: string): TurnLatencyLedger {
  return Object.freeze({
    enabled: false,
    turnId,
    phase: async <T>(_name: string, run: () => Promise<T> | T) => await run(),
    mark() {},
    beginWait: () => () => {},
    openModelCall: () => INERT_MODEL_CALL,
    openCallHandle: () => undefined,
    finish: () => undefined,
  });
}

type OpenModelCall = { call: MutableModelCall; handle: TurnLatencyModelCallHandle };

type MutableModelCall = {
  callIndex: number;
  provider?: string;
  model?: string;
  callReason: LlmCallReason;
  requestStartMs: number;
  responseHeadersMs?: number;
  ttftMs?: number;
  completionMs?: number;
  totalMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  outcome: "completed" | "error" | "abandoned";
  open: boolean;
};

export function createTurnLatencyLedger(params: {
  enabled: boolean;
  channel: string;
  turnId: string;
  sessionKey?: string;
}): TurnLatencyLedger {
  const turnId = safeIdentifier(params.turnId) ?? "unknown";
  if (!params.enabled) {
    return inertLedger(turnId);
  }
  const openedAt = performance.now();
  const phases: TurnLatencyPhase[] = [];
  const calls: MutableModelCall[] = [];
  const openCalls: OpenModelCall[] = [];
  const since = () => performance.now() - openedAt;

  const record = (name: string, atMs: number, durationMs: number) => {
    const safeName = safeIdentifier(name);
    if (safeName) {
      phases.push({ name: safeName, atMs: roundMs(atMs), durationMs: roundMs(durationMs) });
    }
  };

  const openModelCall: TurnLatencyLedger["openModelCall"] = (callParams) => {
    const call: MutableModelCall = {
      callIndex: calls.length,
      ...(safeIdentifier(callParams.provider) === undefined
        ? {}
        : { provider: safeIdentifier(callParams.provider) }),
      ...(safeIdentifier(callParams.model) === undefined
        ? {}
        : { model: safeIdentifier(callParams.model) }),
      callReason: resolveCallReasonForNewCall(calls, safeCallReason(callParams.callReason)),
      requestStartMs: roundMs(since()),
      outcome: "abandoned",
      open: true,
    };
    calls.push(call);
    const close = (outcome: MutableModelCall["outcome"]) => {
      if (!call.open) {
        return;
      }
      call.open = false;
      call.outcome = outcome;
      call.completionMs = roundMs(since());
      call.totalMs = roundMs(call.completionMs - call.requestStartMs);
      const index = openCalls.findIndex((entry) => entry.call === call);
      if (index >= 0) {
        openCalls.splice(index, 1);
      }
    };
    const handle: TurnLatencyModelCallHandle = Object.freeze({
      responseHeaders() {
        call.responseHeadersMs ??= roundMs(since() - call.requestStartMs);
      },
      firstContentToken() {
        call.ttftMs ??= roundMs(since() - call.requestStartMs);
      },
      complete(totals) {
        if (typeof totals?.promptTokens === "number" && Number.isFinite(totals.promptTokens)) {
          call.promptTokens = Math.max(0, Math.floor(totals.promptTokens));
        }
        if (typeof totals?.outputTokens === "number" && Number.isFinite(totals.outputTokens)) {
          call.outputTokens = Math.max(0, Math.floor(totals.outputTokens));
        }
        close("completed");
      },
      fail() {
        close("error");
      },
    });
    openCalls.push({ call, handle });
    return handle;
  };

  return Object.freeze({
    enabled: true,
    turnId,
    phase: async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
      const startedAt = since();
      try {
        return await run();
      } finally {
        record(name, startedAt, since() - startedAt);
      }
    },
    mark(name: string) {
      record(name, since(), 0);
    },
    beginWait(name: string) {
      const startedAt = since();
      return () => record(name, startedAt, since() - startedAt);
    },
    openModelCall,
    // The transport opens the request; a later stage annotates it. Requests in
    // one turn are sequential, so the newest open one is always the caller's.
    openCallHandle: () => openCalls.at(-1)?.handle,
    finish: ({ outcome, runId }) => {
      const userVisibleMs = roundMs(since());
      const modelCalls = calls.map(({ open: _open, ...call }) => Object.freeze({ ...call }));
      return Object.freeze({
        turnId,
        ...(safeIdentifier(runId) === undefined ? {} : { runId: safeIdentifier(runId) }),
        ...(safeIdentifier(params.sessionKey) === undefined
          ? {}
          : { sessionKey: safeIdentifier(params.sessionKey) }),
        channel: safeIdentifier(params.channel) ?? "unknown",
        outcome: safeIdentifier(outcome) ?? "unknown",
        userVisibleMs,
        modelCallCount: modelCalls.length,
        modelTotalMs: roundMs(modelCalls.reduce((sum, call) => sum + (call.totalMs ?? 0), 0)),
        toolIterations: modelCalls.filter((call) => call.callReason === "tool_followup").length,
        phases: Object.freeze([...phases, ...derivedPhases(phases, modelCalls)]),
        modelCalls: Object.freeze(modelCalls),
      });
    },
  });
}

/**
 * The agent re-calls the provider only after tool results come back, so a
 * second `main_agent` request inside one turn IS a tool iteration. Deriving it
 * here keeps the agent loop from having to thread a reason through every
 * retry, and it is the only place the distinction is representable.
 */
function resolveCallReasonForNewCall(
  existing: readonly MutableModelCall[],
  reason: LlmCallReason,
): LlmCallReason {
  if (reason !== "main_agent") {
    return reason;
  }
  return existing.some((call) => call.callReason === "main_agent") ? "tool_followup" : reason;
}

const BEFORE_DISPATCH_PHASE = "before_dispatch.total";
const SEMANTIC_RESOLVER_PHASE = "before_dispatch.semantic_resolver";
const BEFORE_DISPATCH_OTHER_PHASE = "before_dispatch.other";
const PROMPT_BUILD_PHASE = "prompt.build";
const TOOL_ITERATIONS_PHASE = "tools.iterations";

/**
 * Phases nobody can time directly, computed from what was.
 *
 * `before_dispatch.other` is the hook chain minus the helper completion inside
 * it, which is what says whether the pre-agent cost is the model or the
 * plugin's own work. `prompt.build` is the gap between the last hook returning
 * and the first agent request — the unattributed stretch this ledger was built
 * to name.
 */
function derivedPhases(
  phases: readonly TurnLatencyPhase[],
  modelCalls: readonly TurnLatencyModelCall[],
): TurnLatencyPhase[] {
  const derived: TurnLatencyPhase[] = [];
  const beforeDispatch = phases.find((phase) => phase.name === BEFORE_DISPATCH_PHASE);
  if (beforeDispatch) {
    const beforeDispatchEnd = beforeDispatch.atMs + beforeDispatch.durationMs;
    const resolverMs = modelCalls
      .filter(
        (call) =>
          call.callReason === "cloudbath_conversation_referent" &&
          call.requestStartMs >= beforeDispatch.atMs &&
          call.requestStartMs <= beforeDispatchEnd,
      )
      .reduce((sum, call) => sum + (call.totalMs ?? 0), 0);
    if (resolverMs > 0) {
      derived.push({
        name: SEMANTIC_RESOLVER_PHASE,
        atMs: beforeDispatch.atMs,
        durationMs: roundMs(resolverMs),
      });
    }
    derived.push({
      name: BEFORE_DISPATCH_OTHER_PHASE,
      atMs: beforeDispatch.atMs,
      durationMs: roundMs(Math.max(0, beforeDispatch.durationMs - resolverMs)),
    });
    const firstAgentCall = modelCalls.find(
      (call) => call.callReason !== "cloudbath_conversation_referent",
    );
    if (firstAgentCall && firstAgentCall.requestStartMs >= beforeDispatchEnd) {
      derived.push({
        name: PROMPT_BUILD_PHASE,
        atMs: roundMs(beforeDispatchEnd),
        durationMs: roundMs(firstAgentCall.requestStartMs - beforeDispatchEnd),
      });
    }
  }
  const toolCalls = modelCalls.filter((call) => call.callReason === "tool_followup");
  const firstToolCall = toolCalls[0];
  if (firstToolCall) {
    derived.push({
      name: TOOL_ITERATIONS_PHASE,
      atMs: firstToolCall.requestStartMs,
      durationMs: roundMs(toolCalls.reduce((sum, call) => sum + (call.totalMs ?? 0), 0)),
    });
  }
  return derived;
}

/** The exact record that reaches the log, copied key by key from a closed list. */
const RECORD_KEYS = [
  "turnId",
  "runId",
  "sessionKey",
  "channel",
  "outcome",
  "userVisibleMs",
  "modelCallCount",
  "modelTotalMs",
  "toolIterations",
] as const satisfies ReadonlyArray<keyof TurnLatencyRecord>;

const PHASE_KEYS = ["name", "atMs", "durationMs"] as const satisfies ReadonlyArray<
  keyof TurnLatencyPhase
>;

const MODEL_CALL_KEYS = [
  "callIndex",
  "provider",
  "model",
  "callReason",
  "requestStartMs",
  "responseHeadersMs",
  "ttftMs",
  "completionMs",
  "totalMs",
  "promptTokens",
  "outputTokens",
  "outcome",
] as const satisfies ReadonlyArray<keyof TurnLatencyModelCall>;

function copyKeys<T extends object>(
  source: T,
  keys: ReadonlyArray<keyof T>,
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      copied[key as string] = value;
    }
  }
  return copied;
}

/**
 * Exported so the no-content guarantee is asserted against the real payload
 * rather than against a stubbed logger.
 */
export function buildTurnLatencyLogRecord(record: TurnLatencyRecord): Record<string, unknown> {
  return {
    event: "turn_latency",
    ...copyKeys(record, RECORD_KEYS),
    phases: record.phases.map((phase) => copyKeys(phase, PHASE_KEYS)),
    modelCalls: record.modelCalls.map((call) => copyKeys(call, MODEL_CALL_KEYS)),
  };
}

/** A one-line summary for an operator reading the console. */
export function formatTurnLatencyRecord(record: TurnLatencyRecord): string {
  const calls = record.modelCalls
    .map((call) => `${call.callReason}=${call.totalMs ?? "?"}ms(ttft=${call.ttftMs ?? "?"})`)
    .join(" ");
  return (
    `turn latency ${record.channel} userVisibleMs=${record.userVisibleMs} ` +
    `calls=${record.modelCallCount} modelMs=${record.modelTotalMs} ${calls}`.trimEnd()
  );
}

const ledgerStorage = new AsyncLocalStorage<TurnLatencyLedger>();
const callReasonStorage = new AsyncLocalStorage<LlmCallReason>();

export function runWithTurnLatencyLedger<T>(ledger: TurnLatencyLedger, run: () => T): T {
  return ledgerStorage.run(ledger, run);
}

export function currentTurnLatencyLedger(): TurnLatencyLedger | undefined {
  return ledgerStorage.getStore();
}

/**
 * Labels every provider request made inside `run`.
 *
 * The transport is the only place that sees every request, and it knows
 * nothing about why. The reason is carried rather than threaded because the
 * call sites in between — fallback chains, retry loops, provider adapters —
 * have no business growing a diagnostic parameter.
 */
export function runWithLlmCallReason<T>(reason: LlmCallReason, run: () => T): T {
  return callReasonStorage.run(reason, run);
}

export function currentLlmCallReason(): LlmCallReason {
  return callReasonStorage.getStore() ?? "unknown";
}
