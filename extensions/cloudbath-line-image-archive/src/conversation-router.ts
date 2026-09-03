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
  classifyConversationUtterance,
  type ConversationUtterance,
} from "./conversation-utterance.js";
import {
  storyboardModelSelectionKey,
  type StoryboardModelSelectionStore,
} from "./storyboard-confirmation.js";
import { storyboardDirectorKey, type StoryboardDirectorSession } from "./storyboard-director.js";
import {
  resolveStoryboardAccessClaim,
  type StoryboardDispatchContext,
  type StoryboardDispatchEvent,
  type StoryboardProjectResolver,
} from "./storyboard-line-router.js";
import {
  tryGetStoryboardPaidDraftRuntime,
  type StoryboardPaidDraftRuntime,
  type StoryboardVideoJobSnapshot,
} from "./storyboard-paid-draft-runtime.js";
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

const STALE_POSTBACK_REPLY = "ปุ่มนี้เป็นของขั้นตอนก่อนหน้า ใช้ไม่ได้แล้ว — พิมพ์คำตอบล่าสุดได้เลย";

export type ConversationTurnResolution =
  /** Hand this turn to the existing handler with wording it already parses. */
  | Readonly<{ kind: "rewrite"; canonicalText: string }>
  /** The arbiter answers. Only status and stale-chip replies take this path. */
  | Readonly<{ kind: "answer"; text: string }>
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
  now: () => number;
  /** Question nonces. Must be unguessable enough that chips do not collide. */
  randomId: () => string;
  logger?: Pick<SafeLogger, "warn">;
}>;

type EntityMention = Readonly<{ kind: SemanticReferentType; id: string; label: string }>;

export class CloudbathConversationRouter {
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
    const binding = await this.deps.registry.lookup(claim.accountId, claim.lineGroupId);
    if (binding?.policyId !== "UGC" || binding.boundByOwnerId !== claim.ownerSenderId) {
      return { kind: "pass" };
    }
    const content = event.content ?? "";
    const stored = await this.readContext(claim);

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
    const entities = await this.detectEntities(content, claim);

    // 2. Something named outright outranks anything remembered. "F99 บันทึกเสร็จยัง"
    // is about F99 whatever job is running, so the video path must not take it.
    const namedVideoCode = entities.find((entity) => entity.kind === "video_job");
    if (entities.length > 0 && !namedVideoCode) {
      return { kind: "pass" };
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
        return { kind: "pass" };
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
    const conversational =
      utterance.polarity !== undefined ||
      utterance.ordinal !== undefined ||
      utterance.deixis !== undefined ||
      utterance.progressInquiry;
    if (!conversational || !this.deps.semanticResolver) {
      return { kind: "pass" };
    }
    const unresolved = unresolvedConversationTasks(stored);
    if (!question && unresolved.length === 0) {
      return { kind: "pass" };
    }
    const resolution = await this.deps.semanticResolver.resolve({
      message: utterance.text,
      context: stored,
      unresolvedTasks: unresolved,
      ...(question ? { question } : {}),
      recentTurns: [],
      entities,
    });
    if (!resolution) {
      return { kind: "pass" };
    }
    if (resolution.needsClarification || resolution.confidence < SEMANTIC_CONFIDENCE_FLOOR) {
      return question
        ? { kind: "clarify", text: `ยังไม่แน่ใจว่าหมายถึงอะไร — ${question.prompt}` }
        : { kind: "pass" };
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
            }
          : {}),
        ...(director?.durationSeconds === undefined
          ? {}
          : { durationSeconds: director.durationSeconds }),
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
    const lowered = content.toLowerCase();
    for (const name of names) {
      const needle = name.trim().toLowerCase();
      if (needle && lowered.includes(needle)) {
        mentions.push({ kind: "character", id: name, label: name });
      }
    }
    return mentions;
  }
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
  const valued = readSpokenValue(utterance.text);
  if (valued !== undefined) {
    const match = question.choices.find((choice) => choice.value === valued);
    if (match) {
      return match;
    }
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
