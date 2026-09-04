/**
 * LINE rendering for storyboards and Final Video Drafts.
 *
 * Formatting is the LAST step and is derived entirely from the structured
 * document — prose is never the source of truth, and nothing here is persisted
 * as the storyboard itself.
 */

import { STORYBOARD_CONFIRMATION_PROMPT } from "./storyboard-confirmation.js";
import type {
  StoryboardAudioMode,
  StoryboardCostEstimate,
  StoryboardDraftConfirmation,
  StoryboardDocument,
  StoryboardFinalVideoDraft,
  StoryboardVideoModelSelection,
} from "./storyboard-types.js";

/** Owner-facing wording for the scene audio decision. */
const AUDIO_MODE_LABELS: Readonly<Record<StoryboardAudioMode, string>> = Object.freeze({
  off: "ไม่มีเสียง",
  ambient: "มีเสียงประกอบ ไม่มีเสียงพูด",
  full: "มีเสียง",
});

function beatBlock(document: StoryboardDocument): string[] {
  return document.beats.flatMap((beat) => {
    const heading = beat.environmentNote
      ? `${beat.framing} — ${beat.environmentNote}`
      : beat.framing;
    return [
      "",
      `${beat.startSeconds}–${beat.endSeconds} วิ`,
      heading,
      beat.action,
      // SPEECH and SOUND are labelled apart. One shared "เสียง:" line is what
      // made "มีเสียง" and "มีบทพูด" read identically to the owner.
      ...(beat.dialogue ? [`พูด: ${beat.dialogue}`] : []),
      ...(beat.soundDesign ? [`เสียง: ${beat.soundDesign}`] : []),
      ...(beat.camera && beat.camera !== "Static" ? [`กล้อง: ${beat.camera}`] : []),
    ];
  });
}

/** Renders one storyboard version for LINE. */
export function formatStoryboardForLine(params: {
  versionNumber: number;
  document: StoryboardDocument;
}): string {
  const { document } = params;
  const lines = [
    `🎬 Storyboard v${params.versionNumber} — ${document.durationSeconds} วิ · ${document.aspectRatio}`,
    ...(document.environment ? [`สถานที่: ${document.environment}`] : []),
    `เสียง: ${AUDIO_MODE_LABELS[document.audio]}`,
    ...beatBlock(document),
    "",
    "ตัวละคร:",
    ...document.cast.map((member) => `${member.displayName} · ${member.characterId}`),
    "",
    "พิมพ์แก้ได้ เช่น:",
    // The LAST beat's own window is always a valid range, including on a
    // single-beat storyboard where "first beat end -> duration" would be empty
    // and the router would reject the hint it just printed.
    `“วิ ${document.beats.at(-1)?.startSeconds ?? 0}-${document.durationSeconds} ให้เปลี่ยนเป็น close-up”`,
    "",
    // Content confirmation, which costs nothing. The paid code does not exist
    // yet and is not mentioned: no model has been chosen and nothing is quoted.
    STORYBOARD_CONFIRMATION_PROMPT,
  ];
  return lines.join("\n");
}

/**
 * The model line on a Final Video Draft.
 *
 * Shows the provider AND the exact endpoint id, never a friendly name alone:
 * the owner is about to authorise a charge, and the thing they authorise must
 * be the thing that receives the request. No display-name-only shorthand, and
 * no translation between what is shown and what is submitted.
 */
function formatModel(model: StoryboardVideoModelSelection): string {
  return model.kind === "provider-bound"
    ? `${model.displayName}\nEndpoint: ${model.provider} · ${model.providerModelId}`
    : `${model.displayName} (ยังไม่ผูกกับผู้ให้บริการ)`;
}

function formatCost(estimate: StoryboardCostEstimate): string {
  return estimate.kind === "available"
    ? `ราคาโดยประมาณ: ~$${estimate.amountUsd.toFixed(2)}`
    : "ราคาโดยประมาณ: ยังไม่พร้อมใช้งาน";
}

/**
 * Confirmation instructions, or an honest statement that it is not wired yet.
 *
 * The exact `ยืนยัน VIDEO ####` phrase is only printed for a draft the paid
 * gate can actually resolve. Printing it for a deferred draft would either
 * dead-end or, on a code collision, confirm somebody else\'s pending job.
 */
function confirmationLines(confirmation: StoryboardDraftConfirmation): readonly string[] {
  return confirmation.kind === "ready"
    ? ["ยืนยันด้วยข้อความนี้:", `ยืนยัน VIDEO ${confirmation.code}`]
    : ["การยืนยันเพื่อสร้างวิดีโอจริงยังไม่เปิดใช้งาน (รอเชื่อมต่อผู้ให้บริการ)"];
}

/**
 * Renders a Final Video Draft.
 *
 * The message states plainly that nothing has been generated or charged yet, so
 * the owner is never left believing the draft alone started a paid job.
 */
export function formatFinalVideoDraftForLine(draft: StoryboardFinalVideoDraft): string {
  return [
    "🎬 Final Video Draft",
    `Storyboard v${draft.storyboardVersionNumber}`,
    `Strategy: ${draft.renderStrategy === "quick_video" ? "Quick Video" : "Best Quality / Shot-by-Shot"}`,
    `Input mode: ${draft.inputMode.replaceAll("_", "-")}`,
    `ความยาว: ${draft.durationSeconds} วิ · ${draft.aspectRatio} · ${draft.resolution}`,
    `โมเดล: ${formatModel(draft.model)}`,
    formatCost(draft.estimatedCost),
    "",
    "ตัวละคร:",
    ...draft.plan.characters.map(
      (character) => `${character.displayName} · ${character.characterId}`,
    ),
    "",
    "ยังไม่มีการสร้างวิดีโอและยังไม่มีการคิดค่าใช้จ่าย",
    "",
    ...confirmationLines(draft.confirmation),
  ].join("\n");
}
