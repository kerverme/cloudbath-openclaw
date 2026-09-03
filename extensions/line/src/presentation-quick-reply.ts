/**
 * Portable presentation controls -> LINE quick-reply chips.
 *
 * Owner plugins declare a bounded decision as typed presentation actions; this
 * is the LINE half of that contract, and the only place that knows a LINE
 * postback exists. A `callback` action becomes a postback chip, so the value
 * the offering handler chose comes back verbatim and nothing about the decision
 * has to survive natural-language parsing.
 *
 * A `command` action becomes a plain message chip: LINE has no native command
 * surface, so the command text is what the owner would have typed anyway.
 * `url`, `web-app` and `approval` actions are deliberately dropped rather than
 * approximated — a quick reply cannot open a link or resolve an approval, and a
 * chip that silently does nothing is worse than no chip.
 */
import {
  isMessagePresentationInteractiveBlock,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
  type MessagePresentationAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { LineChannelData, LineQuickReplyItem } from "./types.js";

/** LINE rejects a postback whose data exceeds 300 bytes; an over-long one is dropped. */
const POSTBACK_DATA_MAX_BYTES = 300;

function toQuickReplyItem(
  label: string,
  action: MessagePresentationAction | undefined,
): LineQuickReplyItem | undefined {
  const text = label.trim();
  if (!text || !action) {
    return undefined;
  }
  if (action.type === "command") {
    return action.command.trim() ? { label: text, data: action.command } : undefined;
  }
  if (action.type !== "callback") {
    return undefined;
  }
  const data = action.value;
  return data && Buffer.byteLength(data, "utf8") <= POSTBACK_DATA_MAX_BYTES
    ? { label: text, data }
    : undefined;
}

/**
 * Chips for every interactive control in the presentation, in block order.
 *
 * A command chip has to travel as a postback too: a `message` chip would put
 * the raw command in the transcript as if the owner typed it, and the owner
 * plugin that offered the decision would then have to re-parse its own value.
 */
export function mapLinePresentationQuickReplies(
  presentation: MessagePresentation | undefined,
): LineQuickReplyItem[] {
  const items: LineQuickReplyItem[] = [];
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    const controls =
      block.type === "buttons"
        ? block.buttons.map((button) => ({
            label: button.label,
            action: resolveMessagePresentationButtonAction(button),
          }))
        : block.options.map((option) => ({
            label: option.label,
            action: resolveMessagePresentationOptionAction(option),
          }));
    for (const control of controls) {
      const item = toQuickReplyItem(control.label, control.action);
      if (item) {
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * Merges the presentation's controls into the payload's LINE quick replies.
 *
 * Appended after any `[[quick_replies: ...]]` the text carried, so a typed
 * declaration never silently replaces one an owner plugin already wrote. The
 * presentation itself is left on the payload: core still renders its text
 * fallback for channels and transports that read it.
 */
export function applyLinePresentationQuickReplies(payload: ReplyPayload): ReplyPayload {
  const mapped = mapLinePresentationQuickReplies(payload.presentation);
  if (mapped.length === 0) {
    return payload;
  }
  const line: LineChannelData = { ...(payload.channelData?.line as LineChannelData | undefined) };
  line.quickReplies = [...(line.quickReplies ?? []), ...mapped];
  return { ...payload, channelData: { ...payload.channelData, line } };
}
