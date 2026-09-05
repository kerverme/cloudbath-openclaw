/**
 * Where every image submitted with a paid video request came from.
 *
 * A provider moderation refusal names the request, not the input, so a 422 left
 * no way to tell whether the endpoint had been handed the owner's own photo, a
 * frozen Character Library identity, or something the flow should never have
 * sent at all. Recording the CLASS of each input closes that without recording
 * the input: no URLs, no object keys, no filenames, no bytes, no signed
 * locators — only how many of each provenance the submission carried.
 *
 * The union is closed on purpose. An input this flow cannot classify is
 * `other_authorized_reference` and is counted separately, so an unexplained
 * class shows up in the numbers instead of hiding inside a familiar one. A
 * derived contact-sheet preview is not on the list because it is not a
 * provider input: it is a review artifact built FROM shots that already exist.
 */

/** Every kind of image the paid path is allowed to hand a video endpoint. */
export type LineVideoReferenceProvenance =
  | "inbound_source_image"
  | "character_library_identity"
  | "storyboard_shot_keyframe"
  | "first_frame_image"
  | "other_authorized_reference";

/** Frozen UGC reference kinds, as the scope stores them. */
export function provenanceForUgcReferenceKind(
  kind: "identity" | "product" | "style",
): LineVideoReferenceProvenance {
  return kind === "identity" ? "character_library_identity" : "other_authorized_reference";
}

/**
 * Counts per provenance, for a log line that is safe to keep.
 *
 * Counts rather than a list: a per-input record would grow with the request and
 * invites carrying an identifier along "just for correlation", which is how
 * asset locators end up in logs.
 */
export function summarizeReferenceProvenance(
  provenances: readonly LineVideoReferenceProvenance[],
): Readonly<Record<LineVideoReferenceProvenance, number>> {
  const counts: Record<LineVideoReferenceProvenance, number> = {
    inbound_source_image: 0,
    character_library_identity: 0,
    storyboard_shot_keyframe: 0,
    first_frame_image: 0,
    other_authorized_reference: 0,
  };
  for (const provenance of provenances) {
    counts[provenance] += 1;
  }
  return Object.freeze(counts);
}
