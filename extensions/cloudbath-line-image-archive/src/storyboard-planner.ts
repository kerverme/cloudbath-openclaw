import type {
  StoryboardBeat,
  StoryboardBeatKind,
  StoryboardCastMember,
  StoryboardDocument,
} from "./storyboard-types.js";

const KINDS = new Set<StoryboardBeatKind>([
  "establishing",
  "locomotion",
  "transition",
  "dialogue",
  "action",
]);

type PlannerBeat = Readonly<{
  startSeconds?: number;
  endSeconds?: number;
  kind: StoryboardBeatKind;
  framing: string;
  action: string;
  caption?: string;
  camera: string;
  characterNames: readonly string[];
}>;

type PlannerCreateResult = Readonly<{ beats: readonly PlannerBeat[] }>;
type PlannerEditResult = Readonly<{ fromSeconds: number; toSeconds: number; action: string }>;

export type StoryboardPlannerComplete = (params: {
  systemPrompt: string;
  messages: readonly { role: "user"; content: string }[];
  maxTokens: number;
  temperature: number;
  purpose: string;
}) => Promise<{ text: string }>;

export type PlannedStoryboard = Readonly<{ beats: readonly StoryboardBeat[] }>;

function parseJson(text: string): unknown {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(raw);
}

function readCreate(value: unknown): PlannerCreateResult | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { beats?: unknown }).beats)) {
    return undefined;
  }
  const beats: PlannerBeat[] = [];
  for (const raw of (value as { beats: unknown[] }).beats) {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const beat = raw as Record<string, unknown>;
    if (
      typeof beat.kind !== "string" ||
      !KINDS.has(beat.kind as StoryboardBeatKind) ||
      typeof beat.framing !== "string" ||
      !beat.framing.trim() ||
      typeof beat.action !== "string" ||
      !beat.action.trim() ||
      typeof beat.camera !== "string" ||
      !beat.camera.trim() ||
      !Array.isArray(beat.characterNames) ||
      !beat.characterNames.every((name) => typeof name === "string")
    ) {
      return undefined;
    }
    const startSeconds = typeof beat.startSeconds === "number" ? beat.startSeconds : undefined;
    const endSeconds = typeof beat.endSeconds === "number" ? beat.endSeconds : undefined;
    beats.push({
      kind: beat.kind as StoryboardBeatKind,
      framing: beat.framing.trim(),
      action: beat.action.trim(),
      ...(typeof beat.caption === "string" && beat.caption.trim()
        ? { caption: beat.caption.trim().slice(0, 80) }
        : {}),
      camera: beat.camera.trim(),
      characterNames: beat.characterNames,
      ...(startSeconds === undefined ? {} : { startSeconds }),
      ...(endSeconds === undefined ? {} : { endSeconds }),
    });
  }
  return beats.length > 0 ? { beats } : undefined;
}

