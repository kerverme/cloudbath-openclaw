/**
 * An aggregate question over a Wellness Notion table costs two model calls.
 *
 * Drives the real agent loop with the real scoped Notion tools against a
 * synthetic Notion workspace, behind the same two context seams the embedded
 * runner installs: the tool-loop context guard and provider dispatch, which
 * cuts every tool result to the live cap before the request leaves. The model
 * is a double that answers only from what that request carries: it sums the
 * rows it can read and, when a result arrives cut off, asks for smaller pages
 * until the rows fit.
 *
 * Production: "how much did we spend?" over a ~100-row table took 9-12 model
 * calls and 42-183 s. Raw pretty-printed Notion rows (~6.6k chars each) left
 * the model 9 readable rows per 64k-char result, and the guard counted the
 * uncut bodies, overflowed, and forced compaction and a retry.
 */
import { Agent, type AgentTool, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudbathNotionTools } from "../extensions/cloudbath-line-image-archive/src/notion-tools.js";
import {
  type NotionRequest,
  recordId,
  syntheticWellnessFetch,
  transactionAmount,
  transactionSource,
} from "../extensions/cloudbath-line-image-archive/src/notion-tools.test-support.js";
import { wrapStreamFnWithMessageTransform } from "../src/agents/embedded-agent-runner/run/message-transform-stream-wrapper.js";
import {
  installToolResultContextGuard,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
} from "../src/agents/embedded-agent-runner/tool-result-context-guard.js";
import {
  createToolResultPromptProjectionState,
  resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInMessages,
} from "../src/agents/embedded-agent-runner/tool-result-truncation.js";

// The production window: 1.05M tokens, so each tool result reaches the provider cut to 64k chars.
const CONTEXT_WINDOW_TOKENS = 1_050_000;
const TOOL_RESULT_MAX_CHARS = resolveLiveToolResultMaxChars({
  contextWindowTokens: CONTEXT_WINDOW_TOKENS,
});
const TOOL_RESULT_AGGREGATE_MAX_CHARS = resolveLiveToolResultAggregateMaxChars({
  contextWindowTokens: CONTEXT_WINDOW_TOKENS,
  perResultMaxChars: TOOL_RESULT_MAX_CHARS,
});

const MODEL = {
  api: "openai-responses",
  provider: "openrouter",
  id: "analyst-double",
  name: "Analyst double",
  input: ["text"],
  reasoning: false,
  contextWindow: CONTEXT_WINDOW_TOKENS,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<"openai-responses">;

type ProviderMessage = Context["messages"][number];
type ToolCall = { name: string; arguments: Record<string, unknown> };
type QueryRow = { id: string; properties: Record<string, unknown> };

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function text(message: ProviderMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((block: { text?: unknown }) => (typeof block.text === "string" ? block.text : ""))
        .join("")
    : "";
}

function readable(resultText: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(resultText) as Record<string, unknown>;
  } catch {
    // Cut off by the provider cap: the rows past the cut never reached the model.
    return undefined;
  }
}

/** The calls the model made this turn, each paired with the result text it was sent. */
function turnTools(messages: ProviderMessage[]): Array<ToolCall & { result: string }> {
  const calls = new Map<string, ToolCall>();
  const paired: Array<ToolCall & { result: string }> = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          calls.set(block.id, { name: block.name, arguments: block.arguments });
        }
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call) {
        paired.push({ ...call, result: text(message) });
      }
    }
  }
  return paired;
}

type Decision = { call: ToolCall } | { answer: string };

/**
 * Totals a ledger from query results. Reads only the rows the provider request
 * carried; a result cut off by the cap is retried at half the page size, and a
 * readable page with more rows is followed by its cursor.
 */
function ledgerAnalyst(messages: ProviderMessage[]): Decision {
  const queries = turnTools(messages).filter((call) => call.name === "wellness_notion_query");
  const last = queries.at(-1);
  if (!last) {
    return { call: { name: "wellness_notion_query", arguments: { max_records: 100 } } };
  }
  const page = readable(last.result);
  if (!page) {
    const maxRecords = Math.max(1, Math.floor(Number(last.arguments.max_records) / 2));
    return { call: { name: last.name, arguments: { ...last.arguments, max_records: maxRecords } } };
  }
  if (page.hasMore === true) {
    return {
      call: {
        name: last.name,
        arguments: { max_records: last.arguments.max_records, start_cursor: page.nextCursor },
      },
    };
  }
  const rows = queries.flatMap(
    (query) => (readable(query.result)?.records as QueryRow[] | undefined) ?? [],
  );
  // Reads the amount whether a row carries it plain or inside Notion's number wrapper.
  const amount = (value: unknown) =>
    typeof value === "number" ? value : Number((value as { number?: unknown } | null)?.number);
  const total = rows.reduce((sum, row) => sum + amount(row.properties.Amount), 0);
  return { answer: `Total spend ${total.toFixed(2)} across ${rows.length} transactions` };
}

