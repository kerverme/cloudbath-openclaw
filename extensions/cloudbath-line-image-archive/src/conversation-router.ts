/**
 * Referent arbitration: what is this message ABOUT, before any feature answers.
 *
 * Every handler in this flow used to read a message in isolation, so whichever
 * one recognised a word first answered — which is how "เสร็จยัง" about a running
 * video came back as the status of a Character saved ten minutes earlier. This
 * runs first and decides the referent once, in a fixed order of trust:
 *
 *  1. a trusted postback chip — the owner pressed a control we rendered;
 *  2. an entity named outright in the message (a Character, a `VIDEO ####`);
 *  3. the task the owner has not seen the end of;
 *  4. the question currently open, answered by utterance CLASS not by phrase;
 *  5. a reference back to what was just discussed;
 *  6. the model, for meaning the deterministic steps could not settle;
 *  7. a clarification, when two readings are genuinely plausible.
 *
 * It resolves; it does not execute. The usual outcome is `rewrite`, which hands
 * the SAME turn to the existing handler with the canonical wording that handler
 * already parses — so a chip and a typed answer run one implementation, and
 * this layer can never do something the owner could not have typed. It answers
 * directly only for job status and for a chip that has gone stale, neither of
 * which spends anything.
 */

import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  conversationContextKey,
  emptyConversationContext,
  mergeConversationContext,
  ownsConversationContext,
  recordConversationTask,
  recordOwnerTurn,
  unresolvedConversationTasks,
  type ActiveConversationContext,
  type ConversationChoice,
  type ConversationContextStore,
  type ConversationQuestion,
  type ConversationTaskRef,
} from "./conversation-context.js";
import {
  conversationQuestionPresentation,
  deriveConversationQuestion,
  looksLikeConversationPostback,
  parseConversationPostbackToken,
  resolveConversationPostback,
} from "./conversation-question.js";
import {
  SEMANTIC_CONFIDENCE_FLOOR,
  type ConversationSemanticResolver,
  type SemanticReferentType,
} from "./conversation-semantic-resolver.js";
import { describeVideoJobStatus } from "./conversation-status.js";
import {
  CONVERSATION_RECENT_TURN_LIMIT,
  mergeConversationTurns,
  type ConversationSenderScope,
  type ConversationTranscriptReader,
  type ConversationTurn,
} from "./conversation-transcript.js";
import {
  classifyConversationUtterance,
  type ConversationUtterance,
} from "./conversation-utterance.js";
import { resolveStoryboardAuthorization } from "./storyboard-authorization.js";
import {
  storyboardModelSelectionKey,
  type StoryboardModelSelectionStore,
} from "./storyboard-confirmation.js";
import { storyboardDirectorKey, type StoryboardDirectorSession } from "./storyboard-director.js";
import {
  resolveStoryboardAccessClaim,
  type StoryboardContextualRoute,
  type ResolvedStoryboardReferent,
  type StoryboardDispatchContext,
  type StoryboardDispatchEvent,
  type StoryboardProjectResolver,
} from "./storyboard-line-router.js";
import {
  tryGetStoryboardPaidDraftRuntime,
  type StoryboardPaidDraftRuntime,
  type StoryboardVideoJobSnapshot,
} from "./storyboard-paid-draft-runtime.js";
import { readStoryboardEnvironment } from "./storyboard-request.js";
import { activeStoryboardKey } from "./storyboard-store.js";
import type { ActiveStoryboardContext, StoryboardAccessClaim } from "./storyboard-types.js";
import type { AsyncKeyedStore, SafeLogger } from "./types.js";

/** A `VIDEO ####` code named outright. The only paid identifier owners see. */
const VIDEO_CODE = /\bVIDEO\s*(\d{4})\b/iu;

/**
 * Beyond this a turn is carrying instructions, not just an answer, and a
 * canonical rewrite would discard the rest of it. Sized for the answers this
 * flow actually asks for ("ไม่เปลี่ยน", "เอาตัวเดิม", "15 วิ"), not for prose.
 */
const ANSWER_ONLY_MAX_CHARS = 24;

const AMBIGUOUS_REFERENT_REPLY = "หมายถึงงานไหน? บอกชื่อ Character หรือรหัส VIDEO ได้เลย";

const STALE_POSTBACK_REPLY = "ปุ่มนี้เป็นของขั้นตอนก่อนหน้า ใช้ไม่ได้แล้ว — พิมพ์คำตอบล่าสุดได้เลย";

