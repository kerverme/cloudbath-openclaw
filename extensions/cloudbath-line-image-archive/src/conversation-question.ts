/**
 * The bounded decisions this flow asks about, and the buttons that answer them.
 *
 * A question is DERIVED FROM STATE, never from the text of the reply that asked
 * it: the director session, the model-selection step and the active storyboard
 * already say what is open, and reading the reply string back would make the
 * buttons a second, drifting source of truth.
 *
 * Each choice carries `canonicalText` — the exact wording the owning handler
 * already parses. A chip and a typed answer therefore converge one step before
 * the handler, so buttons add no second implementation of any decision and can
 * never do something typing cannot.
 *
 * Nothing here is billable. The paid trigger stays the exact typed
 * `ยืนยัน VIDEO ####`; there is deliberately no chip for it, and
 * `assertNoPaidChoice` fails loudly if one is ever added.
 */

import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type {
  ActiveConversationContext,
  ConversationChoice,
  ConversationQuestion,
  ConversationProposition,
  ConversationQuestionId,
  ConversationQuestionStance,
  ConversationSubject,
} from "./conversation-context.js";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import { STORYBOARD_CONFIRMATION_PROMPT } from "./storyboard-confirmation.js";
import {
  DIRECTOR_QUESTION,
  nextDirectorSlot,
  STORYBOARD_DURATION_CHOICES,
  type StoryboardDirectorSession,
} from "./storyboard-director.js";
import { STORYBOARD_ASPECT_RATIOS, type ActiveStoryboardContext } from "./storyboard-types.js";

/**
 * Postback payload shape: a version tag, the question's nonce, and the choice
 * index. Nothing else — no project, storyboard or job id ever leaves the
 * server. The nonce is the handle; the question record it names carries the
 * subject and version, so a chip cannot describe work it was not offered for.
 */
const TOKEN_PREFIX = "cbq1";
const TOKEN_PATTERN = /^cbq1:([A-Za-z0-9_-]{6,64}):(\d{1,2})$/u;

/** The paid phrase, guarded against ever becoming a one-tap control. */
const PAID_CONFIRMATION = /ยืนยัน\s+VIDEO\s+\d{4}/iu;

export type ConversationPostbackToken = Readonly<{ nonce: string; choiceIndex: number }>;

export function parseConversationPostbackToken(
  content: string,
): ConversationPostbackToken | undefined {
  const match = TOKEN_PATTERN.exec(content.trim());
  return match ? { nonce: match[1]!, choiceIndex: Number(match[2]) } : undefined;
}

/** True for anything shaped like one of our chips, current or stale. */
export function looksLikeConversationPostback(content: string): boolean {
  return content.trim().startsWith(`${TOKEN_PREFIX}:`);
}

/**
 * Fails the build of any question that would put the paid phrase on a button.
 *
 * A guard rather than a convention: the whole safety story of this flow is that
 * money is spent only by an exact typed phrase, and a chip is one tap.
 */
function assertNoPaidChoice(choices: readonly ConversationChoice[]): void {
  for (const choice of choices) {
    if (PAID_CONFIRMATION.test(choice.canonicalText) || PAID_CONFIRMATION.test(choice.label)) {
      throw new Error("conversation choices must never carry the paid VIDEO confirmation");
    }
  }
}

type ChoiceSpec = Omit<ConversationChoice, "token">;

function buildQuestion(params: {
  id: ConversationQuestionId;
  stance: ConversationQuestionStance;
  proposition: ConversationProposition;
  prompt: string;
  subject: ConversationSubject;
  specs: readonly ChoiceSpec[];
  nonce: string;
  askedAt: string;
}): ConversationQuestion {
  const choices = Object.freeze(
    params.specs.map((spec, index) =>
      Object.freeze({ ...spec, token: `${TOKEN_PREFIX}:${params.nonce}:${index}` }),
    ),
  );
  assertNoPaidChoice(choices);
  return Object.freeze({
    id: params.id,
    stance: params.stance,
    proposition: params.proposition,
    prompt: params.prompt,
    subject: params.subject,
    choices,
    nonce: params.nonce,
    askedAt: params.askedAt,
  });
}

/** Yes/no over one proposition, in the order the owner reads them. */
function binarySpecs(params: {
  affirmLabel: string;
  affirmText: string;
  negateLabel: string;
  negateText: string;
}): readonly ChoiceSpec[] {
  return [
    { label: params.affirmLabel, role: "affirm", canonicalText: params.affirmText },
    { label: params.negateLabel, role: "negate", canonicalText: params.negateText },
  ];
}

export type ConversationQuestionState = Readonly<{
  director?: StoryboardDirectorSession;
  modelSelection?: StoryboardModelSelectionState;
  active?: ActiveStoryboardContext;
  activeVersionNumber?: number;
  /** Families currently compatible with the frozen scene, in preference order. */
  modelFamilies?: readonly Readonly<{ familyId: string; familyDisplayName: string }>[];
}>;

/**
 * The one question now open, or undefined when the owner owes no answer.
 *
 * Ordered by how narrow the commitment is: a model step is a live picker, a
 * director slot is a half-built request, and an active storyboard's standing
 * offer to confirm or revise is the broadest. Answering the narrowest first is
 * what stops a general "ok" from confirming a storyboard when the owner was
 * being asked which model family to use.
 */
