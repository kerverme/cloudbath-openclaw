/**
 * Per-conversation LINE video-model preference — completely separate from the
 * chat/LLM model (extensions/line/src/model-catalog-tool.ts,
 * model-switch-router.ts). Changing the video model never touches
 * agents.defaults.model, the session chat-model override, or any global
 * OpenClaw model configuration: it only ever reads/writes this dedicated
 * SQLite-backed keyed store.
 *
 * Scope key: accountId + normalized LINE-native conversation identity,
 * mirroring the LINE plugin's established per-conversation isolation pattern
 * (see group-owner-control.ts's buildLineGroupSilentModeStateKey). Tool
 * factories receive that identity through `nativeChannelId` / the trusted
 * delivery target, while before_dispatch receives it as `conversationId`.
 * Ephemeral OpenClaw session ids/keys are deliberately never used here.
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

/**
 * Normalizes the same LINE user/group/room identity shape used by bindings.ts.
 * Both `C...` and trusted delivery addresses such as `line:group:C...` become
 * the same canonical value.
 */
export function normalizeLineVideoConversationId(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const prefixed = trimmed.match(/^line:(?:(?:user|group|room):)?(.+)$/iu)?.[1];
  return (prefixed ?? trimmed).trim() || null;
}

/** Builds the sole per-conversation preference/draft/job/delivery ownership key. */
export function buildLineVideoConversationKey(params: {
  accountId: string;
  conversationId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const conversationId = normalizeLineVideoConversationId(params.conversationId);
  return accountId && conversationId ? `${accountId}|${conversationId}` : null;
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
