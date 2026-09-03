/**
 * Bounded decisions have to reach LINE as postbacks, not as text the bot then
 * has to interpret. These assert the mapping and the LINE limits around it; no
 * client is constructed and nothing is sent.
 */

import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  applyLinePresentationQuickReplies,
  mapLinePresentationQuickReplies,
} from "./presentation-quick-reply.js";
import { createQuickReplyItems } from "./send.js";
import type { LineChannelData } from "./types.js";

function buttons(...buttonList: MessagePresentation["blocks"][number][]): MessagePresentation {
  return { blocks: buttonList };
}

describe("portable controls on a LINE reply", () => {
  it("becomes a postback chip carrying the offering handler's own value", () => {
    const items = mapLinePresentationQuickReplies(
      buttons({
        type: "buttons",
        buttons: [
          { label: "15 วิ", action: { type: "callback", value: "cbq1:abc123:0" } },
          { label: "30 วิ", action: { type: "callback", value: "cbq1:abc123:1" } },
        ],
      }),
    );

    expect(items).toEqual([
      { label: "15 วิ", data: "cbq1:abc123:0" },
      { label: "30 วิ", data: "cbq1:abc123:1" },
    ]);
    // The chip the owner taps sends `data`, and shows the label in the thread —
    // the payload is never what they read.
    expect(createQuickReplyItems(items).items?.at(0)).toEqual({
      type: "action",
      action: { type: "postback", label: "15 วิ", data: "cbq1:abc123:0", displayText: "15 วิ" },
    });
  });

  it("drops actions a quick reply cannot perform rather than faking them", () => {
    const items = mapLinePresentationQuickReplies(
      buttons({
        type: "buttons",
        buttons: [
          { label: "Docs", action: { type: "url", url: "https://example.com" } },
          {
            label: "Allow",
            action: {
              type: "approval",
              approvalId: "a1",
              approvalKind: "exec",
              decision: "allow-once",
            },
          },
          { label: "ใช้ Default", action: { type: "callback", value: "cbq1:abc123:0" } },
        ],
      }),
    );

    expect(items).toEqual([{ label: "ใช้ Default", data: "cbq1:abc123:0" }]);
  });

  it("drops a payload LINE would reject rather than sending a chip that fails", () => {
    const items = mapLinePresentationQuickReplies(
      buttons({
        type: "buttons",
        buttons: [{ label: "too big", action: { type: "callback", value: "x".repeat(301) } }],
      }),
    );

    expect(items).toEqual([]);
  });

  it("appends to quick replies the reply text already declared", () => {
    const payload = applyLinePresentationQuickReplies({
      text: "เลือกได้เลย",
      channelData: { line: { quickReplies: ["เดิม"] } satisfies LineChannelData },
      presentation: buttons({
        type: "buttons",
        buttons: [{ label: "ใหม่", action: { type: "callback", value: "cbq1:abc123:0" } }],
      }),
    });

    const line = payload.channelData?.line as LineChannelData | undefined;
    expect(line?.quickReplies).toEqual(["เดิม", { label: "ใหม่", data: "cbq1:abc123:0" }]);
  });

  it("leaves a payload with no controls exactly as it was", () => {
    const payload = { text: "hello" };

    expect(applyLinePresentationQuickReplies(payload)).toBe(payload);
  });

  it("keeps a plain label chip a message action, as it has always been", () => {
    expect(createQuickReplyItems(["Yes"]).items?.at(0)).toEqual({
      type: "action",
      action: { type: "message", label: "Yes", text: "Yes" },
    });
  });
});