export function deriveConversationQuestion(
  state: ConversationQuestionState,
  mint: Readonly<{ nonce: string; askedAt: string }>,
): ConversationQuestion | undefined {
  const modelStep = state.modelSelection;
  if (modelStep?.step === "default") {
    return buildQuestion({
      id: "model_default",
      stance: "asked",
      proposition: "change",
      prompt: "ใช้ Default Model หรือเปลี่ยน Model?",
      subject: {
        kind: "storyboard",
        id: modelStep.storyboardId,
        version: modelStep.frozenVersionNumber,
      },
      // The proposition is "change it", so the DEFAULT is the negating choice:
      // "ไม่เปลี่ยน" and "เอาตัวเดิม" both land here without either being wired
      // to the default by name.
      specs: binarySpecs({
        affirmLabel: "เปลี่ยน Model",
        affirmText: "เปลี่ยน Model",
        negateLabel: "ใช้ Default",
        negateText: "ใช้ Default",
      }),
      ...mint,
    });
  }
  if (modelStep?.step === "family" && state.modelFamilies?.length) {
    return buildQuestion({
      id: "model_family",
      stance: "asked",
      proposition: "change",
      prompt: "เลือกตระกูลโมเดล",
      subject: {
        kind: "storyboard",
        id: modelStep.storyboardId,
        version: modelStep.frozenVersionNumber,
      },
      // Only families the frozen scene can actually run on: the caller passes
      // what the registry answered, so an incompatible family is never offered.
      specs: state.modelFamilies.map((family, index) => ({
        label: family.familyDisplayName,
        role: "value" as const,
        canonicalText: String(index + 1),
        value: index + 1,
      })),
      ...mint,
    });
  }
  const director = state.director;
  if (director && !director.closed) {
    const slot = nextDirectorSlot(director);
    if (slot === "duration") {
      return buildQuestion({
        id: "duration",
        stance: "asked",
        proposition: "property",
        prompt: DIRECTOR_QUESTION.duration,
        subject: { kind: "storyboard", id: directorSubjectId(director) },
        specs: STORYBOARD_DURATION_CHOICES.map((seconds) => ({
          label: `${seconds} วิ`,
          role: "value" as const,
          canonicalText: `${seconds} วิ`,
          value: seconds,
        })),
        ...mint,
      });
    }
    if (slot === "dialogue") {
      return buildQuestion({
        id: "dialogue",
        stance: "asked",
        proposition: "property",
        prompt: DIRECTOR_QUESTION.dialogue,
        subject: { kind: "storyboard", id: directorSubjectId(director) },
        specs: binarySpecs({
          affirmLabel: "มีเสียงพูด",
          affirmText: "มี",
          negateLabel: "ไม่มีเสียงพูด",
          negateText: "ไม่มี",
        }),
        ...mint,
      });
    }
    // The dialogue LINE itself is free speech; there is nothing bounded to
    // offer, so the owner types it.
    return undefined;
  }
  if (state.active) {
    return buildQuestion({
      id: "storyboard_confirm",
      // Nothing was asked: the storyboard is on screen and these two controls
      // stay available until it moves on.
      stance: "standing",
      // Confirming is not a change to something settled: the storyboard is a
      // proposal, so "เอาอันเดิม" must not silently mean "do not confirm".
      proposition: "property",
      prompt: STORYBOARD_CONFIRMATION_PROMPT,
      subject: {
        kind: "storyboard",
        id: state.active.storyboardId,
        ...(state.activeVersionNumber === undefined ? {} : { version: state.activeVersionNumber }),
      },
      // "แก้ Storyboard" has no canonical single command — a revision names what
      // to change — so the negating choice prompts for that instead of pretending
      // to be one. It is a `negate` role so "ยังไม่เอา" reaches it.
      specs: binarySpecs({
        affirmLabel: "ยืนยัน Storyboard",
        affirmText: "ยืนยัน Storyboard",
        negateLabel: "แก้ Storyboard",
        negateText: "แก้ Storyboard",
      }),
      ...mint,
    });
  }
  return undefined;
}

/** Stable per-request subject id for a director session that has no storyboard yet. */
function directorSubjectId(session: StoryboardDirectorSession): string {
  return `director:${session.accountId}:${session.lineGroupId}:${session.ownerSenderId}`;
}

/** The aspect ratios the product offers, for the question that asks for one. */
export function aspectRatioChoiceSpecs(): readonly ChoiceSpec[] {
  return STORYBOARD_ASPECT_RATIOS.map((ratio, index) => ({
    label: ratio,
    role: "value" as const,
    canonicalText: ratio,
    value: index + 1,
  }));
}

/**
 * The question's controls as portable actions.
 *
 * Callback actions only: each channel decides how to render them (LINE makes
 * postback quick replies), and a channel that renders nothing still shows the
 * question text, which every choice can also be answered by typing.
 */
export function conversationQuestionPresentation(
  question: ConversationQuestion,
): MessagePresentation {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: question.choices.map((choice) => ({
          label: choice.label,
          action: { type: "callback", value: choice.token },
        })),
      },
    ],
  };
}

/**
 * The choice a current chip names, or undefined when the chip is stale.
 *
 * Staleness is structural: a new question mints a new nonce, so a chip from an
 * older step cannot match the open one and is rejected without ever reaching a
 * handler. That is also why the payload needs no id of its own.
 */
export function resolveConversationPostback(
  context: ActiveConversationContext,
  token: ConversationPostbackToken,
): ConversationChoice | undefined {
  const question = context.question;
  if (!question || question.nonce !== token.nonce) {
    return undefined;
  }
  return question.choices[token.choiceIndex];
}
