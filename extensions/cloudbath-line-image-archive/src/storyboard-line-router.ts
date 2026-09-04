/**
 * Deterministic LINE routing for the storyboard-first video flow.
 *
 * This runs in `before_dispatch` AHEAD of the previs router and returns
 * `{ handled: true }`, so a natural video request becomes a storyboard instead
 * of a previs — and cannot be answered by the model with a generic
 * confirmation. Explicit legacy previs requests are never claimed here, and an
 * edit or "สร้างวิดีโอ" is only claimed when this owner actually has an active
 * storyboard, so previs behaviour is unchanged when there is none.
 *
 * Nothing in this router is paid. Creating, editing, or preparing a Final Video
 * Draft performs no provider call and consumes no `VIDEO ####` code.
 */

import type { PrevisProjectResolver } from "./previs-line-router.js";
import { parseStoryboardAudioIntent } from "./storyboard-audio.js";
import { compileStoryboardDocument } from "./storyboard-compiler.js";
import {
  isStoryboardConfirmation,
  parseStoryboardModelAnswer,
  storyboardModelSelectionKey,
  type StoryboardModelSelectionState,
  type StoryboardModelSelectionStore,
} from "./storyboard-confirmation.js";
import {
  applyDirectorAnswer,
  closeDirectorSession,
  DIRECTOR_QUESTION,
  directorScenePrompt,
  nextDirectorSlot,
  openDirectorSession,
  ownsDirectorSession,
  parseDirectorAnswer,
  storyboardDirectorKey,
  type StoryboardDirectorSession,
} from "./storyboard-director.js";
import { buildStoryboardDraftScope } from "./storyboard-draft-scope.js";
import { formatFinalVideoDraftForLine, formatStoryboardForLine } from "./storyboard-format.js";
import { parseStoryboardIntent, type StoryboardIntent } from "./storyboard-intent.js";
import {
  formatStoryboardModelCandidates,
  formatStoryboardModelDefault,
  formatStoryboardModelFamilies,
  formatStoryboardModelVersions,
  type StoryboardModelFamilyOption,
  type StoryboardModelOption,
} from "./storyboard-model-reply.js";
import {
  tryGetStoryboardPaidDraftRuntime,
  type StoryboardPaidDraftRuntime,
  type StoryboardVideoRequirements,
} from "./storyboard-paid-draft-runtime.js";
import type { StoryboardLlmPlanner } from "./storyboard-planner.js";
import {
  isDurationTooLong,
  STORYBOARD_DEFAULT_ASPECT_RATIO,
  STORYBOARD_DEFAULT_DURATION_SECONDS,
  STORYBOARD_DEFAULT_RESOLUTION,
  STORYBOARD_MAX_DURATION_SECONDS,
} from "./storyboard-request.js";
import {
  requoteActiveStoryboardDraft,
  type StoryboardRequoteOverrides,
  type StoryboardRequoteResult,
} from "./storyboard-requote.js";
import {
  parseStoryboardRevision,
  readRevisionDuration,
  type StoryboardCastAddition,
  type StoryboardDocumentRevision,
} from "./storyboard-revision.js";
import { activeStoryboardKey, StoryboardStore } from "./storyboard-store.js";
import {
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_RESOLUTIONS,
  type ActiveStoryboardContext,
  type StoryboardAccessClaim,
  type StoryboardAspectRatio,
  type StoryboardCastMember,
  type StoryboardFinalVideoDraft,
  type StoryboardResolution,
  type StoryboardVersion,
} from "./storyboard-types.js";
import {
  prepareStoryboardFinalVideoDraft,
  type PrepareFinalVideoDraftParams,
} from "./storyboard-video-plan.js";
import type {
  AsyncKeyedStore,
  FrozenUgcVideoScope,
  NotionTarget,
  UgcCapabilityId,
  UgcCharacterLock,
} from "./types.js";
import { ugcDraftScopeKey } from "./ugc-workflow.js";

/** A retried webhook arrives within seconds; an hour is far past any retry window. */
const DEDUPE_TTL_MS = 60 * 60 * 1_000;

export type StoryboardDispatchEvent = {
  content: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isGroup?: boolean;
  messageId?: string;
};

/**
 * What the conversation layer resolved a deictic turn INTO.
 *
 * Two shapes only, both bounded: revise the storyboard already in play, or open
 * a fresh request for a cast that is already frozen. `request` is always the
 * owner's own message; `characterNames` always comes from resolved project
 * state. Nothing here is free-form, so nothing here can name a new action.
 */
export type StoryboardContextualRoute =
  | Readonly<{ kind: "revise_active_storyboard"; request: string }>
  | Readonly<{
      kind: "new_scene_request";
      request: string;
      characterNames: readonly string[];
      environment: string;
    }>;

export type StoryboardDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  /** Scopes the transcript read the conversation layer performs. */
  agentId?: string;
};

/**
 * The SAME production resolver previs uses.
 *
 * Reused rather than reimplemented so canonical Character ids, the frozen cast
 * lock and the real UGC project/scene lifecycle stay identical across both
 * flows; a second lookup would be a second source of identity truth.
 */
export type StoryboardProjectResolver = PrevisProjectResolver;

export type StoryboardDedupeStore = Readonly<{
  lookup(key: string): Promise<{ reply: string } | undefined>;
  register(key: string, value: { reply: string }, opts?: { ttlMs?: number }): Promise<void>;
}>;

export type StoryboardLineRouterDeps = Readonly<{
  store: StoryboardStore;
  resolver: StoryboardProjectResolver;
  active: AsyncKeyedStore<ActiveStoryboardContext>;
  drafts: AsyncKeyedStore<StoryboardFinalVideoDraft>;
  dedupe: StoryboardDedupeStore;
  registry: {
    lookup(
      accountId: string | undefined,
      groupId: string,
    ): Promise<{ policyId: string; boundByOwnerId: string } | null | undefined>;
  };
  now: () => number;
  randomId?: PrepareFinalVideoDraftParams["randomId"];
  /**
   * Injected only by tests. Left undefined, the paid handoff resolves the LINE
   * runtime itself; set to null it is disabled, which is how a build without
   * the LINE plugin behaves.
   */
  paidDraftRuntime?: StoryboardPaidDraftRuntime | null;
  planner?: StoryboardLlmPlanner;
  /**
   * Where an in-progress natural request waits for its missing answers.
   * Absent, the flow keeps its shipped behaviour: a request that names no
   * dimensions is simply not claimed.
   */
  director?: AsyncKeyedStore<StoryboardDirectorSession>;
  /**
   * Where the paid gate reads a confirmed draft's workspace scope. Absent, a
   * storyboard draft is still prepared but cannot be confirmed in a UGC group.
   */
  draftScopes?: AsyncKeyedStore<FrozenUgcVideoScope>;
  ugcCapabilities?: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  /**
   * Where the post-freeze model conversation keeps its step. Absent, the
   * storyboard still renders but confirming it is not offered.
   */
  modelSelection?: StoryboardModelSelectionStore;
  /**
   * Warning is required; `info` is optional so a narrow test double stays
   * valid. Routed-and-answered is ordinary operation and logs at info — only
   * a route that produced no reply is a warning, because that is the incident
   * shape this router exists to make visible.
   */
  logger?: {
    info?: (event: string, fields?: Record<string, unknown>) => void;
    warn: (event: string, fields?: Record<string, unknown>) => void;
  };
}>;

