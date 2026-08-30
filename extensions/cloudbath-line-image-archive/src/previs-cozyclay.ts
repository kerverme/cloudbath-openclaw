import type { PrevisDeferral, PrevisDocument } from "./previs-types.js";

/**
 * Compiles a Cloudbath previs document into CozyClay MCP calls.
 *
 * Only tools CozyClay serves HEADLESSLY appear here — verified against
 * CozyClay 1.6.0 (`mcp/server.mjs`), whose `capture_frame`, `set_prompt_blocks`,
 * `generate_motion` and `apply_batch` all refuse without a connected editor.
 * Those become explicit deferrals rather than fabricated calls, so a previs is
 * never reported as carrying blocking the engine did not actually receive.
 */

/** Shot sizes CozyClay's `frame_shot` accepts. */
export const COZYCLAY_SHOT_SIZES = [
  "extreme close-up",
  "close-up",
  "medium close-up",
  "medium shot",
  "medium-wide shot",
  "wide shot",
  "extreme wide shot",
] as const;

export const COZYCLAY_SHOT_VIEWS = [
  "front",
  "front three-quarter",
  "profile",
  "rear three-quarter",
  "back",
] as const;

export const COZYCLAY_SHOT_LEVELS = ["ground", "low", "hip", "eye", "high", "overhead"] as const;
export const COZYCLAY_SHOT_SIDES = ["left", "right"] as const;

/**
 * A fresh CozyClay scene already owns `char-a`. Adding one member per cast slot
 * would leave that default stand-in in frame as an uncast extra, so the first
 * member re-describes A and only the rest are added.
 */
const COZYCLAY_DEFAULT_STAND_IN = "A";

export type CozyClayCall = Readonly<{
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type PrevisCompilation = Readonly<{
  calls: readonly CozyClayCall[];
  deferrals: readonly PrevisDeferral[];
}>;

function requireVocabulary(value: string, allowed: readonly string[], field: string): string {
  if (!allowed.includes(value)) {
    throw new Error(`Previs camera ${field} "${value}" is not CozyClay vocabulary`);
  }
  return value;
}

/**
 * The capabilities CozyClay cannot serve without a live editor tab, and — for
 * motion — an SSH-reachable NVIDIA host running Kimodo. Phase 1 records them so
 * an owner reviewing a previs knows what is genuinely missing from it.
 */
export function previsDeferrals(document: PrevisDocument): readonly PrevisDeferral[] {
  const deferrals: PrevisDeferral[] = [
    {
      capability: "TIMELINE_PROMPT_BLOCKS",
      requires: "LIVE_EDITOR",
      reason:
        "CozyClay set_prompt_blocks writes beats onto the studio timeline and returns " +
        "'open the editor and try again' with no editor connected. Cloudbath holds the " +
        "timeline metadata instead.",
    },
    {
      capability: "FRAME_CAPTURE",
      requires: "LIVE_EDITOR",
      reason:
        "CozyClay capture_frame reads a connected editor's rendered preview; there is no " +
        "headless renderer to produce a preview frame from.",
    },
  ];
  if (document.movements.length > 0) {
    deferrals.push({
      capability: "CHARACTER_MOTION",
      requires: "LIVE_EDITOR_AND_GPU",
      reason:
        "CozyClay generate_motion needs both a connected editor and a Kimodo GPU host. " +
        "Movement beats are carried as Cloudbath timeline metadata until that adapter exists.",
    });
  }
  return Object.freeze(deferrals);
}

/**
 * Ordered, deterministic call plan. Cast first so every later call can address a
 * stand-in by letter, then placement, then the camera for the opening shot.
 */
export function compilePrevisPlan(document: PrevisDocument): PrevisCompilation {
  const calls: CozyClayCall[] = [];
  for (const [index, member] of document.cast.entries()) {
    const placement = document.placements.find((entry) => entry.standIn === member.standIn);
    if (!placement) {
      throw new Error(`Previs cast member ${member.standIn} has no placement`);
    }
    calls.push(
      index === 0
        ? {
            tool: "place_character",
            arguments: {
              character: COZYCLAY_DEFAULT_STAND_IN,
              subject: member.standInSubject,
              x: placement.x,
              z: placement.z,
              facing: placement.facing,
            },
          }
        : {
            tool: "add_character",
            arguments: {
              subject: member.standInSubject,
              x: placement.x,
              z: placement.z,
              facing: placement.facing,
            },
          },
    );
  }
  const opening = document.shots[0];
  if (!opening) {
    throw new Error("Previs document has no shots");
  }
  calls.push({ tool: "focus_character", arguments: { character: opening.camera.focus } });
  calls.push({
    tool: "frame_shot",
    arguments: {
      size: requireVocabulary(opening.camera.size, COZYCLAY_SHOT_SIZES, "size"),
      view: requireVocabulary(opening.camera.view, COZYCLAY_SHOT_VIEWS, "view"),
      level: requireVocabulary(opening.camera.level, COZYCLAY_SHOT_LEVELS, "level"),
      side: requireVocabulary(opening.camera.side, COZYCLAY_SHOT_SIDES, "side"),
    },
  });
  return Object.freeze({ calls: Object.freeze(calls), deferrals: previsDeferrals(document) });
}

/**
 * Applies the previs aspect ratio to a saved `.cclayproject`.
 *
 * CozyClay's scene document carries `stage.shotAspect` and its normaliser
 * accepts "9:16", but no MCP tool sets it headlessly — the editor syncs it. So
 * Cloudbath, which owns aspect ratio for the later video pipeline anyway,
 * writes the documented field directly and CozyClay honours it on open_project.
 */
export function applyAspectRatioToProjectArtifact(artifact: string, aspectRatio: string): string {
  const parsed: unknown = JSON.parse(artifact);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { app?: unknown }).app !== "cozyclay" ||
    (parsed as { kind?: unknown }).kind !== "project"
  ) {
    throw new Error("CozyClay project artifact envelope is unrecognised");
  }
  const scenes = (parsed as { scenes?: { scenes?: Array<{ stage?: Record<string, unknown> }> } })
    .scenes?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("CozyClay project artifact carries no scenes");
  }
  for (const scene of scenes) {
    if (scene.stage) {
      scene.stage.shotAspect = aspectRatio;
    }
  }
  return JSON.stringify(parsed);
}
