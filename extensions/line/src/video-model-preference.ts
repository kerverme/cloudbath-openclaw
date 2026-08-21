/**
 * Per-conversation LINE video-model preference — completely separate from the
 * chat/LLM model (extensions/line/src/model-catalog-tool.ts,
 * model-switch-router.ts). Changing the video model never touches
 * agents.defaults.model, the session chat-model override, or any global
 * OpenClaw model configuration: it only ever reads/writes this dedicated
 * SQLite-backed keyed store.
 *
 * Scope key: accountId + conversation identity, mirroring the LINE plugin's
 * established per-conversation isolation pattern (see
 * group-owner-control.ts's buildLineGroupSilentModeStateKey). The dispatch
 * hook layer (before_dispatch) does not expose raw LINE group/room ids, only
 * a stable per-conversation `conversationId`/`sessionKey` — see
 * video-model-control.ts and video-confirmation.ts for how the key is built
 * at each call site.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const LINE_VIDEO_MODEL_PREFERENCE_NAMESPACE = "video-model-preference-v1";
export const LINE_VIDEO_MODEL_PREFERENCE_MAX_ENTRIES = 20_000;
export const DEFAULT_LINE_VIDEO_MODEL = "bytedance/seedance-2.5";

export type LineVideoModelPreferenceState = {
  model: string;
  updatedAt: number;
};

export type LineVideoModelPreferenceStore = PluginStateKeyedStore<LineVideoModelPreferenceState>;

/** Builds the per-conversation preference/draft/job scope key: accountId + conversation identity. */
export function buildLineVideoConversationKey(params: {
  accountId: string;
  conversationId: string;
}): string | null {
  const conversationId = params.conversationId.trim();
  return conversationId ? `${params.accountId}|${conversationId}` : null;
}

/** Resolves the active video model for a conversation, defaulting to seedance-2.5. */
export async function resolveLineVideoModelPreference(params: {
  store: LineVideoModelPreferenceStore;
  key: string;
  defaultModel?: string;
}): Promise<string> {
  const existing = await params.store.lookup(params.key);
  return existing?.model ?? params.defaultModel ?? DEFAULT_LINE_VIDEO_MODEL;
}

/** Persists a conversation's video-model preference. Owner-only at every call site. */
export async function setLineVideoModelPreference(params: {
  store: LineVideoModelPreferenceStore;
  key: string;
  model: string;
  now?: () => number;
}): Promise<void> {
  await params.store.register(params.key, {
    model: params.model,
    updatedAt: (params.now ?? Date.now)(),
  });
}
