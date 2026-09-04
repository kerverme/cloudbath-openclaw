/**
 * Store wiring for the conversation layer.
 *
 * The context store is the only one this layer owns; the director,
 * model-selection and active-storyboard stores are the storyboard flow's own,
 * passed in rather than reopened, so both layers read one set of rows.
 */

import {
  CLOUDBATH_CONVERSATION_CONTEXT_NAMESPACE,
  CLOUDBATH_CONVERSATION_CONTEXT_TTL_MS,
  type ActiveConversationContext,
} from "./conversation-context.js";
import { CloudbathConversationRouter, type ConversationRouterDeps } from "./conversation-router.js";
import type { StoryboardStateApi } from "./storyboard-runtime.js";

export function createCloudbathConversationRouter(
  deps: Omit<ConversationRouterDeps, "context"> & { state: StoryboardStateApi },
): CloudbathConversationRouter {
  const { state, ...rest } = deps;
  return new CloudbathConversationRouter({
    ...rest,
    // A conversation is transient by nature: the referent of "it" must age out,
    // and it must never refuse new rows and wedge arbitration for an owner.
    context: state.openKeyedStore<ActiveConversationContext>({
      namespace: CLOUDBATH_CONVERSATION_CONTEXT_NAMESPACE,
      maxEntries: 5_000,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: CLOUDBATH_CONVERSATION_CONTEXT_TTL_MS,
    }),
  });
}
