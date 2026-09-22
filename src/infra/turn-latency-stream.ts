/**
 * True time-to-first-token for the active turn's provider request.
 *
 * The transport can only report when response HEADERS arrived. For a streamed
 * completion the body has not started then, so headers-time flatters TTFT — on
 * a slow turn by seconds. The first `text_delta` carrying non-empty text is
 * the first thing a person could have seen, and this is the one place every
 * core provider call passes through on its way to a caller.
 *
 * The wrapper is transparent: it forwards `push`, `end`, `result` and the
 * async iteration untouched, observes event TYPES and never reads delta text
 * beyond asking whether it is empty.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "@openclaw/llm-core";
import { currentTurnLatencyLedger } from "./turn-latency-ledger.js";

function completionTotals(message: AssistantMessage | undefined) {
  const usage = message?.usage;
  return usage ? { promptTokens: usage.input, outputTokens: usage.output } : undefined;
}

export function observeAssistantStreamLatency(
  contract: AssistantMessageEventStreamContract,
): AssistantMessageEventStreamContract {
  const ledger = currentTurnLatencyLedger();
  if (!ledger?.enabled) {
    return contract;
  }
  // Resolved lazily: the transport opens the request while this stream is
  // being consumed, so the handle does not exist yet when the contract is
  // built. Captured once so a later event cannot annotate a different call.
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

  return {
    push(event: AssistantMessageEvent) {
      observe(event);
      contract.push(event);
    },
    end(result?: AssistantMessage) {
      contract.end(result);
    },
    async result(): Promise<AssistantMessage> {
      try {
        const message = await contract.result();
        // A non-streamed completion never emits `done` through this wrapper,
        // so the result is the only place its totals exist.
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
    },
    async *[Symbol.asyncIterator]() {
      for await (const event of contract) {
        observe(event);
        yield event;
      }
    },
  };
}
