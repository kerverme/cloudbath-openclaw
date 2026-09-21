/**
 * The run's authoritative reply must outlive the agent runner, not just `agent_end`.
 *
 * Production trace of a failing LINE translation turn, with #87 deployed:
 *
 *   .803 authoritative_finalized
 *   .811 run_context_clear_requested
 *   .840 delivery_window_released      <- agent runner returned here
 *   .845 authoritative_cleared
 *   .990 line_outbound_authoritative_checked  authoritativeFound=false
 *
 * Releasing when the agent runner returns is ~150ms too early: the reply has
 * not been dispatched yet, so neither LINE hook has read the decision. The
 * dispatcher's settle lifecycle is the real end of the turn — it runs after
 * `waitForIdle`, which is after every outbound send.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimAgentRunDeliveryWindow,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDeliveryWindow,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import type { TurnPresentationPolicy } from "../infra/reply-language-policy.js";
import {
  isAuthoritativeReplyText,
  resetAuthoritativeReplyTextForTest,
  resolveAuthoritativeReplyText,
} from "../infra/reply-language-repair.js";
import {
  registerReplyDispatcherSettledTask,
  settleReplyDispatcher,
} from "./dispatch-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

const RUN_ID = "24300a2d-ae2a-4787-a4f9-a537b7b0f694";
const JAPANESE = "ありがとう。";
/** Thai expected; this turn's request asked for Japanese. */
const POLICY: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  multilingualOverride: { allowed: true, language: "ja", reason: "request_asks_to_translate" },
};

/** Minimal dispatcher: only the settle lifecycle matters here. */
function createDispatcher(options: { failOnIdle?: boolean } = {}): ReplyDispatcher {
  return {
    markComplete: () => {},
    waitForIdle: async () => {
      if (options.failOnIdle) {
        throw new Error("delivery failed");
      }
    },
  } as unknown as ReplyDispatcher;
}

beforeEach(() => {
  resetAgentRunContextForTest();
  resetAuthoritativeReplyTextForTest();
});

describe("the authoritative reply survives until the dispatcher settles", () => {
  it("reproduces the production order and keeps both hooks authoritative", async () => {
    const dispatcher = createDispatcher();
    const observed: string[] = [];

    // Ingress: the turn registers its policy and opens the delivery window.
    registerAgentRunContext(RUN_ID, {
      sessionKey: "agent:main:main",
      isControlUiVisible: true,
      replyPresentation: POLICY,
    } as never);
    claimAgentRunDeliveryWindow(RUN_ID);
    // The dispatch path adopts the run when it starts, exactly as production does.
    registerReplyDispatcherSettledTask(dispatcher, () => {
      releaseAgentRunDeliveryWindow(RUN_ID);
    });

    resolveAuthoritativeReplyText({ runId: RUN_ID, text: JAPANESE, policy: POLICY });
    observed.push(`finalized:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);

    // agent_end: the Control UI's terminal projection asks for the clear.
    clearAgentRunContext(RUN_ID);
    observed.push(`afterTerminalClear:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);

    // The agent runner has now returned. Under #87 the window closed here.
    observed.push(`afterRunnerReturned:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);

    // Delivery: both LINE hooks consult the decision before anything is released.
    observed.push(`replyPayloadSending:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);
    observed.push(`messageSending:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);

    // Actual delivery completion.
    await settleReplyDispatcher({ dispatcher });
    observed.push(`afterSettle:${isAuthoritativeReplyText(JAPANESE, RUN_ID)}`);

    expect(observed).toStrictEqual([
      "finalized:true",
      "afterTerminalClear:true",
      "afterRunnerReturned:true",
      "replyPayloadSending:true",
      "messageSending:true",
      "afterSettle:false",
    ]);
    expect(getAgentRunContext(RUN_ID)).toBeUndefined();
  });

  it("shows why releasing at agent-runner return loses the decision", () => {
    // This is #87's arrangement, kept as the defect's executable description:
    // the same turn, released one step early, and both hooks then miss it.
    registerAgentRunContext(RUN_ID, {
      sessionKey: "agent:main:main",
      replyPresentation: POLICY,
    } as never);
    claimAgentRunDeliveryWindow(RUN_ID);
    resolveAuthoritativeReplyText({ runId: RUN_ID, text: JAPANESE, policy: POLICY });
    clearAgentRunContext(RUN_ID);

    // The agent runner returns and releases here, as #87 did.
    releaseAgentRunDeliveryWindow(RUN_ID);

    // Delivery has not run yet, and the decision is already gone — which is
    // exactly what production logged as authoritativeFound=false.
    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(false);
  });

  it("still releases exactly once when delivery throws", async () => {
    const dispatcher = createDispatcher({ failOnIdle: true });
    let releases = 0;

    registerAgentRunContext(RUN_ID, { sessionKey: "agent:main:main" } as never);
    claimAgentRunDeliveryWindow(RUN_ID);
    registerReplyDispatcherSettledTask(dispatcher, () => {
      releases += 1;
      releaseAgentRunDeliveryWindow(RUN_ID);
    });
    resolveAuthoritativeReplyText({ runId: RUN_ID, text: JAPANESE, policy: POLICY });
    clearAgentRunContext(RUN_ID);

    await expect(settleReplyDispatcher({ dispatcher })).rejects.toThrow("delivery failed");

    // The dispatch error still surfaces, and the run is not left behind.
    expect(releases).toBe(1);
    expect(isAuthoritativeReplyText(JAPANESE, RUN_ID)).toBe(false);
    expect(getAgentRunContext(RUN_ID)).toBeUndefined();
  });

  it("does not run a settled task twice on the success path", async () => {
    const dispatcher = createDispatcher();
    let runs = 0;
    registerReplyDispatcherSettledTask(dispatcher, () => {
      runs += 1;
    });

    await settleReplyDispatcher({ dispatcher });

    expect(runs).toBe(1);
  });

  it("releasing a run that never opened a window is a no-op", () => {
    // Turns that are not delivered through a dispatcher must not be disturbed.
    expect(() => {
      releaseAgentRunDeliveryWindow("run-never-claimed");
    }).not.toThrow();
  });
});
