/**
 * The latency record, driven as a real turn drives it.
 *
 * Goal is diagnostic fidelity, so these tests care about exactly the
 * distinctions the investigation got wrong before: TTFT is not total provider
 * time, provider time is not user-visible time, and queue/lock waiting is its
 * own number rather than being buried inside another phase.
 */
import { describe, expect, it } from "vitest";
import {
  createTurnLatencyLedger,
  currentTurnLatencyLedger,
  formatTurnLatencyRecord,
  runWithTurnLatencyLedger,
  TURN_LATENCY_PHASES,
  type TurnLatencyLedger,
} from "./turn-latency-ledger.js";

/** A controllable clock, so assertions are exact instead of timing-dependent. */
function fakeClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function ledgerWith(clock: { now: () => number }): TurnLatencyLedger {
  return createTurnLatencyLedger({
    enabled: true,
    channel: "line",
    turnId: "turn-1",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    inboundMessageId: "631349597666541587",
    conversationId: "line:group:Cdb23ef53fcf7fbde85371b7ba0cd6bb7",
    sessionKey: "agent:main:line:group:cdb23ef53fcf7fbde85371b7ba0cd6bb7",
    buildSha: "b845068928d264093386bc5b4ef1b210a523a09d",
    now: clock.now,
  });
}

describe("one turn, one correlated record", () => {
  it("carries every correlation id a trace needs", () => {
    const clock = fakeClock();
    const record = ledgerWith(clock).finish({
      outcome: "delivered",
      deliveryAttemptId: "attempt-1",
    });

    expect(record).toMatchObject({
      turnId: "turn-1",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      channel: "line",
      inboundMessageId: "631349597666541587",
      conversationId: "line:group:Cdb23ef53fcf7fbde85371b7ba0cd6bb7",
      sessionKey: "agent:main:line:group:cdb23ef53fcf7fbde85371b7ba0cd6bb7",
      deliveryAttemptId: "attempt-1",
      buildSha: "b845068928d264093386bc5b4ef1b210a523a09d",
      outcome: "delivered",
    });
  });

  it("reports user-visible latency as open-to-finish, not summed phases", async () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    await ledger.phase("prompt.build", () => clock.advance(40));
    clock.advance(600); // time inside no phase at all — still the user's wait
    await ledger.phase("delivery.send", () => clock.advance(60));

    const record = ledger.finish({ outcome: "delivered" });

    expect(record?.userVisibleMs).toBe(700);
    // The gap proves the record cannot be reconstructed from phases alone.
    const phaseTotal = record!.phases.reduce((sum, phase) => sum + phase.durationMs, 0);
    expect(phaseTotal).toBeLessThan(record!.userVisibleMs);
  });

  it("places each phase on the timeline in closing order", async () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    await ledger.phase("route.tool_policy", () => clock.advance(10));
    await ledger.phase("prompt.build", () => clock.advance(30));

    expect(ledger.finish({ outcome: "delivered" })?.phases).toEqual([
      { name: "route.tool_policy", durationMs: 10, atMs: 10 },
      { name: "prompt.build", durationMs: 30, atMs: 40 },
    ]);
  });

  it("returns the measured value untouched", async () => {
    const ledger = ledgerWith(fakeClock());

    await expect(ledger.phase("prompt.build", async () => "kept")).resolves.toBe("kept");
  });

  it("still closes a phase when the stage throws", async () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    await expect(
      ledger.phase("model.calls", () => {
        clock.advance(25);
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    expect(ledger.finish({ outcome: "error" })?.phases).toEqual([
      { name: "model.calls", durationMs: 25, atMs: 25 },
    ]);
  });
});

describe("queue and lock waiting is its own number", () => {
  it("sums waits separately from other phases", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const endQueue = ledger.beginWait("queue.wait");
    clock.advance(120);
    endQueue();
    const endLock = ledger.beginWait("session.lock_wait");
    clock.advance(80);
    endLock();

    const record = ledger.finish({ outcome: "delivered" });

    expect(record?.waitMs).toBe(200);
    expect(record?.phases.map((phase) => phase.name)).toEqual(["queue.wait", "session.lock_wait"]);
  });

  it("counts a wait once even if closed twice", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const end = ledger.beginWait("queue.wait");
    clock.advance(50);
    end();
    end();

    expect(ledger.finish({ outcome: "delivered" })?.waitMs).toBe(50);
  });

  it("reports zero wait rather than omitting it", () => {
    expect(ledgerWith(fakeClock()).finish({ outcome: "delivered" })?.waitMs).toBe(0);
  });
});

