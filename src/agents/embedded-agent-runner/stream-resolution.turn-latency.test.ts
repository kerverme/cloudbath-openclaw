/**
 * The main agent's stream, observed end to end on the path production takes.
 *
 * Two production defects live here, and both needed the real path to show:
 *
 * 1. #92's observer sat on the `src/llm/stream.ts` facade, which an embedded
 *    attempt almost never uses. `openai-completions` (how OpenRouter models run)
 *    resolves to a boundary-aware transport instead, so the record showed
 *    `main_agent=?ms(ttft=?)`: opened by the transport, never closed.
 *
 * 2. #93 moved the observer to `resolveEmbeddedAgentStreamFn`, and every
 *    main-agent turn with the profiler on then failed immediately with
 *
 *      Cannot assign to read only property 'result' of object '#<AssistantMessageEventStream>'
 *
 *    because the attempt re-wraps the resolved stream IN PLACE — among others
 *    `wrapStreamFnHandleSensitiveStopReason` assigns `result` and the async
 *    iterator — and the observer had defined both as non-writable own
 *    properties.
 *
 * Nothing here is module-mocked. A loopback server speaks OpenAI-compatible SSE,
 * and the real resolver, the real boundary-aware transport, the real guarded
 * fetch (which is what opens the ledger call and records headers), the real SSE
 * parser and the real downstream wrapper all run. That is also what keeps this
 * file safe in the non-isolated unit-fast lane: a second factory for
 * provider-transport-stream.js would collide with stream-resolution.test.ts.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTurnLatencyLedger,
  runWithLlmCallReason,
  runWithTurnLatencyLedger,
  type TurnLatencyLedger,
  type TurnLatencyModelCall,
} from "../../infra/turn-latency-ledger.js";
import type { StreamFn } from "../runtime/index.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./run/attempt.stop-reason-recovery.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";

type ResolverModel = Parameters<typeof resolveEmbeddedAgentStreamFn>[0]["model"];

const REPLY_TEXT = "เดือน 1-2: วิ่งสบาย ๆ";
/** Long enough that headers-time and first-token time cannot coincide. */
const FIRST_TOKEN_DELAY_MS = 80;

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open) {
    await new Promise<void>((resolve) => {
      open.close(() => resolve());
    });
  }
});

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-turn-latency",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek/deepseek-v4-flash-0731",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

/**
 * An OpenAI-compatible endpoint that opens the stream, waits, and only then
 * sends content — the shape that makes headers-time flatter first-token.
 */