/**
 * What a frozen version needs from an endpoint.
 *
 * Derived once, here, so the default, both pickers and the eventual paid
 * request all judge the same scene rather than three similar derivations.
 */
function storyboardVideoRequirements(version: StoryboardVersion): StoryboardVideoRequirements {
  const document = version.document;
  return Object.freeze({
    durationSeconds: document.durationSeconds,
    aspectRatio: document.aspectRatio,
    resolution: document.resolution,
    audio: document.audio,
    spokenDialogue: document.beats.some((beat) => Boolean(beat.dialogue?.trim())),
    identityReferenceCount: version.characterLocks.reduce(
      (total, lock) => total + lock.identityReferences.length,
      0,
    ),
  });
}

const REPLY = {
  engineDown: "สร้าง Storyboard ไม่สำเร็จ กรุณาลองอีกครั้ง",
  emptyAction: "กรุณาระบุสิ่งที่ต้องการให้เกิดขึ้นในช่วงเวลานั้น",
  conflict: "มีการแก้ Storyboard พร้อมกัน กรุณาลองอีกครั้ง",
  missingVersion: "ไม่พบ Storyboard ล่าสุด กรุณาสร้างใหม่",
  directorCancelled: "ยกเลิกคำขอวิดีโอแล้ว",
  directorUnavailable: "ยังไม่สามารถรับคำขอแบบสนทนาได้ กรุณาระบุความยาว เช่น 10 วิ",
  noCompatibleModel:
    "ยังไม่มีโมเดลที่รองรับ Storyboard นี้ได้ (ความยาว/เสียง/ตัวละครอ้างอิง) กรุณาปรับ Storyboard",
} as const;

/**
 * Families in registry order, deduplicated.
 *
 * Derived from the compatible models themselves, so a family with nothing this
 * storyboard can run never appears as a choice that dead-ends.
 */
function uniqueFamilies(models: readonly StoryboardModelOption[]): StoryboardModelFamilyOption[] {
  const seen = new Map<string, StoryboardModelFamilyOption>();
  for (const model of models) {
    if (!seen.has(model.familyId)) {
      seen.set(model.familyId, { id: model.familyId, displayName: model.familyDisplayName });
    }
  }
  return [...seen.values()];
}

function castAddedReply(names: readonly string[]): string {
  return `"${names.join(", ")}" ยังไม่อยู่ในโปรเจกต์นี้ จึงเริ่มงานใหม่ให้แทน (โปรเจกต์เดิมยังอยู่)`;
}

function durationTooLongAnswerReply(seconds: number): string {
  return `${durationTooLongReply(seconds)} กรุณาระบุใหม่`;
}

function unknownCharacterReply(name: string): string {
  return `ไม่พบตัวละคร "${name}" ใน Character Library`;
}

function rangeOutsideReply(from: number, to: number, duration: number): string {
  return `ช่วงเวลา ${from}-${to} วิ อยู่นอกความยาว Storyboard ${duration} วิ`;
}

/** A reversed range is in bounds but backwards; saying "outside" misleads. */
function rangeReversedReply(from: number, to: number): string {
  return `ช่วงเวลา ${from}-${to} วิ กลับด้าน กรุณาระบุเวลาเริ่มก่อนเวลาจบ`;
}

function durationTooLongReply(seconds: number): string {
  return `ความยาว ${seconds} วิ เกินสูงสุด ${STORYBOARD_MAX_DURATION_SECONDS} วิ`;
}

/**
 * Intents that can append a version to the ACTIVE storyboard.
 *
 * Named because the paid-retirement check keys off it: a cast addition opens a
 * NEW storyboard rather than revising this one, and drafting or opening the
 * director changes no version at all, so neither may retire an outstanding
 * code.
 */
function revisesActiveStoryboard(intent: StoryboardIntent): boolean {
  return intent.kind === "edit" || intent.kind === "natural_edit" || intent.kind === "revision";
}

/** Native LINE group id, or undefined for anything that is not a group. */
function nativeGroupId(conversationId: string | undefined): string | undefined {
  const value = conversationId?.trim();
  if (!value) {
    return undefined;
  }
  const native = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  return /^[CR][0-9a-f]{32}$|^C[0-9A-Za-z]{5,}$/u.test(native) ? native : undefined;
}

/**
 * The trusted LINE identity triple, or undefined when the turn is not the
 * bound owner speaking in a bound conversation.
 *
 * Exported so the conversation layer scopes its context to exactly the same
 * triple the storyboard flow scopes its work to; a second derivation would be a
 * second answer to "whose conversation is this?".
 */
export function resolveStoryboardAccessClaim(
  event: StoryboardDispatchEvent,
  context: StoryboardDispatchContext,
): StoryboardAccessClaim | undefined {
  const lineGroupId = nativeGroupId(context.conversationId);
  const accountId = context.accountId?.trim();
  const ownerSenderId = event.senderId?.trim();
  if (!lineGroupId || !accountId || !ownerSenderId || event.senderIsOwner !== true) {
    return undefined;
  }
  return { accountId, lineGroupId, ownerSenderId };
}

function toAspectRatio(value: string | undefined): StoryboardAspectRatio {
  return (
    STORYBOARD_ASPECT_RATIOS.find((candidate) => candidate === value) ??
    STORYBOARD_DEFAULT_ASPECT_RATIO
  );
}

function toResolution(value: string | undefined): StoryboardResolution {
  return (
    STORYBOARD_RESOLUTIONS.find((candidate) => candidate === value) ?? STORYBOARD_DEFAULT_RESOLUTION
  );
}

