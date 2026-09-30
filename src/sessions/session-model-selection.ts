// A user's explicit model choice for one session, applied the way every
// surface applies it: sessions.patch (the Control UI picker) and plugin-owned
// natural-language switches share this so their stored fields cannot drift.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { hasUserPinnedSessionModel } from "../agents/agent-scope.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";
import { currentSessionModelScope } from "./session-model-scope.js";

type ModelRef = { provider: string; model: string };

/**
 * A session's pinned auth profile survives a model switch only while it still
 * authenticates the target provider; otherwise the next run would send the
 * old provider's credentials to the new one.
 */
export function shouldPreserveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
}): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  if (!profileOverride) {
    return false;
  }
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!provider) {
    return false;
  }
  const resolvesToTargetProvider = (rawProvider: string | undefined): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    if (!candidate) {
      return false;
    }
    return (
      resolveProviderIdForAuth(candidate, { config: params.cfg }) ===
      resolveProviderIdForAuth(provider, { config: params.cfg })
    );
  };
  const delimiterIndex = profileOverride.indexOf(":");
  if (delimiterIndex < 0) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  const profileProvider = normalizeOptionalLowercaseString(
    profileOverride.slice(0, delimiterIndex),
  );
  if (!profileProvider) {
    return false;
  }
  return resolvesToTargetProvider(profileProvider);
}

/**
 * Applies a user-selected model to a session entry and marks the switch live so
 * an in-flight run picks it up. Choosing the model that happens to be the
 * agent's default still pins it: a pin owns every text call and disables
 * cross-model fallback, and only an explicit reset (`/model default`,
 * `sessions.patch` with `model: null`) returns the session to the default.
 */
export function applyUserSessionModelSelection(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  selection: ModelRef;
  defaultModel: ModelRef;
  profileOverride?: string;
}): { updated: boolean } {
  const { cfg, entry, selection, defaultModel } = params;
  return applyModelOverrideToSessionEntry({
    entry,
    selection: { provider: selection.provider, model: selection.model },
    profileOverride: params.profileOverride,
    preserveAuthProfileOverride: shouldPreserveSessionAuthProfileOverride({
      cfg,
      entry,
      currentProvider: entry.providerOverride ?? entry.modelProvider ?? defaultModel.provider,
      provider: selection.provider,
    }),
    markLiveSwitchPending: true,
  });
}

/**
 * The model a text completion made on this session's behalf must use, as a
 * `provider/model` ref: the model the current run attempt executes, else the
 * session's pin. Undefined when the owner never pinned one, so the caller keeps
 * its configured default.
 *
 * Reads the session row lazily, at the one call that needs it; turns that make
 * no such call never pay for the read.
 */
export function resolvePinnedSessionModelRef(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): { modelRef: string; authProfileId?: string } | undefined {
  const entry = loadSessionEntry({
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    readConsistency: "latest",
    clone: false,
  });
  if (!entry || !hasUserPinnedSessionModel(entry)) {
    return undefined;
  }
  const scope = currentSessionModelScope();
  const runModel = scope?.sessionKey === params.sessionKey ? scope.runModel : undefined;
  const selected = runModel ?? {
    ...resolveSessionModelRef(params.cfg, entry, params.agentId),
    authProfileId: normalizeOptionalString(entry.authProfileOverride),
  };
  return {
    modelRef: `${selected.provider}/${selected.model}`,
    ...(selected.authProfileId ? { authProfileId: selected.authProfileId } : {}),
  };
}
