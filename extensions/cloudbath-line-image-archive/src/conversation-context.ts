/**
 * The owner's Active Conversation Context: what "it", "that one" and "yet?"
 * are currently about.
 *
 * Every feature in this flow already has an authoritative store — projects and
 * scenes live in Notion, storyboard versions in the storyboard store, paid jobs
 * in the LINE plugin's job store. This record deliberately holds NONE of that
 * content. It holds the references (ids) plus the few facts that only exist in
 * the conversation itself: which question is currently open, which choices were
 * offered with it, and which tasks the owner has not yet seen the end of.
 *
 * That split is the point. A duplicated storyboard body or job status would go
 * stale the moment its owner store moved; an id cannot. Anything read back out
 * of here is re-resolved against the store that owns it.
 *
 * Scoped exactly like a storyboard — account + LINE conversation + owner — so
 * one owner's context can never answer for another's, and nothing here is
 * reachable by a non-owner at all.
 */

import type { StoryboardAccessClaim } from "./storyboard-types.js";
import type { AsyncKeyedStore } from "./types.js";

export const CLOUDBATH_CONVERSATION_CONTEXT_NAMESPACE = "cloudbath-conversation-context-v1";
/**
 * Long enough to walk away from a chat and come back to it, short enough that
 * a question asked yesterday cannot capture today's first message.
 */
export const CLOUDBATH_CONVERSATION_CONTEXT_TTL_MS = 6 * 60 * 60 * 1_000;

/** Kinds of work the owner can be in the middle of, across features. */
export type ConversationTaskType = "video_generation" | "storyboard" | "character_save";

/**
 * Whether the owner has seen this task end.
 *
 * `unresolved` is not "running": a task that failed but has never been reported
 * is still what a bare "ยัง?" is most likely about.
 */
export type ConversationTaskStatus = "pending" | "running" | "resolved";

export type CreativeArtifactRef = Readonly<{
  artifactId: string;
  kind: "generated_image" | "source_image" | "storyboard_shot" | "storyboard_contact_sheet";
  createdAt: string;
}>;

export type ActiveCreativeWork = Readonly<{
  workId: string;
  kind: "image" | "storyboard" | "video";
  status: "open" | "resolved";
  storyboardId?: string;
  storyboardVersionNumber?: number;
  projectInstanceId?: string;
  updatedAt: string;
}>;

/**
 * One task, by reference.
 *
 * `label` is what the OWNER calls it ("F99", "VIDEO 9566") and is the only
 * string an arbitration step may match a message against; `taskId` is the
 * internal handle used to re-read the authoritative store.
 */
export type ConversationTaskRef = Readonly<{
  taskType: ConversationTaskType;
  taskId: string;
  status: ConversationTaskStatus;
  label: string;
  updatedAt: string;
}>;

/**
 * Which question the assistant last asked.
 *
 * A question is identified, not quoted: the id says what is being decided and
 * `subject` says what it is being decided ABOUT, so an answer can be checked
 * against the subject it was offered for rather than against whatever is active
 * by the time it arrives.
 */
export type ConversationQuestionId =
  | "duration"
  | "dialogue"
  | "storyboard_confirm"
  | "model_default"
  | "model_family"
  | "audio"
  | "aspect_ratio";

export type ConversationSubject = Readonly<{
  kind: "storyboard" | "video_job" | "character";
  id: string;
  /** Storyboard version the question was asked about, when it has one. */
  version?: number;
}>;

/**
 * What one offered choice means, in terms general enough to resolve an answer
 * that does not repeat the label.
 *
 * `role` is the whole reason this flow does not need a phrase table. A binary
 * question declares which of its choices AFFIRMS its proposition and which
 * NEGATES it, so a general negation ("ไม่เปลี่ยน", "ไม่เอา", "no") resolves to
 * the negating choice of whatever question happens to be open. `value` choices
 * are picked by their ordinal or by the value itself.
 */
export type ConversationChoiceRole = "affirm" | "negate" | "value";