export type ConversationTurnResolution =
  /** Hand this turn to the existing handler with wording it already parses. */
  | Readonly<{ kind: "rewrite"; canonicalText: string }>
  /** The arbiter answers. Only status and stale-chip replies take this path. */
  | Readonly<{ kind: "answer"; text: string }>
  /**
   * The referent was resolved, and the turn is work for a handler. Carries the
   * owner's own words plus state-derived binding, never composed wording.
   */
  | Readonly<{ kind: "route"; route: StoryboardContextualRoute }>
  /** Two plausible referents; ask rather than pick one. */
  | Readonly<{ kind: "clarify"; text: string }>
  /** Not ours: the turn continues to the handlers unchanged. */
  | Readonly<{ kind: "pass" }>;

export type ConversationRouterDeps = Readonly<{
  context: ConversationContextStore;
  /**
   * The SAME binding check every handler makes. Arbitration answers and
   * rewrites turns, so it must be reachable in exactly the conversations the
   * handlers are, and in no others.
   */
  registry: {
    lookup(
      accountId: string | undefined,
      groupId: string,
    ): Promise<{ policyId: string; boundByOwnerId: string } | null | undefined>;
  };
  /** The SAME stores the storyboard router uses; the question is derived from them. */
  director?: AsyncKeyedStore<StoryboardDirectorSession>;
  modelSelection?: StoryboardModelSelectionStore;
  active: AsyncKeyedStore<ActiveStoryboardContext>;
  resolveStoryboardReferent?(params: {
    storyboardId: string;
    claim: StoryboardAccessClaim;
  }): Promise<ResolvedStoryboardReferent | undefined>;
  isStoryboardRevisionCandidate?(params: {
    request: string;
    claim: StoryboardAccessClaim;
  }): Promise<boolean>;
  resolver: StoryboardProjectResolver;
  /**
   * LINE's paid seam, for the one job this conversation may be waiting on.
   * Left undefined the installed runtime is resolved per call, exactly as the
   * storyboard router does it, so a seam installed after this router was built
   * is still found; `null` models a build with no LINE plugin.
   */
  paidDraftRuntime?: StoryboardPaidDraftRuntime | null;
  /** Absent, arbitration simply stops after the deterministic steps. */
  semanticResolver?: ConversationSemanticResolver;
  /**
   * Recent dialogue for the semantic step. Absent, that step still runs on
   * structured state alone — history is a hint, never a precondition.
   */
  transcript?: ConversationTranscriptReader;
  now: () => number;
  /** Question nonces. Must be unguessable enough that chips do not collide. */
  randomId: () => string;
  logger?: Pick<SafeLogger, "info" | "warn">;
}>;

type EntityMention = Readonly<{ kind: SemanticReferentType; id: string; label: string }>;

export class CloudbathConversationRouter {
  private readonly ownerClaimsBySession = new Map<string, StoryboardAccessClaim>();

  constructor(private readonly deps: ConversationRouterDeps) {}

  /** Step 1-7 above. Never writes anything the owner has to undo. */
  async resolveTurn(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<ConversationTurnResolution> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return { kind: "pass" };
    }
    const claim = resolveStoryboardAccessClaim(event, context);
    if (!claim) {
      return { kind: "pass" };
    }
    // Ownership decides whether this layer may arbitrate at all; the UGC
    // workspace only decides whether project-backed capability exists, and is
    // checked where a project is actually needed.
    const authorization = await resolveStoryboardAuthorization({
      claim,
      lookup: (accountId, groupId) => this.deps.registry.lookup(accountId, groupId),
    });
    if (authorization.kind === "denied") {
      return { kind: "pass" };
    }
    const sessionKey = context.sessionKey?.trim();
    if (sessionKey) {
      if (this.ownerClaimsBySession.size >= 5_000 && !this.ownerClaimsBySession.has(sessionKey)) {
        const oldest = this.ownerClaimsBySession.keys().next().value;
        if (oldest) {
          this.ownerClaimsBySession.delete(oldest);
        }
      }
      this.ownerClaimsBySession.set(sessionKey, claim);
    }
    const content = event.content ?? "";
    let stored = await this.readContext(claim);

