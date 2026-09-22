/**
 * One turn, every model call, and nothing anybody said.
 *
 * Production could not answer "which calls did that turn make" — a plugin
 * helper completion ran before the agent and roughly four seconds between it
 * returning and the main request were unattributed. These pin the record that
 * answers it, and pin that the record cannot carry a reply, a prompt or a
 * secret even when a caller casts past the types.
 */
import { describe, expect, it } from "vitest";
import {
  buildTurnLatencyLogRecord,
  createTurnLatencyLedger,
  currentLlmCallReason,
  currentTurnLatencyLedger,
  runWithLlmCallReason,
  runWithTurnLatencyLedger,
  type TurnLatencyRecord,
} from "./turn-latency-ledger.js";

/** Everything that must never appear, whatever the caller does. */
const REPLY_TEXT = "เดือน 1-2: วิ่งสบาย ๆ 5-7 กิโลเมตร";
const REQUEST_TEXT = "อยากวิ่ง เพจ 5 ใน 6 เดือนทำไง";
const SECRET = "sk-live-0123456789abcdef";

function ledger() {
  return createTurnLatencyLedger({
    enabled: true,
    channel: "line",
    turnId: "line:m-1",
    sessionKey: "agent:main:line:U6b",
  });
}

/** The production shape: the referent helper, then the agent turn. */
async function recordOrdinaryLineTurn(): Promise<TurnLatencyRecord> {
  const turn = ledger();
  await turn.phase("before_dispatch.total", async () => {
    const helper = turn.openModelCall({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      callReason: "cloudbath_conversation_referent",
    });
    helper.responseHeaders();
    helper.complete({ promptTokens: 900, outputTokens: 40 });
  });
  const main = turn.openModelCall({
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash-0731",
    callReason: "main_agent",
  });
  main.responseHeaders();
  main.firstContentToken();
  main.complete({ promptTokens: 4200, outputTokens: 700 });
  const record = turn.finish({ outcome: "completed", runId: "run-1" });
  if (!record) {
    throw new Error("expected a record from an enabled ledger");
  }
  return record;
}

