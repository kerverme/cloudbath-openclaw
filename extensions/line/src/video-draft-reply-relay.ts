/**
 * Deterministic relay for the owner-facing video-draft result text.
 *
 * `line_video_draft` returns its outcome as tool-result content, which is
 * LLM-facing. The visible LINE message can instead be sent by either the
 * automatic source-reply dispatcher or the model's `message` tool. Both paths
 * pass through `message_sending`; only the automatic path carries the
 * narrower `reply_payload_sending` metadata.
 *
 * Relay state is process-global rather than plugin-lifecycle-local. Agent tool
 * discovery may evaluate the LINE entry in a separate runtime registry from
 * the live channel hook registry, but both registries share this host process.
 * This keeps the tool-side arm and channel-side send on one state machine.
 */
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

type PendingReply = {
  phase: "armed" | "delivered";
  text: string;
  expiresAt: number;
};

type MessageSendingResult = {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
};

type RelayState = {
  pending: Map<string, PendingReply>;
  handledEvents: WeakMap<object, MessageSendingResult>;
};

const LINE_VIDEO_REPLY_RELAY_STATE = Symbol.for("openclaw.line.videoDraftReplyRelay");

export const LINE_VIDEO_REPLY_RELAY_TTL_MS = 15 * 60 * 1000;
export const LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES = 512;

type BeforeDispatchEvent = {
  channel?: string;
  sessionKey?: string;
};

type MessageSendingEvent = {
  content: string;
  metadata?: Record<string, unknown>;
};

type MessageSendingContext = {
  channelId?: string;
  sessionKey?: string;
};

export type LineVideoDraftReplyRelay = {
  /** Clears any completed/crashed prior turn before the next model dispatch. */
  beginTurn: (event: BeforeDispatchEvent, ctx: MessageSendingContext) => void;
  /** Arms this session's deterministic text from the tool result. */
  record: (params: { sessionKey?: string; text: string }) => void;
  /** Rewrites/cancels the LINE send shared by source and message-tool replies. */
  messageSending: (
    event: MessageSendingEvent,
    ctx: MessageSendingContext,
  ) => MessageSendingResult | undefined;
};

function getRelayState(): RelayState {
  return resolveGlobalSingleton<RelayState>(LINE_VIDEO_REPLY_RELAY_STATE, () => ({
    pending: new Map(),
    handledEvents: new WeakMap(),
  }));
}

function resolveSessionKey(event: BeforeDispatchEvent, ctx: MessageSendingContext): string {
  return (event.sessionKey ?? ctx.sessionKey)?.trim() ?? "";
}

export function createLineVideoDraftReplyRelay(deps?: {
  now?: () => number;
}): LineVideoDraftReplyRelay {
  const now = deps?.now ?? (() => Date.now());
  const state = getRelayState();

  const dropExpired = (at: number): void => {
    for (const [key, entry] of state.pending) {
      if (entry.expiresAt <= at) {
        state.pending.delete(key);
      }
    }
  };

  return {
    beginTurn: (event, ctx) => {
      if ((event.channel ?? ctx.channelId) !== "line") {
        return;
      }
      const key = resolveSessionKey(event, ctx);
      if (key) {
        state.pending.delete(key);
      }
    },

    record: ({ sessionKey, text }) => {
      const key = sessionKey?.trim();
      if (!key || !text) {
        return;
      }
      const at = now();
      dropExpired(at);
      if (state.pending.size >= LINE_VIDEO_REPLY_RELAY_MAX_ENTRIES && !state.pending.has(key)) {
        const oldest = state.pending.keys().next();
        if (!oldest.done) {
          state.pending.delete(oldest.value);
        }
      }
      state.pending.set(key, {
        phase: "armed",
        text,
        expiresAt: at + LINE_VIDEO_REPLY_RELAY_TTL_MS,
      });
    },

    messageSending: (event, ctx) => {
      const channel =
        typeof event.metadata?.channel === "string" ? event.metadata.channel : ctx.channelId;
      if (channel !== "line") {
        return undefined;
      }

      // A composed runner can expose this plugin from multiple live registries.
      // Reuse the first decision for this exact dispatch event rather than
      // treating the second registration as another LINE message.
      const cached = state.handledEvents.get(event);
      if (cached) {
        return cached;
      }

      const key = ctx.sessionKey?.trim();
      if (!key) {
        return undefined;
      }
      dropExpired(now());
      const entry = state.pending.get(key);
      if (!entry) {
        return undefined;
      }

      if (entry.phase === "armed") {
        entry.phase = "delivered";
        const result = { content: entry.text };
        state.handledEvents.set(event, result);
        return result;
      }

      const result = {
        cancel: true,
        cancelReason: "line_video_draft_reply_already_sent",
      };
      state.handledEvents.set(event, result);
      return result;
    },
  };
}
