/**
 * Headers are not first-token.
 *
 * A production turn showed ~5.2s to response headers and ~9s more before the
 * answer was final. Reading the first number as time-to-first-token is how a
 * latency investigation reaches the wrong conclusion, so the ledger keeps them
 * apart and this is the seam that supplies the real one: the first `text_delta`
 * carrying text, which is the first thing a person could have seen.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  createTurnLatencyLedger,
  runWithTurnLatencyLedger,
  type TurnLatencyLedger,
} from "./turn-latency-ledger.js";
import { observeAssistantStreamLatency } from "./turn-latency-stream.js";

const REPLY_TEXT = "เดือน 1-2: วิ่งสบาย ๆ";

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: REPLY_TEXT }],
    api: "openai-completions",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    usage: {
      input: 4200,
      output: 700,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4900,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

/** A provider stream that replays a fixed event list. */
function fakeContract(events: AssistantMessageEvent[]): AssistantMessageEventStreamContract {
  return {
    push() {},
    end() {},
    result: async () => assistantMessage(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function openTurn(): { ledger: TurnLatencyLedger; openCall: () => void } {
  const ledger = createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "line:m-1" });
  return {
    ledger,
    // The transport opens the request; this stands in for it.
    openCall: () => {
      ledger.openModelCall({ callReason: "main_agent" }).responseHeaders();
    },
  };
}

describe("first content token", () => {
  it("is taken from the first text delta that carries text", async () => {
    const { ledger, openCall } = openTurn();

    await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(
        fakeContract([
          { type: "start", partial: assistantMessage() },
          { type: "text_start", contentIndex: 0, partial: assistantMessage() },
          { type: "text_delta", contentIndex: 0, delta: "" },
          { type: "text_delta", contentIndex: 0, delta: REPLY_TEXT },
          { type: "done", reason: "stop", message: assistantMessage() },
        ]),
      );
      openCall();
      for await (const _event of observed) {
        // The consumer drives the stream; the observer only watches it pass.
      }
    });

    const [call] = ledger.finish({ outcome: "completed" })?.modelCalls ?? [];

    expect(call?.ttftMs).toEqual(expect.any(Number));
    expect(call?.outcome).toBe("completed");
  });

  it("stays absent when the stream produced no text at all", async () => {
    const { ledger, openCall } = openTurn();

    await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(
        fakeContract([
          { type: "toolcall_start", contentIndex: 0, partial: assistantMessage() },
          { type: "done", reason: "toolUse", message: assistantMessage() },
        ]),
      );
      openCall();
      for await (const _event of observed) {
        // drain
      }
    });

    expect(ledger.finish({ outcome: "completed" })?.modelCalls[0]).not.toHaveProperty("ttftMs");
  });

  it("carries the provider's own token totals onto the call", async () => {
    const { ledger, openCall } = openTurn();

    await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(
        fakeContract([{ type: "done", reason: "stop", message: assistantMessage() }]),
      );
      openCall();
      for await (const _event of observed) {
        // drain
      }
    });

    expect(ledger.finish({ outcome: "completed" })?.modelCalls[0]).toMatchObject({
      promptTokens: 4200,
      outputTokens: 700,
    });
  });

  it("completes a non-streamed call from its result", async () => {
    // A plugin completion never iterates; `result()` is the only place its
    // totals exist.
    const { ledger, openCall } = openTurn();

    await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(fakeContract([]));
      openCall();
      await observed.result();
    });

    expect(ledger.finish({ outcome: "completed" })?.modelCalls[0]).toMatchObject({
      outcome: "completed",
      outputTokens: 700,
    });
  });

  it("records a failed result as an error rather than leaving it abandoned", async () => {
    const { ledger, openCall } = openTurn();
    const failing: AssistantMessageEventStreamContract = {
      ...fakeContract([]),
      result: async () => {
        throw new Error("provider down");
      },
    };

    await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(failing);
      openCall();
      await expect(observed.result()).rejects.toThrow("provider down");
    });

    expect(ledger.finish({ outcome: "error" })?.modelCalls[0]?.outcome).toBe("error");
  });
});

describe("the observer is transparent", () => {
  it("returns the provider's own stream untouched when nothing is recording", () => {
    const contract = fakeContract([]);

    expect(observeAssistantStreamLatency(contract)).toBe(contract);
  });

  it("forwards every event to the consumer in order", async () => {
    const ledger = createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "line:m-1" });
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "a" },
      { type: "text_delta", contentIndex: 0, delta: "b" },
      { type: "done", reason: "stop", message: assistantMessage() },
    ];

    const seen = await runWithTurnLatencyLedger(ledger, async () => {
      const observed = observeAssistantStreamLatency(fakeContract(events));
      const collected: string[] = [];
      for await (const event of observed) {
        collected.push(event.type);
      }
      return collected;
    });

    expect(seen).toStrictEqual(["text_delta", "text_delta", "done"]);
  });
});
