import { describe, expect, it } from "vitest";
import { extractInboundLineImage } from "./inbound.js";

describe("universal LINE image ingestion", () => {
  it("extracts routing and original managed-media metadata", () => {
    expect(
      extractInboundLineImage(
        {
          from: "line:group:C123",
          messageId: "message-1",
          senderId: "U123",
          timestamp: Date.parse("2026-07-25T01:02:03.000Z"),
          metadata: {
            originatingTo: "line:group:C123",
            mediaPath: "/state/media/inbound/image.png",
            mediaType: "image/png",
          },
        },
        {
          channelId: "line",
          accountId: "default",
          conversationId: "line:group:C123",
        },
      ),
    ).toEqual(
      expect.objectContaining({
        groupId: "C123",
        lineTarget: "line:group:C123",
        messageId: "message-1",
        userId: "U123",
        mediaPath: "/state/media/inbound/image.png",
        mimeType: "image/png",
      }),
    );
  });

  it("ignores non-images, direct messages, and other channels", () => {
    const event = {
      from: "line:group:C123",
      messageId: "message-1",
      metadata: { mediaPath: "/tmp/file.pdf", mediaType: "application/pdf" },
    };
    expect(extractInboundLineImage(event, { channelId: "line" })).toBeNull();
    expect(
      extractInboundLineImage(
        {
          ...event,
          from: "line:user:U1",
          metadata: { ...event.metadata, mediaType: "image/png" },
        },
        { channelId: "line" },
      ),
    ).toBeNull();
    expect(
      extractInboundLineImage(
        { ...event, metadata: { ...event.metadata, mediaType: "image/png" } },
        { channelId: "telegram" },
      ),
    ).toBeNull();
  });
});