function allocateWindows(beats: readonly PlannerBeat[], durationSeconds: number) {
  if (beats.length > durationSeconds) {
    throw new Error("Storyboard planner returned more beats than the duration can hold");
  }
  const weights = beats.map((beat) => {
    const hinted = (beat.endSeconds ?? 0) - (beat.startSeconds ?? 0);
    return Number.isFinite(hinted) && hinted > 0 ? hinted : 1;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const boundaries: number[] = [];
  let running = 0;
  for (const [index, weight] of weights.entries()) {
    running += weight;
    const floor = index + 1;
    const ceiling = durationSeconds - (weights.length - index - 1);
    const previous = boundaries[index - 1] ?? 0;
    boundaries.push(
      Math.min(
        Math.max(Math.round((durationSeconds * running) / total), floor, previous + 1),
        ceiling,
      ),
    );
  }
  boundaries[boundaries.length - 1] = durationSeconds;
  return boundaries.map((endSeconds, index) => ({
    startSeconds: index === 0 ? 0 : boundaries[index - 1]!,
    endSeconds,
  }));
}

function compilePlannedBeats(params: {
  plan: PlannerCreateResult;
  cast: readonly StoryboardCastMember[];
  durationSeconds: number;
  minimumShotCount: number;
}): PlannedStoryboard {
  const planned = [...params.plan.beats];
  for (let index = planned.length; index < params.minimumShotCount; index += 1) {
    const source = planned[index % params.plan.beats.length]!;
    planned.push({
      ...source,
      framing: index % 2 === 0 ? "Close-up" : source.framing,
      camera: index % 2 === 0 ? "Cut to detail" : source.camera,
    });
  }
  const castByName = new Map(params.cast.map((member) => [member.displayName, member]));
  const windows = allocateWindows(planned, params.durationSeconds);
  const beats = planned.map((beat, index) => {
    const members = beat.characterNames.map((name) => castByName.get(name));
    if (members.some((member) => !member)) {
      throw new Error("Storyboard planner named a character outside the canonical cast");
    }
    return Object.freeze({
      beatId: `BEAT-${index + 1}`,
      ...windows[index]!,
      kind: beat.kind,
      framing: beat.framing,
      action: beat.action,
      caption: beat.caption ?? beat.action.slice(0, 80),
      camera: beat.camera,
      characterIds: Object.freeze(members.map((member) => member!.characterId)),
    });
  });
  return { beats: Object.freeze(beats) };
}

function readEdit(value: unknown, durationSeconds: number): PlannerEditResult | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const edit = value as Record<string, unknown>;
  if (
    typeof edit.fromSeconds !== "number" ||
    typeof edit.toSeconds !== "number" ||
    typeof edit.action !== "string" ||
    !edit.action.trim() ||
    edit.fromSeconds < 0 ||
    edit.toSeconds <= edit.fromSeconds ||
    edit.toSeconds > durationSeconds
  ) {
    return undefined;
  }
  return {
    fromSeconds: edit.fromSeconds,
    toSeconds: edit.toSeconds,
    action: edit.action.trim(),
  };
}

export class StoryboardLlmPlanner {
  constructor(private readonly complete: StoryboardPlannerComplete) {}

  private async request<T>(params: {
    prompt: string;
    read: (value: unknown) => T | undefined;
    purpose: string;
  }): Promise<T> {
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.complete({
        systemPrompt:
          "Return only strict JSON. Preserve every requested action in semantic order. Never invent character names or identity fields.",
        messages: [{ role: "user", content: `${params.prompt}${correction}` }],
        maxTokens: 2_000,
        temperature: 0.2,
        purpose: params.purpose,
      });
      try {
        const parsed = params.read(parseJson(result.text));
        if (parsed) {
          return parsed;
        }
      } catch {
        // One schema-correction retry is allowed; persistence happens only after validation.
      }
      correction =
        "\nYour previous JSON was invalid. Return one value matching the requested fields exactly.";
    }
    throw new Error("Storyboard planner returned invalid structured output twice");
  }

  async planCreate(params: {
    request: string;
    durationSeconds: number;
    cast: readonly StoryboardCastMember[];
  }): Promise<PlannedStoryboard> {
    const names = params.cast.map((member) => member.displayName);
    const requestedShots = /(?:^|\s)(\d{1,2})\s*(?:ช็อต|shots?)(?:\s|$)/iu.exec(params.request)?.[1];
    const explicitRanges = params.request.match(/\d{1,3}\s*(?:-|–|—|ถึง|to)\s*\d{1,3}/giu);
    const minimumShotCount = Math.min(
      params.durationSeconds,
      Math.max(1, requestedShots ? Number(requestedShots) : (explicitRanges?.length ?? 0) || 6),
    );
    return await this.request({
      purpose: "cloudbath-storyboard-create",
      prompt: [
        `Plan a ${params.durationSeconds}-second storyboard from the user's request.`,
        `Allowed characterNames: ${JSON.stringify(names)}.`,
        `Return at least ${minimumShotCount} beats unless the user explicitly requested fewer.`,
        'Return {"beats":[{"startSeconds":number,"endSeconds":number,"kind":"establishing|locomotion|transition|dialogue|action","framing":string,"action":string,"caption":string,"camera":string,"characterNames":string[]}]}',
        "Timings are guidance; keep the beats ordered. Do not add generic establishing filler unless it supports the requested events.",
        `USER_REQUEST: ${params.request}`,
      ].join("\n"),
      read: (value) => {
        const plan = readCreate(value);
        if (!plan) {
          return undefined;
        }
        try {
          return compilePlannedBeats({
            plan,
            cast: params.cast,
            durationSeconds: params.durationSeconds,
            minimumShotCount,
          });
        } catch {
          return undefined;
        }
      },
    });
  }

  async planEdit(params: {
    request: string;
    document: StoryboardDocument;
  }): Promise<PlannerEditResult> {
    return await this.request({
      purpose: "cloudbath-storyboard-edit",
      prompt: [
        "Select the existing beat range the user clearly intends to change.",
        `Duration: ${params.document.durationSeconds}.`,
        `Existing beats: ${JSON.stringify(params.document.beats.map(({ startSeconds, endSeconds, action }) => ({ startSeconds, endSeconds, action })))}`,
        'Return {"fromSeconds":number,"toSeconds":number,"action":string}.',
        `USER_REQUEST: ${params.request}`,
      ].join("\n"),
      read: (value) => readEdit(value, params.document.durationSeconds),
    });
  }
}
