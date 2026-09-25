// A user's explicit model choice for one session, applied the way every
// surface applies it: sessions.patch (the Control UI picker) and plugin-owned
// natural-language switches share this so their stored fields cannot drift.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

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
 * Applies a user-selected model to a session entry. Choosing the agent's
 * default clears the override (a reset, not a pinned copy of the default), and
 * the switch is marked live so an in-flight run picks it up.
 */
export function applyUserSessionModelSelection(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  selection: ModelRef;
  defaultModel: ModelRef;
  profileOverride?: string;
}): { updated: boolean } {
  const { cfg, entry, selection, defaultModel } = params;
  const isDefault =
    selection.provider === defaultModel.provider && selection.model === defaultModel.model;
  return applyModelOverrideToSessionEntry({
    entry,
    selection: { provider: selection.provider, model: selection.model, isDefault },
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
