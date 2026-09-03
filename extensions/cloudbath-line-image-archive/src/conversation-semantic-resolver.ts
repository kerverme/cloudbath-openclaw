/**
 * The last step before giving up: ask the model what the owner meant.
 *
 * It is reached only when deterministic arbitration cannot decide, and it
 * decides MEANING ONLY. Two structural guards, not conventions, keep it there:
 *
 *  - the result is a closed shape (a fixed intent enum, a referent id, and at
 *    most one requested action), so there is no field through which a free-form
 *    instruction could travel; and
 *  - `requestedAction` is accepted only when it is character-for-character one
 *    of the choices the CURRENT open question offered. Anything else is
 *    discarded, so the model can pick between doors this flow already opened
 *    and can never open one of its own — including the paid one, which is never
 *    an offered choice.
 *
 * It therefore cannot spend money, cannot write to any store, and cannot name a
 * storyboard, project or job the arbiter did not put in front of it.
 */

import type {
  ActiveConversationContext,
  ConversationQuestion,
  ConversationTaskRef,
} from "./conversation-context.js";
import type { StoryboardPlannerComplete } from "./storyboard-planner.js";

/** What the model is allowed to conclude the turn is. */
export type SemanticIntent =
  | "answer_question"
  | "task_status"
  | "revise_active_storyboard"
  | "new_request"
  | "unrelated";

export type SemanticReferentType = "storyboard" | "video_job" | "character" | "project" | "none";

export type SemanticResolution = Readonly<{
  intent: SemanticIntent;
  referentType: SemanticReferentType;
  /** Must be one the input offered; the arbiter re-checks it. */
  referentId?: string;
  /** Must equal one offered choice's canonical text, or it is dropped. */
  requestedAction?: string;
  confidence: number;
  needsClarification: boolean;
}>;

export type SemanticResolutionInput = Readonly<{
  message: string;
  context: ActiveConversationContext;
  unresolvedTasks: readonly ConversationTaskRef[];
  question?: ConversationQuestion;
  /** Newest last, already trimmed by the caller. */
  recentTurns: readonly Readonly<{ role: "owner" | "assistant"; text: string }>[];
  /** Entities the deterministic pass already found in the message. */
  entities: readonly Readonly<{ kind: SemanticReferentType; id: string; label: string }>[];
}>;

export type ConversationSemanticResolver = Readonly<{
  resolve(input: SemanticResolutionInput): Promise<SemanticResolution | undefined>;
}>;

/**
 * Below this the arbiter asks instead of acting.
 *
 * A wrong referent is not a small error here: it means answering about the
 * wrong piece of work, which is exactly the failure this layer exists to stop.
 */
export const SEMANTIC_CONFIDENCE_FLOOR = 0.6;

const INTENTS = new Set<SemanticIntent>([
  "answer_question",
  "task_status",
  "revise_active_storyboard",
  "new_request",
  "unrelated",
]);
const REFERENTS = new Set<SemanticReferentType>([
  "storyboard",
  "video_job",
  "character",
  "project",
  "none",
]);

const SYSTEM_PROMPT = [
  "You resolve what a chat message REFERS TO in an ongoing video-production conversation.",
  "You never decide to spend money, never invent work, and never write anything.",
  "Reply with ONLY a JSON object of this exact shape:",
  '{"intent":"answer_question|task_status|revise_active_storyboard|new_request|unrelated",',
  '"referentType":"storyboard|video_job|character|project|none","referentId":"<id from context or omit>",',
  '"requestedAction":"<one offered choice, copied exactly, or omit>","confidence":0.0,',
  '"needsClarification":true|false}',
  "Use requestedAction ONLY when the message answers the open question, and copy an offered choice verbatim.",
  "If two referents are equally plausible, set needsClarification true and lower confidence.",
].join("\n");

function renderInput(input: SemanticResolutionInput): string {
  const question = input.question;
  return JSON.stringify({
    message: input.message,
    openQuestion: question
      ? {
          id: question.id,
          prompt: question.prompt,
          subject: question.subject,
          offeredChoices: question.choices.map((choice) => choice.canonicalText),
        }
      : null,
    unresolvedTasks: input.unresolvedTasks.map((task) => ({
      taskType: task.taskType,
      taskId: task.taskId,
      status: task.status,
      label: task.label,
    })),
    activeStoryboardId: input.context.activeStoryboardId ?? null,
    activeStoryboardVersion: input.context.activeStoryboardVersion ?? null,
    activeProjectId: input.context.activeProjectId ?? null,
    activeCharacters: input.context.activeCharacters ?? [],
    entitiesInMessage: input.entities,
    recentTurns: input.recentTurns,
  });
}

function parseResolution(text: string): SemanticResolution | undefined {
  let value: unknown;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/iu, "")
        .replace(/\s*```$/u, ""),
    );
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const intent = record.intent;
  const referentType = record.referentType;
  const confidence = record.confidence;
  if (
    typeof intent !== "string" ||
    !INTENTS.has(intent as SemanticIntent) ||
    typeof referentType !== "string" ||
    !REFERENTS.has(referentType as SemanticReferentType) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence)
  ) {
    return undefined;
  }
  const referentId = typeof record.referentId === "string" ? record.referentId.trim() : "";
  const requestedAction =
    typeof record.requestedAction === "string" ? record.requestedAction.trim() : "";
  return Object.freeze({
    intent: intent as SemanticIntent,
    referentType: referentType as SemanticReferentType,
    ...(referentId ? { referentId } : {}),
    ...(requestedAction ? { requestedAction } : {}),
    confidence: Math.min(1, Math.max(0, confidence)),
    needsClarification: record.needsClarification === true,
  });
}

/**
 * Model-backed resolver over the same completion seam the beat planner uses.
 *
 * A failed or unparseable completion returns undefined rather than throwing:
 * the arbiter then asks the owner, which is the correct outcome for "we do not
 * know what this meant".
 */
export function createConversationSemanticResolver(
  complete: StoryboardPlannerComplete,
): ConversationSemanticResolver {
  return {
    resolve: async (input) => {
      try {
        const { text } = await complete({
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: renderInput(input) }],
          maxTokens: 400,
          temperature: 0,
          purpose: "cloudbath-conversation-referent",
        });
        return parseResolution(text);
      } catch {
        return undefined;
      }
    },
  };
}
