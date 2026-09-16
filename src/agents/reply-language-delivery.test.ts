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
  prepareAuthoritativeReplyRegeneration,
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
  it.each([
    ["English", "Sure — here it is in English."],
    ["Russian", "Привет, я могу помочь вам с этим."],
    ["Japanese", "こんにちは。こちらが回答です。"],
  ])("keeps an intentional %s reply", (_language, text) => {
    registerAgentRunContext("run-multi", {
      replyPresentation: {
        ...THAI,
        multilingualOverride: { allowed: true, reason: "request_names_a_reply_language" },
      },
    });

    expect(
      finalizeDeliveryPayloadsLanguage({ runId: "run-multi", payloads: [{ text }] })?.[0]?.text,
    ).toBe(text);
  });

  it("hands every later surface the regeneration prepared before the decision", () => {
    // G: prepare happens while the run still owns the decision, so whichever
    // surface finalizes FIRST already has the structured text — and the rest
    // inherit it rather than repairing separately.
    const regenerated = "ฉาก 1 · 0-3 วิ · ปูฉาก\nแมวเดินในสวนครับ";
    prepareAuthoritativeReplyRegeneration({
      runId: "run-1",
      sourceText: CORRUPTED,
      regeneratedText: regenerated,
    });

    // The Control UI finalizes first, as it does in production.
    const uiFinal = resolveAuthoritativeReplyText({
      runId: "run-1",
      text: CORRUPTED,
      policy: THAI,
    });
    const delivered = finalize([{ text: CORRUPTED }]);

    expect(uiFinal).toMatchObject({ text: regenerated, repairKind: "regenerated" });
    expect(delivered?.[0]?.text).toBe(uiFinal.text);
    expect(delivered?.[0]?.text).not.toBe(FALLBACK);
  });

  it("regenerates trusted structured text before authoritative finalization", () => {
    const regenerated = "ฉาก 1 · 0-3 วิ · ปูฉาก\nแมวเดินในสวนครับ";
    prepareAuthoritativeReplyRegeneration({
      runId: "run-1",
      sourceText: CORRUPTED,
      regeneratedText: regenerated,
    });

    expect(finalize([{ text: CORRUPTED }])?.[0]?.text).toBe(regenerated);
    expect(
      resolveAuthoritativeReplyText({ runId: "run-1", text: CORRUPTED, policy: THAI }).text,
    ).toBe(regenerated);
  });

  it.each([
    "NO_REPLY",
    '"NO_REPLY"',
    '{"action":"NO_REPLY"}',
    "<thinking>internal plan</thinking> NO_REPLY",
  ])("keeps wrapped silent payload internal: %s", (text) => {
    expect(finalize([{ text }])?.[0]?.text).toBeUndefined();
  });

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

  it("replaces a reply written wholly in another language", () => {
    // The rule that needs turn context lives here, where the policy and its
    // multilingual override are known.
    expect(finalize([{ text: "Sure, I updated the storyboard with 6 shots." }])?.[0]?.text).toBe(
      FALLBACK,
    );
    expect(finalize([{ text: "Привет, я могу помочь вам с этим." }])?.[0]?.text).toBe(FALLBACK);
  });

  it("keeps a non-Thai reply when the turn declared a multilingual override", () => {
    registerAgentRunContext("run-multi", {
      sessionKey: "session-multi",
      replyPresentation: {
        ...THAI,
        multilingualOverride: {
          allowed: true,
          language: "en",
          reason: "request_names_a_reply_language",
        },
      },
    });
    const payloads: ReplyPayload[] = [{ text: "Sure — here it is in English." }];

    expect(finalizeDeliveryPayloadsLanguage({ runId: "run-multi", payloads })).toBe(payloads);
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

  it("preserves a paid confirmation code inside the honest fallback", () => {
    const delivered = finalize([{ text: "เรียบร้อยแล้วครับ ทุกอย่างพร้อม\nรหัส VIDEO 4821 ใช่ไಮೈ" }]);

    expect(delivered?.[0]?.text).toBe(`${FALLBACK}\nVIDEO 4821`);
  });

  it("preserves URLs and opaque identifiers only as their exact spans", () => {
    const delivered = finalize([
      { text: "เข้าใจครับ Привет https://example.com/job/ABC-42 asset_9f2" },
    ]);

    expect(delivered?.[0]?.text).toBe(`${FALLBACK}\nhttps://example.com/job/ABC-42 asset_9f2`);
    expect(delivered?.[0]?.text).not.toContain("Привет");
  });
});
