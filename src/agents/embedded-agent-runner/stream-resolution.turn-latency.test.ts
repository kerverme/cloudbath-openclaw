/**
 * The main agent's stream is the one the turn record could not see.
 *
 * Production, with the reply profiler on, reported `main_agent=?ms(ttft=?)`
 * while the pre-agent helper closed correctly. The helper runs through the
 * `src/llm/stream.ts` facade, which is where the observer was installed; an
 * embedded attempt almost never does. Every transport-aware API resolves to a
 * boundary-aware transport instead — `openai-completions` among them, which is
 * how OpenRouter models run — so the transport opened the request, recorded
 * headers, and nothing ever closed it: no first token, no completion, outcome
 * `abandoned`.
 *
 * These drive the real resolver with the network faked, so the branch selection
 * is production's and only the transport is a stub.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
} from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTurnLatencyLedger,
  runWithTurnLatencyLedger,
  type TurnLatencyLedger,
} from "../../infra/turn-latency-ledger.js";
import type { StreamFn } from "../runtime/index.js";

const hoisted = vi.hoisted(() => ({
  createBoundaryAwareStreamFnForModel: vi.fn(),
  createTransportAwareStreamFnForModel: vi.fn(() => undefined),
}));

// Only the transport is faked. The resolver's own branch selection, which is
// what sends production down this path, runs for real.
vi.mock("../provider-transport-stream.js", () => ({
  createBoundaryAwareStreamFnForModel: hoisted.createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel: hoisted.createTransportAwareStreamFnForModel,
}));

const { describeEmbeddedAgentStreamStrategy, resolveEmbeddedAgentStreamFn } =
  await import("./stream-resolution.js");

/** The production model shape: an OpenRouter DeepSeek route. */
const MODEL = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4-flash-0731",
  api: "openai-completions",
} as Parameters<typeof resolveEmbeddedAgentStreamFn>[0]["model"];

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

/**
 * A boundary-aware transport, as the resolver would return one.
 *
 * Opening the ledger call is the real transport's job (`buildGuardedModelFetch`
 * does it before the request goes out), so the stub does the same thing at the
 * same point.
 */
function fakeBoundaryAwareStreamFn(
  ledger: TurnLatencyLedger,
  events: AssistantMessageEvent[],
): StreamFn {
  return (() => {
    const call = ledger.openModelCall({
      provider: MODEL.provider,
      model: MODEL.id,
      callReason: "main_agent",
    });
    call.responseHeaders();
    const stream: AssistantMessageEventStreamLike = {
      result: async () => assistantMessage(),
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    };
    return stream;
  }) as StreamFn;
}

function newLedger(): TurnLatencyLedger {
  return createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "line:m-1" });
}

beforeEach(() => {
  hoisted.createBoundaryAwareStreamFnForModel.mockReset();
  hoisted.createTransportAwareStreamFnForModel.mockReset();
  hoisted.createTransportAwareStreamFnForModel.mockReturnValue(undefined);
});

describe("the embedded agent's resolved stream is on the turn record", () => {
  it("takes the boundary-aware branch for the production model", () => {
    hoisted.createBoundaryAwareStreamFnForModel.mockReturnValue((() => {}) as unknown as StreamFn);

    // The strategy the record could not see: not the src/llm facade.
    expect(describeEmbeddedAgentStreamStrategy({ currentStreamFn: undefined, model: MODEL })).toBe(
      "boundary-aware:openai-completions",
    );
  });

  it("records first token and completion for a streamed main-agent turn", async () => {
    const ledger = newLedger();
    hoisted.createBoundaryAwareStreamFnForModel.mockReturnValue(
      fakeBoundaryAwareStreamFn(ledger, [
        { type: "start", partial: assistantMessage() },
        { type: "text_delta", contentIndex: 0, delta: "" },
        { type: "text_delta", contentIndex: 0, delta: REPLY_TEXT },
        { type: "done", reason: "stop", message: assistantMessage() },
      ]),
    );

    await runWithTurnLatencyLedger(ledger, async () => {
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: MODEL,
      });
      const stream = await streamFn(MODEL as never, { messages: [] } as never, undefined);
      for await (const _event of stream) {
        // The agent drives the stream; the observer only watches it pass.
      }
    });

    const [call] = ledger.finish({ outcome: "completed" })?.modelCalls ?? [];

    expect(call).toMatchObject({
      callReason: "main_agent",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      outcome: "completed",
      promptTokens: 4200,
      outputTokens: 700,
    });
    expect(call?.requestStartMs).toEqual(expect.any(Number));
    expect(call?.responseHeadersMs).toEqual(expect.any(Number));
    expect(call?.ttftMs).toEqual(expect.any(Number));
    expect(call?.completionMs).toEqual(expect.any(Number));
    expect(call?.totalMs).toEqual(expect.any(Number));
  });

  it("takes first token from the first NON-EMPTY delta, never from headers", async () => {
    const ledger = newLedger();
    hoisted.createBoundaryAwareStreamFnForModel.mockReturnValue(
      fakeBoundaryAwareStreamFn(ledger, [
        // An SSE stream opens, and its opening events carry nothing to read.
        { type: "start", partial: assistantMessage() },
        { type: "text_start", contentIndex: 0, partial: assistantMessage() },
        { type: "text_delta", contentIndex: 0, delta: "" },
        { type: "done", reason: "stop", message: assistantMessage() },
      ]),
    );

    await runWithTurnLatencyLedger(ledger, async () => {
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: MODEL,
      });
      const stream = await streamFn(MODEL as never, { messages: [] } as never, undefined);
      for await (const _event of stream) {
        // drain
      }
    });

    const [call] = ledger.finish({ outcome: "completed" })?.modelCalls ?? [];

    expect(call?.responseHeadersMs).toEqual(expect.any(Number));
    expect(call).not.toHaveProperty("ttftMs");
    expect(call?.outcome).toBe("completed");
  });

  it("closes a main-agent call whose stream ends in an error", async () => {
    const ledger = newLedger();
    hoisted.createBoundaryAwareStreamFnForModel.mockReturnValue(
      fakeBoundaryAwareStreamFn(ledger, [
        { type: "error", reason: "error", error: assistantMessage() },
      ]),
    );

    await runWithTurnLatencyLedger(ledger, async () => {
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: MODEL,
      });
      const stream = await streamFn(MODEL as never, { messages: [] } as never, undefined);
      for await (const _event of stream) {
        // drain
      }
    });

    expect(ledger.finish({ outcome: "error" })?.modelCalls[0]?.outcome).toBe("error");
  });

  it("forwards the provider's own events unchanged", async () => {
    const ledger = newLedger();
    hoisted.createBoundaryAwareStreamFnForModel.mockReturnValue(
      fakeBoundaryAwareStreamFn(ledger, [
        { type: "text_delta", contentIndex: 0, delta: "a" },
        { type: "done", reason: "stop", message: assistantMessage() },
      ]),
    );

    const seen = await runWithTurnLatencyLedger(ledger, async () => {
      const streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        sessionId: "session-1",
        model: MODEL,
      });
      const stream = await streamFn(MODEL as never, { messages: [] } as never, undefined);
      const collected: string[] = [];
      for await (const event of stream) {
        collected.push(event.type);
      }
      return collected;
    });

    expect(seen).toStrictEqual(["text_delta", "done"]);
  });
});
