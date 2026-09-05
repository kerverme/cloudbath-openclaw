/**
 * Store wiring for the storyboard LINE router.
 *
 * Kept out of the plugin entry so the namespace/overflow decisions — which are
 * a durability contract, not plugin bootstrap — live next to the router that
 * depends on them.
 */

import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import {
  STORYBOARD_CONFIRMATION_NAMESPACE,
  STORYBOARD_CONFIRMATION_TTL_MS,
  type StoryboardModelSelectionState,
} from "./storyboard-confirmation.js";
import {
  CLOUDBATH_STORYBOARD_DIRECTOR_NAMESPACE,
  CLOUDBATH_STORYBOARD_DIRECTOR_TTL_MS,
  type StoryboardDirectorSession,
} from "./storyboard-director.js";
import {
  CloudbathStoryboardLineRouter,
  type StoryboardProjectResolver,
  type StoryboardLineRouterDeps,
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
  StoryboardAccessClaim,
  StoryboardFinalVideoDraft,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import type { StoryboardVisualService } from "./storyboard-visual.js";
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

/**
 * The three stores that say where a conversation currently stands: the
 * half-answered request, the post-freeze model step, and which storyboard is
 * being worked on.
 *
 * Extracted because the conversation layer derives its open question from
 * exactly these rows. Re-declaring their namespaces and expiry there would make
 * "what is open?" answerable two ways, which is the one thing arbitration
 * cannot tolerate.
 */
export function openStoryboardConversationStores(state: StoryboardStateApi): Readonly<{
  active: AsyncKeyedStore<ActiveStoryboardContext>;
  director: AsyncKeyedStore<StoryboardDirectorSession>;
  modelSelection: AsyncKeyedStore<StoryboardModelSelectionState>;
}> {
  return {
    // Bounded on purpose. "สร้างวิดีโอ" and bare time-range edits are only
    // claimed while a storyboard is active, so an active record that never
    // expired would intercept those phrases forever and leave the owner with
    // no route back to the existing paid flow. Versions themselves are durable
    // and unaffected; only the "what am I editing right now" pointer ages out.
    active: state.openKeyedStore<ActiveStoryboardContext>({
      namespace: CLOUDBATH_STORYBOARD_ACTIVE_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: CLOUDBATH_STORYBOARD_ACTIVE_TTL_MS,
    }),
    // An unanswered request is a conversation, not a record: it must age out
    // quickly so a stale question cannot claim a reply the owner meant for
    // something else, and it must never refuse new rows and wedge the flow.
    director: state.openKeyedStore<StoryboardDirectorSession>({
      namespace: CLOUDBATH_STORYBOARD_DIRECTOR_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: CLOUDBATH_STORYBOARD_DIRECTOR_TTL_MS,
    }),
    // The post-freeze model conversation. Transient like the director's: a
    // stale step must never claim a reply the owner meant for something else.
    modelSelection: state.openKeyedStore<StoryboardModelSelectionState>({
      namespace: STORYBOARD_CONFIRMATION_NAMESPACE,
      maxEntries: CLOUDBATH_STORYBOARD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: STORYBOARD_CONFIRMATION_TTL_MS,
    }),
  };
}

/**
 * How recently an inbound image still counts as "the image I just sent".
 *
 * Long enough to describe a scene after sending a photo, short enough that
 * yesterday's picture can never quietly become today's first frame.
 */
export const SOURCE_IMAGE_SELECTION_WINDOW_MS = 30 * 60 * 1_000;

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
  visuals?: StoryboardVisualService;
  publicAssetBaseUrl?: string;
  sendVisualImage?: StoryboardLineRouterDeps["sendVisualImage"];
  /**
   * Proves the owner explicitly put an image in THIS conversation.
   *
   * Read from the durable inbound-image record the character workflow already
   * captures, keyed by the same trusted triple — never a scan for the newest
   * image anywhere. Absent, the storyboard flow asks instead of guessing.
   */
  readLatestInboundImage?: (
    claim: StoryboardAccessClaim,
  ) => Promise<Readonly<{ durableMediaKey: string; sourceReceivedAt: string }> | undefined>;
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
    ...openStoryboardConversationStores(deps.state),
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
    ...(deps.visuals ? { visuals: deps.visuals } : {}),
    ...(deps.publicAssetBaseUrl ? { publicAssetBaseUrl: deps.publicAssetBaseUrl } : {}),
    ...(deps.sendVisualImage ? { sendVisualImage: deps.sendVisualImage } : {}),
    ...(deps.draftScopes ? { draftScopes: deps.draftScopes } : {}),
    ...(deps.ugcCapabilities ? { ugcCapabilities: deps.ugcCapabilities } : {}),
    ...(deps.readLatestInboundImage
      ? {
          resolveSelectedSourceImage: async (claim: StoryboardAccessClaim) => {
            const record = await deps.readLatestInboundImage?.(claim).catch(() => undefined);
            if (!record) {
              return { kind: "none" as const };
            }
            // Bounded on purpose. "Use the image I sent" means the one they just
            // sent; an image from hours ago is a different intention, and
            // adopting it silently is the wrong-content failure this branch
            // exists to avoid. A stale record asks again instead.
            const age = now() - Date.parse(record.sourceReceivedAt);
            return Number.isFinite(age) && age >= 0 && age <= SOURCE_IMAGE_SELECTION_WINDOW_MS
              ? { kind: "selected" as const, mediaId: record.durableMediaKey }
              : { kind: "none" as const };
          },
        }
      : {}),
  });
}
