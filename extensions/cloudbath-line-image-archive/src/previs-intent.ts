/**
 * Deterministic LINE intent parsing for previs.
 *
 * The model is not consulted. A recognised previs request is classified here and
 * executed from `before_dispatch`, so a character-led scene request can never
 * end as a generic `[[confirm:...]]` yes/no prompt the way it could before.
 *
 * Character names are matched against the names the Character Library actually
 * holds rather than guessed out of free text: an unknown name then fails closed
 * naming it, instead of silently recasting the scene.
 */

/** Exact approval commands. Anything else -- including a bare confirm -- is not approval. */
export const PREVIS_APPROVE_COMMANDS = ["APPROVE PREVIS", "อนุมัติ PREVIS"] as const;

/** Aspect ratios a request may ask for, and the words that select them. */
const ASPECT_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/9\s*:\s*16|แนวตั้ง/u, "9:16"],
  [/16\s*:\s*9|แนวนอน/u, "16:9"],
  [/1\s*:\s*1/u, "1:1"],
  [/4\s*:\s*3/u, "4:3"],
  [/2\.39\s*:\s*1/u, "2.39:1"],
];

const DEFAULT_DURATION_SECONDS = 15;
const DEFAULT_ASPECT_RATIO = "9:16";
/** Upper bound on one previs scene. Longer is a product decision, not a parse. */
const MAX_DURATION_SECONDS = 60;

export type PrevisIntent =
  | Readonly<{
      kind: "create";
      characterNames: readonly string[];
      unknownNames: readonly string[];
      durationSeconds: number;
      aspectRatio: string;
      scenePrompt: string;
    }>
  | Readonly<{
      kind: "edit";
      characterName?: string;
      unknownNames: readonly string[];
      fromSecond: number;
      toSecond: number;
      beat: string;
    }>
  | Readonly<{ kind: "approve" }>;

function normalize(text: string): string {
  return text.normalize("NFKC").trim();
}

/** Longest-first, so "Twong2" wins over "Twong" on the same span. */
export function matchKnownNames(text: string, knownNames: readonly string[]): string[] {
  const ordered = knownNames.toSorted((a, b) => b.length - a.length);
  const matched: string[] = [];
  let remaining = text;
  for (const name of ordered) {
    if (!name.trim()) {
      continue;
    }
    let index = remaining.indexOf(name);
    while (index !== -1) {
      if (!matched.includes(name)) {
        matched.push(name);
      }
      remaining = `${remaining.slice(0, index)} ${remaining.slice(index + name.length)}`;
      index = remaining.indexOf(name);
    }
  }
  // Report in the order they appear in the ORIGINAL text: cast order decides the
  // stand-in letters, so "Twong ... Twong2" must always yield A then B.
  return matched.toSorted((a, b) => text.indexOf(a) - text.indexOf(b));
}

/**
 * Names the message clearly casts that the library does not hold.
 *
 * Only tokens in an explicit casting position count, so ordinary scene wording
 * is never mistaken for a missing character.
 */
export function findUnknownCastNames(text: string, knownNames: readonly string[]): string[] {
  const unknown: string[] = [];
  const casting = /(?:ใช้|กับ|ให้|และ)\s*([A-Za-z][A-Za-z0-9_-]{1,31})/gu;
  for (const match of text.matchAll(casting)) {
    const candidate = match[1]!;
    if (!knownNames.includes(candidate) && !unknown.includes(candidate)) {
      unknown.push(candidate);
    }
  }
  return unknown;
}

function readDuration(text: string): number | undefined {
  const match = text.match(/(\d{1,3})\s*(?:วินาที|วิ|s\b|sec\b|seconds?\b)/iu);
  if (!match) {
    return undefined;
  }
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_DURATION_SECONDS
    ? seconds
    : undefined;
}

function readAspect(text: string): string | undefined {
  for (const [pattern, aspect] of ASPECT_WORDS) {
    if (pattern.test(text)) {
      return aspect;
    }
  }
  return undefined;
}

/**
 * A time range such as "10-14" after a seconds word, or "3 to 6 seconds".
 *
 * Both numbers must be present: a bare duration is a create request, not an
 * edit, and must never be read as a range.
 */
export function parseTimeRange(text: string): { fromSecond: number; toSecond: number } | undefined {
  const SEC = "วิ|วินาที|ช่วง";
  const TO = "-|–|—|ถึง|to";
  const patterns = [
    new RegExp(`(?:${SEC}|second|sec)\\D{0,8}?(\\d{1,3})\\s*(?:${TO})\\s*(\\d{1,3})`, "iu"),
    new RegExp(`(\\d{1,3})\\s*(?:${TO})\\s*(\\d{1,3})\\s*(?:${SEC}|s\\b|sec\\b)`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const fromSecond = Number(match[1]);
      const toSecond = Number(match[2]);
      if (Number.isFinite(fromSecond) && Number.isFinite(toSecond)) {
        return { fromSecond, toSecond };
      }
    }
  }
  return undefined;
}

/** True when the message reads as a scene/video request rather than chatter. */
function looksLikeSceneRequest(text: string): boolean {
  const SCENE = "วิ|วินาที|ฉาก|แนวตั้ง|แนวนอน|พรีวิส";
  return new RegExp(`${SCENE}|second|sec\\b|previs|scene|\\d\\s*:\\s*\\d`, "iu").test(text);
}

/**
 * Classifies one inbound LINE message.
 *
 * Returns undefined when the message is not a previs request, leaving every
 * other flow -- including the generic video path -- exactly as it was.
 */
export function parsePrevisIntent(params: {
  content: string;
  knownCharacterNames: readonly string[];
}): PrevisIntent | undefined {
  const text = normalize(params.content);
  if (!text) {
    return undefined;
  }
  // Approval is an exact command, so an ordinary confirm can never approve.
  const upper = text.toUpperCase();
  if (PREVIS_APPROVE_COMMANDS.some((command) => upper === command.toUpperCase())) {
    return { kind: "approve" };
  }

  const matched = matchKnownNames(text, params.knownCharacterNames);
  const unknownNames = findUnknownCastNames(text, params.knownCharacterNames);
  const range = parseTimeRange(text);

  if (range) {
    return {
      kind: "edit",
      ...(matched[0] ? { characterName: matched[0] } : {}),
      unknownNames,
      fromSecond: range.fromSecond,
      toSecond: range.toSecond,
      beat: text,
    };
  }

  // A create request needs at least one real cast member and scene-shaped
  // wording; otherwise this is not ours and the normal flow continues.
  if (matched.length === 0 || !looksLikeSceneRequest(text)) {
    return undefined;
  }
  return {
    kind: "create",
    characterNames: matched,
    unknownNames,
    durationSeconds: readDuration(text) ?? DEFAULT_DURATION_SECONDS,
    aspectRatio: readAspect(text) ?? DEFAULT_ASPECT_RATIO,
    scenePrompt: text,
  };
}
