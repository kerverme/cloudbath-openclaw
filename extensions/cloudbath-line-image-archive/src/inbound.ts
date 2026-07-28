import type { InboundImageJob } from "./types.js";

export type MessageReceivedEventLike = {
  from?: string;
  timestamp?: number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
};

export type MessageReceivedContextLike = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(stringValue).find(Boolean);
}

function resolveGroupTarget(values: Array<unknown>): { groupId: string; target: string } | null {
  for (const value of values) {
    const target = stringValue(value);
    const match = target?.match(/^line:group:([A-Za-z0-9_-]+)$/);
    if (target && match?.[1]) {
      return { groupId: match[1], target };
    }
  }
  return null;
}

export function extractInboundLineImage(
  event: MessageReceivedEventLike,
  context: MessageReceivedContextLike,
): InboundImageJob | null {
  if (context.channelId?.trim().toLowerCase() !== "line") {
    return null;
  }

  const metadata = event.metadata ?? {};
  const mimeType =
    stringValue(metadata.mediaType) ??
    firstString(metadata.mediaTypes) ??
    "application/octet-stream";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return null;
  }

  const mediaPath = stringValue(metadata.mediaPath) ?? firstString(metadata.mediaPaths);
  const messageId =
    stringValue(event.messageId) ??
    stringValue(context.messageId) ??
    stringValue(metadata.messageId);
  const group = resolveGroupTarget([
    metadata.originatingTo,
    context.conversationId,
    event.from,
    metadata.to,
  ]);
  if (!mediaPath || !messageId || !group) {
    return null;
  }

  const timestamp =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.now();

  return {
    accountId: stringValue(context.accountId),
    groupId: group.groupId,
    lineTarget: group.target,
    messageId,
    webhookEventId: stringValue(metadata.webhookEventId),
    userId:
      stringValue(event.senderId) ??
      stringValue(context.senderId) ??
      stringValue(metadata.senderId),
    senderName: stringValue(metadata.senderName),
    sessionKey: stringValue(event.sessionKey) ?? stringValue(context.sessionKey),
    mediaPath,
    mimeType,
    receivedAt: new Date(timestamp).toISOString(),
  };
}
