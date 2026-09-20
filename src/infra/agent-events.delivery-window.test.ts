/**
 * A run's authoritative reply must outlive `agent_end`.
 *
 * Channel delivery hooks run AFTER the run's terminal event, while the Control
 * UI's terminal projection calls `clearAgentRunContext` at that event. With no
 * delivery window the memo was gone before the channel read it: the UI showed
 * the Japanese translation the user asked for and LINE, finding nothing
 * authoritative, applied its own Thai-only guard and sent the "reply came out
 * malformed" line instead.
 *
 * The window is the fix and the release is the other half of it — the memo must
 * not simply live longer, it must end deterministically when delivery is done.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeDeliveryPayloadsLanguage } from "../agents/reply-language-delivery.js";
import {
  claimAgentRunDeliveryWindow,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDeliveryWindow,
  resetAgentRunContextForTest,
} from "./agent-events.js";
import type { TurnPresentationPolicy } from "./reply-language-policy.js";
import {
  isAuthoritativeReplyText,
  resetAuthoritativeReplyTextForTest,
} from "./reply-language-repair.js";

const RUN_ID = "run-line-turn";
/** Thai expected, and this turn's request asked for Japanese. */
const POLICY: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง",
  multilingualOverride: { allowed: true, language: "ja", reason: "request_asks_to_translate" },
};
const JAPANESE = "ありがとう。";

/** Ingress: the turn registers its policy and opens the delivery window. */
function beginTurn(policy: TurnPresentationPolicy | undefined = POLICY): void {
  registerAgentRunContext(RUN_ID, {
    sessionKey: "agent:main:main",
    agentId: "main",
    isControlUiVisible: true,
  } as never);
  claimAgentRunDeliveryWindow(RUN_ID);
  if (policy) {
    registerAgentRunContext(RUN_ID, {
      sessionKey: "agent:main:main",
      agentId: "main",
      isControlUiVisible: true,
      replyPresentation: policy,
    } as never);
  }
}

beforeEach(() => {
  resetAgentRunContextForTest();
  resetAuthoritativeReplyTextForTest();
});

describe("the authoritative reply survives until delivery has consumed it", () => {
  it("keeps the decision through the Control UI's terminal clear", () => {
    beginTurn();
    finalizeDeliveryPayloadsLanguage({ runId: RUN_ID, payloads: [{ text: JAPANESE }] });
    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(true);

    // agent_end: the UI projection asks for the run to be cleared.
    clearAgentRunContext(RUN_ID);

    // Delivery has not run yet, so the decision must still be readable.
    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(true);
  });

  it("releases the decision once delivery closes the window", () => {
    beginTurn();
    finalizeDeliveryPayloadsLanguage({ runId: RUN_ID, payloads: [{ text: JAPANESE }] });
    clearAgentRunContext(RUN_ID);

    releaseAgentRunDeliveryWindow(RUN_ID);

    // Deterministic: no timer, and nothing of the run is left behind.
    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(false);
    expect(getAgentRunContext(RUN_ID)).toBeUndefined();
  });

  it("releases the run when delivery ends without any terminal clear", () => {
    // A turn whose UI projection never ran must not leak the run either.
    beginTurn();
    finalizeDeliveryPayloadsLanguage({ runId: RUN_ID, payloads: [{ text: JAPANESE }] });

    releaseAgentRunDeliveryWindow(RUN_ID);

    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(false);
    expect(getAgentRunContext(RUN_ID)).toBeUndefined();
  });

  it("does not resurrect a run that was cleared before the window opened", () => {
    registerAgentRunContext(RUN_ID, { sessionKey: "agent:main:main" } as never);
    clearAgentRunContext(RUN_ID);

    expect(getAgentRunContext(RUN_ID)).toBeUndefined();
  });
});
