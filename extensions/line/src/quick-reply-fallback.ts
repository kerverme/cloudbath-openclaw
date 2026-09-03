// Line plugin module implements quick reply fallback behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { LineQuickReplyItem } from "./types.js";

/** Only the label is ever shown; a postback chip's `data` is transport-private. */
export function readLineQuickReplyLabels(
  items: readonly LineQuickReplyItem[] | undefined,
): string[] {
  return normalizeStringEntries(
    (items ?? []).map((item) => (typeof item === "string" ? item : item.label)),
  );
}

export function buildLineQuickReplyFallbackText(
  items: readonly LineQuickReplyItem[] | undefined,
): string {
  const labels = readLineQuickReplyLabels(items).slice(0, 13);
  if (labels.length === 0) {
    return "Choose an option.";
  }
  return `Options:\n${labels.map((label) => `- ${label}`).join("\n")}`;
}
