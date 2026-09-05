import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { expect, vi } from "vitest";
import type { ActiveConversationContext } from "./conversation-context.js";
import {
  CloudbathConversationRouter,
  type ConversationTurnResolution,
} from "./conversation-router.js";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import type { ConversationTranscriptReader } from "./conversation-transcript.js";
import {
  CloudbathPrevisLineRouter,
  type PrevisDedupeStore,
  type PrevisProjectResolver,
  type ActivePrevisContext,
} from "./previs-line-router.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisArtifactSink, type PrevisEngine } from "./previs-store.js";
import type { PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import type { StoryboardModelSelectionStore } from "./storyboard-confirmation.js";
import type { StoryboardDirectorSession } from "./storyboard-director.js";
import { isExplicitPrevisRequest } from "./storyboard-intent.js";
import {
  CloudbathStoryboardLineRouter,
  type StoryboardDedupeStore,
  type StoryboardLineRouterDeps,
  type StoryboardProjectResolver,
} from "./storyboard-line-router.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import type { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { StoryboardStore } from "./storyboard-store.js";
import type {
  ActiveStoryboardContext,
  StoryboardFinalVideoDraft,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import type { StoryboardVisualService } from "./storyboard-visual.js";
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
/** Another member of the SAME LINE group, sharing its session key. */
export const OTHER_MEMBER = "U1111111111";
export const OWNER_SENDER_ID = OWNER;
/** The session this LINE conversation's transcript lives under. */
export const SESSION_KEY = `line:group:${GROUP}`;
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

export type StoryboardLogFn = (event: string, fields?: Record<string, unknown>) => void;

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
  source: "conversation" | "character" | "storyboard" | "previs" | "model";
  handled: boolean;
  text?: string;
  /** How arbitration read the turn, for suites that assert the ladder itself. */
  conversation?: ConversationTurnResolution;
  /** Controls attached to the reply, when the handler left a question open. */
  presentation?: MessagePresentation;
};

export function harness(
  options: {
    resolver?: StoryboardProjectResolver;
    logger?: { info?: StoryboardLogFn; warn: StoryboardLogFn };
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
    /**
     * Enables the post-freeze model conversation. Opt-in like `draftScopes`:
     * without it `ยืนยัน Storyboard` resolves no store and stays unclaimed,
     * which is what the suites that never reach model selection assert.
     */
    modelSelection?: StoryboardModelSelectionStore;
    ugcCapabilities?: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    planner?: StoryboardLlmPlanner;
    /** Absent, arbitration stops after its deterministic steps. */
    semanticResolver?: ConversationSemanticResolver;
    /** `null` models a LINE conversation this workspace policy does not bind. */
    binding?: { policyId: string; boundByOwnerId: string } | null;
    /** Recent dialogue for the semantic step. Absent, it runs on state alone. */
    transcript?: ConversationTranscriptReader;
    /**
     * Stands where the Character/image workflow sits in the real chain, so a
     * suite can prove a turn REACHED it rather than only that arbitration did
     * not answer it wrongly.
     */
    characterHandler?: (content: string) => Promise<{ handled: true; text?: string } | undefined>;
    /** Character Library names, for the entity-matching cases. */
    resolverNames?: readonly string[];
    /** Models a 1:1 chat, where the session provably has one human sender. */
    directChat?: boolean;
    /** Enables authoritative per-shot visuals; absent, the flow has none. */
    visuals?: StoryboardVisualService;
    sendVisualImage?: StoryboardLineRouterDeps["sendVisualImage"];
    /** Stands where the media store proves an EXPLICIT first-frame choice. */
    resolveSelectedSourceImage?: StoryboardLineRouterDeps["resolveSelectedSourceImage"];
    publicAssetBaseUrl?: string;
  } = {},
) {
  const shared =
    options.resolver ??
    resolver(
      options.resolverNames ? { listCharacterNames: async () => options.resolverNames! } : {},
    );
  const storyboardVersions = mem<StoryboardVersion>();
  const storyboardHeads = mem<StoryboardHead>();
  const drafts = mem<StoryboardFinalVideoDraft>();
  const active = mem<ActiveStoryboardContext>();
  const director = mem<StoryboardDirectorSession>();
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
  // ONE binding for both routers. They are two halves of the same policy
  // decision, so a harness that bound them differently could prove a routing
  // outcome the product cannot actually produce.
  const binding =
    options.binding === undefined ? { policyId: "UGC", boundByOwnerId: OWNER } : options.binding;
  const storyboardRouter = new CloudbathStoryboardLineRouter({
    store,
    resolver: shared,
    active,
    drafts,
    director,
    dedupe,
    registry: { lookup: async () => binding },
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    randomId: () => `draft-${(nextDraft += 1)}`,
    paidDraftRuntime: options.paidDraftRuntime ?? null,
    ...(options.planner ? { planner: options.planner } : {}),
    ...(options.draftScopes ? { draftScopes: options.draftScopes } : {}),
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.ugcCapabilities ? { ugcCapabilities: options.ugcCapabilities } : {}),
    ...(options.visuals ? { visuals: options.visuals } : {}),
    ...(options.sendVisualImage ? { sendVisualImage: options.sendVisualImage } : {}),
    ...(options.resolveSelectedSourceImage
      ? { resolveSelectedSourceImage: options.resolveSelectedSourceImage }
      : {}),
    ...(options.publicAssetBaseUrl ? { publicAssetBaseUrl: options.publicAssetBaseUrl } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const conversationContext = mem<ActiveConversationContext>();
  let nextNonce = 0;
  const conversationRouter = new CloudbathConversationRouter({
    context: conversationContext,
    registry: { lookup: async () => binding },
    active,
    director,
    resolver: shared,
    resolveStoryboardReferent: async (params) =>
      await storyboardRouter.resolveStoryboardReferent(params),
    isStoryboardRevisionCandidate: async (params) =>
      await storyboardRouter.isStoryboardRevisionCandidate(params),
    paidDraftRuntime: options.paidDraftRuntime ?? null,
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    randomId: () => `nonce${(nextNonce += 1)}0000`,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.semanticResolver ? { semanticResolver: options.semanticResolver } : {}),
    ...(options.transcript ? { transcript: options.transcript } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  /** The plugin's real before_dispatch order. */
  const dispatch = async (
    content: string,
    over: { messageId?: string; senderId?: string; senderIsOwner?: boolean } = {},
  ): Promise<DispatchOutcome> => {
    const event = {
      content,
      senderId: over.senderId ?? OWNER,
      // A different sender in the SAME group is not the bound owner, which is
      // exactly what production resolves from the LINE webhook.
      senderIsOwner: over.senderIsOwner ?? (over.senderId ?? OWNER) === OWNER,
      isGroup: !options.directChat,
      ...(over.messageId ? { messageId: over.messageId } : {}),
    };
    const ctx = {
      channelId: "line",
      accountId: ACCOUNT,
      conversationId: GROUP,
      sessionKey: SESSION_KEY,
      agentId: "main",
    };
    const conversation = await conversationRouter.resolveTurn(event, ctx);
    if (conversation.kind === "answer" || conversation.kind === "clarify") {
      return { source: "conversation", handled: true, text: conversation.text, conversation };
    }
    if (conversation.kind === "route") {
      const routed = await storyboardRouter.handleContextualRoute(conversation.route, event, ctx);
      if (routed) {
        const presentation = await conversationRouter.observeHandledTurn(event, ctx);
        return {
          source: "storyboard",
          ...routed,
          conversation,
          ...(presentation ? { presentation } : {}),
        };
      }
    }
    const routedEvent =
      conversation.kind === "rewrite" ? { ...event, content: conversation.canonicalText } : event;
    // Mirrors index.ts: the Character/image workflow is the first handler after
    // arbitration, so a turn arbitration declined reaches it before storyboard.
    const characterResult = await options.characterHandler?.(routedEvent.content);
    if (characterResult) {
      return { source: "character", ...characterResult, conversation };
    }
    let storyboardResult = await storyboardRouter.handleBeforeDispatch(routedEvent, ctx);
    // Mirrors index.ts: a rewrite the target handler declined must not swallow
    // the owner's own message.
    if (!storyboardResult && conversation.kind === "rewrite") {
      storyboardResult = await storyboardRouter.handleBeforeDispatch(event, ctx);
    }
    if (storyboardResult) {
      const presentation = await conversationRouter.observeHandledTurn(routedEvent, ctx);
      return {
        source: "storyboard",
        ...storyboardResult,
        conversation,
        ...(presentation ? { presentation } : {}),
      };
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
      return { source: "previs", ...previsResult, conversation };
    }
    return { source: "model", handled: false, conversation };
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
    /** The trusted triple every store in this harness is scoped to. */
    claim: { accountId: ACCOUNT, lineGroupId: GROUP, ownerSenderId: OWNER },
    dedupe,
    dispatch,
    conversationRouter,
    conversationContext,
    modelSelection: options.modelSelection,
    latest,
    versionAt,
    store,
    active,
    director,
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