describe("provider calls: TTFT is not total, and count is visible", () => {
  it("separates time to first byte from the whole response", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const call = ledger.modelCall({ provider: "openrouter", model: "deepseek-v4-flash-0731" });
    clock.advance(900);
    call.responseStarted(); // SSE headers
    clock.advance(400);
    call.firstByte(); // first content token, strictly later
    clock.advance(8_300);
    call.complete({ promptTokens: 3_120, outputTokens: 210 });

    const record = ledger.finish({ outcome: "delivered" });

    expect(record?.modelCalls[0]).toMatchObject({
      provider: "openrouter",
      model: "deepseek-v4-flash-0731",
      responseStartMs: 900,
      ttftMs: 1_300,
      totalMs: 9_600,
      promptTokens: 3_120,
      outputTokens: 210,
      outcome: "completed",
    });
    // The three distinctions the first investigation collapsed into one number.
    expect(record?.firstResponseStartMs).toBe(900);
    expect(record?.firstTtftMs).toBe(1_300);
    expect(record?.firstTtftMs).not.toBe(record?.modelCalls[0]?.totalMs);
  });

  it("counts every call in the turn and sums their durations", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    // Production showed four provider calls in fourteen seconds on one turn.
    for (const duration of [800, 1_240, 720, 760]) {
      const call = ledger.modelCall({ model: "deepseek-v4-flash-0731" });
      clock.advance(duration);
      call.complete({ promptTokens: 1_000, outputTokens: 50 });
    }

    const record = ledger.finish({ outcome: "delivered" });

    expect(record?.modelCallCount).toBe(4);
    expect(record?.modelTotalMs).toBe(3_520);
    expect(record?.promptTokens).toBe(4_000);
    expect(record?.outputTokens).toBe(200);
  });

  it("keeps only the FIRST call's TTFT as the turn's TTFT", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const first = ledger.modelCall();
    clock.advance(300);
    first.firstByte();
    first.complete();
    const second = ledger.modelCall();
    clock.advance(50);
    second.firstByte();
    second.complete();

    expect(ledger.finish({ outcome: "delivered" })?.firstTtftMs).toBe(300);
  });

  it("leaves ttft absent when only the response start was observed", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    // What the transport can report today: headers only. Absent must read as
    // "not measured", never as zero.
    const call = ledger.modelCall();
    clock.advance(700);
    call.responseStarted();
    call.complete();
    const record = ledger.finish({ outcome: "delivered" })!;

    expect(record.firstResponseStartMs).toBe(700);
    expect(record.firstTtftMs).toBeUndefined();
    expect(record.modelCalls[0]).not.toHaveProperty("ttftMs");
  });

  it("records a call that never returns instead of dropping it", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    ledger.modelCall({ model: "deepseek-v4-flash-0731" });
    clock.advance(30_000);

    // A hung provider request is exactly what must not vanish from the record.
    const call = ledger.finish({ outcome: "timeout" })?.modelCalls[0];
    expect(call).toMatchObject({ outcome: "abandoned", model: "deepseek-v4-flash-0731" });
    // No total, because the call never finished — not a fabricated duration.
    expect(call).not.toHaveProperty("totalMs");
  });

  it("records a failed call as an error, with its duration", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const call = ledger.modelCall();
    clock.advance(400);
    call.fail();

    expect(ledger.finish({ outcome: "error" })?.modelCalls[0]).toMatchObject({
      outcome: "error",
      totalMs: 400,
    });
  });

  it("ignores a duplicate settle, so a retry wrapper cannot double-count", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    const call = ledger.modelCall();
    clock.advance(100);
    call.complete({ outputTokens: 10 });
    clock.advance(5_000);
    call.complete({ outputTokens: 999 });

    expect(ledger.finish({ outcome: "delivered" })?.modelCalls[0]).toMatchObject({
      totalMs: 100,
      outputTokens: 10,
    });
  });
});

