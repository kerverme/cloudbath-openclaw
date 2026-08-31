import { expect, vi } from "vitest";
import {
  CloudbathPrevisLineRouter,
  type PrevisDedupeStore,
  type PrevisProjectResolver,
  type ActivePrevisContext,
} from "./previs-line-router.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisArtifactSink, type PrevisEngine } from "./previs-store.js";
import type { PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import { isExplicitPrevisRequest } from "./storyboard-intent.js";
import {
  CloudbathStoryboardLineRouter,
  type StoryboardDedupeStore,
  type StoryboardProjectResolver,
} from "./storyboard-line-router.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardStore } from "./storyboard-store.js";
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
  UgcCapabilityId,
  UgcCharacterLock,
} from "./types.js";

/**
 * Shared fixtures for the storyboard routing suites.
 *
 * `harness().dispatch()` reproduces the plugin's real `before_dispatch` order —
 * storyboard, then previs, then the model — so every routing assertion is about
 * the ordering production actually uses, not a router in isolation.
 */

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
export const NAMES = ["Twong", "Twong2"] as const;

/** The canonical production request this phase must support. */
export const CREATE_MESSAGE =
  "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ ในร้านกาแฟ แนวตั้ง";

const lock = (code: string, pageId: string): UgcCharacterLock =>
  Object.freeze({
    code,
    pageId,
    identityReferences: Object.freeze([
      Object.freeze({ kind: "identity", source: "r2", locator: `ugc/${pageId}.png` } as const),
    ]),
    styleReferences: Object.freeze([]),
    frozenAt: "2026-08-30T00:00:00.000Z",
  });

export type LoggerWarn = (event: string, fields?: Record<string, unknown>) => void;

