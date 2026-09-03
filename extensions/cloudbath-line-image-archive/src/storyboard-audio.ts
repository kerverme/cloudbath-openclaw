/**
 * Audio direction for a storyboard: SOUND and SPEECH are separate decisions.
 *
 * The two were previously conflated on one `dialogue` field, so "มีเสียง" and
 * "มีบทพูด" produced the same storyboard, and a scene with no spoken line got
 * no sound at all. They are now two axes:
 *
 *   - SOUND is the scene's ambience and effects, carried per beat on
 *     `soundDesign`, and is what makes the provider's `generate_audio` worth
 *     paying for.
 *   - SPEECH is a spoken line, still carried on `dialogue`, still verbatim.
 *
 * `StoryboardAudioMode` is the closed union those two axes collapse to, and it
 * is the single value the LINE-visible storyboard, the compiled plan and the
 * provider prompt all read — which is what keeps them in agreement.
 */
import { normalizeStoryboardText } from "./storyboard-request.js";
import type {
  StoryboardAudioMode,
  StoryboardBeat,
  StoryboardDocument,
} from "./storyboard-types.js";

/** Nouns that make a negation SPEECH-specific rather than scene-wide. */
const SPEECH_NOUNS = "เสียงพูด|บทพูด|คำพูด|ผู้พูด|คนพูด";
// "ปิด" is guarded: without the lookbehind it also matches inside "เปิดเสียง",
// which is a request FOR sound, and would mute the scene the owner turned on.
const NEGATORS = "ไม่เอา|ไม่ต้อง|ไม่มี|เอาออก|ตัด|(?<!เ)ปิด";

/**
 * Negates SPEECH only.
 *
 * Tested before the silence pattern because "ไม่มีเสียงพูด" contains
 * "ไม่มีเสียง": read in the other order, "ไม่มีเสียงพูด แต่มีเสียง" would mute
 * the scene the owner explicitly asked to have sound.
 */
const NO_SPEECH_PATTERN = new RegExp(
  `(?:${NEGATORS})\\s*(?:${SPEECH_NOUNS})|เสียงพูดออก|\\bno\\s+(?:dialogue|speech|voice)\\b`,
  "iu",
);
/** Every negated-audio clause, consumed before the SOUND test so it cannot read as "มีเสียง". */
const NEGATED_AUDIO_PATTERN = new RegExp(
  `(?:${NEGATORS})\\s*(?:${SPEECH_NOUNS}|เสียง)|เสียงพูดออก`,
  "giu",
);
/** Negates SOUND scene-wide: a negator followed by "เสียง" with no speech noun after it. */
const SILENCE_PATTERN = new RegExp(
  `(?:${NEGATORS})\\s*เสียง(?!\\s*(?:พูด|บทพูด|คำพูด|ผู้พูด|คนพูด))|\\bno\\s+(?:sound|audio)\\b|\\bsilent\\b|\\bmuted?\\b`,
  "iu",
);
const SOUND_PATTERN = /มีเสียง|เปิดเสียง|ใส่เสียง|มีซาวด์|\bwith\s+(?:sound|audio)\b/iu;

/**
 * Reads the audio decision out of a request, or `undefined` when it names none.
 *
 * `undefined` is deliberately distinct from `"off"`: a message that never
 * mentions audio must leave whatever the storyboard already decided alone,
 * whereas "ไม่มีเสียง" is an instruction to mute it.
 */
export function parseStoryboardAudioIntent(text: string): StoryboardAudioMode | undefined {
  const normalized = normalizeStoryboardText(text);
  const speechNegated = NO_SPEECH_PATTERN.test(normalized);
  const withoutNegations = normalized.replace(NEGATED_AUDIO_PATTERN, " ");
  const soundRequested = SOUND_PATTERN.test(withoutNegations);
  if (speechNegated) {
    // Negating speech says nothing about ambience on its own, so sound stays
    // off unless the SAME message also asks for it -- "ไม่มีเสียงพูด แต่มีเสียง".
    return soundRequested ? "ambient" : "off";
  }
  if (SILENCE_PATTERN.test(normalized) && !soundRequested) {
    return "off";
  }
  return soundRequested ? "full" : undefined;
}

/** Scene ambience for a beat: its own note when it has one, else the scene's. */
function ambienceFor(beat: StoryboardBeat, environment: string): string {
  const place = beat.environmentNote?.trim() || environment.trim();
  return place ? `บรรยากาศ${place}` : "บรรยากาศรอบตัว";
}

/**
 * Sound direction for one beat, derived from its kind.
 *
 * Derived rather than authored so every beat in a sound-on scene has a
 * direction — the requirement is a continuous audio timeline, and a beat left
 * blank is a silent gap the provider fills however it likes.
 */
function soundDesignFor(beat: StoryboardBeat, environment: string): string {
  const ambience = ambienceFor(beat, environment);
  switch (beat.kind) {
    case "establishing":
      return `${ambience} ต่อเนื่อง`;
    case "locomotion":
      return `${ambience} + เสียงฝีเท้าตามจังหวะการเคลื่อนไหว`;
    case "transition":
      return `${ambience} + เสียงเสื้อผ้าและการขยับตัว`;
    case "dialogue":
      return `${ambience} เบาลงเพื่อเปิดพื้นที่ให้เสียงหน้า`;
    default:
      return `${ambience} + เสียงประกอบการกระทำในช็อต`;
  }
}

/**
 * Returns a NEW document carrying the audio decision on every beat.
 *
 * Three shapes, and nothing in between:
 *   - `off`   — no `soundDesign`, and no `dialogue`. Nothing audio-related is
 *               invented, and any speech the scene had is dropped rather than
 *               left for a silent render to ignore.
 *   - `ambient` — `soundDesign` on every beat, `dialogue` removed everywhere.
 *   - `full`  — `soundDesign` on every beat, `dialogue` preserved VERBATIM in
 *               the beat that already held it, with its window untouched.
 */
export function applyStoryboardAudioMode(
  document: StoryboardDocument,
  mode: StoryboardAudioMode,
): StoryboardDocument {
  const beats = document.beats.map((beat) => {
    // Rebuilt without the keys rather than set to undefined: both fields are
    // optional and downstream (plan compilation, LINE rendering) reads
    // presence, so an explicit undefined would render as a direction.
    const { dialogue, soundDesign: _dropped, ...rest } = beat;
    if (mode === "off") {
      return Object.freeze(rest);
    }
    return Object.freeze({
      ...rest,
      ...(mode === "full" && dialogue ? { dialogue } : {}),
      soundDesign: soundDesignFor(beat, document.environment),
    });
  });
  return Object.freeze({ ...document, audio: mode, beats: Object.freeze(beats) });
}

/** True when any beat carries a spoken line. Only meaningful in `full` mode. */
export function storyboardHasSpeech(document: StoryboardDocument): boolean {
  return document.audio === "full" && document.beats.some((beat) => Boolean(beat.dialogue?.trim()));
}

/** Whether the provider should be asked to generate audio for this document. */
export function storyboardWantsProviderAudio(document: StoryboardDocument): boolean {
  return document.audio !== "off";
}
