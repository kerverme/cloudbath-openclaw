/**
 * Store wiring for the storyboard LINE router.
 *
 * Kept out of the plugin entry so the namespace/overflow decisions — which are
 * a durability contract, not plugin bootstrap — live next to the router that
 * depends on them.
 */

import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import {
  CloudbathStoryboardLineRouter,
  type StoryboardProjectResolver,
} from "./storyboard-line-router.js";
import type { StoryboardLlmPlanner } from "./storyboard-planner.js";
import {
  CLOUDBATH_STORYBOARD_ACTIVE_NAMESPACE,
  CLOUDBATH_STORYBOARD_ACTIVE_TTL_MS,
  CLOUDBATH_STORYBOARD_DEDUPE_NAMESPACE,
  CLOUDBATH_STORYBOARD_DRAFT_NAMESPACE,
  CLOUDBATH_STORYBOARD_HEAD_NAMESPACE,
  CLOUDBATH_STORYBOARD_MAX_ENTRIES,
  CLOUDBATH_STORYBOARD_VERSION_NAMESPACE,
  StoryboardStore,
} from "./storyboard-store.js";
import type {
  ActiveStoryboardContext,
  StoryboardFinalVideoDraft,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import type {
  AsyncKeyedStore,
  FrozenUgcVideoScope,
  NotionTarget,
  SafeLogger,
  UgcCapabilityId,
} from "./types.js";

/** The subset of the plugin state API this wiring needs. */
export type StoryboardStateApi = Readonly<{
  openKeyedStore<T>(options: {
    namespace: string;
    maxEntries: number;
    overflowPolicy: "evict-oldest" | "reject-new";
    defaultTtlMs?: number;
  }): AsyncKeyedStore<T>;
}>;

export function createCloudbathStoryboardLineRouter(deps: {
  state: StoryboardStateApi;
  resolver: StoryboardProjectResolver;
  workspaceRegistry: LineGroupWorkspacePolicyRegistry;
  logger: SafeLogger;
  now?: () => number;
  /**
   * The SAME store the UGC tool path freezes a confirmed draft's scope in, so
   * the LINE confirmation gate finds a storyboard draft's scope exactly where
   * it already looks. Omitted, a storyboard draft is still prepared but cannot
   * be confirmed in a UGC-bound group.
   */
  draftScopes?: AsyncKeyedStore<FrozenUgcVideoScope>;
  ugcCapabilities?: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  planner?: StoryboardLlmPlanner;
}): CloudbathStoryboardLineRouter {
  const now = deps.now ?? Date.now;
  return new CloudbathStoryboardLineRouter({
    // History is immutable and outlives any scope window: an owner comparing v1
    // against v3 must still find v1, so these namespaces reject new rows at the
    // limit instead of evicting. "evict-oldest" removes the oldest row in the
    // NAMESPACE, which would silently drop v1 of a live storyboard whose head
    // still references it.
    store: new StoryboardStore({
      heads: deps.state.openKeyedStore<StoryboardHead>({
        namespace: CLOUDBATH_STORYBOARD_HEAD_NAMESPACE,
        maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }),
      versions: deps.state.openKeyedStore<StoryboardVersion>({
        namespace: CLOUDBATH_STORYBOARD_VERSION_NAMESPACE,
        maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }),
      now,
    }),
    resolver: deps.resolver,
    // Bounded on purpose. "สร้างวิดีโอ" and bare time-range edits are only
    // claimed while a storyboard is active, so an active record that never
    // expired would intercept those phrases forever and leave the owner with
    // no route back to the existing paid flow. Versions themselves are durable
    // and unaffected; only the "what am I editing right now" pointer ages out.
    active: deps.state.openKeyedStore<ActiveStoryboardContext>({
      namespace: CLOUDBATH_STORYBOARD_ACTIVE_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: CLOUDBATH_STORYBOARD_ACTIVE_TTL_MS,
    }),
    // A prepared draft is a transient review artifact, not history: it can be
    // re-prepared from the storyboard at any time. Evicting the oldest is
    // therefore correct, and unlike the version chain it must never be able to
    // wedge the flow by refusing new rows.
    drafts: deps.state.openKeyedStore<StoryboardFinalVideoDraft>({
      namespace: CLOUDBATH_STORYBOARD_DRAFT_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
    }),
    dedupe: deps.state.openKeyedStore<{ reply: string }>({
      namespace: CLOUDBATH_STORYBOARD_DEDUPE_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
    }),
    registry: {
      lookup: async (accountId, groupId) => await deps.workspaceRegistry.lookup(accountId, groupId),
    },
    now,
    logger: deps.logger,
    ...(deps.planner ? { planner: deps.planner } : {}),
    ...(deps.draftScopes ? { draftScopes: deps.draftScopes } : {}),
    ...(deps.ugcCapabilities ? { ugcCapabilities: deps.ugcCapabilities } : {}),
  });
}