describe("the record names every call in the turn", () => {
  it("proves the ordinary LINE path is the referent helper then the agent", async () => {
    const record = await recordOrdinaryLineTurn();

    expect(record.modelCalls.map((call) => call.callReason)).toStrictEqual([
      "cloudbath_conversation_referent",
      "main_agent",
    ]);
    expect(record.modelCalls.map((call) => call.callIndex)).toStrictEqual([0, 1]);
    expect(record.modelCallCount).toBe(2);
  });

  it("measures the helper and the agent turn separately", async () => {
    const record = await recordOrdinaryLineTurn();
    const [helper, main] = record.modelCalls;

    expect(helper?.totalMs).toEqual(expect.any(Number));
    expect(main?.totalMs).toEqual(expect.any(Number));
    expect(main?.requestStartMs).toBeGreaterThanOrEqual(helper?.requestStartMs ?? 0);
  });

  it("splits the pre-agent hook chain into the helper and everything else", async () => {
    const record = await recordOrdinaryLineTurn();
    const names = record.phases.map((phase) => phase.name);

    expect(names).toContain("before_dispatch.semantic_resolver");
    expect(names).toContain("before_dispatch.other");
  });

  it("names the gap between the last hook and the first agent request", async () => {
    // The unattributed stretch this ledger was built to measure.
    const record = await recordOrdinaryLineTurn();
    const promptBuild = record.phases.find((phase) => phase.name === "prompt.build");

    expect(promptBuild).toBeDefined();
    expect(promptBuild?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("counts a second agent request as a tool iteration", () => {
    const turn = ledger();
    turn.openModelCall({ callReason: "main_agent" }).complete();
    turn.openModelCall({ callReason: "main_agent" }).complete();
    turn.openModelCall({ callReason: "main_agent" }).complete();

    const record = turn.finish({ outcome: "completed" });

    // The agent only re-calls the provider after tool results come back.
    expect(record?.modelCalls.map((call) => call.callReason)).toStrictEqual([
      "main_agent",
      "tool_followup",
      "tool_followup",
    ]);
    expect(record?.toolIterations).toBe(2);
    expect(record?.phases.map((phase) => phase.name)).toContain("tools.iterations");
  });

  it("keeps response headers and first token apart", () => {
    const turn = ledger();
    const call = turn.openModelCall({ callReason: "main_agent" });
    call.responseHeaders();
    call.firstContentToken();
    call.complete();

    const [recorded] = turn.finish({ outcome: "completed" })?.modelCalls ?? [];

    // Two fields, because an SSE stream opens before it emits anything.
    expect(recorded?.responseHeadersMs).toEqual(expect.any(Number));
    expect(recorded?.ttftMs).toEqual(expect.any(Number));
    expect(recorded?.ttftMs).toBeGreaterThanOrEqual(recorded?.responseHeadersMs ?? 0);
  });

  it("leaves a never-measured first token absent rather than zero", () => {
    const turn = ledger();
    const call = turn.openModelCall({ callReason: "plugin_llm" });
    call.responseHeaders();
    call.complete();

    expect(turn.finish({ outcome: "completed" })?.modelCalls[0]).not.toHaveProperty("ttftMs");
  });

  it("marks an unfinished call abandoned instead of completed", () => {
    const turn = ledger();
    turn.openModelCall({ callReason: "main_agent" });

    expect(turn.finish({ outcome: "error" })?.modelCalls[0]?.outcome).toBe("abandoned");
  });

  it("records a failed call as an error", () => {
    const turn = ledger();
    turn.openModelCall({ callReason: "main_agent" }).fail();

    expect(turn.finish({ outcome: "error" })?.modelCalls[0]?.outcome).toBe("error");
  });
});

describe("waits and phases", () => {
  it("records a wait only for the time spent waiting", async () => {
    const turn = ledger();
    const close = turn.beginWait("queue.wait");
    await Promise.resolve();
    close();

    expect(turn.finish({ outcome: "completed" })?.phases.map((phase) => phase.name)).toContain(
      "queue.wait",
    );
  });

  it("records a mark as a zero-length checkpoint", () => {
    const turn = ledger();
    turn.mark("inbound.received");

    const [phase] = turn.finish({ outcome: "completed" })?.phases ?? [];

    expect(phase).toMatchObject({ name: "inbound.received", durationMs: 0 });
  });

  it("closes a phase even when the work throws", async () => {
    const turn = ledger();

    await expect(
      turn.phase("model.calls", () => Promise.reject(new Error("provider down"))),
    ).rejects.toThrow("provider down");

    expect(turn.finish({ outcome: "error" })?.phases.map((phase) => phase.name)).toContain(
      "model.calls",
    );
  });
});

describe("an inert ledger costs nothing and reports nothing", () => {
  it("returns no record and still runs the work", async () => {
    const turn = createTurnLatencyLedger({ enabled: false, channel: "line", turnId: "line:m-1" });

    await expect(turn.phase("model.calls", () => Promise.resolve("value"))).resolves.toBe("value");
    expect(turn.enabled).toBe(false);
    expect(turn.finish({ outcome: "completed" })).toBeUndefined();
  });
});

describe("the carriers reach the transport", () => {
  it("exposes the ledger and the call reason to nested async work", async () => {
    const turn = ledger();

    const seen = await runWithTurnLatencyLedger(turn, async () =>
      runWithLlmCallReason("cloudbath_conversation_referent", async () => {
        await Promise.resolve();
        return { ledger: currentTurnLatencyLedger()?.turnId, reason: currentLlmCallReason() };
      }),
    );

    expect(seen).toStrictEqual({
      ledger: "line:m-1",
      reason: "cloudbath_conversation_referent",
    });
  });

  it("reports an unlabelled call rather than guessing", () => {
    expect(currentLlmCallReason()).toBe("unknown");
  });
});

describe("the record never carries content", () => {
  it("emits no reply, request or secret for a fully populated turn", async () => {
    const record = await recordOrdinaryLineTurn();

    const emitted = JSON.stringify(buildTurnLatencyLogRecord(record));

    for (const forbidden of [REPLY_TEXT, REQUEST_TEXT, SECRET]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it("has no field that accepts text, even for a caller casting past the types", () => {
    const turn = ledger();
    turn
      .openModelCall({
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash-0731",
        callReason: "main_agent",
        replyText: REPLY_TEXT,
        prompt: REQUEST_TEXT,
      } as never)
      .complete({ promptTokens: 1, outputTokens: 1, apiKey: SECRET } as never);
    const record = turn.finish({ outcome: "completed", note: REPLY_TEXT } as never);

    const emitted = JSON.stringify(buildTurnLatencyLogRecord(record as TurnLatencyRecord));

    for (const forbidden of [REPLY_TEXT, REQUEST_TEXT, SECRET]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it("reduces a smuggled sentence to an identifier before storing it", () => {
    // Prose carries spaces and punctuation; an id does not. A phase name or a
    // session key is sanitized rather than escaped, so no field that
    // legitimately exists can carry a sentence.
    const turn = createTurnLatencyLedger({
      enabled: true,
      channel: "line",
      turnId: "line:m-1",
      sessionKey: REQUEST_TEXT,
    });
    turn.mark(REPLY_TEXT);

    const emitted = JSON.stringify(buildTurnLatencyLogRecord(turn.finish({ outcome: "ok" })!));

    expect(emitted).not.toContain(REPLY_TEXT);
    expect(emitted).not.toContain(REQUEST_TEXT);
    expect(emitted).not.toContain(" ");
  });

  it("refuses an invented call reason", () => {
    const turn = ledger();
    turn.openModelCall({ callReason: "exfiltrate" as never }).complete();

    expect(turn.finish({ outcome: "completed" })?.modelCalls[0]?.callReason).toBe("unknown");
  });
});
