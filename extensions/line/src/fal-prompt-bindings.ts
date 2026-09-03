/**
 * Binds Character Library references to the markers the selected fal model reads.
 *
 * fal's reference endpoints do not share one dialect, and two endpoints from
 * the SAME vendor can differ: Seedance 2.5 reads `[Image1]` while Seedance 2.0
 * reads `@Image1`; MiniMax H3 and H3 Max read `Image 1`; Veo 3.1 takes
 * `image_urls` for "consistent subject appearance" and documents no marker at
 * all. A prompt written in the wrong dialect does not fail — the references
 * are simply ignored and the owner pays for a video that does not contain
 * their character.
 *
 * The binding block is generated from the SAME ordered reference list that
 * becomes the request's image URLs, in the same pass, so marker N and asset N
 * cannot drift apart. A marker is never emitted for a reference that does not
 * exist.
 */
import type { FalReferenceMarkerStyle, FalVideoModel } from "./fal-video-registry.js";

/** One reference, in submission order. Index 0 is the first image sent. */
export type FalBoundReference = Readonly<{
  index: number;
  /** Canonical Character Library code, e.g. "CHAR-12". Never a display name. */
  characterCode?: string;
  /** Name as cast in this scene, e.g. "F1". */
  displayName?: string;
}>;

/** The marker text for position `index` in the model's own dialect. */
export function falReferenceMarker(
  style: FalReferenceMarkerStyle,
  index: number,
): string | undefined {
  const position = index + 1;
  switch (style) {
    case "bracket_image_n":
      return `[Image${position}]`;
    case "at_image_n":
      return `@Image${position}`;
    case "image_space_n":
      return `Image ${position}`;
    default:
      return undefined;
  }
}

function describe(reference: FalBoundReference): string {
  const name = reference.displayName?.trim();
  const code = reference.characterCode?.trim();
  if (name && code) {
    return `${name} (${code})`;
  }
  return name || code || "the reference subject";
}

/**
 * The reference-binding block appended to the provider prompt.
 *
 * Returns an empty string for a model with no marker dialect (Veo) or a
 * request with no references: emitting "@Image1" for an endpoint that does not
 * read it is noise in a paid prompt, and emitting it for an absent asset is
 * an instruction to use something that was never sent.
 */
export function compileFalReferenceBindings(params: {
  model: Pick<FalVideoModel, "references">;
  references: readonly FalBoundReference[];
}): string {
  const support = params.model.references;
  if (support.kind !== "identity_reference" || params.references.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const reference of params.references) {
    const marker = falReferenceMarker(support.markerStyle, reference.index);
    if (!marker) {
      break;
    }
    lines.push(`${marker} = ${describe(reference)}, identity reference.`);
  }
  if (lines.length === 0) {
    return "";
  }
  const subjects = params.references
    .map((reference, position) => {
      const marker = falReferenceMarker(support.markerStyle, position);
      return marker ? `${describe(reference)} from ${marker}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
  return [
    "Reference bindings:",
    ...lines,
    `Preserve the identity, face and clothing of ${subjects.join("; ")}.`,
  ].join("\n");
}

/**
 * The full provider prompt: the confirmed storyboard text, then its bindings.
 *
 * The storyboard half is passed through byte-for-byte. Model selection may add
 * the binding block, but it must never rewrite the scene the owner confirmed.
 */
export function compileFalProviderPrompt(params: {
  storyboardPrompt: string;
  model: Pick<FalVideoModel, "references">;
  references: readonly FalBoundReference[];
}): string {
  const bindings = compileFalReferenceBindings(params);
  return bindings ? `${params.storyboardPrompt}\n\n${bindings}` : params.storyboardPrompt;
}