async function startCompletionsServer(options: { status?: number } = {}): Promise<string> {
  const listening = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (options.status && options.status !== 200) {
        response.writeHead(options.status, { "content-type": "application/json" });
        response.end('{"error":{"message":"upstream unavailable"}}');
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.flushHeaders();
      // The role-only opener carries no text, so it must not count as first token.
      response.write(chunk({ role: "assistant", content: "" }));
      setTimeout(() => {
        response.write(chunk({ content: REPLY_TEXT }));
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-turn-latency",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "deepseek/deepseek-v4-flash-0731",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4200, completion_tokens: 700, total_tokens: 4900 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
      }, FIRST_TOKEN_DELAY_MS);
    });
  });
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}/v1`;
}

/** The production model shape, pointed at the loopback endpoint. */
function productionModel(baseUrl: string): ResolverModel {
  return {
    id: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65_536,
    maxTokens: 1024,
  } as unknown as ResolverModel;
}

const CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
  tools: [],
} as never;

function newLedger(): TurnLatencyLedger {
  return createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "line:m-1" });
}

/** One main-agent turn, composed the way the attempt composes it. */
async function runMainAgentTurn(
  ledger: TurnLatencyLedger,
  model: ResolverModel,
  options: { rewrap?: boolean } = {},
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  return await runWithTurnLatencyLedger(ledger, () =>
    runWithLlmCallReason("main_agent", async () => {
      const resolved = resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        sessionId: "session-1",
        model,
        resolvedApiKey: "test-key",
      });
      const streamFn = options.rewrap ? wrapStreamFnHandleSensitiveStopReason(resolved) : resolved;
      const stream = await streamFn(model as never, CONTEXT, undefined);
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      return { events, message: await stream.result() };
    }),
  );
}

function onlyCall(ledger: TurnLatencyLedger): TurnLatencyModelCall | undefined {
  const calls = ledger.finish({ outcome: "completed" })?.modelCalls ?? [];
  // One provider request, one entry: wrapping must never double-count it.
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe("the production branch", () => {
  it("resolves the production model to the boundary-aware transport", () => {
    expect(
      describeEmbeddedAgentStreamStrategy({
        currentStreamFn: undefined,
        model: productionModel("http://127.0.0.1:1/v1"),
      }),
    ).toBe("boundary-aware:openai-completions");
  });
});

describe("a streamed main-agent turn is on the record", () => {
  it("records the whole call", async () => {
    const ledger = newLedger();
    await runMainAgentTurn(ledger, productionModel(await startCompletionsServer()));

    const call = onlyCall(ledger);

    expect(call).toMatchObject({
      callReason: "main_agent",
      provider: "openrouter",
      outcome: "completed",
      promptTokens: 4200,
      outputTokens: 700,
    });
    for (const field of [
      "requestStartMs",
      "responseHeadersMs",
      "ttftMs",
      "completionMs",
      "totalMs",
    ] as const) {
      expect(call?.[field]).toEqual(expect.any(Number));
    }
  });

  it("takes first token from the first NON-EMPTY delta, not from headers", async () => {
    const ledger = newLedger();
    await runMainAgentTurn(ledger, productionModel(await startCompletionsServer()));

    const call = onlyCall(ledger);

    // The server opens the stream, sends an empty role-only delta, and waits
    // before any text. Headers-time would miss that whole wait.
    expect((call?.ttftMs ?? 0) - (call?.responseHeadersMs ?? 0)).toBeGreaterThanOrEqual(
      FIRST_TOKEN_DELAY_MS - 20,
    );
  });

  it("closes a call whose provider request fails", async () => {
    const ledger = newLedger();
    // 400, not 5xx: the SDK retries 5xx, and each retry is its own request.
    await runMainAgentTurn(ledger, productionModel(await startCompletionsServer({ status: 400 })));

    expect(onlyCall(ledger)?.outcome).toBe("error");
  });
});

describe("the attempt can still re-wrap the observed stream in place", () => {
  it("lets the real downstream wrapper replace result and the iterator", async () => {
    const ledger = newLedger();

    const { message } = await runMainAgentTurn(
      ledger,
      productionModel(await startCompletionsServer()),
      { rewrap: true },
    );

    expect(message.content).toContainEqual(expect.objectContaining({ text: REPLY_TEXT }));
  });

  it("still records the whole call after being re-wrapped", async () => {
    const ledger = newLedger();
    await runMainAgentTurn(ledger, productionModel(await startCompletionsServer()), {
      rewrap: true,
    });

    const call = onlyCall(ledger);

    expect(call).toMatchObject({ callReason: "main_agent", outcome: "completed" });
    for (const field of ["responseHeadersMs", "ttftMs", "completionMs", "totalMs"] as const) {
      expect(call?.[field]).toEqual(expect.any(Number));
    }
  });

  it("yields exactly the events an unobserved turn yields", async () => {
    const model = productionModel(await startCompletionsServer());
    const observed = await runMainAgentTurn(newLedger(), model, { rewrap: true });
    // Same transport, same server, no ledger: nothing is wrapped at all.
    const plain = await runWithLlmCallReason("main_agent", async () => {
      const streamFn = wrapStreamFnHandleSensitiveStopReason(
        resolveEmbeddedAgentStreamFn({
          currentStreamFn: undefined,
          sessionId: "session-1",
          model,
          resolvedApiKey: "test-key",
        }),
      );
      const stream = await streamFn(model as never, CONTEXT, undefined);
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      return types;
    });

    expect(observed.events.map((event) => event.type)).toStrictEqual(plain);
  });
});

describe("the observed stream is the provider's stream, not a copy", () => {
  /** A provider-owned stream, as a provider plugin hands one over. */
  function providerOwnedTurn(stream: AssistantMessageEventStream): {
    model: ResolverModel;
    providerStreamFn: StreamFn;
  } {
    return {
      model: productionModel("http://127.0.0.1:1/v1"),
      providerStreamFn: (() => stream) as unknown as StreamFn,
    };
  }

  it("never writes a downstream replacement onto the provider's stream", async () => {
    const providerStream = createAssistantMessageEventStream();
    const { model, providerStreamFn } = providerOwnedTurn(providerStream);

    await runWithTurnLatencyLedger(newLedger(), async () => {
      const streamFn = wrapStreamFnHandleSensitiveStopReason(
        resolveEmbeddedAgentStreamFn({
          currentStreamFn: undefined,
          providerStreamFn,
          sessionId: "session-1",
          model,
        }),
      );
      await streamFn(model as never, CONTEXT, undefined);
    });

    expect(Object.hasOwn(providerStream, "result")).toBe(false);
    expect(Object.hasOwn(providerStream, Symbol.asyncIterator)).toBe(false);
  });

  it("keeps push, end and provider-specific members acting on the provider's stream", async () => {
    const providerStream = createAssistantMessageEventStream() as AssistantMessageEventStream & {
      providerRequestId?: string;
    };
    providerStream.providerRequestId = "req-1";
    const { model, providerStreamFn } = providerOwnedTurn(providerStream);

    const observed = (await runWithTurnLatencyLedger(newLedger(), async () =>
      resolveEmbeddedAgentStreamFn({
        currentStreamFn: undefined,
        providerStreamFn,
        sessionId: "session-1",
        model,
      })(model as never, CONTEXT, undefined),
    )) as AssistantMessageEventStream & { providerRequestId?: string };

    expect(observed.providerRequestId).toBe("req-1");
    observed.push({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: [] } as unknown as AssistantMessage,
    });
    observed.end();

    // The provider's own iterator only terminates if ITS state was closed. With
    // push/end running against a shadow object it drains and then waits forever.
    const drained = (async () => {
      const types: string[] = [];
      for await (const event of providerStream) {
        types.push(event.type);
      }
      return types;
    })();
    const stalled = new Promise<"stalled">((resolve) => {
      setTimeout(() => resolve("stalled"), 200);
    });
    await expect(Promise.race([drained, stalled])).resolves.toStrictEqual(["done"]);
  });
});

describe("with nothing recording, nothing is wrapped", () => {
  it("returns a caller's own stream function unchanged", () => {
    const providerStream = createAssistantMessageEventStream();
    const customStreamFn = (() => providerStream) as unknown as StreamFn;

    // Diagnostics off is the production default; the path must then be exactly
    // what it was before the observer existed.
    expect(
      resolveEmbeddedAgentStreamFn({
        currentStreamFn: customStreamFn,
        sessionId: "session-1",
        model: { provider: "custom", id: "m", api: "custom-api" } as unknown as ResolverModel,
      }),
    ).toBe(customStreamFn);
  });
});