function mem<T>(): AsyncKeyedStore<T> {
  const m = new Map<string, T>();
  return {
    register: async (k, v) => void m.set(k, v),
    registerIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    lookup: async (k) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function dedupeStore(): StoryboardDedupeStore & PrevisDedupeStore {
  const m = new Map<string, { reply: string }>();
  return { lookup: async (k) => m.get(k), register: async (k, v) => void m.set(k, v) };
}

/**
 * Production-shaped resolver: the display name is NEVER the canonical id.
 *
 * "Twong" resolves to CHAR-6 and "Twong2" to CHAR-7, so any code path that
 * leaks a display name into an identity field fails loudly here.
 */
export function resolver(
  overrides: Partial<PrevisProjectResolver> = {},
): StoryboardProjectResolver {
  const locks = [lock("CHAR-6", "page-char-6"), lock("CHAR-7", "page-char-7")];
  const displayNames = { "CHAR-6": "Twong", "CHAR-7": "Twong2" } as const;
  return {
    listCharacterNames: async () => NAMES,
    resolveProject: async ({ characterNames }) => ({
      projectInstanceId: "proj-instance-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-1",
      scenePageId: "page-scene-1",
      characterLocks: locks.slice(0, Math.max(1, characterNames.length)),
      displayNames,
    }),
    readProjectCast: async () => ({ characterLocks: locks, displayNames }),
    ...overrides,
  };
}

type DispatchOutcome = {
  source: "storyboard" | "previs" | "model";
  handled: boolean;
  text?: string;
};

export function harness(
  options: {
    resolver?: StoryboardProjectResolver;
    logger?: { warn: LoggerWarn };
    /** Makes the storyboard dedupe write fail, without touching creation. */
    failDedupeWrite?: boolean;
    /**
     * The LINE-owned paid-draft runtime. Left undefined the router resolves the
     * installed one; null models a build with no LINE plugin, which is the
     * provider-neutral behaviour every existing suite asserts.
     */
    paidDraftRuntime?: StoryboardPaidDraftRuntime | null;
    /** Enables the workspace-scope freeze the LINE confirmation gate reads. */
    draftScopes?: AsyncKeyedStore<FrozenUgcVideoScope>;
    ugcCapabilities?: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  } = {},
) {
  const shared = options.resolver ?? resolver();
  const storyboardVersions = mem<StoryboardVersion>();
  const storyboardHeads = mem<StoryboardHead>();
  const drafts = mem<StoryboardFinalVideoDraft>();
  const active = mem<ActiveStoryboardContext>();
  const store = new StoryboardStore({
    heads: storyboardHeads,
    versions: storyboardVersions,
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
  });

  // A real previs router sits behind storyboard, with spies on the only two
  // things a previs create would touch: the CozyClay engine and the R2 sink.
  const previsEngineCalls = vi.fn();
  const previsEngine: PrevisEngine = {
    renderProjectArtifact: async () => {
      previsEngineCalls();
      return JSON.stringify({ app: "cozyclay", kind: "project", version: 2 });
    },
  };
  const previsArtifactCalls = vi.fn();
  const previsArtifacts: PrevisArtifactSink = {
    putPrivateArtifact: async () => void previsArtifactCalls(),
  };
  const previsVersions = mem<PrevisVersion>();
  const previsStore = new PrevisStore({
    heads: mem<PrevisProjectHead>(),
    versions: previsVersions,
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    artifactKeyPrefix: "previs/cozyclay",
  });
  const previsRouter = new CloudbathPrevisLineRouter({
    service: new CloudbathPrevisService(
      previsStore,
      "https://cloudbath.example",
      previsEngine,
      previsArtifacts,
    ),
    resolver: shared,
    active: mem<ActivePrevisContext>(),
    dedupe: dedupeStore(),
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
  });

  let nextDraft = 0;
  const baseDedupe = dedupeStore();
  const dedupe: StoryboardDedupeStore = options.failDedupeWrite
    ? {
        lookup: baseDedupe.lookup,
        register: async () => {
          throw new Error("plugin state write failed");
        },
      }
    : baseDedupe;
  const storyboardRouter = new CloudbathStoryboardLineRouter({
    store,
    resolver: shared,
    active,
    drafts,
    dedupe,
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    randomId: () => `draft-${(nextDraft += 1)}`,
    paidDraftRuntime: options.paidDraftRuntime ?? null,
    ...(options.draftScopes ? { draftScopes: options.draftScopes } : {}),
    ...(options.ugcCapabilities ? { ugcCapabilities: options.ugcCapabilities } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  /** The plugin's real before_dispatch order. */
  const dispatch = async (
    content: string,
    over: { messageId?: string; senderId?: string } = {},
  ): Promise<DispatchOutcome> => {
    const event = {
      content,
      senderId: over.senderId ?? OWNER,
      senderIsOwner: true,
      isGroup: true,
      ...(over.messageId ? { messageId: over.messageId } : {}),
    };
    const ctx = { channelId: "line", accountId: ACCOUNT, conversationId: GROUP };
    const storyboardResult = await storyboardRouter.handleBeforeDispatch(event, ctx);
    if (storyboardResult) {
      return { source: "storyboard", ...storyboardResult };
    }
    // Mirrors index.ts: previs answers an explicit request, or anything at all
    // while no storyboard is active. Calling it unconditionally would let the
    // harness pass while production sent declined messages into CozyClay.
    const previsMayAnswer =
      isExplicitPrevisRequest(content) || !(await storyboardRouter.hasActiveStoryboard(event, ctx));
    const previsResult = previsMayAnswer
      ? await previsRouter.handleBeforeDispatch(event, ctx)
      : undefined;
    if (previsResult) {
      return { source: "previs", ...previsResult };
    }
    return { source: "model", handled: false };
  };

  const latest = async (): Promise<StoryboardVersion> => {
    const context = await active.lookup(`storyboard-active:${ACCOUNT}:${GROUP}:${OWNER}`);
    const version = await store.readLatest({
      storyboardId: context!.storyboardId,
      claim: { accountId: ACCOUNT, lineGroupId: GROUP, ownerSenderId: OWNER },
    });
    return version!;
  };

  const versionAt = async (n: number): Promise<StoryboardVersion | undefined> => {
    const context = await active.lookup(`storyboard-active:${ACCOUNT}:${GROUP}:${OWNER}`);
    return await store.readVersion({
      storyboardId: context!.storyboardId,
      claim: { accountId: ACCOUNT, lineGroupId: GROUP, ownerSenderId: OWNER },
      versionNumber: n,
    });
  };

  return {
    dedupe,
    dispatch,
    latest,
    versionAt,
    store,
    active,
    drafts,
    storyboardRouter,
    previsEngineCalls,
    previsArtifactCalls,
    previsVersions,
    storyboardVersions,
  };
}

/**
 * Asserts nothing billable happened, using signals that can actually fail.
 *
 * An earlier version created `vi.fn()` spies that were wired to nothing, so the
 * assertion was vacuous. These four are real: the CozyClay engine and the R2
 * artifact sink are the only I/O a previs create performs, and a paid job needs
 * a draft the LINE gate can resolve.
 */
export async function expectNothingBillable(h: {
  previsEngineCalls: { mock: { calls: unknown[] } };
  previsArtifactCalls: { mock: { calls: unknown[] } };
  previsVersions: AsyncKeyedStore<PrevisVersion>;
  drafts: AsyncKeyedStore<StoryboardFinalVideoDraft>;
}): Promise<void> {
  expect(h.previsEngineCalls).not.toHaveBeenCalled();
  expect(h.previsArtifactCalls).not.toHaveBeenCalled();
  expect((await h.previsVersions.entries()).length).toBe(0);
  for (const { value } of await h.drafts.entries()) {
    // A draft the paid gate could resolve would need a `ready` confirmation.
    expect(value.confirmation).toEqual({ kind: "deferred" });
  }
}
