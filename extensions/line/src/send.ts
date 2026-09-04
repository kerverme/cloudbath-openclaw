// Line plugin module implements send behavior.
import { messagingApi } from "@line/bot-sdk";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveLineAccount } from "./accounts.js";
import { messageAction, postbackAction } from "./actions.js";
import { resolveLineChannelAccessToken } from "./channel-access-token.js";
import { stageLineOutboundMessageImages } from "./outbound-media-staging.js";
import { validateLineMediaUrl } from "./outbound-media.js";
import { createLineSendReceipt } from "./send-receipt.js";
import type { LineQuickReplyItem, LineSendResult } from "./types.js";

type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type ImageMessage = messagingApi.ImageMessage;
type VideoMessage = messagingApi.VideoMessage & { trackingId?: string };
type AudioMessage = messagingApi.AudioMessage;
type LocationMessage = messagingApi.LocationMessage;
type FlexMessage = messagingApi.FlexMessage;
type FlexContainer = messagingApi.FlexContainer;
type TemplateMessage = messagingApi.TemplateMessage;
type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;

const userProfileCache = new Map<
  string,
  { displayName: string; pictureUrl?: string; fetchedAt: number }
>();
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

interface LineSendOpts {
  cfg: OpenClawConfig;
  channelAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaKind?: "image" | "video" | "audio";
  previewImageUrl?: string;
  mediaAlreadyPersistent?: boolean;
  durationMs?: number;
  trackingId?: string;
  replyToken?: string;
}

type LineClientOpts = Pick<LineSendOpts, "cfg" | "channelAccessToken" | "accountId">;
type LinePushOpts = Pick<
  LineSendOpts,
  "cfg" | "channelAccessToken" | "accountId" | "verbose" | "mediaAlreadyPersistent"
>;

interface LinePushBehavior {
  errorContext?: string;
  verboseMessage?: (chatId: string, messageCount: number) => string;
}

interface LineReplyBehavior {
  verboseMessage?: (messageCount: number) => string;
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for LINE sends");
  }

  const normalized = trimmed
    .replace(/^line:group:/i, "")
    .replace(/^line:room:/i, "")
    .replace(/^line:user:/i, "")
    .replace(/^line:/i, "");

  if (!normalized) {
    throw new Error("Recipient is required for LINE sends");
  }

  // Real LINE chat ids are a capital C/U/R followed by 32 lowercase hex chars
  // (33 chars total) and are case-sensitive — push returns HTTP 400 otherwise.
  // Reject values that match the LINE id shape but lost their leading capital
  // so the failure is surfaced as a permanent error (recovery moves the entry
  // to failed/ immediately instead of silently retrying 5 times). Short test
  // fixtures (e.g. "U123") are left alone. openclaw/openclaw#81628
  if (normalized.length >= 33 && !/^[CUR]/.test(normalized)) {
    throw new Error(
      `Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): ${truncateUtf16Safe(normalized, 4)}…`,
    );
  }

  return normalized;
}

function isLineUserChatId(chatId: string): boolean {
  return /^U/i.test(chatId);
}

function createLineMessagingClient(opts: LineClientOpts): {
  account: ReturnType<typeof resolveLineAccount>;
  client: messagingApi.MessagingApiClient;
} {
  const cfg = requireRuntimeConfig(opts.cfg, "LINE send");
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveLineChannelAccessToken(opts.channelAccessToken, account);
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });
  return { account, client };
}

function createLinePushContext(
  to: string,
  opts: LineClientOpts,
): {
  account: ReturnType<typeof resolveLineAccount>;
  client: messagingApi.MessagingApiClient;
  chatId: string;
} {
  const { account, client } = createLineMessagingClient(opts);
  const chatId = normalizeTarget(to);
  return { account, client, chatId };
}

function createTextMessage(text: string): TextMessage {
  return { type: "text", text };
}

export function createImageMessage(
  originalContentUrl: string,
  previewImageUrl?: string,
): ImageMessage {
  return {
    type: "image",
    originalContentUrl,
    previewImageUrl: previewImageUrl ?? originalContentUrl,
  };
}

export function createVideoMessage(
  originalContentUrl: string,
  previewImageUrl: string,
  trackingId?: string,
): VideoMessage {
  return {
    type: "video",
    originalContentUrl,
    previewImageUrl,
    ...(trackingId ? { trackingId } : {}),
  };
}

export function createAudioMessage(originalContentUrl: string, durationMs: number): AudioMessage {
  return {
    type: "audio",
    originalContentUrl,
    duration: durationMs,
  };
}

