/**
 * Deterministic relay for the owner-facing video-draft result text.
 *
 * `line_video_draft` returns its outcome text — the success preview, or the
 * deterministic Thai reason for a failed branch — as agent tool-result
 * content, which is LLM-facing only: the LINE-visible message is whatever the
 * model writes on the following turn. In production that turn paraphrased the
 * preview down to the confirmation code alone, dropping the model, settings
 * and — critically — the estimated price the owner is being asked to approve.
 * The same turn also narrated a failed `unknown_cost` branch as if a draft had
 * been created, which was simply false. Tool-description prose cannot fix
 * either: text that states what a paid action will cost, or whether it
 * happened at all, has to be tool-owned.
 *
 * So the text is pinned onto the outbound payload instead, through the host's
 * `reply_payload_sending` hook (src/auto-reply/reply/route-reply.ts populates
 * it; src/infra/outbound/deliver.ts runs it), which may rewrite or cancel each
 * payload before it reaches the channel. The model's text for that turn is
 * replaced wholesale, so no paraphrase, omission or invented claim can survive
 * to LINE.
 *
 * `sessionKey` is the correlation key because it is the one identity present
 * on BOTH sides — `OpenClawPluginToolContext` (tool) and the hook event
 * (outbound). `runId` exists only on the hook side and is used for the
 * same-turn cancel window below.
 */

/** Tool-owned text awaiting its outbound payload, plus the turn that consumed it. */
type PendingReply = {
  text: string;
  expiresAt: number;
  /**
   * Set once the text has been pinned onto a payload. Further payloads from
   * that same turn are cancelled so one tool call yields exactly one LINE
   * message; a payload from any later turn releases the entry untouched.
   */
  deliveredRunId?: string;
  delivered?: boolean;
};

/**
 * Entries live only between the tool call and the payload it belongs to, so a
 * run that never emits a payload cannot leave text armed against some
 * unrelated later message. Matches the draft's own 15-minute lifetime.
 */
export const LINE_VIDEO_REPLY_RELAY_TTL_MS = 15 * 60 * 1000;

/** Bounds the map for a gateway serving many LINE conversations at once. */
export const LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES = 512;

type ReplyPayloadSendingEvent = {
  payload?: { text?: string } & Record<string, unknown>;
  kind?: string;
  channel?: string;
  sessionKey?: string;
  runId?: string;
};

type ReplyPayloadSendingContext = {
  channelId?: string;
  sessionKey?: string;
};

type ReplyPayloadSendingResult = {
  payload?: Record<string, unknown>;
  cancel?: boolean;
  reason?: string;
};

export type LineVideoDraftReplyRelay = {
  /** Arms this session's text. Called once per deterministic tool outcome. */
  record: (params: { sessionKey?: string; text: string }) => void;
  /** `reply_payload_sending` handler. Registered for the LINE plugin only. */
  replyPayloadSending: (
    event: ReplyPayloadSendingEvent,
    ctx: ReplyPayloadSendingContext,
  ) => ReplyPayloadSendingResult | undefined;
};

export function createLineVideoDraftReplyRelay(deps?: {
  now?: () => number;
}): LineVideoDraftReplyRelay {
  const now = deps?.now ?? (() => Date.now());
  const pending = new Map<string, PendingReply>();

  const dropExpired = (at: number): void => {
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= at) {
        pending.delete(key);
      }
    }
  };

  return {
    record: ({ sessionKey, text }) => {
      const key = sessionKey?.trim();
      // No sessionKey means no way to match the outbound payload. Leaving the
      // entry out keeps the model's text in place rather than pinning this
      // text onto some other conversation's message.
      if (!key || !text) {
        return;
      }
      const at = now();
      dropExpired(at);
      if (pending.size >= LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES && !pending.has(key)) {
        const oldest = pending.keys().next();
        if (!oldest.done) {
          pending.delete(oldest.value);
        }
      }
      // Single slot per session: a repeated request supersedes the previous
      // text, matching the one-live-draft-per-conversation flow.
      pending.set(key, { text, expiresAt: at + LINE_VIDEO_REPLY_RELAY_TTL_MS });
    },

    replyPayloadSending: (event, ctx) => {
      const channel = event.channel ?? ctx.channelId;
      if (channel !== "line") {
        return undefined;
      }
      const key = (event.sessionKey ?? ctx.sessionKey)?.trim();
      if (!key) {
        return undefined;
      }
      const at = now();
      dropExpired(at);
      const entry = pending.get(key);
      if (!entry) {
        return undefined;
      }

      if (!entry.delivered) {
        entry.delivered = true;
        entry.deliveredRunId = event.runId;
        // Replace the whole text rather than appending: the model's own
        // wording for this turn is exactly what must not reach the owner.
        return { payload: { ...event.payload, text: entry.text } };
      }

      // Same turn, second payload: the text already went out, so anything
      // further would be a duplicate or a model gloss on top of it.
      if (entry.deliveredRunId && event.runId === entry.deliveredRunId) {
        return { cancel: true, reason: "line_video_draft_reply_already_sent" };
      }

      // A later turn: the tool's turn is over, release and stay out of the way.
      pending.delete(key);
      return undefined;
    },
  };
}
