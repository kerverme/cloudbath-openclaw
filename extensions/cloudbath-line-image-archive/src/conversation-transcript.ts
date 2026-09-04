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
export type ConversationTurn = Readonly<{
  role: "owner" | "assistant";
  text: string;
  /** Epoch ms, when the source dated it. Used only to interleave two sources. */
  at?: number;
}>;

/**
 * Whether every human turn on this session provably came from one person.
 *
 * A LINE group routes on the group id, so one session key carries EVERY
 * member's turns. `shared` therefore means a persisted `user` message cannot be
 * attributed and must not be presented as the owner's; `single-sender` (a
 * direct chat) means the session has exactly one human and attribution is
 * structural.
 */
export type ConversationSenderScope = "single-sender" | "shared";

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
    senderScope: ConversationSenderScope;
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

/**
 * Which persisted roles may be read, given who shares this session.
 *
 * An `assistant` turn is the bot's own output and is attributable whatever the
 * conversation shape. A `user` turn is NOT: the canonical `UserMessage` carries
 * `role`, `content` and `timestamp` and no author, and in a group every
 * member's turns land on the same session key. Where the group's sender id
 * survives at all it survives as a rendered prefix inside the envelope body —
 * a prompt rendering, not a data contract, and `BodyForAgent` often persists
 * the clean text without it. Reading an author out of that would be guessing
 * from free-form text, so a shared session drops user turns instead. System and
 * tool messages are machinery and never appear either.
 */
function toRole(
  role: unknown,
  senderScope: ConversationSenderScope,
): ConversationTurn["role"] | undefined {
  if (role === "assistant") {
    return "assistant";
  }
  return role === "user" && senderScope === "single-sender" ? "owner" : undefined;
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
    readRecentTurns: async ({ sessionKey, agentId, limit, senderScope }) => {
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
          entries.map((row) => ({
            role: row.role,
            message: row.message,
            createdAt: row.createdAt,
          })),
          limit,
          senderScope,
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
  rows: readonly Readonly<{ role: unknown; message: unknown; createdAt?: string | undefined }>[],
  limit: number,
  senderScope: ConversationSenderScope,
): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  // Walked newest-first so the cap keeps the MOST recent turns, then reversed
  // back into reading order.
  for (let index = rows.length - 1; index >= 0 && turns.length < limit; index -= 1) {
    const row = rows[index]!;
    const role = toRole(row.role, senderScope);
    const text = readTurnText(row.message);
    if (!role || !text) {
      continue;
    }
    const at = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    turns.push({
      role,
      text: text.slice(0, CONVERSATION_TURN_MAX_CHARS),
      ...(Number.isFinite(at) ? { at } : {}),
    });
  }
  return Object.freeze(turns.toReversed());
}

/**
 * Interleaves the two attributable sources into one reading order.
 *
 * Assistant turns come from the transcript; owner turns come from the
 * conversation record, which knows who spoke because it only ever records the
 * bound owner's own turns. Dated turns sort by time; an undated one keeps its
 * relative position ahead of them rather than being invented a timestamp.
 */
export function mergeConversationTurns(
  transcriptTurns: readonly ConversationTurn[],
  ownerTurns: readonly ConversationTurn[],
  limit: number,
): readonly ConversationTurn[] {
  const all = [...transcriptTurns, ...ownerTurns];
  const undated = all.filter((turn) => turn.at === undefined);
  const dated = all
    .filter((turn) => turn.at !== undefined)
    .toSorted((left, right) => left.at! - right.at!);
  return Object.freeze([...undated, ...dated].slice(-limit));
}