function runTurn(params: {
  prompt: string;
  tools: AgentTool[];
  decide: (messages: ProviderMessage[]) => Decision;
}) {
  const providerRequests: ProviderMessage[][] = [];
  let callId = 0;
  const model: StreamFn = (_model, context) => {
    providerRequests.push(context.messages);
    const decision = params.decide(context.messages);
    const stream = createAssistantMessageEventStream();
    const message =
      "answer" in decision
        ? assistant([{ type: "text", text: decision.answer }])
        : assistant([
            {
              type: "toolCall",
              id: `call_${(callId += 1)}`,
              name: decision.call.name,
              arguments: decision.call.arguments,
            },
          ]);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    });
    return stream;
  };
  // The runner's provider-dispatch transform: every tool result is cut to the live caps.
  const projection = createToolResultPromptProjectionState();
  const agent = new Agent({
    initialState: {
      model: MODEL,
      systemPrompt: "You are a bookkeeping assistant.",
      tools: params.tools,
    },
    streamFn: wrapStreamFnWithMessageTransform(
      model,
      (messages) =>
        truncateOversizedToolResultsInMessages(
          messages,
          CONTEXT_WINDOW_TOKENS,
          TOOL_RESULT_MAX_CHARS,
          TOOL_RESULT_AGGREGATE_MAX_CHARS,
          projection,
        ).messages,
    ),
  });
  installToolResultContextGuard({
    agent,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    providerToolResultCaps: {
      maxChars: TOOL_RESULT_MAX_CHARS,
      aggregateMaxChars: TOOL_RESULT_AGGREGATE_MAX_CHARS,
    },
  });
  return {
    providerRequests,
    done: agent.prompt(params.prompt).then(() => {
      const last = agent.state.messages.at(-1);
      return {
        error: agent.state.errorMessage,
        answer: last?.role === "assistant" ? text(last as ProviderMessage) : undefined,
      };
    }),
  };
}

function notionTools(requests: NotionRequest[], pageCount = 100): AgentTool[] {
  return createCloudbathNotionTools(
    syntheticWellnessFetch([transactionSource(0, "Ledger", pageCount)], requests),
  ) as unknown as AgentTool[];
}

const LEDGER_TOTAL = Array.from({ length: 100 }, (_, index) => transactionAmount(index)).reduce(
  (sum, amount) => sum + amount,
  0,
);

beforeEach(() => {
  vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("aggregate question over a 100-row Wellness table", () => {
  it("is answered from one query: main agent, one tool round, final answer", async () => {
    const notionRequests: NotionRequest[] = [];
    const turn = runTurn({
      prompt: "How much did we spend in total across the ledger?",
      tools: notionTools(notionRequests),
      decide: ledgerAnalyst,
    });

    const { error, answer } = await turn.done;

    expect(error).toBeUndefined();
    expect(answer).toBe(`Total spend ${LEDGER_TOTAL.toFixed(2)} across 100 transactions`);
    expect(turn.providerRequests).toHaveLength(2);
    // The second request carried the whole result: nothing was cut to reach the cap.
    const [queryResult] = turnTools(turn.providerRequests[1]!);
    expect(queryResult?.result.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
    expect(readable(queryResult!.result)?.records).toHaveLength(100);
    expect(notionRequests.filter((request) => request.url.includes("/query"))).toHaveLength(1);
  });
});

describe("records the model already knows are fetched together", () => {
  it("one batched get_record call returns every requested record", async () => {
    const notionRequests: NotionRequest[] = [];
    const wanted = [recordId(0, 12), recordId(0, 47), recordId(0, 88)];
    const turn = runTurn({
      prompt: `What are the amounts on ${wanted.join(", ")}?`,
      tools: notionTools(notionRequests),
      decide: (messages) => {
        const [lookup] = turnTools(messages);
        if (!lookup) {
          return {
            call: { name: "wellness_notion_get_record", arguments: { record_ids: wanted } },
          };
        }
        const { records } = readable(lookup.result) as { records: QueryRow[] };
        return {
          answer: records.map((row) => `${row.id}=${String(row.properties.Amount)}`).join(" "),
        };
      },
    });

    const { error, answer } = await turn.done;

    expect(error).toBeUndefined();
    expect(answer).toBe(
      [12, 47, 88].map((index) => `${recordId(0, index)}=${transactionAmount(index)}`).join(" "),
    );
    expect(turn.providerRequests).toHaveLength(2);
    expect(notionRequests.filter((request) => request.url.includes("/v1/blocks/"))).toHaveLength(1);
  });
});

describe("the tool-loop guard budgets what provider dispatch sends", () => {
  const rawExport = "x".repeat(660_000);
  const exportTool: AgentTool = {
    name: "ledger_export",
    label: "Ledger export",
    description: "Exports the ledger as text.",
    parameters: { type: "object", properties: {} } as AgentTool["parameters"],
    execute: async () => ({ content: [{ type: "text", text: rawExport }], details: undefined }),
  };

  function exportsThenAnswer(count: number) {
    return (messages: ProviderMessage[]): Decision =>
      turnTools(messages).length < count
        ? { call: { name: "ledger_export", arguments: {} } }
        : { answer: "exported" };
  }

  it("does not overflow on raw tool bodies that dispatch cuts to the cap", async () => {
    const turn = runTurn({
      prompt: "Export it four times.",
      tools: [exportTool],
      decide: exportsThenAnswer(4),
    });

    const { error, answer } = await turn.done;

    expect(error).toBeUndefined();
    expect(answer).toBe("exported");
    expect(turn.providerRequests).toHaveLength(5);
    for (const result of turnTools(turn.providerRequests[4]!)) {
      expect(result.result.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    }
  });

  it("still stops a turn whose context is too large after the caps", async () => {
    const turn = runTurn({
      prompt: "u".repeat(3_800_000),
      tools: [exportTool],
      decide: exportsThenAnswer(1),
    });

    const { error } = await turn.done;

    expect(error).toContain(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    expect(turn.providerRequests).toHaveLength(0);
  });
});