describe("it logs no message content", () => {
  it("has no API that accepts text, and renders none", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);
    const call = ledger.modelCall({ provider: "openrouter", model: "deepseek-v4-flash-0731" });
    clock.advance(120);
    call.firstByte();
    call.complete({ promptTokens: 10, outputTokens: 5 });
    const record = ledger.finish({ outcome: "delivered" })!;

    const rendered = formatTurnLatencyRecord(record);
    // Every field is an id, a name, a count or a duration.
    expect(rendered).toContain("turnId=turn-1");
    expect(rendered).toContain("firstTtftMs=120");
    expect(JSON.stringify(record)).not.toMatch(/[฀-๿]/u);
    expect(rendered).not.toMatch(/[฀-๿]/u);
  });

  it("renders a readable line for a turn with nothing recorded", () => {
    const record = ledgerWith(fakeClock()).finish({ outcome: "skipped" })!;

    expect(formatTurnLatencyRecord(record)).toContain("phases=[none] calls=[none]");
  });
});

describe("instrumentation completeness", () => {
  it("names every stage the investigation asked for", () => {
    // A missing phase is how "we measured it" becomes "we measured the easy
    // part", so the expected set is pinned rather than left implicit.
    expect([...TURN_LATENCY_PHASES]).toEqual([
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
    ]);
  });

  it("accepts every declared phase name", async () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    for (const name of TURN_LATENCY_PHASES) {
      await ledger.phase(name, () => clock.advance(1));
    }

    expect(ledger.finish({ outcome: "delivered" })?.phases).toHaveLength(
      TURN_LATENCY_PHASES.length,
    );
  });
});

describe("it is free when disabled", () => {
  it("records nothing and returns no record", async () => {
    const clock = fakeClock();
    const ledger = createTurnLatencyLedger({
      channel: "line",
      turnId: "turn-off",
      now: clock.now,
    });

    const end = ledger.beginWait("queue.wait");
    clock.advance(5_000);
    end();
    const call = ledger.modelCall({ model: "m" });
    call.responseStarted();
    call.firstByte();
    call.complete({ outputTokens: 1 });
    await ledger.phase("prompt.build", () => clock.advance(10));

    expect(ledger.enabled).toBe(false);
    expect(ledger.finish({ outcome: "delivered" })).toBeUndefined();
  });

  it("still passes the measured value through when disabled", async () => {
    const ledger = createTurnLatencyLedger({ channel: "line", turnId: "turn-off" });

    await expect(ledger.phase("prompt.build", async () => 42)).resolves.toBe(42);
  });
});

describe("finishing twice", () => {
  it("emits one record only, so a retry cannot double-report a turn", () => {
    const ledger = ledgerWith(fakeClock());

    expect(ledger.finish({ outcome: "delivered" })).toBeDefined();
    expect(ledger.finish({ outcome: "delivered" })).toBeUndefined();
  });
});

describe("the default clock is monotonic", () => {
  it("never reports a negative duration", async () => {
    // Wall-clock deltas go backwards across an NTP step; performance.now() does
    // not, which is why the ledger does not use Date.now().
    const ledger = createTurnLatencyLedger({ enabled: true, channel: "line", turnId: "turn-real" });

    await ledger.phase("prompt.build", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const record = ledger.finish({ outcome: "delivered" })!;

    expect(record.userVisibleMs).toBeGreaterThan(0);
    for (const phase of record.phases) {
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
      expect(phase.atMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the carrier the provider transport relies on", () => {
  it("exposes the active ledger to code that was handed no argument", () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    runWithTurnLatencyLedger(ledger, () => {
      // Stands in for provider-transport-fetch, several layers below dispatch.
      const call = currentTurnLatencyLedger()?.modelCall({
        provider: "openrouter",
        model: "deepseek-v4-flash-0731",
      });
      clock.advance(450);
      call?.responseStarted();
      call?.complete({ promptTokens: 2_000, outputTokens: 80 });
    });

    const record = ledger.finish({ outcome: "delivered" })!;
    expect(record.modelCallCount).toBe(1);
    expect(record.firstResponseStartMs).toBe(450);
    expect(record.promptTokens).toBe(2_000);
  });

  it("is invisible outside a scope, so a stray call records nothing", () => {
    expect(currentTurnLatencyLedger()).toBeUndefined();
  });

  it("hides a disabled ledger, so the transport does no work when off", () => {
    const off = createTurnLatencyLedger({ channel: "line", turnId: "turn-off" });

    runWithTurnLatencyLedger(off, () => {
      expect(currentTurnLatencyLedger()).toBeUndefined();
    });
  });

  it("survives an await inside the scope", async () => {
    const clock = fakeClock();
    const ledger = ledgerWith(clock);

    await runWithTurnLatencyLedger(ledger, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      currentTurnLatencyLedger()?.modelCall({ model: "m" }).complete();
    });

    expect(ledger.finish({ outcome: "delivered" })?.modelCallCount).toBe(1);
  });
});
