/**
 * What the OpenClaw UI actually receives when a reply drifts out of the
 * expected language.
 *
 * The streamed delta path publishes before any outbound hook exists, which is
 * why the UI showed the provider's raw text while LINE showed a repaired
 * version of the same turn. These tests assert the literal event sequence —
 * which payloads were broadcast, in which order, with which text — rather than
 * inferring it from the source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerAgentRunContext,
  resetAgentRunContextForTest,
  type AgentRunContext,
} from "../infra/agent-events.js";
import { resetAuthoritativeReplyTextForTest } from "../infra/reply-language-repair.js";

const logWarnMock = vi.fn();

vi.mock("./server-chat.persist-session-lifecycle.runtime.js", () => ({
  persistGatewaySessionLifecycleEvent: vi.fn(async () => undefined),
}));

vi.mock("../logger.js", () => ({
  logError: vi.fn(),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

vi.mock("./server-chat.load-gateway-session-row.runtime.js", () => ({
  loadGatewaySessionRow: vi.fn(() => null),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-1",
    storeKeys: ["session-1"],
    legacyKey: undefined,
  })),
}));

import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const THAI_POLICY: NonNullable<AgentRunContext["replyPresentation"]> = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: FALLBACK,
};

type ChatPayload = {
  state: string;
  deltaText?: string;
  replace?: boolean;
  message?: { role?: string; content?: Array<{ type: string; text: string }> };
};

describe("expected reply language on the streamed chat path", () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    logWarnMock.mockReset();
    resetAgentRunContextForTest();
    resetAuthoritativeReplyTextForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunContextForTest();
    resetAuthoritativeReplyTextForTest();
  });

  function createHarness(policy?: AgentRunContext["replyPresentation"]) {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const chatRunState = createChatRunState();
    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds: vi.fn(),
      nodeSendToSession,
      agentRunSeq: new Map<string, number>(),
      chatRunState,
      resolveSessionKeyForRun: () => "session-1",
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: createToolEventRecipientRegistry(),
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      loadGatewaySessionRowForSnapshot: vi.fn(() => null),
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "run-1" });
    registerAgentRunContext("run-1", {
      sessionKey: "session-1",
      ...(policy ? { replyPresentation: policy } : {}),
    });

    /** One assistant delta carrying the cumulative text the provider has produced. */
    const stream = (cumulativeText: string) => {
      now += 200;
      handler({
        runId: "run-1",
        seq: 1,
        stream: "assistant",
        ts: now,
        data: { text: cumulativeText },
      });
    };

    const finish = () => {
      now += 200;
      handler({ runId: "run-1", seq: 2, stream: "lifecycle", ts: now, data: { phase: "end" } });
    };

    const payloads = (): ChatPayload[] =>
      broadcast.mock.calls
        .filter(([event]) => event === "chat")
        .map(([, payload]) => payload as ChatPayload);

    /** What the session transcript mirror receives, in order. */
    const mirrored = (): ChatPayload[] =>
      nodeSendToSession.mock.calls
        .filter((call) => call[1] === "chat")
        .map((call) => call[2] as ChatPayload);

    const textOf = (payload: ChatPayload) => payload.message?.content?.[0]?.text;

    return { stream, finish, payloads, mirrored, textOf };
  }

  it("streams a clean Thai reply delta by delta and finalizes it unchanged", () => {
    const { stream, finish, payloads, textOf } = createHarness(THAI_POLICY);

    stream("เข้าใจครับ");
    stream("เข้าใจครับ ผมจัดให้แล้ว");
    stream("เข้าใจครับ ผมจัดให้แล้ว ส่งทาง LINE นะครับ");
    finish();

    const events = payloads();
    expect(events.map((payload) => payload.state)).toEqual(["delta", "delta", "delta", "final"]);
    expect(events.every((payload) => payload.replace !== true)).toBe(true);
    expect(textOf(events.at(-1) as ChatPayload)).toBe("เข้าใจครับ ผมจัดให้แล้ว ส่งทาง LINE นะครับ");
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("never broadcasts the first invalid cumulative delta, nor any after it", () => {
    const { stream, finish, payloads, textOf } = createHarness(THAI_POLICY);

    stream("เข้าใจครับ");
    // The contamination arrives fused onto a Thai word, as it did in production.
    stream('เข้าใจครับ — "จัดไว้ อันนี้" ใช่ไಮೈ');
    stream('เข้าใจครับ — "จัดไว้ อันนี้" ใช่ไಮೈ? 🐱');
    finish();

    const events = payloads();
    const streamed = events.filter((payload) => payload.state === "delta");
    expect(streamed.map((payload) => payload.deltaText)).toEqual(["เข้าใจครับ", FALLBACK]);
    for (const payload of events) {
      expect(payload.deltaText ?? "").not.toContain("ಮ");
      expect(textOf(payload) ?? "").not.toContain("ಮ");
    }
  });

  it("replaces the partial stream with the authoritative final, exactly once", () => {
    const { stream, finish, payloads, textOf } = createHarness(THAI_POLICY);

    stream("เข้าใจครับ");
    stream("เข้าใจครับ ใช่ไಮೈ");
    finish();

    const events = payloads();
    expect(events.map((payload) => payload.state)).toEqual(["delta", "delta", "final"]);
    // The valid prefix streamed; the refresh delta carries `replace` so the
    // client swaps its buffer instead of appending to it; the final agrees.
    expect(events[0]).toMatchObject({ state: "delta", deltaText: "เข้าใจครับ" });
    expect(events[1]).toMatchObject({ state: "delta", replace: true, deltaText: FALLBACK });
    expect(events[2]?.state).toBe("final");
    expect(textOf(events[2] as ChatPayload)).toBe(FALLBACK);
    expect(events.filter((payload) => payload.state === "final")).toHaveLength(1);
  });

  it("catches a reply written wholly in another language", () => {
    const { stream, finish, payloads, textOf } = createHarness(THAI_POLICY);

    stream("Привет");
    stream("Привет, я могу помочь вам с этим.");
    finish();

    const events = payloads();
    expect(
      events.filter((payload) => payload.state === "delta" && payload.replace !== true),
    ).toEqual([]);
    expect(textOf(events.at(-1) as ChatPayload)).toBe(FALLBACK);
  });

  it("leaves an intentionally multilingual turn streaming normally", () => {
    const { stream, finish, payloads, textOf } = createHarness({
      ...THAI_POLICY,
      multilingualOverride: { allowed: true, reason: "request_asks_to_translate" },
    });

    stream("คำนี้แปลว่า");
    stream('คำนี้แปลว่า "Привет" ครับ');
    finish();

    const events = payloads();
    expect(events.map((payload) => payload.state)).toEqual(["delta", "delta", "final"]);
    expect(textOf(events.at(-1) as ChatPayload)).toBe('คำนี้แปลว่า "Привет" ครับ');
  });

  it("changes nothing when no reply language is configured", () => {
    const { stream, finish, payloads, textOf } = createHarness(undefined);

    stream("Привет");
    stream("Привет, я могу помочь.");
    finish();

    const events = payloads();
    expect(events.map((payload) => payload.state)).toEqual(["delta", "delta", "final"]);
    expect(events.every((payload) => payload.replace !== true)).toBe(true);
    expect(textOf(events.at(-1) as ChatPayload)).toBe("Привет, я могу помочь.");
  });

  it("gives the transcript mirror the same authoritative text as the UI final", () => {
    const { stream, finish, payloads, mirrored, textOf } = createHarness(THAI_POLICY);

    stream("เข้าใจครับ");
    stream("เข้าใจครับ ใช่ไಮೈ");
    finish();

    const uiFinal = payloads().find((payload) => payload.state === "final");
    const mirrorFinal = mirrored().find((payload) => payload.state === "final");

    expect(textOf(uiFinal as ChatPayload)).toBe(FALLBACK);
    expect(textOf(mirrorFinal as ChatPayload)).toBe(textOf(uiFinal as ChatPayload));
    // Neither record keeps the contaminated stream.
    for (const payload of [...payloads(), ...mirrored()]) {
      expect(textOf(payload) ?? "").not.toContain("ಮ");
      expect(payload.deltaText ?? "").not.toContain("ಮ");
    }
  });

  it("logs the outcome without logging any reply text", () => {
    const { stream, finish } = createHarness(THAI_POLICY);

    stream("เข้าใจครับ ใช่ไಮೈ");
    finish();

    const logged = logWarnMock.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logged).toContain("streamValidationFailed=true");
    expect(logged).toContain("detectedScriptClasses=");
    expect(logged).toContain("finalValidationOutcome=fallback");
    expect(logged).toContain("finalRepairKind=fallback");
    expect(logged).toContain("expectedReplyLanguage=th");
    expect(logged).toContain("expectedReplyLanguageSource=account");
    expect(logged).toMatch(/streamSuppressionStartedMs=\d+/u);
    expect(logged).not.toContain("เข้าใจ");
    expect(logged).not.toContain("ಮ");
  });
});