export type ConversationChoice = Readonly<{
  /** Shown on the button and in the numbered list. Never an internal id. */
  label: string;
  role: ConversationChoiceRole;
  /**
   * The text the owning handler already understands. Resolution rewrites the
   * turn to this, so a button and a typed answer run the exact same code.
   */
  canonicalText: string;
  /** Postback payload for this chip. Opaque; see conversation-question.ts. */
  token: string;
  /** Numeric meaning for `value` choices, e.g. 15 seconds. */
  value?: number;
}>;

/**
 * What the affirm/negate pair is about.
 *
 * `change` questions propose altering something already settled, so "keep it as
 * it is" ("เอาตัวเดิม", "same") means the NEGATING choice. `property` questions
 * ask whether the work has some attribute, where "the same one" means nothing.
 * One flag, so a general keep-it utterance resolves without knowing which
 * question is open.
 */
export type ConversationProposition = "change" | "property";

/**
 * Whether the assistant is WAITING for this answer.
 *
 * `asked` means the last reply put the question to the owner, so their next
 * turn may be read as an answer to it by utterance class alone. `standing` is
 * an offer that simply remains available — "confirm this, or tell me what to
 * change" — and must NOT capture the next turn that way: a refusal while a
 * storyboard is on screen is nearly always the change itself ("ไม่เอาเสียงพูด"),
 * not a request to be asked what to change. A standing offer still renders its
 * chips, and a chip is still resolved exactly, because tapping one is
 * unambiguous in a way a sentence is not.
 */
export type ConversationQuestionStance = "asked" | "standing";

export type ConversationQuestion = Readonly<{
  id: ConversationQuestionId;
  stance: ConversationQuestionStance;
  proposition: ConversationProposition;
  /** The question as it was asked, for a clarification that has to repeat it. */
  prompt: string;
  subject: ConversationSubject;
  choices: readonly ConversationChoice[];
  /** Minted with the question; a chip from an older question cannot match it. */
  nonce: string;
  askedAt: string;
}>;

/** One remembered owner message. `at` is epoch ms, for interleaving. */
export type ConversationOwnerTurn = Readonly<{ text: string; at: number }>;

/** Enough to resolve a reference back, and short enough to stay a hint. */
const MAX_OWNER_TURNS = 6;
/** One turn is a line of chat; a longer one is cut, not dropped. */
const OWNER_TURN_MAX_CHARS = 400;

/** How many tasks are remembered. Older ones are re-derivable from their store. */
const MAX_REMEMBERED_TASKS = 5;

export type ActiveConversationContext = Readonly<{
  version: 1;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  /** Most recent first. Bounded; the authoritative stores keep the history. */
  tasks: readonly ConversationTaskRef[];
  /** One authoritative referent shared by every creative specialist. */
  currentWork?: ActiveCreativeWork;
  /** Most recent generated image explicitly registered by the image workflow. */
  latestGeneratedImage?: CreativeArtifactRef;
  latestStoryboardId?: string;
  latestStoryboardVersion?: number;
  latestStoryboardVisualVersion?: number;
  latestFinalVideoDraft?: Readonly<{
    draftId: string;
    storyboardId: string;
    storyboardVersionNumber: number;
  }>;
  /** Explicit source choice; never inferred from an arbitrary attachment. */
  selectedSourceArtifact?: CreativeArtifactRef;
  /** Notion project instance the active work belongs to. */
  activeProjectId?: string;
  /** Canonical Character codes frozen into that project. */
  activeCharacters?: readonly string[];
  activeStoryboardId?: string;
  activeStoryboardVersion?: number;
  /** Endpoint id the owner settled on, once they have. */
  selectedVideoModel?: string;
  durationSeconds?: number;
  resolution?: string;
  /** Where the flow stands, for a status answer that has no job to read. */
  currentStage?: string;
  question?: ConversationQuestion;
  /**
   * The bound owner's own recent messages, newest last.
   *
   * Attributed BY CONSTRUCTION, not by inference: a turn only reaches this
   * record after the arbiter has verified it came from the bound owner of this
   * account + conversation, so every entry has a proven author. That is the
   * whole reason it exists — a LINE group routes every member onto one session
   * key, and the canonical transcript's user messages carry no author, so
   * reading owner turns back out of the transcript would attribute another
   * member's words to the owner.
   *
   * It is not a transcript: bounded, text only, owner side only, and never read
   * by anything but the semantic step's prompt.
   */
  recentOwnerTurns?: readonly ConversationOwnerTurn[];
  updatedAt: string;
}>;