export function createLocationMessage(location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}): LocationMessage {
  return {
    type: "location",
    title: truncateUtf16Safe(location.title, 100),
    address: truncateUtf16Safe(location.address, 100),
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function logLineHttpError(err: unknown, context: string): void {
  if (!err || typeof err !== "object") {
    return;
  }
  const { status, statusText, body } = err as {
    status?: number;
    statusText?: string;
    body?: string;
  };
  if (typeof body === "string") {
    const summary = status ? `${status} ${statusText ?? ""}`.trim() : "unknown status";
    logVerbose(`line: ${context} failed (${summary}): ${body}`);
  }
}

function recordLineOutboundActivity(accountId: string): void {
  recordChannelActivity({
    channel: "line",
    accountId,
    direction: "outbound",
  });
}

function resolveLineReceiptKind(messages: readonly Message[]) {
  const types = new Set(messages.map((message) => message.type));
  if (types.has("audio")) {
    return "voice";
  }
  if (types.has("image") || types.has("video")) {
    return "media";
  }
  if (types.has("flex") || types.has("template") || types.has("location")) {
    return "card";
  }
  if (types.has("text")) {
    return "text";
  }
  return "unknown";
}

async function pushLineMessages(
  to: string,
  messages: Message[],
  opts: LinePushOpts,
  behavior: LinePushBehavior = {},
): Promise<LineSendResult> {
  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  if (opts.mediaAlreadyPersistent) {
    for (const message of messages) {
      if (message.type !== "image") continue;
      for (const value of [message.originalContentUrl, message.previewImageUrl]) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
          throw new Error("Persistent LINE image URLs must be query-free HTTPS URLs");
        }
      }
    }
  }
  const stagedMessages = opts.mediaAlreadyPersistent
    ? messages
    : await stageLineOutboundMessageImages(messages);
  const { account, client, chatId } = createLinePushContext(to, opts);
  const pushRequest = client.pushMessage({
    to: chatId,
    messages: stagedMessages,
  });

  if (behavior.errorContext) {
    await pushRequest.catch((err: unknown) => {
      logLineHttpError(err, behavior.errorContext!);
      throw err;
    });
  } else {
    await pushRequest;
  }

  recordLineOutboundActivity(account.accountId);

  if (opts.verbose) {
    const logMessage =
      behavior.verboseMessage?.(chatId, messages.length) ??
      `line: pushed ${messages.length} messages to ${chatId}`;
    logVerbose(logMessage);
  }

  return {
    messageId: "push",
    chatId,
    receipt: createLineSendReceipt({
      messageId: "push",
      chatId,
      kind: resolveLineReceiptKind(messages),
      messageCount: messages.length,
    }),
  };
}

async function replyLineMessages(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts,
  behavior: LineReplyBehavior = {},
): Promise<void> {
  const stagedMessages = await stageLineOutboundMessageImages(messages);
  const { account, client } = createLineMessagingClient(opts);

  await client.replyMessage({
    replyToken,
    messages: stagedMessages,
  });

  recordLineOutboundActivity(account.accountId);

  if (opts.verbose) {
    logVerbose(
      behavior.verboseMessage?.(messages.length) ??
        `line: replied with ${stagedMessages.length} messages`,
    );
  }
}

export async function sendMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts,
): Promise<LineSendResult> {
  const chatId = normalizeTarget(to);
  const messages: Message[] = [];

  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    switch (opts.mediaKind) {
      case "video": {
        await validateLineMediaUrl(mediaUrl);
        const previewImageUrl = opts.previewImageUrl?.trim();
        if (!previewImageUrl) {
          throw new Error("LINE video messages require previewImageUrl to reference an image URL");
        }
        const trackingId = isLineUserChatId(chatId) ? opts.trackingId : undefined;
        messages.push(createVideoMessage(mediaUrl, previewImageUrl, trackingId));
        break;
      }
      case "audio":
        await validateLineMediaUrl(mediaUrl);
        messages.push(createAudioMessage(mediaUrl, opts.durationMs ?? 60000));
        break;
      default:
        // Image sources are staged and verified at the final LINE send boundary.
        messages.push(createImageMessage(mediaUrl, opts.previewImageUrl?.trim() || mediaUrl));
        break;
    }
  }

  if (text?.trim()) {
    messages.push(createTextMessage(text.trim()));
  }

  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  if (opts.replyToken) {
    await replyLineMessages(opts.replyToken, messages, opts, {
      verboseMessage: () => `line: replied to ${chatId}`,
    });

    return {
      messageId: "reply",
      chatId,
      receipt: createLineSendReceipt({
        messageId: "reply",
        chatId,
        kind: resolveLineReceiptKind(messages),
        messageCount: messages.length,
      }),
    };
  }

  return pushLineMessages(chatId, messages, opts, {
    verboseMessage: (resolvedChatId) => `line: pushed message to ${resolvedChatId}`,
  });
}

