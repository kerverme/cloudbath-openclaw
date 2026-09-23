/**
 * True time-to-first-token for the active turn's provider request.
 *
 * The transport can only report when response HEADERS arrived. For a streamed
 * completion the body has not started then, so headers-time flatters TTFT — on
 * a slow turn by seconds. The first `text_delta` carrying non-empty text is the
 * first thing a person could have seen, and it is also where the request stops
 * being merely open: the same observation closes the call with the provider's
 * own token totals.
 *
 * The wrapper is transparent. It forwards `result`, the async iteration and any
 * other member of the stream it was handed, observes event TYPES, and never
 * reads delta text beyond asking whether it is empty.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
} from "@openclaw/llm-core";
import { currentTurnLatencyLedger } from "./turn-latency-ledger.js";

/**
 * Marks a stream this module already watches.
 *
 * An embedded attempt resolves its stream through several layers and more than
 * one of them can hand the same object back here. Returning it unchanged keeps
 * exactly one observer per provider request.
 */
const OBSERVED = Symbol.for("openclaw.turnLatency.observedStream");

function completionTotals(message: AssistantMessage | undefined) {
  const usage = message?.usage;
  return usage ? { promptTokens: usage.input, outputTokens: usage.output } : undefined;
}

function isObserved(stream: object): boolean {
  return (stream as Record<PropertyKey, unknown>)[OBSERVED] === true;
}

export function observeAssistantStreamLatency<T extends AssistantMessageEventStreamLike>(
  stream: T,
): T {
  const ledger = currentTurnLatencyLedger();
  if (!ledger?.enabled || isObserved(stream)) {
    return stream;
  }
  // Resolved lazily: the transport opens the request while this stream is being
  // consumed, so the handle does not exist yet when the wrapper is built.
  // Captured once, so a later event cannot annotate a different call.
  let handle: ReturnType<typeof ledger.openCallHandle>;
  const resolveHandle = () => {
    handle ??= ledger.openCallHandle();
    return handle;
  };
  let settled = false;

  const observe = (event: AssistantMessageEvent) => {
    if (event.type === "text_delta") {
      if (event.delta.length > 0) {
        resolveHandle()?.firstContentToken();
      }
      return;
    }
    if (event.type === "done") {
      settled = true;
      resolveHandle()?.complete(completionTotals(event.message));
      return;
    }
    if (event.type === "error") {
      settled = true;
      resolveHandle()?.fail();
    }
  };

  const observedResult = async (): Promise<AssistantMessage> => {
    try {
      const message = await stream.result();
      // A non-streamed completion never emits `done` through this wrapper,
      // so its result is the only place its totals exist.
      if (!settled) {
        settled = true;
        resolveHandle()?.complete(completionTotals(message));
      }
      return message;
    } catch (error) {
      if (!settled) {
        settled = true;
        resolveHandle()?.fail();
      }
      throw error;
    }
  };
  const observedIterator = async function* (): AsyncGenerator<AssistantMessageEvent> {
    for await (const event of stream) {
      observe(event);
      yield event;
    }
  };

  // A Proxy, because the attempt re-wraps this stream IN PLACE: wrappers such
  // as wrapStreamFnHandleSensitiveStopReason assign `result` and the async
  // iterator on the object they are handed. Own properties defined here were
  // non-writable, and the first assignment threw "Cannot assign to read only
  // property 'result'", failing every main-agent turn with the profiler on.
  //
  // Assignments land in `assigned`, never on the provider's stream. Every other
  // member is read from the provider's stream and its methods run with the
  // provider's stream as `this`, so push/end change ITS state rather than a
  // shadow copy on the wrapper.
  const assigned = new Map<PropertyKey, unknown>();
  const bound = new WeakMap<object, unknown>();
  return new Proxy(stream, {
    get(target, property) {
      if (assigned.has(property)) {
        return assigned.get(property);
      }
      if (property === OBSERVED) {
        return true;
      }
      if (property === "result") {
        return observedResult;
      }
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      let method = bound.get(value);
      if (!method) {
        method = (value as (...args: unknown[]) => unknown).bind(target);
        bound.set(value, method);
      }
      return method;
    },
    set(_target, property, value) {
      assigned.set(property, value);
      return true;
    },
  });
}

/** Observes a stream function's result, whether it resolves now or later. */
export function observeAssistantStreamLatencyResult<
  T extends AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
>(result: T): T {
  return (
    result instanceof Promise
      ? result.then((stream) => observeAssistantStreamLatency(stream))
      : observeAssistantStreamLatency(result)
  ) as T;
}
