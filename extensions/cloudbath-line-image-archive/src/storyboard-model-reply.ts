/**
 * LINE rendering for the post-freeze model conversation.
 *
 * Everything here is derived from what the LINE plugin reported about fal's
 * registry. This plugin names no model, family or price of its own: it renders
 * the choices it was handed, so a registry change shows up in the chat without
 * a change here.
 */

/** One choice as the LINE side described it. */
export type StoryboardModelOption = Readonly<{
  modelId: string;
  displayName: string;
  familyId: string;
  familyDisplayName: string;
}>;

export type StoryboardModelFamilyOption = Readonly<{ id: string; displayName: string }>;

function numbered(labels: readonly string[]): string[] {
  return labels.map((label, index) => `${index + 1}. ${label}`);
}

/**
 * The default offer, with an explanation when it is not the usual default.
 *
 * `displacedReason` is rendered as the owner's own sentence rather than a
 * reason code: being told "H3 does not reach 30 seconds, so this scene
 * defaults to X" is what makes a different model feel like a decision instead
 * of a substitution.
 */
export function formatStoryboardModelDefault(params: {
  model: StoryboardModelOption;
  estimatedCostUsd?: number;
  displacedReason?: string;
}): string {
  return [
    ...(params.displacedReason ? [params.displacedReason, ""] : []),
    `Default Model: ${params.model.displayName}`,
    ...(params.estimatedCostUsd === undefined
      ? []
      : [`ราคาโดยประมาณ: ~$${params.estimatedCostUsd.toFixed(2)}`]),
    "",
    "ใช้ Default Model หรือเปลี่ยน Model?",
  ].join("\n");
}

/** The family menu. Only families with a compatible model are ever passed in. */
export function formatStoryboardModelFamilies(
  families: readonly StoryboardModelFamilyOption[],
): string {
  return [
    "เลือกค่าย / Model Family:",
    ...numbered(families.map((family) => family.displayName)),
  ].join("\n");
}

/**
 * The version menu inside one family.
 *
 * Only models that can execute the frozen storyboard reach this list, so every
 * numbered line leads to a payable draft rather than to a dead end.
 */
export function formatStoryboardModelVersions(params: {
  familyName: string;
  models: readonly StoryboardModelOption[];
}): string {
  return [
    `${params.familyName}:`,
    ...numbered(params.models.map((model) => model.displayName)),
  ].join("\n");
}

/** Ambiguous query: the owner picks rather than the product guessing. */
export function formatStoryboardModelCandidates(models: readonly StoryboardModelOption[]): string {
  return ["เลือกโมเดลที่ต้องการ:", ...numbered(models.map((model) => model.displayName))].join("\n");
}
