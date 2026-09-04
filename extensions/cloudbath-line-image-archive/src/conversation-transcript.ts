/**
 * A small window of what was just said, for the one step that needs language
 * rather than state.
 *
 * The Active Conversation Context answers "what work is in play" with ids. It
 * cannot answer "what does แบบเมื่อกี้ point at", because that is a property of
 * the words, not of the state. This supplies those words — and nothing else.
 *
 * It reads the session's OWN transcript through the canonical SDK accessor;
 * there is deliberately no second store here. The scope is the session key the
 * inbound turn arrived on, so another group's or owner's conversation is not
 * reachable rather than merely filtered: a different LINE conversation is a
 * different session key, and this never enumerates sessions.
 *
 * Everything that leaves here is bounded and text-only — no attachments, no
 * tool payloads, no media, no unbounded history — because it is about to be
 * serialized into a model prompt.
 */

import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";

/** One remembered turn. Newest last, as the resolver's prompt expects. */
export type ConversationTurn = Readonly<{ role: "owner" | "assistant"; text: string }>;

/** Enough to resolve a reference back; short enough to stay a hint, not a dump. */
export const CONVERSATION_RECENT_TURN_LIMIT = 8;
/** One turn is a line of chat, not a document. Long turns are cut, not dropped. */
export const CONVERSATION_TURN_MAX_CHARS = 400;

export type ConversationTranscriptReader = Readonly<{
  /**
   * The most recent turns on THIS session, oldest first.
   *
   * Returns an empty list when history is unavailable for any reason: a missing
   * session, a store that cannot be read, a session that has not spoken yet.
   * Arbitration then falls back to structured state, which is always present.
   */
  readRecentTurns(params: {
    sessionKey: string;
    agentId?: string;
    limit: number;
  }): Promise<readonly ConversationTurn[]>;
}>;

/**
 * Visible text of one transcript message.
 *
 * Only text blocks are read. An image, a tool call and a tool result all carry
 * bytes or internals that have no place in a referent prompt, so they collapse
 * to nothing and the turn is skipped.
 */
function readTurnText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
    }
  }
  return parts.join("\n").trim() || undefined;
}

function toRole(role: unknown): ConversationTurn["role"] | undefined {
  // Only the two sides of the conversation. System and tool messages are
  // machinery: they are not what "เมื่อกี้" refers to.
  return role === "user" ? "owner" : role === "assistant" ? "assistant" : undefined;
}

/**
 * The production reader, over the canonical session transcript.
 *
 * Injected rather than imported at the call site so the arbitration suites can
 * supply history without a session store, and so a build where transcripts are
 * unavailable simply has no reader.
 */
export function createConversationTranscriptReader(): ConversationTranscriptReader {
  return {
    readRecentTurns: async ({ sessionKey, agentId, limit }) => {
      try {
        const entry = getSessionEntry({
          sessionKey,
          ...(agentId ? { agentId } : {}),
        });
        const sessionId = entry?.sessionId?.trim();
        if (!sessionId) {
          return [];
        }
        const entries = await readVisibleSessionTranscriptMessageEntries({
          sessionKey,
          sessionId,
          ...(agentId ? { agentId } : {}),
        });
        return projectRecentTurns(
          entries.map((row) => ({ role: row.role, message: row.message })),
          limit,
        );
      } catch {
        // History is an enhancement, never a precondition: arbitration still
        // has the structured context, which is the authoritative half.
        return [];
      }
    },
  };
}

/**
 * Shared projection: the last `limit` owner/assistant turns, oldest first,
 * each trimmed to one chat line's worth of text.
 *
 * Exported so a test double produces exactly the shape production does, rather
 * than a friendlier one that would hide a bug here.
 */
export function projectRecentTurns(
  rows: readonly Readonly<{ role: unknown; message: unknown }>[],
  limit: number,
): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  // Walked newest-first so the cap keeps the MOST recent turns, then reversed
  // back into reading order.
  for (let index = rows.length - 1; index >= 0 && turns.length < limit; index -= 1) {
    const row = rows[index]!;
    const role = toRole(row.role);
    const text = readTurnText(row.message);
    if (role && text) {
      turns.push({ role, text: text.slice(0, CONVERSATION_TURN_MAX_CHARS) });
    }
  }
  return Object.freeze(turns.toReversed());
}