export async function pushMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts,
): Promise<LineSendResult> {
  return sendMessageLine(to, text, { ...opts, replyToken: undefined });
}

export async function replyMessageLine(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts,
): Promise<void> {
  await replyLineMessages(replyToken, messages, opts);
}

export async function pushMessagesLine(
  to: string,
  messages: Message[],
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, messages, opts, {
    errorContext: "push message",
  });
}

export function createFlexMessage(
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText,
    contents,
  };
}

export async function pushImageMessage(
  to: string,
  originalContentUrl: string,
  previewImageUrl: string | undefined,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [createImageMessage(originalContentUrl, previewImageUrl)], opts, {
    verboseMessage: (chatId) => `line: pushed image to ${chatId}`,
  });
}

export async function pushLocationMessage(
  to: string,
  location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  },
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [createLocationMessage(location)], opts, {
    verboseMessage: (chatId) => `line: pushed location to ${chatId}`,
  });
}

export async function pushFlexMessage(
  to: string,
  altText: string,
  contents: FlexContainer,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  const flexMessage: FlexMessage = {
    type: "flex",
    altText: truncateUtf16Safe(altText, 400),
    contents,
  };

  return pushLineMessages(to, [flexMessage], opts, {
    errorContext: "push flex message",
    verboseMessage: (chatId) => `line: pushed flex message to ${chatId}`,
  });
}

export async function pushTemplateMessage(
  to: string,
  template: TemplateMessage,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [template], opts, {
    verboseMessage: (chatId) => `line: pushed template message to ${chatId}`,
  });
}

export async function pushTextMessageWithQuickReplies(
  to: string,
  text: string,
  quickReplies: readonly LineQuickReplyItem[],
  opts: LinePushOpts,
): Promise<LineSendResult> {
  const message = createTextMessageWithQuickReplies(text, quickReplies);

  return pushLineMessages(to, [message], opts, {
    verboseMessage: (chatId) => `line: pushed message with quick replies to ${chatId}`,
  });
}

/**
 * LINE caps a quick reply at 13 chips, so the extras are dropped rather than
 * rejected: a decision the owner can still type is worth showing partly.
 */
const QUICK_REPLY_LIMIT = 13;

/**
 * Chips for one message.
 *
 * A postback chip carries `data` the webhook receives verbatim, so the handler
 * that offered the decision resolves it exactly. `displayText` is the label, so
 * the transcript still reads like the owner said it.
 */
export function createQuickReplyItems(items: readonly LineQuickReplyItem[]): QuickReply {
  return {
    items: items.slice(0, QUICK_REPLY_LIMIT).map((item): QuickReplyItem => {
      if (typeof item === "string") {
        return { type: "action", action: messageAction(item, item) };
      }
      return { type: "action", action: postbackAction(item.label, item.data, item.label) };
    }),
  };
}

export function createTextMessageWithQuickReplies(
  text: string,
  quickReplies: readonly LineQuickReplyItem[],
): TextMessage & { quickReply: QuickReply } {
  return {
    type: "text",
    text,
    quickReply: createQuickReplyItems(quickReplies),
  };
}

export async function showLoadingAnimation(
  chatId: string,
  opts: LineClientOpts & { loadingSeconds?: number },
): Promise<void> {
  const { client } = createLineMessagingClient(opts);

  try {
    await client.showLoadingAnimation({
      chatId: normalizeTarget(chatId),
      loadingSeconds: opts.loadingSeconds ?? 20,
    });
    logVerbose(`line: showing loading animation to ${chatId}`);
  } catch (err) {
    logVerbose(`line: loading animation failed (non-fatal): ${String(err)}`);
  }
}

export async function getUserProfile(
  userId: string,
  opts: LineClientOpts & { useCache?: boolean },
): Promise<{ displayName: string; pictureUrl?: string } | null> {
  const useCache = opts.useCache ?? true;

  if (useCache) {
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
      return { displayName: cached.displayName, pictureUrl: cached.pictureUrl };
    }
  }

  const { client } = createLineMessagingClient(opts);

  try {
    const profile = await client.getProfile(userId);
    const result = {
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
    };

    userProfileCache.set(userId, {
      ...result,
      fetchedAt: Date.now(),
    });

    return result;
  } catch (err) {
    logVerbose(`line: failed to fetch profile for ${userId}: ${String(err)}`);
    return null;
  }
}

export async function getUserDisplayName(userId: string, opts: LineClientOpts): Promise<string> {
  const profile = await getUserProfile(userId, opts);
  return profile?.displayName ?? userId;
}
