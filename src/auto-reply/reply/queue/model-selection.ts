// Propagates a committed explicit model selection into turns queued for the session.
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import { resolveEffectiveAgentRuntime } from "../../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getExistingFollowupQueue, refreshQueuedFollowupSession } from "./state.js";

/**
 * Retargets turns queued for `sessionKey` at an explicit model selection that
 * has already been persisted as `entry`.
 *
 * Every explicit writer (`/model`, gateway `sessions.patch`, channel switches)
 * calls this after its save wins: a queued turn captured its model before it
 * was queued, and without this it would still run the superseded model. A run
 * already sending a provider request is not in the queue and keeps its model;
 * the post-attempt live switch owns that boundary.
 */
export function refreshQueuedFollowupModelSelection(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  /** The session's model after the save: its override, or the resulting default. */
  selection: { provider: string; model: string };
  /** The persisted row the save produced; auth profile and thinking level come from it. */
  entry: SessionEntry;
  agentId?: string;
  /** Session key the agent runtime policy resolves against, when it differs. */
  runtimePolicySessionKey?: string;
  thinkingCatalog?: ModelCatalogEntry[];
}): void {
  if (!getExistingFollowupQueue(params.sessionKey.trim())) {
    return;
  }
  const { provider, model } = params.selection;
  refreshQueuedFollowupSession({
    key: params.sessionKey,
    nextProvider: provider,
    nextModel: model,
    nextModelOverrideSource: "user",
    nextAuthProfileId: params.entry.authProfileOverride,
    nextAuthProfileIdSource: params.entry.authProfileOverrideSource,
    nextThinking: {
      level: params.entry.thinkingLevel,
      catalog: params.thinkingCatalog,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
        sessionEntry: params.entry,
      }),
    },
  });
}