export type ConversationContextStore = AsyncKeyedStore<ActiveConversationContext>;

export function conversationContextKey(claim: StoryboardAccessClaim): string {
  return `conversation:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}`;
}

export function emptyConversationContext(
  claim: StoryboardAccessClaim,
  updatedAt: string,
): ActiveConversationContext {
  return Object.freeze({
    version: 1 as const,
    accountId: claim.accountId,
    lineGroupId: claim.lineGroupId,
    ownerSenderId: claim.ownerSenderId,
    tasks: Object.freeze([]),
    updatedAt,
  });
}

/**
 * Owner-scoped read: a record written for another owner or group is treated as
 * absent rather than merged, so a mis-scoped row can never leak referents.
 */
export function ownsConversationContext(
  context: ActiveConversationContext | undefined,
  claim: StoryboardAccessClaim,
): context is ActiveConversationContext {
  return (
    context !== undefined &&
    context.accountId === claim.accountId &&
    context.lineGroupId === claim.lineGroupId &&
    context.ownerSenderId === claim.ownerSenderId
  );
}

/**
 * Fields a caller may set. `question: null` clears the open question, which is
 * distinct from "leave it alone" — closing a question is an explicit act.
 */
export type ConversationContextPatch = Partial<
  Omit<
    ActiveConversationContext,
    "version" | "accountId" | "lineGroupId" | "ownerSenderId" | "tasks" | "updatedAt" | "question"
  >
> &
  Readonly<{ question?: ConversationQuestion | null }>;

export function mergeConversationContext(
  context: ActiveConversationContext,
  patch: ConversationContextPatch,
  updatedAt: string,
): ActiveConversationContext {
  const { question, ...rest } = patch;
  const next: Record<string, unknown> = { ...context, ...rest, updatedAt };
  if (question === null) {
    delete next.question;
  } else if (question !== undefined) {
    next.question = question;
  }
  return Object.freeze(next as unknown as ActiveConversationContext);
}

/**
 * Records a task, replacing any earlier entry for the same id.
 *
 * Replacement rather than append: one job has one current status, and two rows
 * for it would make "the most recent unresolved task" answerable two ways.
 */
export function recordConversationTask(
  context: ActiveConversationContext,
  task: ConversationTaskRef,
  updatedAt: string,
): ActiveConversationContext {
  const rest = context.tasks.filter(
    (existing) => !(existing.taskType === task.taskType && existing.taskId === task.taskId),
  );
  return Object.freeze({
    ...context,
    tasks: Object.freeze([task, ...rest].slice(0, MAX_REMEMBERED_TASKS)),
    updatedAt,
  });
}

/**
 * Appends one message the arbiter has already proven the owner authored.
 *
 * Consecutive duplicates are collapsed so a retried webhook delivery cannot
 * make the owner look like they said the same thing twice.
 */
export function recordOwnerTurn(
  context: ActiveConversationContext,
  text: string,
  at: number,
): ActiveConversationContext {
  const trimmed = text.trim().slice(0, OWNER_TURN_MAX_CHARS);
  const existing = context.recentOwnerTurns ?? [];
  if (!trimmed || existing.at(-1)?.text === trimmed) {
    return context;
  }
  return Object.freeze({
    ...context,
    recentOwnerTurns: Object.freeze([...existing, { text: trimmed, at }].slice(-MAX_OWNER_TURNS)),
  });
}

/** Tasks the owner has not seen the end of, most recent first. */
export function unresolvedConversationTasks(
  context: ActiveConversationContext,
): readonly ConversationTaskRef[] {
  return context.tasks.filter((task) => task.status !== "resolved");
}
