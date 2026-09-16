/**
 * Registers the trusted storyboard summary BEFORE anything finalizes the turn.
 *
 * Repair prefers structured regeneration over dropping text, but only the
 * storyboard flow can regenerate, and by the time an outbound hook runs the
 * authoritative text has already been chosen. So the summary is prepared at
 * `before_agent_finalize`, while the run still owns the decision.
 *
 * Every identity here comes from the run's ingress context — account, owner,
 * conversation — never from the reply text. A turn that cannot name all three
 * prepares nothing, because the storyboard store is scoped to exactly that
 * triple and there is no safe way to guess a conversation's owner.
 */

export type StoryboardRegenerationPrepareContext = Readonly<{
  accountId?: string;
  senderId?: string;
  chatId?: string;
  channel?: string;
  channelId?: string;
  sessionKey?: string;
}>;

export type StoryboardRegenerationPrepareDeps = Readonly<{
  /** Reads this conversation's current storyboard summary, claim-scoped. */
  readStoryboardLanguage(
    context: Readonly<{
      channelId: string;
      accountId: string;
      conversationId: string;
      sessionKey?: string;
    }>,
    options: Readonly<{ ownerSenderId: string }>,
  ): Promise<Readonly<{ summary: string | undefined }> | undefined>;
  /** Whether this text is the summary's own operation, so a rebuild is faithful. */
  isRebuildTarget(text: string): boolean;
  prepare(params: Readonly<{ runId: string; sourceText: string; regeneratedText: string }>): void;
}>;

/**
 * Prepares regeneration for one turn, or does nothing.
 *
 * Returns whether it prepared, so a caller (and a test) can tell "refused" from
 * "no storyboard here" without reading private state.
 */
export async function prepareStoryboardRegeneration(params: {
  event: Readonly<{ runId?: string; lastAssistantMessage?: string }>;
  ctx: StoryboardRegenerationPrepareContext;
  deps: StoryboardRegenerationPrepareDeps;
}): Promise<boolean> {
  const { event, ctx, deps } = params;
  const runId = event.runId?.trim();
  const sourceText = event.lastAssistantMessage;
  const accountId = ctx.accountId?.trim();
  const ownerSenderId = ctx.senderId?.trim();
  const conversationId = ctx.chatId?.trim();
  const channelId = ctx.channel?.trim() || ctx.channelId?.trim();
  if (!runId || !sourceText?.trim() || !accountId || !ownerSenderId || !conversationId) {
    return false;
  }
  if (channelId?.toLowerCase() !== "line" || !deps.isRebuildTarget(sourceText)) {
    return false;
  }
  const structured = await deps
    .readStoryboardLanguage(
      {
        channelId,
        accountId,
        conversationId,
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      },
      { ownerSenderId },
    )
    .catch(() => undefined);
  const regeneratedText = structured?.summary?.trim();
  if (!regeneratedText) {
    return false;
  }
  deps.prepare({ runId, sourceText, regeneratedText });
  return true;
}