    // 1. A chip is the owner pressing a control this flow rendered, so it needs
    // no interpretation at all — and a chip from an older step is refused here
    // rather than being read as text that might still match something.
    if (looksLikeConversationPostback(content)) {
      const token = parseConversationPostbackToken(content);
      const choice = token ? resolveConversationPostback(stored, token) : undefined;
      return choice
        ? { kind: "rewrite", canonicalText: choice.canonicalText }
        : { kind: "answer", text: STALE_POSTBACK_REPLY };
    }

    const utterance = classifyConversationUtterance(content);
    if (!utterance) {
      return { kind: "pass" };
    }
    // Everything above proved this turn came from the bound owner of this
    // account + conversation, so here — and only here — the message has a
    // provable author. Nothing downstream, and nothing in the persisted
    // transcript, can tell one group member's turn from another's later, which
    // is why the owner half of the history is captured at this point instead of
    // read back out. A chip is not language and is deliberately not recorded.
    stored = recordOwnerTurn(stored, utterance.text, this.deps.now());
    await this.write(claim, stored);
    const entities = await this.detectEntities(content, claim);

    // 2. Something named outright outranks anything remembered. "F99 บันทึกเสร็จยัง"
    // is about F99 whatever job is running, so the video path must not take it.
    const namedVideoCode = entities.find((entity) => entity.kind === "video_job");
    if (entities.length > 0 && !namedVideoCode) {
      return { kind: "pass" };
    }

    // 3. Asking to SEE the work, or to carry on with it, is decided here rather
    // than by the semantic step. Both classes name nothing, so a standing offer
    // would otherwise capture them as its own answer — and "ทำต่อ" would freeze
    // a storyboard whose images do not exist yet. Deterministic, referent-bound,
    // and reaching only free steps.
    if (utterance.visualRequest || utterance.continuation) {
      const referent = stored.activeStoryboardId
        ? await this.deps.resolveStoryboardReferent?.({
            storyboardId: stored.activeStoryboardId,
            claim,
          })
        : undefined;
      if (referent) {
        const kind = utterance.visualRequest
          ? ("generate_storyboard_visuals" as const)
          : ("continue_toward_video" as const);
        this.deps.logger?.info("contextual_work_route_resolved", {
          routeKind: kind,
          resolvedWorkKind: referent.workKind,
          storyboardId: referent.storyboardId,
          storyboardVersionNumber: referent.storyboardVersionNumber,
          resolutionSource: referent.resolvedFrom,
          referentProven: true,
        });
        return { kind: "route", route: { kind, referent } };
      }
    }

    const job = utterance.progressInquiry ? await this.readActiveJob(claim, context) : undefined;
    if (job) {
      await this.rememberJob(claim, stored, job);
    }
    if (namedVideoCode) {
      return job && job.draftId === namedVideoCode.id
        ? { kind: "answer", text: describeVideoJobStatus(job) }
        : { kind: "pass" };
    }

    // Only a question the assistant is WAITING on may be answered by utterance
    // class; a standing offer is resolved by its chips alone (see
    // `ConversationQuestionStance`), so a refusal while a storyboard is on
    // screen stays the revision it almost always is.
    const question = stored.question?.stance === "asked" ? stored.question : undefined;
    if (utterance.progressInquiry) {
      // 3 vs 4: a bare progress question with BOTH a running job and an open
      // question is genuinely two-ways ambiguous — Thai builds "not yet" from
      // the same word — so it is asked about rather than guessed.
      if (job && question) {
        return { kind: "clarify", text: this.clarifyBetween(job, question) };
      }
      if (job) {
        return { kind: "answer", text: describeVideoJobStatus(job) };
      }
      if (!question) {
        const referent = stored.activeStoryboardId
          ? await this.deps.resolveStoryboardReferent?.({
              storyboardId: stored.activeStoryboardId,
              claim,
            })
          : undefined;
        return referent
          ? {
              kind: "answer",
              text: `Storyboard v${referent.storyboardVersionNumber} ยังเป็นงานปัจจุบัน บอกจุดที่ต้องการแก้ได้เลย`,
            }
          : stored.activeStoryboardId
            ? { kind: "clarify", text: AMBIGUOUS_REFERENT_REPLY }
            : { kind: "pass" };
      }
    }

    // 4/5. The open question, answered by what KIND of move the turn is.
    //
    // Only for a turn short enough to BE an answer. A rewrite replaces the
    // turn's content, so a longer message — "ไม่เอาเสียงพูด แต่เปลี่ยนเป็นกลางคืน"
    // — would have its second half thrown away. The handler's own parser reads
    // those in full, so they are passed through untouched.
    if (question && utterance.text.length <= ANSWER_ONLY_MAX_CHARS) {
      const choice = matchQuestionChoice(question, utterance);
      if (choice) {
        return { kind: "rewrite", canonicalText: choice.canonicalText };
      }
    }

