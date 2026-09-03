/**
 * Re-quoting the ACTIVE storyboard against a newly chosen video model.
 *
 * The owner changes the video model in the LINE plugin; the storyboard they are
 * iterating on lives here. This module is the whole of what that crossing needs
 * — it opens no new store, mints no code, and calls no provider. The draft goes
 * through `prepareStoryboardFinalVideoDraftWithOutcome`, which is the same path
 * `สร้างวิดีโอ` uses, so the LINE allocator remains the only source of a
 * `VIDEO ####` code and its supersede is the only thing that retires one.
 *
 * Nothing here retires the previous code. Superseding happens inside the LINE
 * allocator, and only once a replacement draft has actually been allocated, so
 * a refused re-quote leaves the owner's last payable code exactly as it was.
 */

import { buildStoryboardDraftScope } from "./storyboard-draft-scope.js";
import type {
  StoryboardPaidDraftResult,
  StoryboardPaidDraftRuntime,
} from "./storyboard-paid-draft-runtime.js";
import { activeStoryboardKey, StoryboardStore } from "./storyboard-store.js";
import type {
  ActiveStoryboardContext,
  StoryboardAccessClaim,
  StoryboardFinalVideoDraft,
} from "./storyboard-types.js";
import {
  prepareStoryboardFinalVideoDraftWithOutcome,
  type PrepareFinalVideoDraftParams,
} from "./storyboard-video-plan.js";
import type {
  AsyncKeyedStore,
  FrozenUgcVideoScope,
  NotionTarget,
  UgcCapabilityId,
} from "./types.js";
import { ugcDraftScopeKey } from "./ugc-workflow.js";

/**
 * A single field the newly chosen model cannot satisfy.
 *
 * The owner is asked about exactly this field and nothing else: silently
 * changing a length or dropping audio would alter the video they approved.
 */
export type StoryboardRequoteIncompatibility = Readonly<{
  kind: "duration" | "resolution" | "aspectRatio" | "audio";
  requested: string;
  supported: readonly string[];
}>;

export type StoryboardRequoteResult =
  | Readonly<{ kind: "created"; draft: StoryboardFinalVideoDraft; code: string }>
  | Readonly<{ kind: "no_active_storyboard" }>
  | Readonly<{ kind: "incompatible"; incompatibility: StoryboardRequoteIncompatibility }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Owner-chosen adjustments applied to the re-quote, one field at a time. */
export type StoryboardRequoteOverrides = Readonly<{
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  /** The scene's three-way audio decision, not a boolean. */
  audio?: "off" | "ambient" | "full";
}>;

export type StoryboardRequoteDeps = Readonly<{
  store: StoryboardStore;
  active: AsyncKeyedStore<ActiveStoryboardContext>;
  drafts: PrepareFinalVideoDraftParams["drafts"];
  now: () => number;
  randomId?: PrepareFinalVideoDraftParams["randomId"];
  /** Defaults to the installed LINE runtime; injected in tests. */
  paidDraftRuntime?: StoryboardPaidDraftRuntime | null;
  draftScopes?: AsyncKeyedStore<FrozenUgcVideoScope>;
  ugcCapabilities?: Readonly<Record<UgcCapabilityId, NotionTarget>>;
}>;

/** A scalar the owner can read back; anything else is not worth showing. */
function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function scalarList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(scalarText).filter((entry) => entry.length > 0) : [];
}

/** Maps the LINE allocator's typed refusal onto the field to ask the owner about. */
function readIncompatibility(
  paid: StoryboardPaidDraftResult | undefined,
): StoryboardRequoteIncompatibility | undefined {
  if (!paid || paid.kind !== "rejected") {
    return undefined;
  }
  const field = (
    {
      unsupported_duration: "duration",
      unsupported_resolution: "resolution",
      unsupported_aspect_ratio: "aspectRatio",
    } as const
  )[paid.reason as string];
  if (!field) {
    return undefined;
  }
  const rejection: Record<string, unknown> = paid;
  return {
    kind: field,
    requested: scalarText(rejection.requested),
    supported: scalarList(rejection.supported),
  };
}

/**
 * Re-prepares the owner's active storyboard, or reports why it cannot be.
 *
 * Returns `no_active_storyboard` rather than creating anything when the owner
 * has none: changing the model is then a preference change only, and a later
 * request picks it up.
 */
export async function requoteActiveStoryboardDraft(params: {
  claim: StoryboardAccessClaim;
  deliveryTo?: string;
  overrides?: StoryboardRequoteOverrides;
  deps: StoryboardRequoteDeps;
}): Promise<StoryboardRequoteResult> {
  const { claim, deps } = params;
  const active = await deps.active.lookup(activeStoryboardKey(claim));
  if (
    !active ||
    active.accountId !== claim.accountId ||
    active.lineGroupId !== claim.lineGroupId ||
    active.ownerSenderId !== claim.ownerSenderId
  ) {
    return { kind: "no_active_storyboard" };
  }
  const version = await deps.store
    .readLatest({ storyboardId: active.storyboardId, claim })
    .catch(() => undefined);
  if (!version) {
    return { kind: "no_active_storyboard" };
  }

  try {
    const { draft, paid } = await prepareStoryboardFinalVideoDraftWithOutcome({
      version,
      drafts: deps.drafts,
      now: deps.now,
      ...(deps.randomId ? { randomId: deps.randomId } : {}),
      ...(params.overrides ? { overrides: params.overrides } : {}),
      paid: {
        conversationId: claim.lineGroupId,
        deliveryTo: params.deliveryTo ?? `line:group:${claim.lineGroupId}`,
        ...(deps.paidDraftRuntime === undefined ? {} : { runtime: deps.paidDraftRuntime }),
      },
    });
    if (draft.confirmation.kind === "ready") {
      // Freeze the scope the paid gate validates, exactly as the storyboard
      // router does, so a code minted here is confirmable by the same gate.
      const scopes = deps.draftScopes;
      const capabilities = deps.ugcCapabilities;
      if (scopes && capabilities) {
        const scope = buildStoryboardDraftScope({
          draft,
          claim,
          capabilities,
          createdAt: new Date(deps.now()).toISOString(),
        });
        if (scope) {
          await scopes.register(ugcDraftScopeKey(draft.confirmation.code), scope);
        }
      }
      return { kind: "created", draft, code: draft.confirmation.code };
    }
    const incompatibility = readIncompatibility(paid);
    if (incompatibility) {
      return { kind: "incompatible", incompatibility };
    }
    return {
      kind: "unavailable",
      reason: paid?.kind === "rejected" ? paid.reason : "quote_unavailable",
    };
  } catch {
    return { kind: "unavailable", reason: "quote_unavailable" };
  }
}