/**
 * Frozen locks -> storyboard cast, in lock order.
 *
 * `characterId` is always the lock's canonical code. The display name is only
 * looked up for presentation and falls back to the code, so a missing name can
 * never promote a display string into the canonical identity.
 */
function buildCast(
  characterLocks: readonly UgcCharacterLock[],
  displayNames: Readonly<Record<string, string>>,
): readonly StoryboardCastMember[] {
  return Object.freeze(
    characterLocks.map((lock) =>
      Object.freeze({
        characterId: lock.code,
        characterPageId: lock.pageId,
        displayName: displayNames[lock.code] ?? lock.code,
      }),
    ),
  );
}

export class CloudbathStoryboardLineRouter {
  /**
   * Executions in flight, keyed by dedupe key.
   *
   * The durable dedupe record is only written AFTER execution, so two
   * simultaneous deliveries of the same inbound message both missed it and each
   * created a storyboard -- minting a second real Notion project and scene.
   * Duplicates now await the first execution and receive its reply.
   */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: StoryboardLineRouterDeps) {}

  /**
   * Handles a storyboard intent, or returns undefined to leave the turn alone.
   *
   * Returning undefined is what keeps previs and the paid confirmation gate
   * reachable, so every non-storyboard branch must return it untouched.
   */
  async handleBeforeDispatch(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const claim = this.trustedClaim(event, context);
    if (!claim) {
      return undefined;
    }
    const binding = await this.deps.registry.lookup(claim.accountId, claim.lineGroupId);
    if (binding?.policyId !== "UGC" || binding.boundByOwnerId !== claim.ownerSenderId) {
      return undefined;
    }

    // A pending question is answered before anything is classified, because the
    // answer ("10 วิ", "ไม่มี") is deliberately too weak to be an intent on its
    // own. An unrelated message still parses normally: only a reply that
    // actually answers the OPEN slot is claimed here.
    const openRequest = await this.readDirector(claim);
    if (openRequest) {
      const answered = await this.answerDirector(event, claim, openRequest);
      if (answered) {
        return { handled: true, text: answered };
      }
    }

    // Content confirmation and the model question that follows it are exact,
    // owner-scoped commands. They are claimed before intent parsing for the
    // same reason a pending director answer is: "ใช้ Default" and "2" are far
    // too weak to survive classification as intents.
    const modelStep = await this.readModelSelection(claim);
    if (modelStep) {
      const answered = await this.answerModelSelection(event, claim, modelStep);
      if (answered) {
        return { handled: true, text: answered };
      }
    }
    if (isStoryboardConfirmation(event.content ?? "")) {
      const confirmed = await this.confirmStoryboard(claim);
      return confirmed ? { handled: true, text: confirmed } : undefined;
    }

    const knownCharacterNames = await this.deps.resolver
      .listCharacterNames(claim)
      .catch(() => [] as readonly string[]);
    const intent = parseStoryboardIntent({ content: event.content ?? "", knownCharacterNames });
    if (!intent) {
      return undefined;
    }
    // An edit, revision or draft request without an active storyboard is not
    // ours: it must fall through so the existing previs routing keeps working.
    const active = await this.readActive(claim);
    if (intent.kind !== "create" && intent.kind !== "director_open" && !active) {
      return undefined;
    }
    // While a storyboard is active a bare natural request is ambiguous between
    // a tweak and new work, so it keeps its shipped behaviour of not being
    // claimed. The owner revises the active one, or names a cast to start new.
    if (intent.kind === "director_open" && (active || !this.deps.director)) {
      return undefined;
    }
    // With a storyboard already active, only an EXPLICIT casting instruction
    // starts a second one. Otherwise a follow-up tweak ("เอาแบบ 16:9 นะ Twong")
    // would mint another Notion project and scene and move the active pointer
    // off the storyboard the owner is iterating on.
    if (intent.kind === "create" && active && !intent.explicitCasting) {
      return undefined;
    }

    const dedupeKey = this.dedupeKey(event, context, claim);
    if (!dedupeKey) {
      return {
        handled: true,
        text: await this.executeAndRetire(intent, claim, active, context.conversationId),
      };
    }
    const seen = await this.deps.dedupe.lookup(dedupeKey);
    if (seen) {
      return { handled: true, text: seen.reply };
    }
    const running = this.inFlight.get(dedupeKey);
    if (running) {
      return { handled: true, text: await running };
    }
    const pending = this.executeAndRetire(intent, claim, active, context.conversationId).then(
      async (text) => {
        // A failed dedupe write must not discard a storyboard that WAS created:
        // rejecting here loses the owner's reply and leaves the retry free to
        // mint a second Notion project and scene.
        await this.deps.dedupe
          .register(dedupeKey, { reply: text }, { ttlMs: DEDUPE_TTL_MS })
          .catch((error: unknown) => {
            this.deps.logger?.warn("storyboard_dedupe_write_failed", {
              reason: error instanceof Error ? error.message : "unknown",
            });
          });
        return text;
      },
    );
    this.inFlight.set(dedupeKey, pending);
    try {
      return { handled: true, text: await pending };
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  /**
   * Runs one intent and retires the paid state if it moved the scene.
   *
   * A plainly worded revision reaches the router here rather than through the
   * contextual route, and it retires the outstanding code for exactly the same
   * reason: the owner was quoted for content that no longer exists.
   */
  private async executeAndRetire(
    intent: StoryboardIntent,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext | undefined,
    conversationId: string | undefined,
  ): Promise<string> {
    if (!active || !revisesActiveStoryboard(intent)) {
      return await this.execute(intent, claim, active);
    }
    const before = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    const text = await this.execute(intent, claim, active);
    await this.retireIfVersionAdvanced({
      claim,
      active,
      conversationId,
      beforeVersionNumber: before?.versionNumber,
    });
    return text;
  }

  private async execute(
    intent: StoryboardIntent,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext | undefined,
  ): Promise<string> {
    if (intent.kind === "create") {
      return await this.create(intent, claim);
    }
    if (intent.kind === "edit") {
      return await this.edit(intent, claim, active!);
    }
    if (intent.kind === "natural_edit") {
      return await this.naturalEdit(intent, claim, active!);
    }
    if (intent.kind === "director_open") {
      return await this.openDirector(intent, claim);
    }
    if (intent.kind === "revision") {
      return await this.revise(intent.revision, claim, active!);
    }
    return await this.prepareDraft(claim, active!);
  }

  private async create(
    intent: Extract<StoryboardIntent, { kind: "create" }>,
    claim: StoryboardAccessClaim,
  ): Promise<string> {
    // A named-but-unknown character fails closed: dropping it silently would
    // recast the scene without the owner realising.
    if (intent.unknownNames[0]) {
      return unknownCharacterReply(intent.unknownNames[0]);
    }
    if (isDurationTooLong(intent.durationSeconds)) {
      return durationTooLongReply(intent.durationSeconds!);
    }
    try {
      const resolved = await this.deps.resolver.resolveProject({
        claim,
        characterNames: intent.characterNames,
        scenePrompt: intent.scenePrompt,
        // A cast that ADDS someone the active project never froze is new work,
        // whatever phrasing named it, and the storyboard flow has no other way
        // to open a project. The workflow owns that judgement: it opens a new
        // project only when the request names someone new, and a strict subset
        // still fails loudly on the cast-lock guard. Gating this on
        // `explicitCasting` meant only "ใช้ X กับ Y" phrasing qualified, so
        // "เอา F99 ทำวิดีโอ ..." tried to CONTINUE a project frozen to another
        // cast and died on that guard instead of starting F99's own project.
        startNewProjectOnCastChange: true,
      });
      const cast = buildCast(resolved.characterLocks, resolved.displayNames);
      const durationSeconds = intent.durationSeconds ?? STORYBOARD_DEFAULT_DURATION_SECONDS;
      const planned = this.deps.planner
        ? await this.deps.planner.planCreate({
            request: intent.scenePrompt,
            durationSeconds,
            cast,
          })
        : undefined;
      const document = compileStoryboardDocument({
        scenePrompt: intent.scenePrompt,
        cast,
        durationSeconds,
        aspectRatio: toAspectRatio(intent.aspectRatio),
        resolution: toResolution(intent.resolution),
        environment: intent.environment,
        // Read from the owner's own words, by the one parser that separates
        // SOUND from SPEECH. Absent, the compiler falls back to whether the
        // scene has a spoken line, which is the pre-audio-mode behaviour.
        ...((mode) => (mode ? { audio: mode } : {}))(
          parseStoryboardAudioIntent(intent.scenePrompt),
        ),
        ...(planned ? { plannedBeats: planned.beats } : {}),
      });
      const created = await this.deps.store.createStoryboard({
        document,
        claim,
        projectInstanceId: resolved.projectInstanceId,
        projectPageId: resolved.projectPageId,
        sceneId: resolved.sceneId,
        scenePageId: resolved.scenePageId,
        characterLocks: resolved.characterLocks,
      });
      await this.deps.active.register(activeStoryboardKey(claim), {
        version: 1,
        storyboardId: created.head.storyboardId,
        projectInstanceId: resolved.projectInstanceId,
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        updatedAt: new Date(this.deps.now()).toISOString(),
      });
      return formatStoryboardForLine({
        versionNumber: created.version.versionNumber,
        document: created.version.document,
      });
    } catch (error) {
      return this.failure("storyboard_create_failed", error);
    }
  }

  /** Opens a session and asks the first missing question. Writes no Notion work. */
  private async openDirector(
    intent: Extract<StoryboardIntent, { kind: "director_open" }>,
    claim: StoryboardAccessClaim,
  ): Promise<string> {
    if (intent.unknownNames[0]) {
      return unknownCharacterReply(intent.unknownNames[0]);
    }
    const store = this.deps.director;
    if (!store) {
      return REPLY.directorUnavailable;
    }
    const session = openDirectorSession({
      claim,
      scenePrompt: intent.scenePrompt,
      characterNames: intent.characterNames,
      environment: intent.environment,
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    const slot = nextDirectorSlot(session);
    if (!slot) {
      return await this.completeDirector(session, claim);
    }
    await store.register(storyboardDirectorKey(claim), session);
    return DIRECTOR_QUESTION[slot];
  }

  /**
   * Applies one reply to the open slot.
   *
   * Returns undefined when the message does not answer the open question, so
   * the turn continues to ordinary classification rather than being swallowed.
   */
  private async answerDirector(
    event: StoryboardDispatchEvent,
    claim: StoryboardAccessClaim,
    session: StoryboardDirectorSession,
  ): Promise<string | undefined> {
    const slot = nextDirectorSlot(session);
    if (!slot) {
      return undefined;
    }
    const answer = parseDirectorAnswer({ content: event.content ?? "", slot });
    if (!answer) {
      return undefined;
    }
    if (answer.kind === "cancel") {
      await this.closeDirector(claim, session);
      return REPLY.directorCancelled;
    }
    if (answer.kind === "duration_too_long") {
      return durationTooLongAnswerReply(answer.durationSeconds);
    }
    const updated = applyDirectorAnswer(session, answer, new Date(this.deps.now()).toISOString());
    const next = nextDirectorSlot(updated);
    if (!next) {
      await this.closeDirector(claim, updated);
      return await this.completeDirector(updated, claim);
    }
    await this.deps.director?.register(storyboardDirectorKey(claim), updated);
    return DIRECTOR_QUESTION[next];
  }

  /**
   * Turns a complete session into a storyboard, and nothing else.
   *
   * Deliberately NOT quoted or coded here. The gathered answers are still
   * content, so they follow the same order every other scene does: the owner
   * reads the storyboard, revises it freely, and only "ยืนยัน Storyboard"
   * opens the model conversation that mints a payable code.
   */
  private async completeDirector(
    session: StoryboardDirectorSession,
    claim: StoryboardAccessClaim,
  ): Promise<string> {
    return await this.create(
      {
        kind: "create",
        characterNames: session.characterNames,
        unknownNames: [],
        explicitCasting: true,
        environment: session.environment,
        scenePrompt: directorScenePrompt(session),
        ...(session.durationSeconds === undefined
          ? {}
          : { durationSeconds: session.durationSeconds }),
        ...(session.aspectRatio === undefined ? {} : { aspectRatio: session.aspectRatio }),
        ...(session.resolution === undefined ? {} : { resolution: session.resolution }),
      },
      claim,
    );
  }

  /**
   * Applies a natural revision to the active storyboard.
   *
   * A cast ADDITION is not a revision: the shared lifecycle opens new work for
   * a cast the project never froze, and rewriting the frozen cast in place
   * would reverse that rule. The owner is told the new draft replaced nothing.
   */
  private async revise(
    revision: StoryboardDocumentRevision | StoryboardCastAddition,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
  ): Promise<string> {
    if (revision.kind === "cast_add") {
      const latest = await this.deps.store
        .readLatest({ storyboardId: active.storyboardId, claim })
        .catch(() => undefined);
      if (!latest) {
        return REPLY.missingVersion;
      }
      const existing = latest.document.cast.map((member) => member.displayName);
      const names = [...existing, ...revision.names.filter((name) => !existing.includes(name))];
      const created = await this.create(
        {
          kind: "create",
          characterNames: names,
          unknownNames: [],
          explicitCasting: true,
          environment: latest.document.environment,
          scenePrompt: latest.document.scenePrompt,
          durationSeconds: latest.document.durationSeconds,
          aspectRatio: latest.document.aspectRatio,
          resolution: latest.document.resolution,
        },
        claim,
      );
      return `${castAddedReply(revision.names)}\n\n${created}`;
    }
    if (revision.kind === "duration" && isDurationTooLong(revision.durationSeconds)) {
      return durationTooLongReply(revision.durationSeconds);
    }
    try {
      const version = await this.deps.store.appendRevision({
        storyboardId: active.storyboardId,
        claim,
        revision,
      });
      await this.touchActive(active);
      const storyboard = formatStoryboardForLine({
        versionNumber: version.versionNumber,
        document: version.document,
      });
      // Deliberately NOT re-quoted. A revision changes the scene, and the
      // scene must be confirmed before any model is chosen or priced, so this
      // returns the new version and waits for "ยืนยัน Storyboard".
      return storyboard;
    } catch (error) {
      if (error instanceof Error && error.message.includes("concurrently")) {
        return REPLY.conflict;
      }
      return this.failure("storyboard_revision_failed", error);
    }
  }

  /**
   * What a contextual route actually produced.
   *
   * The production incident this exists for was a turn that reached here,
   * completed, and reached the owner as silence — diagnosable only by the
   * generic "no queued reply payloads" warning much later. Text is measured,
   * never echoed: a scene prompt is owner content and has no place in a log.
   */
  private logContextualRoute(
    route: StoryboardContextualRoute,
    text: string | undefined,
    version: StoryboardVersion | undefined,
  ): void {
    const fields = {
      routeKind: route.kind,
      handled: true,
      replyTextPresent: Boolean(text?.trim()),
      replyTextLength: text?.length ?? 0,
      ...(version
        ? {
            storyboardVersion: version.versionNumber,
            durationSeconds: version.document.durationSeconds,
          }
        : {}),
    };
    if (fields.replyTextPresent) {
      this.deps.logger?.info?.("storyboard_contextual_route_handled", fields);
      return;
    }
    // Claiming the turn with nothing to say is the failure mode itself, so it
    // is reported HERE, naming the route, rather than surfacing downstream as
    // an unattributed empty dispatch.
    this.deps.logger?.warn("storyboard_contextual_route_empty_reply", fields);
  }

  /**
   * Retires the outstanding paid state when a step actually advanced the
   * version, and reports where the storyboard now stands.
   *
   * Every route that can revise the active storyboard goes through here, so
   * "a changed scene retires its code" has one owner instead of one per route.
   * A failed or no-op revision leaves the owner's existing code alone.
   */
  private async retireIfVersionAdvanced(params: {
    claim: StoryboardAccessClaim;
    active: ActiveStoryboardContext;
    conversationId: string | undefined;
    beforeVersionNumber: number | undefined;
  }): Promise<StoryboardVersion | undefined> {
    const after = await this.deps.store
      .readLatest({ storyboardId: params.active.storyboardId, claim: params.claim })
      .catch(() => undefined);
    if (after && after.versionNumber !== params.beforeVersionNumber) {
      await this.retirePaidStateForNewVersion(params.claim, params.active, params.conversationId);
    }
    return after;
  }

  /**
   * Retires everything the PREVIOUS version had been priced and coded for.
   *
   * A new version means the owner is looking at different content, so the
   * outstanding `VIDEO ####` must stop being payable and the frozen model step
   * must go: a code minted for an 8-second scene may not execute a 15-second
   * one, and the model was chosen against capabilities the new length can
   * change. Doing it here makes the stale code visibly dead the moment the
   * scene moves, which is what the owner is told.
   *
   * It is NOT what makes the old code unpayable. This is a proactive write and
   * a write can fail, so a failure is logged and the revision still completes —
   * the owner keeps the scene they asked for. The guarantee lives in the LINE
   * confirmation gate, which proves a code's frozen storyboard version against
   * the current one before it reaches anything paid, and refuses when it
   * cannot. Both exist on purpose: this one keeps the conversation honest, that
   * one keeps the money safe.
   */
  private async retirePaidStateForNewVersion(
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
    conversationId: string | undefined,
  ): Promise<void> {
    const step = await this.readModelSelection(claim);
    if (step) {
      await this.clearModelSelection(claim, step);
    }
    const runtime = this.videoRuntime();
    if (!runtime?.supersedeStoryboardDrafts || !conversationId) {
      return;
    }
    await runtime
      .supersedeStoryboardDrafts({
        accountId: claim.accountId,
        conversationId,
        ownerSenderId: claim.ownerSenderId,
        storyboardId: active.storyboardId,
      })
      .catch((error: unknown) => {
        this.deps.logger?.warn("storyboard_supersede_drafts_failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        return [] as readonly string[];
      });
  }

  /** Retires the session in place; the shared store offers no delete. */
  private async closeDirector(
    claim: StoryboardAccessClaim,
    session: StoryboardDirectorSession,
  ): Promise<void> {
    await this.deps.director?.register(
      storyboardDirectorKey(claim),
      closeDirectorSession(session, new Date(this.deps.now()).toISOString()),
    );
  }

  /**
   * This storyboard's current version number, for the LINE confirmation gate.
   *
   * The gate refuses any payable code whose frozen version is not this one, so
   * every answer here is load-bearing: undefined must mean "could not be
   * established" and never "unchanged". The claim is rebuilt from the trusted
   * triple and the store checks it, so one owner can never resolve another's
   * storyboard — and nothing here writes, retires or mints anything.
   */
  async readStoryboardVersionNumber(request: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    storyboardId: string;
  }): Promise<number | undefined> {
    const lineGroupId = nativeGroupId(request.conversationId);
    const accountId = request.accountId.trim();
    const ownerSenderId = request.ownerSenderId.trim();
    const storyboardId = request.storyboardId.trim();
    if (!lineGroupId || !accountId || !ownerSenderId || !storyboardId) {
      return undefined;
    }
    const version = await this.deps.store
      .readLatest({ storyboardId, claim: { accountId, lineGroupId, ownerSenderId } })
      .catch(() => undefined);
    return version?.versionNumber;
  }

  /**
   * Re-quotes this owner's active storyboard against the currently selected
   * video model, for the LINE-side model picker.
   *
   * Lives on the router because the router already owns the storyboard store,
   * the active pointer, the draft store and the paid seam — a second wiring of
   * those would be a second source of truth for what "active" means.
   */
  async requoteActiveDraft(request: {
    accountId: string;
    conversationId: string;
    ownerSenderId: string;
    overrides?: StoryboardRequoteOverrides;
  }): Promise<StoryboardRequoteResult> {
    const lineGroupId = nativeGroupId(request.conversationId);
    const accountId = request.accountId.trim();
    const ownerSenderId = request.ownerSenderId.trim();
    if (!lineGroupId || !accountId || !ownerSenderId) {
      return { kind: "no_active_storyboard" };
    }
    return await requoteActiveStoryboardDraft({
      claim: { accountId, lineGroupId, ownerSenderId },
      ...(request.overrides ? { overrides: request.overrides } : {}),
      deps: {
        store: this.deps.store,
        active: this.deps.active,
        drafts: this.deps.drafts,
        now: this.deps.now,
        ...(this.deps.randomId ? { randomId: this.deps.randomId } : {}),
        ...(this.deps.paidDraftRuntime === undefined
          ? {}
          : { paidDraftRuntime: this.deps.paidDraftRuntime }),
        ...(this.deps.draftScopes ? { draftScopes: this.deps.draftScopes } : {}),
        ...(this.deps.ugcCapabilities ? { ugcCapabilities: this.deps.ugcCapabilities } : {}),
      },
    });
  }

  /** Owner-scoped read of the pending natural request, when one exists. */
  private async readDirector(
    claim: StoryboardAccessClaim,
  ): Promise<StoryboardDirectorSession | undefined> {
    const session = await this.deps.director?.lookup(storyboardDirectorKey(claim));
    return ownsDirectorSession(session, claim) ? session : undefined;
  }

  private async naturalEdit(
    intent: Extract<StoryboardIntent, { kind: "natural_edit" }>,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
  ): Promise<string> {
    if (!this.deps.planner) {
      return REPLY.emptyAction;
    }
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    try {
      const edit = await this.deps.planner.planEdit({
        request: intent.request,
        document: latest.document,
      });
      const version = await this.deps.store.appendEdit({
        storyboardId: active.storyboardId,
        claim,
        edit,
      });
      await this.touchActive(active);
      return formatStoryboardForLine({
        versionNumber: version.versionNumber,
        document: version.document,
      });
    } catch (error) {
      return this.failure("storyboard_natural_edit_failed", error);
    }
  }

  private async edit(
    intent: Extract<StoryboardIntent, { kind: "edit" }>,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
  ): Promise<string> {
    // Unknown-name fail-closed applies to CREATE, where the cast is being
    // chosen. An edit instruction is free-form, so a Latin word after "ให้"
    // ("ให้ zoom in") is direction, not a missing character.
    if (!intent.action.trim()) {
      return REPLY.emptyAction;
    }
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    const duration = latest.document.durationSeconds;
    if (!Number.isFinite(intent.fromSeconds) || !Number.isFinite(intent.toSeconds)) {
      return rangeOutsideReply(intent.fromSeconds, intent.toSeconds, duration);
    }
    // Never silently clamp: the owner must know the range was not applied, and
    // must be told WHICH way it was wrong.
    if (intent.toSeconds <= intent.fromSeconds) {
      return rangeReversedReply(intent.fromSeconds, intent.toSeconds);
    }
    if (intent.fromSeconds < 0 || intent.toSeconds > duration) {
      return rangeOutsideReply(intent.fromSeconds, intent.toSeconds, duration);
    }
    try {
      const version = await this.deps.store.appendEdit({
        storyboardId: active.storyboardId,
        claim,
        edit: {
          fromSeconds: intent.fromSeconds,
          toSeconds: intent.toSeconds,
          action: intent.action,
          ...this.editCharacterIds(latest, intent.characterNames),
        },
      });
      // Keep the pointer alive while the owner is actively iterating; only an
      // ABANDONED storyboard should age out.
      await this.touchActive(active);
      return formatStoryboardForLine({
        versionNumber: version.versionNumber,
        document: version.document,
      });
    } catch (error) {
      // A concurrent edit already claimed this version slot; the owner retries
      // rather than having their edit silently overwrite the other one.
      if (error instanceof Error && error.message.includes("concurrently")) {
        return REPLY.conflict;
      }
      return this.failure("storyboard_edit_failed", error);
    }
  }

  /**
   * Spread-ready cast override for an edit, omitted when nothing resolves.
   *
   * An empty array is NOT nullish, so returning `characterIds: []` would defeat
   * the edit's `?? anchor ?? cast` fallback and leave the rewritten beat with
   * no cast at all.
   */
  private editCharacterIds(
    version: StoryboardVersion,
    names: readonly string[],
  ): { characterIds?: readonly string[] } {
    const ids = version.document.cast
      .filter((member) => names.includes(member.displayName))
      .map((member) => member.characterId);
    return ids.length > 0 ? { characterIds: ids } : {};
  }

  /**
   * The plugin that owns fal's registry, injected or installed.
   *
   * The SAME object the paid handoff uses, so the model a picker offers and
   * the model a draft allocates can never come from two different registries.
   */
  private videoRuntime(): StoryboardPaidDraftRuntime | undefined {
    return this.deps.paidDraftRuntime === undefined
      ? (tryGetStoryboardPaidDraftRuntime() ?? undefined)
      : (this.deps.paidDraftRuntime ?? undefined);
  }

  /** The open model question for this owner, if the storyboard is frozen. */
  private async readModelSelection(
    claim: StoryboardAccessClaim,
  ): Promise<StoryboardModelSelectionState | undefined> {
    return await this.deps.modelSelection?.lookup(storyboardModelSelectionKey(claim));
  }

  /**
   * Freezes the active storyboard and opens the model conversation.
   *
   * Nothing is quoted and no code is minted here: freezing is a CONTENT
   * decision, and the paid side does not begin until a model is settled.
   */
  private async confirmStoryboard(claim: StoryboardAccessClaim): Promise<string | undefined> {
    const active = await this.readActive(claim);
    if (!active || !this.deps.modelSelection) {
      return undefined;
    }
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    const offer = await this.videoRuntime()?.offerDefaultVideoModel?.(
      claim.accountId,
      storyboardVideoRequirements(latest),
    );
    if (!offer || offer.kind !== "offered") {
      return REPLY.noCompatibleModel;
    }
    await this.deps.modelSelection.register(storyboardModelSelectionKey(claim), {
      version: 1,
      storyboardId: active.storyboardId,
      frozenVersionNumber: latest.versionNumber,
      step: "default",
      offeredModelIds: Object.freeze([offer.model.modelId]),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    return formatStoryboardModelDefault({
      model: offer.model,
      ...(offer.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: offer.estimatedCostUsd }),
      ...(offer.displacedReason ? { displacedReason: offer.displacedReason } : {}),
    });
  }

  /**
   * Advances the family -> version conversation, or drafts on "use default".
   *
   * A revision between freezing and choosing invalidates the step: the frozen
   * version number is compared, so a selection can never be applied to content
   * the owner has since changed.
   */
  private async answerModelSelection(
    event: StoryboardDispatchEvent,
    claim: StoryboardAccessClaim,
    step: StoryboardModelSelectionState,
  ): Promise<string | undefined> {
    const answer = parseStoryboardModelAnswer(event.content ?? "");
    if (!answer || !this.deps.modelSelection) {
      return undefined;
    }
    const active = await this.readActive(claim);
    const latest = active
      ? await this.deps.store
          .readLatest({ storyboardId: active.storyboardId, claim })
          .catch(() => undefined)
      : undefined;
    if (!latest || latest.versionNumber !== step.frozenVersionNumber) {
      // The scene moved on. Drop the stale step rather than binding a model to
      // content the owner did not confirm.
      await this.clearModelSelection(claim, step);
      return undefined;
    }
    const compatible =
      (await this.videoRuntime()?.listCompatibleVideoModels?.(
        claim.accountId,
        storyboardVideoRequirements(latest),
      )) ?? [];
    if (answer.kind === "use_default" && step.step === "default") {
      const chosen = step.offeredModelIds?.[0];
      return chosen ? await this.draftWithModel(claim, chosen, step) : undefined;
    }
    if (answer.kind === "change_model") {
      const families = uniqueFamilies(compatible);
      await this.deps.modelSelection.register(storyboardModelSelectionKey(claim), {
        ...step,
        step: "family",
        offeredModelIds: Object.freeze(families.map((family) => family.id)),
        updatedAt: new Date(this.deps.now()).toISOString(),
      });
      return formatStoryboardModelFamilies(families);
    }
    if (answer.kind === "choice") {
      return await this.applyNumberedChoice(claim, step, compatible, answer.index);
    }
    return answer.kind === "query"
      ? await this.applyModelQuery(claim, step, latest, compatible, answer.text)
      : undefined;
  }

  /** Resolves a numbered pick against whatever menu is currently on screen. */
  private async applyNumberedChoice(
    claim: StoryboardAccessClaim,
    step: StoryboardModelSelectionState,
    compatible: readonly StoryboardModelOption[],
    index: number,
  ): Promise<string | undefined> {
    const offered = step.offeredModelIds ?? [];
    const picked = offered[index];
    if (!picked) {
      return undefined;
    }
    if (step.step !== "family") {
      return await this.draftWithModel(claim, picked, step);
    }
    return await this.showFamilyVersions(claim, step, compatible, picked);
  }

  /** Narrows to one family and lists only its compatible versions. */
  private async showFamilyVersions(
    claim: StoryboardAccessClaim,
    step: StoryboardModelSelectionState,
    compatible: readonly StoryboardModelOption[],
    familyId: string,
  ): Promise<string | undefined> {
    const models = compatible.filter((model) => model.familyId === familyId);
    const family = uniqueFamilies(compatible).find((entry) => entry.id === familyId);
    if (models.length === 0 || !family) {
      return undefined;
    }
    await this.deps.modelSelection?.register(storyboardModelSelectionKey(claim), {
      ...step,
      step: "version",
      familyId,
      offeredModelIds: Object.freeze(models.map((model) => model.modelId)),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    return formatStoryboardModelVersions({ familyName: family.displayName, models });
  }

  /**
   * Applies a typed model query.
   *
   * A confident single match applies; a family name narrows; anything weaker
   * renders choices. A guess is never billed.
   */
  private async applyModelQuery(
    claim: StoryboardAccessClaim,
    step: StoryboardModelSelectionState,
    version: StoryboardVersion,
    compatible: readonly StoryboardModelOption[],
    text: string,
  ): Promise<string | undefined> {
    const matched = await this.videoRuntime()?.matchVideoModelQuery?.(
      claim.accountId,
      storyboardVideoRequirements(version),
      text,
    );
    if (!matched) {
      return undefined;
    }
    if (matched.kind === "model") {
      return await this.draftWithModel(claim, matched.modelId, step);
    }
    if (matched.kind === "family") {
      return await this.showFamilyVersions(claim, step, compatible, matched.familyId);
    }
    await this.deps.modelSelection?.register(storyboardModelSelectionKey(claim), {
      ...step,
      step: "version",
      offeredModelIds: Object.freeze(matched.models.map((model) => model.modelId)),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
    return formatStoryboardModelCandidates(matched.models);
  }

  /** Retires the model step in place; the shared store offers no delete. */
  private async clearModelSelection(
    claim: StoryboardAccessClaim,
    step: StoryboardModelSelectionState,
  ): Promise<void> {
    await this.deps.modelSelection?.register(storyboardModelSelectionKey(claim), {
      ...step,
      step: "default",
      offeredModelIds: Object.freeze([]),
      updatedAt: new Date(this.deps.now()).toISOString(),
    });
  }

  /** Quotes and allocates the Final Video Draft for one chosen endpoint. */
  private async draftWithModel(
    claim: StoryboardAccessClaim,
    modelId: string,
    step: StoryboardModelSelectionState,
  ): Promise<string | undefined> {
    const active = await this.readActive(claim);
    if (!active) {
      return undefined;
    }
    await this.clearModelSelection(claim, step);
    return await this.prepareDraft(claim, active, modelId);
  }

  private async prepareDraft(
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
    requestedModelId?: string,
  ): Promise<string> {
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    try {
      const draft = await prepareStoryboardFinalVideoDraft({
        version: latest,
        drafts: this.deps.drafts,
        now: this.deps.now,
        ...(this.deps.randomId ? { randomId: this.deps.randomId } : {}),
        ...(requestedModelId ? { requestedModelId } : {}),
        // The paid draft is scoped to the conversation that may confirm it, in
        // the SAME shape the LINE paid flow already uses, so a code minted here
        // is resolvable by the existing gate and by nothing else.
        paid: {
          conversationId: claim.lineGroupId,
          deliveryTo: `line:group:${claim.lineGroupId}`,
          ...(this.deps.paidDraftRuntime === undefined
            ? {}
            : { runtime: this.deps.paidDraftRuntime }),
        },
      });
      // A UGC-bound group's confirmation gate requires a frozen workspace scope
      // for the draft it is about to submit; without one it refuses, which
      // would make every storyboard code unconfirmable. Registered through the
      // SAME store and key the existing tool path uses, so the gate's own
      // validation runs over it unchanged.
      if (draft.confirmation.kind === "ready") {
        await this.freezeDraftScope(draft, claim, draft.confirmation.code);
      }
      await this.touchActive(active);
      return formatFinalVideoDraftForLine(draft);
    } catch (error) {
      return this.failure("storyboard_draft_failed", error);
    }
  }

  /** Freezes the scope the paid gate validates, in the store it already reads. */
  private async freezeDraftScope(
    draft: StoryboardFinalVideoDraft,
    claim: StoryboardAccessClaim,
    code: string,
  ): Promise<void> {
    const scopes = this.deps.draftScopes;
    const capabilities = this.deps.ugcCapabilities;
    if (!scopes || !capabilities) {
      return;
    }
    const scope = buildStoryboardDraftScope({
      draft,
      claim,
      capabilities,
      createdAt: new Date(this.deps.now()).toISOString(),
    });
    if (scope) {
      await scopes.register(ugcDraftScopeKey(code), scope);
    }
  }

  private trustedClaim(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): StoryboardAccessClaim | undefined {
    return resolveStoryboardAccessClaim(event, context);
  }

  /** Stable per-inbound-message key, scoped to the owner so it cannot collide. */
  private dedupeKey(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
    claim: StoryboardAccessClaim,
  ): string | undefined {
    const id = event.messageId?.trim() || context.messageId?.trim();
    return id
      ? `storyboard-dedupe:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}:${id}`
      : undefined;
  }

  /**
   * Whether this owner is currently iterating on a storyboard.
   *
   * The plugin uses this to decide whether previs may see the turn: with no
   * storyboard active, previs keeps its shipped behaviour, including the
   * documented bare `วิ 10-14 ...` edit that follows an explicit previs create.
   */
  async hasActiveStoryboard(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<boolean> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return false;
    }
    const claim = this.trustedClaim(event, context);
    return claim ? Boolean(await this.readActive(claim)) : false;
  }

  /**
   * Runs a turn whose REFERENT the conversation layer resolved.
   *
   * The hint says which of this router's own paths to take and carries the
   * owner's own words as the instruction; it never carries wording anything
   * else composed. Everything that follows — the binding check, the active
   * storyboard, the planner, the version write — is this router's existing
   * code, so a contextual revision and a plainly-worded one are one
   * implementation and neither can reach a paid action.
   */
  async handleContextualRoute(
    route: StoryboardContextualRoute,
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const claim = this.trustedClaim(event, context);
    if (!claim) {
      return undefined;
    }
    const binding = await this.deps.registry.lookup(claim.accountId, claim.lineGroupId);
    if (binding?.policyId !== "UGC" || binding.boundByOwnerId !== claim.ownerSenderId) {
      return undefined;
    }
    const active = await this.readActive(claim);
    if (route.kind === "revise_active_storyboard") {
      // The referent is the storyboard this owner is on. If it aged out between
      // resolution and here, there is nothing to revise and the turn is left
      // alone rather than being applied to whatever comes next.
      if (!active) {
        return undefined;
      }
      // A document-level change — a new length, a new environment, sound on or
      // off — is read by the SAME parser the plainly-worded path uses, and
      // applied by the same handler. Going straight to the beat planner meant
      // "เอาเป็น 15 วิ" produced a re-planned 8-second scene: a new length was
      // never a beat instruction, so nothing on that path could apply it.
      const knownCharacterNames = await this.deps.resolver
        .listCharacterNames(claim)
        .catch(() => [] as readonly string[]);
      const before = await this.deps.store
        .readLatest({ storyboardId: active.storyboardId, claim })
        .catch(() => undefined);
      // The marker-gated parser first, for every shape it already knows. Then a
      // named length: the general parser demands a replacement marker
      // ("ขอ 15 วิแทน") to tell a revision from a fresh request, and a
      // contextually resolved turn has already settled that — the referent IS
      // this storyboard — so a length that differs from the current one is the
      // change being asked for, however it was phrased.
      const named = readRevisionDuration(route.request);
      const revision =
        parseStoryboardRevision({ content: route.request, knownCharacterNames }) ??
        (named !== undefined && named !== before?.document.durationSeconds
          ? ({ kind: "duration", durationSeconds: named } as const)
          : undefined);
      const text = revision
        ? await this.revise(revision, claim, active)
        : await this.naturalEdit({ kind: "natural_edit", request: route.request }, claim, active);
      const after = await this.retireIfVersionAdvanced({
        claim,
        active,
        conversationId: context.conversationId,
        beforeVersionNumber: before?.versionNumber,
      });
      this.logContextualRoute(route, text, after);
      return { handled: true, text };
    }
    return {
      handled: true,
      text: await this.openDirector(
        {
          kind: "director_open",
          characterNames: route.characterNames,
          unknownNames: [],
          environment: route.environment,
          scenePrompt: route.request,
        },
        claim,
      ),
    };
  }

  /** Re-registers the active pointer so its TTL tracks last use, not creation. */
  private async touchActive(active: ActiveStoryboardContext): Promise<void> {
    await this.deps.active.register(
      activeStoryboardKey({
        accountId: active.accountId,
        lineGroupId: active.lineGroupId,
        ownerSenderId: active.ownerSenderId,
      }),
      { ...active, updatedAt: new Date(this.deps.now()).toISOString() },
    );
  }

  /** Owner-scoped read: another owner or group never resolves this context. */
  private async readActive(
    claim: StoryboardAccessClaim,
  ): Promise<ActiveStoryboardContext | undefined> {
    const active = await this.deps.active.lookup(activeStoryboardKey(claim));
    if (
      !active ||
      active.accountId !== claim.accountId ||
      active.lineGroupId !== claim.lineGroupId ||
      active.ownerSenderId !== claim.ownerSenderId
    ) {
      return undefined;
    }
    return active;
  }

  /** Logs the real cause, replies with a message that leaks no internals. */
  private failure(event: string, error: unknown): string {
    this.deps.logger?.warn(event, {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return REPLY.engineDown;
  }
}
