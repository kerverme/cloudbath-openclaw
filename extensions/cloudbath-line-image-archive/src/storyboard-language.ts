/**
 * Owner-facing Thai text built from storyboard STRUCTURED fields.
 *
 * The planner prompt is English-framed and never constrained its OUTPUT
 * language, so a Thai request produced Thai prose carrying stray Latin (and
 * occasionally other-script) fragments, which was then persisted into the
 * document and echoed to LINE. Regenerating the owner-facing text from the
 * document instead of echoing planner prose removes most of that surface:
 * everything except the scene description is a fixed Thai template or a
 * number.
 *
 * Script validation itself is generic and lives in `line-language.ts`; this
 * module is the one surface that can REGENERATE its text, which is why it can
 * offer a rebuild to the outbound guard.
 */
import {
  isThaiText,
  LINE_PRODUCT_TERMS,
  stripForeignFragments,
  validateThaiText,
  type ThaiValidationOptions,
} from "./line-language.js";
import type { StoryboardBeatKind } from "./storyboard-types.js";

/** The structured facts a Thai scene line is built from. */
export type StoryboardSummaryBeat = Readonly<{
  shotIndex: number;
  startSeconds: number;
  endSeconds: number;
  kind: StoryboardBeatKind;
  action: string;
  caption?: string;
  characterNames?: readonly string[];
}>;

/** Fixed Thai wording per beat kind. A closed union, so no beat can invent one. */
const KIND_LABEL: Readonly<Record<StoryboardBeatKind, string>> = Object.freeze({
  establishing: "ปูฉาก",
  locomotion: "เคลื่อนไหว",
  transition: "เปลี่ยนฉาก",
  dialogue: "บทพูด",
  action: "แอ็กชัน",
});

/**
 * Builds the owner-facing Thai scene list from STRUCTURED fields.
 *
 * Preferred over echoing planner prose because every part except the scene
 * description is a fixed Thai template or a number, so the only text that can
 * carry contamination is the one field validated and repaired below. Scene
 * ids, timings and cast names pass through untouched — this renames nothing.
 */
export function buildThaiStoryboardSummary(
  beats: readonly StoryboardSummaryBeat[],
  options: ThaiValidationOptions = {},
): string {
  return beats
    .map((beat) => {
      const description = repairThaiFragment(beat.caption?.trim() || beat.action, options);
      const cast = beat.characterNames?.length ? ` (${beat.characterNames.join(", ")})` : "";
      return `ฉาก ${beat.shotIndex} · ${beat.startSeconds}-${beat.endSeconds} วิ · ${KIND_LABEL[beat.kind]}${cast}\n${description}`;
    })
    .join("\n\n");
}

/**
 * Returns Thai text safe to show, repairing it when contaminated.
 *
 * Stripping is acceptable HERE and nowhere else on the outbound path: the
 * input is one structured field, not a sentence whose meaning the caller is
 * relaying, and the caller can fall back to another field when stripping
 * leaves nothing.
 */
export function repairThaiFragment(text: string, options: ThaiValidationOptions = {}): string {
  const value = text.trim();
  if (validateThaiText(value, options).kind === "clean") {
    return value;
  }
  return stripForeignFragments(value, options);
}

/**
 * The owner-facing Thai scene list for a whole version, or undefined when this
 * storyboard is not Thai.
 *
 * One implementation shared by the tool result and the outbound guard: if the
 * relay ever rebuilt a different summary than the tool advertised, the owner
 * would see the text change for no reason they can observe.
 */
export function thaiSummaryForVersion(version: {
  document: {
    beats: readonly Readonly<{
      startSeconds: number;
      endSeconds: number;
      kind: StoryboardBeatKind;
      action: string;
      caption?: string;
    }>[];
    cast: readonly Readonly<{ displayName: string }>[];
  };
  characterLocks: readonly Readonly<{ code: string }>[];
}): string | undefined {
  const beats = version.document.beats;
  if (!beats.some((beat) => isThaiText(beat.caption ?? beat.action))) {
    return undefined;
  }
  return buildThaiStoryboardSummary(
    beats.map((beat, index) => ({
      shotIndex: index + 1,
      startSeconds: beat.startSeconds,
      endSeconds: beat.endSeconds,
      kind: beat.kind,
      action: beat.action,
      caption: beat.caption ?? "",
    })),
    { allowedTerms: storyboardAllowedTerms(version) },
  );
}

/** Product vocabulary plus the cast and codes THIS storyboard declares. */
export function storyboardAllowedTerms(version: {
  document: { cast: readonly Readonly<{ displayName: string }>[] };
  characterLocks: readonly Readonly<{ code: string }>[];
}): readonly string[] {
  return [
    ...LINE_PRODUCT_TERMS,
    ...version.document.cast.map((member) => member.displayName),
    ...version.characterLocks.map((lock) => lock.code),
  ].filter(Boolean);
}
