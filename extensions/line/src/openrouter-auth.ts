/**
 * Canonical OpenRouter credential resolution for every LINE surface.
 *
 * All LINE OpenRouter callers must resolve through here rather than through
 * the agent tool context's `resolveApiKeyForProvider`. That context closure is
 * built only when an authProfileStore is supplied
 * (src/agents/openclaw-plugin-tools.ts:99) and resolves solely via
 * resolveApiKeyForProfile, which reads `store.profiles[profileId]` and nothing
 * else (src/agents/auth-profiles/oauth.ts:342) -- so a deployment that holds
 * OpenRouter credentials in env or config, rather than a saved auth profile,
 * gets `undefined` from it. That mismatch is what made the LINE video draft
 * fail with a provider-auth error while the switch routers, which already used
 * this canonical path, kept working. Keeping one helper means a future LINE
 * OpenRouter surface cannot reintroduce the split.
 */
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export const LINE_OPENROUTER_PROVIDER_ID = "openrouter";

/** Resolves a provider API key through env, config, and auth profiles. */
export async function resolveLineProviderApiKey(
  providerId: string = LINE_OPENROUTER_PROVIDER_ID,
): Promise<string | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg: getRuntimeConfig(),
    agentDir: resolveOpenClawAgentDir(),
  });
  return auth.apiKey;
}
