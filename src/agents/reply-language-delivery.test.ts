/**
 * Delivery and the Control UI must show the same reply.
 *
 * Previously each repaired its own copy: the UI streamed the provider's raw
 * text and LINE received a differently repaired version of the same turn. These
 * tests pin that one decision is made per run and that every surface reading it
 * gets byte-identical text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import type { TurnPresentationPolicy } from "../infra/reply-language-policy.js";
import {
  resetAuthoritativeReplyTextForTest,
  resolveAuthoritativeReplyText,
} from "../infra/reply-language-repair.js";
import { finalizeDeliveryPayloadsLanguage } from "./reply-language-delivery.js";

const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const THAI: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: FALLBACK,
};
const CORRUPTED = 'เข้าใจครับ — "จัดไว้ อันนี้" ใช่ไಮೈ? 🐱';

const finalize = (payloads: ReplyPayload[], runId = "run-1") =>
  finalizeDeliveryPayloadsLanguage({ runId, payloads });

beforeEach(() => {
  resetAgentRunContextForTest();
  resetAuthoritativeReplyTextForTest();
  registerAgentRunContext("run-1", { sessionKey: "session-1", replyPresentation: THAI });
});

describe("payloads are finalized before they reach a channel", () => {
  it("replaces contaminated assistant text", () => {
    const finalized = finalize([{ text: CORRUPTED }]);

    expect(finalized?.[0]?.text).toBe(FALLBACK);
  });

  it("leaves a clean reply and its media untouched", () => {
    const payload: ReplyPayload = {
      text: "ส่งให้ทาง LINE แล้วครับ",
      mediaUrls: ["https://example.com/a.png"],
    };
    const finalized = finalize([payload]);

    expect(finalized?.[0]).toBe(payload);
  });

  it("does not rewrite runtime reporting payloads", () => {
    const error: ReplyPayload = { text: "Provider error: Привет", isError: true };
    const reasoning: ReplyPayload = { text: "Привет", isReasoning: true };
    const finalized = finalize([error, reasoning]);

    expect(finalized?.[0]).toBe(error);
    expect(finalized?.[1]).toBe(reasoning);
  });

  it("changes nothing when the run declares no policy", () => {
    registerAgentRunContext("run-2", { sessionKey: "session-2" });
    const payloads: ReplyPayload[] = [{ text: CORRUPTED }];

    expect(finalize(payloads, "run-2")).toBe(payloads);
  });

  it("changes nothing when there is no run to read a policy from", () => {
    const payloads: ReplyPayload[] = [{ text: CORRUPTED }];

    expect(finalizeDeliveryPayloadsLanguage({ runId: undefined, payloads })).toBe(payloads);
  });
});

describe("delivery and the UI final converge", () => {
  it("hands both surfaces the same string for the same turn", () => {
    // The Control UI finalizes the buffered stream text; delivery finalizes the
    // payload. Same run, same source, so the memo returns one decision.
    const uiFinal = resolveAuthoritativeReplyText({
      runId: "run-1",
      text: CORRUPTED,
      policy: THAI,
    });
    const delivered = finalize([{ text: CORRUPTED }]);

    expect(delivered?.[0]?.text).toBe(uiFinal.text);
    expect(uiFinal).toMatchObject({ outcome: "fallback", repairKind: "fallback" });
  });

  it("converges in either order", () => {
    const delivered = finalize([{ text: CORRUPTED }]);
    const uiFinal = resolveAuthoritativeReplyText({
      runId: "run-1",
      text: CORRUPTED,
      policy: THAI,
    });

    expect(uiFinal.text).toBe(delivered?.[0]?.text);
  });

  it("keeps a paid confirmation code rather than quietly dropping it", () => {
    // A reply carrying an exact span is never shortened into something that
    // looks complete; it falls back and says so instead.
    const delivered = finalize([{ text: "เรียบร้อยแล้วครับ ทุกอย่างพร้อม\nรหัส VIDEO 4821 ใช่ไಮೈ" }]);

    expect(delivered?.[0]?.text).toBe(FALLBACK);
  });
});
