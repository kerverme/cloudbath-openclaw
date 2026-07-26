import { describe, expect, it } from "vitest";
import { extractInboundLineImage, isAuthorizedLineGroup } from "./inbound.js";

describe("LINE inbound image extraction", () => {
  it("extracts the official message_received media metadata", () => {
    const job = extractInboundLineImage(
      {
        from: "line:group:C123",
        messageId: "message-1",
        senderId: "U123",
        timestamp: Date.parse("2026-07-25T01:02:03.000Z"),
        metadata: {
          originatingTo: "line:group:C123",
          mediaPath: "/state/media/inbound/image.png",
          mediaType: "image/png",
          senderName: "Example Sender",
        },
      },
      {
        channelId: "line",
        accountId: "default",
        conversationId: "line:group:C123",
        sessionKey: "agent:main:line:group:C123",
      },
    );

    expect(job).toEqual({
      accountId: "default",
      groupId: "C123",
      lineTarget: "line:group:C123",
      messageId: "message-1",
      webhookEventId: undefined,
      userId: "U123",
      senderName: "Example Sender",
      sessionKey: "agent:main:line:group:C123",
      mediaPath: "/state/media/inbound/image.png",
      mimeType: "image/png",
      receivedAt: "2026-07-25T01:02:03.000Z",
    });
  });

  it("ignores non-image media, direct messages, and other channels", () => {
    const baseEvent = {
      from: "line:group:C123",
      messageId: "message-1",
      metadata: {
        mediaPath: "/state/media/inbound/file.pdf",
        mediaType: "application/pdf",
      },
    };
    expect(extractInboundLineImage(baseEvent, { channelId: "line" })).toBeNull();
    expect(
      extractInboundLineImage(
        {
          ...baseEvent,
          from: "line:user:U123",
          metadata: { ...baseEvent.metadata, mediaType: "image/png" },
        },
        { channelId: "line", conversationId: "line:user:U123" },
      ),
    ).toBeNull();
    expect(
      extractInboundLineImage(
        {
          ...baseEvent,
          metadata: { ...baseEvent.metadata, mediaType: "image/png" },
        },
        { channelId: "telegram" },
      ),
    ).toBeNull();
  });

  it("rejects unauthorized LINE groups", () => {
    const allowed = new Set(["C123"]);
    expect(isAuthorizedLineGroup("C123", allowed)).toBe(true);
    expect(isAuthorizedLineGroup("C999", allowed)).toBe(false);
  });
});