    // 6. Only for a turn that is plainly conversational (a refusal, a pick, a
    // reference back) yet did not resolve. A message with no such marker is new
    // work, and classifying new work is the storyboard router's job, not this
    // one's, so it is passed through untouched.
    const revisionCandidate = stored.activeStoryboardId
      ? await this.deps
          .isStoryboardRevisionCandidate?.({ request: utterance.text, claim })
          .catch(() => false)
      : false;
    const conversational =
      utterance.polarity !== undefined ||
      utterance.ordinal !== undefined ||
      utterance.deixis !== undefined ||
      utterance.progressInquiry ||
      revisionCandidate;
    if (!conversational || !this.deps.semanticResolver) {
      return { kind: "pass" };
    }
    const unresolved = unresolvedConversationTasks(stored);
    // A reference back needs SOMETHING to point at. With no active storyboard
    // and nothing unresolved, "แบบเมื่อกี้" in a fresh conversation is not a
    // referent this flow can bind, and carrying one over from whatever is
    // lying around is exactly the guess this layer exists to prevent.
    const bindable =
      Boolean(question) || unresolved.length > 0 || Boolean(stored.activeStoryboardId);
    if (!bindable) {
      return utterance.deixis
        ? { kind: "clarify", text: AMBIGUOUS_REFERENT_REPLY }
        : { kind: "pass" };
    }
    const recentTurns = await this.readRecentTurns(event, context, stored);
    const resolution = await this.deps.semanticResolver.resolve({
      message: utterance.text,
      context: stored,
      unresolvedTasks: unresolved,
      ...(question ? { question } : {}),
      recentTurns,
      entities,
    });
    if (!resolution) {
      return { kind: "pass" };
    }
    if (resolution.needsClarification || resolution.confidence < SEMANTIC_CONFIDENCE_FLOOR) {
      // Naming the open question is more useful than a generic ask, but an
      // unresolved referent with no question open still gets asked about
      // rather than guessed.
      return {
        kind: "clarify",
        text: question ? `ยังไม่แน่ใจว่าหมายถึงอะไร — ${question.prompt}` : AMBIGUOUS_REFERENT_REPLY,
      };
    }
    // The model may only pick a door this flow already opened: an action it did
    // not copy verbatim from the offered choices is discarded, which is what
    // keeps it unable to reach anything billable.
    const offered = question?.choices.find(
      (choice) => choice.canonicalText === resolution.requestedAction,
    );
    if (resolution.intent === "answer_question" && offered) {
      return { kind: "rewrite", canonicalText: offered.canonicalText };
    }
    if (resolution.intent === "revise_active_storyboard" && stored.activeStoryboardId) {
      // Bound to the storyboard OUR state says is active, never to an id the
      // model named, and carrying the owner's message unchanged: the planner
      // reads it as the edit instruction it already is.
      const referent = await this.deps.resolveStoryboardReferent?.({
        storyboardId: stored.activeStoryboardId,
        claim,
      });
      if (!referent) {
        this.deps.logger?.warn("contextual_revision_referent_unprovable", {
          routeKind: "revise_active_storyboard",
          resolvedWorkKind: "storyboard",
          referentProven: false,
          clarificationReason: "authoritative_storyboard_unavailable",
        });
        return { kind: "clarify", text: AMBIGUOUS_REFERENT_REPLY };
      }
      this.deps.logger?.info("contextual_revision_referent_resolved", {
        routeKind: "revise_active_storyboard",
        resolvedWorkKind: referent.workKind,
        storyboardId: referent.storyboardId,
        storyboardVersionNumber: referent.storyboardVersionNumber,
        resolutionSource: referent.resolvedFrom,
        currentWorkStatus: referent.status,
        referentProven: true,
      });
      return {
        kind: "route",
        route: { kind: "revise_active_storyboard", request: utterance.text, referent },
      };
    }
    if (resolution.intent === "new_request") {
      const characterNames = stored.activeCharacters ?? [];
      // New work still needs a cast, and the only cast this layer may supply is
      // the one already frozen into the active project. Without it there is
      // nothing to open, so the turn goes to the handler's own classifier.
      return characterNames.length > 0
        ? {
            kind: "route",
            route: {
              kind: "new_scene_request",
              request: utterance.text,
              characterNames,
              environment: readStoryboardEnvironment(utterance.text),
            },
          }
        : { kind: "pass" };
    }
    if (resolution.intent === "task_status" && job) {
      return { kind: "answer", text: describeVideoJobStatus(job) };
    }
    return { kind: "pass" };
  }

  /**
   * Records what is now open, after a handler has answered.
   *
   * Derived from the handler's own stores rather than from its reply text, so
   * the buttons cannot describe a question the flow is not actually in. Returns
   * the controls to attach to that reply.
   */
  async observeHandledTurn(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<MessagePresentation | undefined> {
    const claim = resolveStoryboardAccessClaim(event, context);
    if (!claim || context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const [director, modelSelection, active] = await Promise.all([
      this.deps.director?.lookup(storyboardDirectorKey(claim)),
      this.deps.modelSelection?.lookup(storyboardModelSelectionKey(claim)),
      this.deps.active.lookup(activeStoryboardKey(claim)),
    ]);
    const activeReferent = active
      ? await this.deps.resolveStoryboardReferent?.({ storyboardId: active.storyboardId, claim })
      : undefined;
    const activeVersionNumber = activeReferent?.storyboardVersionNumber;
    const updatedAt = new Date(this.deps.now()).toISOString();
    const question = deriveConversationQuestion(
      {
        ...(director ? { director } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(active ? { active } : {}),
      },
      { nonce: this.deps.randomId(), askedAt: updatedAt },
    );
    const stored = await this.readContext(claim);
    let next = mergeConversationContext(
      stored,
      {
        question: question ?? null,
        ...(active
          ? {
              activeStoryboardId: active.storyboardId,
              activeProjectId: active.projectInstanceId,
              latestStoryboardId: active.storyboardId,
              ...(activeVersionNumber === undefined
                ? {}
                : {
                    activeStoryboardVersion: activeVersionNumber,
                    latestStoryboardVersion: activeVersionNumber,
                  }),
              currentWork: {
                workId: active.projectInstanceId ?? active.storyboardId,
                kind: "storyboard" as const,
                status: "open" as const,
                storyboardId: active.storyboardId,
                ...(activeVersionNumber === undefined
                  ? {}
                  : { storyboardVersionNumber: activeVersionNumber }),
                ...(active.projectInstanceId
                  ? { projectInstanceId: active.projectInstanceId }
                  : {}),
                updatedAt,
              },
            }
          : {}),
        ...(director?.durationSeconds === undefined
          ? {}
          : { durationSeconds: director.durationSeconds }),
        ...(director?.media?.kind === "source_image"
          ? {
              selectedSourceArtifact: {
                artifactId: director.media.mediaId,
                kind: "source_image" as const,
                createdAt: director.updatedAt,
              },
            }
          : {}),
      },
      updatedAt,
    );
    if (question) {
      // An open question is itself unfinished work: it is what a later "ยัง?"
      // may be about, so it is remembered as a task rather than only as a
      // question, and stops being unresolved the moment nothing is open.
      next = recordConversationTask(
        next,
        {
          taskType: "storyboard",
          taskId: question.subject.id,
          status: "pending",
          label: question.prompt,
          updatedAt,
        },
        updatedAt,
      );
    } else {
      next = mergeConversationContext(
        {
          ...next,
          tasks: next.tasks.map((task) =>
            task.taskType === "storyboard" ? { ...task, status: "resolved" as const } : task,
          ),
        },
        {},
        updatedAt,
      );
    }
    await this.write(claim, next);
    return question ? conversationQuestionPresentation(question) : undefined;
  }

  /** Resolves tool completion back to the owner turn that started it. */
  claimForSession(sessionKey: string | undefined): StoryboardAccessClaim | undefined {
    return sessionKey ? this.ownerClaimsBySession.get(sessionKey.trim()) : undefined;
  }

  /** Records a durable generated image as current work; bytes stay in its media store. */
  async observeGeneratedImage(
    claim: StoryboardAccessClaim,
    artifactId: string,
    createdAt: string,
  ): Promise<void> {
    const stored = await this.readContext(claim);
    const artifact = Object.freeze({
      artifactId,
      kind: "generated_image" as const,
      createdAt,
    });
    await this.write(
      claim,
      mergeConversationContext(
        stored,
        {
          latestGeneratedImage: artifact,
          currentWork: {
            workId: artifactId,
            kind: "image",
            status: "open",
            updatedAt: createdAt,
          },
        },
        createdAt,
      ),
    );
  }

  private async readContext(claim: StoryboardAccessClaim): Promise<ActiveConversationContext> {
    const stored = await this.deps.context.lookup(conversationContextKey(claim)).catch(() => {
      this.deps.logger?.warn("conversation_context_read_failed");
      return undefined;
    });
    return ownsConversationContext(stored, claim)
      ? stored
      : emptyConversationContext(claim, new Date(this.deps.now()).toISOString());
  }

  private async write(
    claim: StoryboardAccessClaim,
    context: ActiveConversationContext,
  ): Promise<void> {
    // A failed write must not fail the turn: the owner already has their reply,
    // and the next turn simply arbitrates with less remembered context.
    await this.deps.context.register(conversationContextKey(claim), context).catch(() => {
      this.deps.logger?.warn("conversation_context_write_failed");
    });
  }

  private async readActiveJob(
    claim: StoryboardAccessClaim,
    context: StoryboardDispatchContext,
  ): Promise<StoryboardVideoJobSnapshot | undefined> {
    const runtime =
      this.deps.paidDraftRuntime === undefined
        ? tryGetStoryboardPaidDraftRuntime()
        : this.deps.paidDraftRuntime;
    const conversationId = context.conversationId?.trim();
    if (!runtime?.readActiveVideoJob || !conversationId) {
      return undefined;
    }
    return await runtime
      .readActiveVideoJob({ accountId: claim.accountId, conversationId })
      .catch(() => {
        this.deps.logger?.warn("conversation_active_job_read_failed");
        return undefined;
      });
  }

  /**
   * The recent dialogue for THIS turn's session, or nothing.
   *
   * Scoped by the session key the turn arrived on, so another conversation's
   * history is not reachable rather than filtered out afterwards.
   */
  private async readRecentTurns(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
    stored: ActiveConversationContext,
  ): Promise<readonly ConversationTurn[]> {
    // The turn being resolved was just recorded, and it already reaches the
    // resolver as `message`; the window is what came BEFORE it.
    const ownerTurns: readonly ConversationTurn[] = (stored.recentOwnerTurns ?? [])
      .slice(0, -1)
      .map((turn) => ({ role: "owner" as const, text: turn.text, at: turn.at }));
    const sessionKey = context.sessionKey?.trim();
    if (!this.deps.transcript || !sessionKey) {
      return ownerTurns;
    }
    // A LINE group puts every member on one session key, so persisted user
    // turns there have no provable author and the reader drops them; the owner
    // half comes from this layer's own record, where authorship is structural.
    const senderScope: ConversationSenderScope =
      event.isGroup === false ? "single-sender" : "shared";
    const transcriptTurns = await this.deps.transcript
      .readRecentTurns({
        sessionKey,
        ...(context.agentId?.trim() ? { agentId: context.agentId.trim() } : {}),
        limit: CONVERSATION_RECENT_TURN_LIMIT,
        senderScope,
      })
      .catch(() => {
        this.deps.logger?.warn("conversation_recent_turns_read_failed");
        return [] as readonly ConversationTurn[];
      });
    return mergeConversationTurns(transcriptTurns, ownerTurns, CONVERSATION_RECENT_TURN_LIMIT);
  }

  private async rememberJob(
    claim: StoryboardAccessClaim,
    stored: ActiveConversationContext,
    job: StoryboardVideoJobSnapshot,
  ): Promise<void> {
    const updatedAt = new Date(this.deps.now()).toISOString();
    const task: ConversationTaskRef = {
      taskType: "video_generation",
      taskId: job.jobId,
      status: job.status === "running" ? "running" : "resolved",
      label: `VIDEO ${job.draftId}`,
      updatedAt,
    };
    await this.write(claim, recordConversationTask(stored, task, updatedAt));
  }

  /** Names both readings in one line, using the owner's own words for each. */
  private clarifyBetween(job: StoryboardVideoJobSnapshot, question: ConversationQuestion): string {
    return ["ถามถึงอันไหน?", `1. สถานะของ VIDEO ${job.draftId}`, `2. ${question.prompt}`].join("\n");
  }

  /**
   * Characters and `VIDEO ####` codes the message names outright.
   *
   * Character names come from the Character Library, so this list is the
   * product's own vocabulary rather than anything hard-coded here.
   */
  private async detectEntities(
    content: string,
    claim: StoryboardAccessClaim,
  ): Promise<readonly EntityMention[]> {
    const mentions: EntityMention[] = [];
    const code = VIDEO_CODE.exec(content)?.[1];
    if (code) {
      mentions.push({ kind: "video_job", id: code, label: `VIDEO ${code}` });
    }
    const names = await this.deps.resolver
      .listCharacterNames(claim)
      .catch(() => [] as readonly string[]);
    for (const name of matchCharacterNames(content, names)) {
      mentions.push({ kind: "character", id: name, label: name });
    }
    return mentions;
  }
}

/**
 * A name is too short to be evidence of anything on its own.
 *
 * One character matches inside nearly every message, and a Character Library
 * entry that short cannot be told apart from ordinary text in either script.
 */
const CHARACTER_NAME_MIN_CHARS = 2;

/** Latin letters and digits, the run a name must not be spliced into. */
const LATIN_WORD_CHAR = /[0-9A-Za-z]/u;

/**
 * Whether `name` occurs in `text` as a name rather than as a fragment.
 *
 * Latin and digit names carry real collision risk — "F9" sits inside "F99", and
 * a code is exactly the kind of name owners pick — so a match may not be
 * extended by another Latin word character on either side. Thai script has no
 * word boundaries to test, so a Thai name is matched by containment; the
 * longest-name rule below is what protects those.
 */
function occursAsName(text: string, name: string): boolean {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return false;
    }
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const splicedLeft =
      LATIN_WORD_CHAR.test(needle[0]!) && before !== undefined && LATIN_WORD_CHAR.test(before);
    const splicedRight =
      LATIN_WORD_CHAR.test(needle[needle.length - 1]!) &&
      after !== undefined &&
      LATIN_WORD_CHAR.test(after);
    if (!splicedLeft && !splicedRight) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Character names this message actually names.
 *
 * Longest wins: when "Twong" and "Twong2" both match, only "Twong2" is a
 * mention, because the shorter name matched only as part of the longer one.
 * That single rule covers Thai names, where no boundary test is possible, and
 * doubles as a second guard for Latin ones.
 */
export function matchCharacterNames(content: string, names: readonly string[]): readonly string[] {
  const candidates = names
    .map((name) => name.trim())
    .filter((name) => name.length >= CHARACTER_NAME_MIN_CHARS && occursAsName(content, name));
  return candidates.filter(
    (name) =>
      !candidates.some(
        (other) => other !== name && other.toLowerCase().includes(name.toLowerCase()),
      ),
  );
}

/**
 * Resolves an answer against the question's DECLARED choices.
 *
 * Every branch reads a general property of the turn — its polarity, its
 * ordinal, its numeric value, whether it points back at what is already chosen
 * — and looks up what THIS question said that property means. No branch knows
 * any question by name, which is why a new bounded decision needs no code here.
 */
function matchQuestionChoice(
  question: ConversationQuestion,
  utterance: ConversationUtterance,
): ConversationChoice | undefined {
  if (utterance.ordinal !== undefined) {
    const picked = question.choices[utterance.ordinal - 1];
    if (picked) {
      return picked;
    }
  }
  // A number the owner said is content the answer has to account for. If this
  // question has no choice that MEANS that number, the message is not an answer
  // to it at all — "เอาเป็น 15 วิ" while a model question is open is a duration
  // request, not the agreement its "เอา" would otherwise look like. Declining
  // here is what stops a substantive message being collapsed into a bare choice.
  const valued = readSpokenValue(utterance.text);
  if (valued !== undefined) {
    return question.choices.find((choice) => choice.value === valued);
  }
  // "keep what we already have" only means something when the question proposed
  // changing something; against "is there speech?" it is not an answer at all.
  if (utterance.deixis === "same" && question.proposition === "change") {
    return question.choices.find((choice) => choice.role === "negate");
  }
  if (utterance.polarity) {
    return question.choices.find((choice) => choice.role === utterance.polarity);
  }
  return undefined;
}

/**
 * A number the owner said inside a longer answer ("เอา 15", "15 วิ").
 *
 * Only consulted against a question that declared numeric choices, so a number
 * in ordinary conversation cannot pick anything.
 */
function readSpokenValue(text: string): number | undefined {
  const match = /(?<!\d)(\d{1,3})(?!\d)/u.exec(text)?.[1];
  return match ? Number(match) : undefined;
}
