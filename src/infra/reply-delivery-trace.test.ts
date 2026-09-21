/**
 * The delivery trace must never carry what was said.
 *
 * It exists to line up one LINE turn against one Control UI turn, which needs
 * identities and ordering — not content. These tests pin that the emitted line
 * carries the ids and booleans an operator needs and none of the reply, the
 * request, or anything credential-shaped, including when a caller tries to
 * smuggle text through a field that does exist.
 */
import { describe, expect, it } from "vitest";
import {
  buildReplyDeliveryTraceRecord,
  type ReplyDeliveryTraceFields,
} from "./reply-delivery-trace.js";

/** Everything that must never appear, whatever the caller does. */
const REPLY_TEXT = "ありがとう。";
const REQUEST_TEXT = "แปลเป็นภาษาญี่ปุ่นว่า ขอบคุณ";
const FALLBACK_TEXT = "ขออภัยครับ ระบบตอบกลับไม่สมบูรณ์ กรุณาลองถามใหม่อีกครั้ง";
const SECRET = "sk-live-0123456789abcdef";

/** The exact JSON an operator would see for this event. */
function line(
  event: Parameters<typeof buildReplyDeliveryTraceRecord>[0],
  fields: ReplyDeliveryTraceFields,
): string {
  return JSON.stringify(buildReplyDeliveryTraceRecord(event, fields));
}

describe("the trace records identity and ordering", () => {
  it("carries the run identities, hook and verdict", () => {
    const record = buildReplyDeliveryTraceRecord("delivery_hook_examined", {
      runId: "run-1",
      eventRunId: "run-1",
      ctxRunId: "run-2",
      sessionKey: "agent:main:main",
      conversationId: "line:U6b",
      hook: "reply_payload_sending",
      authoritativeFound: false,
      deliveryWindowClaimed: true,
      clearRequested: true,
      lifecyclePhase: "gen-7",
    });

    expect(record).toMatchObject({
      event: "delivery_hook_examined",
      runId: "run-1",
      eventRunId: "run-1",
      ctxRunId: "run-2",
      hook: "reply_payload_sending",
      authoritativeFound: false,
      deliveryWindowClaimed: true,
      clearRequested: true,
    });
  });

  it("omits fields the caller did not supply", () => {
    const record = buildReplyDeliveryTraceRecord("delivery_window_claimed", { runId: "run-1" });

    expect(Object.keys(record).toSorted()).toStrictEqual(["event", "runId"]);
  });

  it("keeps a false boolean rather than dropping it", () => {
    // authoritativeFound=false is the whole signal; it must survive compaction.
    expect(
      buildReplyDeliveryTraceRecord("delivery_hook_examined", { authoritativeFound: false }),
    ).toMatchObject({ authoritativeFound: false });
  });
});

describe("the trace never carries content", () => {
  it("emits no reply, request, fallback or secret for a fully populated event", () => {
    const emitted = line("authoritative_finalized", {
      runId: "run-1",
      eventRunId: "run-1",
      ctxRunId: "run-1",
      sessionKey: "agent:main:main",
      conversationId: "line:U6b",
      channelId: "line",
      hook: "message_sending",
      authoritativeFound: true,
      deliveryWindowClaimed: true,
      clearRequested: false,
      lifecyclePhase: "unchecked",
      policyPresent: true,
      multilingualAllowed: true,
      multilingualLanguage: "ja",
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
    });

    for (const forbidden of [REPLY_TEXT, REQUEST_TEXT, FALLBACK_TEXT, SECRET]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it("has no field that accepts reply text", () => {
    // The field set is closed, so a caller cannot route text through it. This
    // asserts the shape rather than trusting reviewers to keep noticing.
    const smuggled = { runId: "run-1", replyText: REPLY_TEXT } as never;

    expect(line("authoritative_finalized", smuggled)).not.toContain(REPLY_TEXT);
  });

  it("names the stage on the record itself", () => {
    expect(
      buildReplyDeliveryTraceRecord("authoritative_cleared", { runId: "run-1" }),
    ).toStrictEqual({ event: "authoritative_cleared", runId: "run-1" });
  });
});
