/**
 * LINE side of "the owner changed the video model while a draft was open".
 *
 * The storyboard lives in the Cloudbath archive plugin, so this module holds
 * only the consumer half of the seam plus the wording. It never mints a code,
 * never supersedes one and never calls a provider: a re-quote goes through the
 * archive's existing preparation, which hands back to THIS plugin's allocator,
 * so there remains exactly one code space and one supersede.
 *
 * The safety rule this file exists to keep: the owner's last payable code stays
 * valid until a replacement has actually been allocated. Every refusal path
 * below therefore leaves it alone and only asks a question.
 */

import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const LINE_VIDEO_REQUOTE_PENDING_NAMESPACE = "video-requote-pending-v1";
export const LINE_VIDEO_REQUOTE_PENDING_TTL_MS = 10 * 60 * 1000;
export const LINE_VIDEO_REQUOTE_PENDING_MAX_ENTRIES = 5_000;

/** Mirrors the archive seam's result without importing across the plugin boundary. */
export type LineRequoteIncompatibility = Readonly<{
  kind: "duration" | "resolution" | "aspectRatio" | "audio";
  requested: string;
  supported: readonly string[];
}>;

export type LineRequoteResult =
  | Readonly<{ kind: "created"; code: string; modelName?: string; estimatedCostUsd?: number }>
  | Readonly<{ kind: "no_active_storyboard" }>
  | Readonly<{ kind: "incompatible"; incompatibility: LineRequoteIncompatibility }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type LineRequoteOverrides = Readonly<{
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  audio?: boolean;
}>;

/**
 * One unanswered capability question, scoped to the owner, the conversation and
 * the storyboard it was asked about, and expiring on its own TTL.
 *
 * Overrides accumulate so answering a second question keeps the first answer.
 */
export type LinePendingRequoteState = {
  version: 1;
  modelId: string;
  modelName: string;
  field: LineRequoteIncompatibility["kind"];
  supported: readonly string[];
  overrides: LineRequoteOverrides;
  createdAt: number;
};

export type LinePendingRequoteStore = PluginStateKeyedStore<LinePendingRequoteState>;

export function requotePendingKey(scopeKey: string): string {
  return createHash("sha256").update(`requote:${scopeKey}`).digest("hex");
}

const NUMBER_PATTERN = /(\d+(?:\.\d+)?)/u;
const NEGATIVE_AUDIO = /ไม่เอา|ไม่ต้อง|ไม่มี|\bno\b|\boff\b|เงียบ/iu;
const AFFIRMATIVE_AUDIO = /^(?:เอา|ต้องการ|ใช่|ตกลง|โอเค|ok|yes|y)\b|^(?:เอา|ใช่|ตกลง)/iu;

/**
 * Reads an answer to the ONE open capability question.
 *
 * Returns undefined when the reply does not answer it, so unrelated chat during
 * a pending clarification still reaches the model instead of being swallowed.
 */
export function parseRequoteAnswer(params: {
  field: LineRequoteIncompatibility["kind"];
  supported: readonly string[];
  text: string;
}): LineRequoteOverrides | undefined {
  const text = params.text.trim();
  if (!text) {
    return undefined;
  }
  if (params.field === "audio") {
    // Dropping audio is never assumed: only an explicit yes/no counts.
    if (NEGATIVE_AUDIO.test(text)) {
      return { audio: false };
    }
    return AFFIRMATIVE_AUDIO.test(text) ? { audio: true } : undefined;
  }
  const normalized = text.toLowerCase().replace(/\s+/gu, "");
  const supported = params.supported.map((entry) => entry.toLowerCase());
  if (params.field === "duration") {
    const seconds = Number(NUMBER_PATTERN.exec(text)?.[1] ?? "");
    // Only a length the model actually offers is accepted; anything else keeps
    // the question open rather than quoting something unsupported.
    return Number.isFinite(seconds) && supported.includes(String(seconds))
      ? { durationSeconds: seconds }
      : undefined;
  }
  const picked = supported.find((entry) => entry.replace(/\s+/gu, "") === normalized);
  if (!picked) {
    return undefined;
  }
  const original = params.supported[supported.indexOf(picked)]!;
  return params.field === "resolution" ? { resolution: original } : { aspectRatio: original };
}

/** The question for exactly the field that did not fit. Nothing else is changed. */
export function formatIncompatibilityQuestion(params: {
  modelName: string;
  incompatibility: LineRequoteIncompatibility;
}): string {
  const { modelName, incompatibility } = params;
  const list = incompatibility.supported.join(" หรือ ");
  if (incompatibility.kind === "audio") {
    return [`${modelName} ไม่รองรับ Audio`, "ต้องการสร้างแบบไม่มีเสียงไหม?"].join("\n");
  }
  if (incompatibility.kind === "duration") {
    return [
      `${modelName} ไม่รองรับ ${incompatibility.requested} วินาที`,
      `รองรับ ${list} วินาที`,
      "ต้องการใช้กี่วินาที?",
    ].join("\n");
  }
  const label = incompatibility.kind === "resolution" ? "ความละเอียด" : "อัตราส่วนภาพ";
  return [
    `${modelName} ไม่รองรับ${label} ${incompatibility.requested}`,
    `รองรับ ${list}`,
    `ต้องการใช้${label}ไหน?`,
  ].join("\n");
}

/** The replacement draft, stating plainly that the previous code is now dead. */
export function formatRequotedDraft(params: {
  modelName: string;
  result: Extract<LineRequoteResult, { kind: "created" }>;
  overrides: LineRequoteOverrides;
}): string {
  const { overrides } = params;
  const adjusted = [
    overrides.durationSeconds === undefined ? "" : `${overrides.durationSeconds} วิ`,
    overrides.resolution ?? "",
    overrides.aspectRatio ?? "",
    overrides.audio === false ? "ไม่มีเสียง" : "",
  ].filter(Boolean);
  const price =
    params.result.estimatedCostUsd === undefined
      ? ""
      : `ราคาโดยประมาณ: ~$${params.result.estimatedCostUsd.toFixed(2)}`;
  return [
    "🎬 Final Video Draft (อัปเดตโมเดลแล้ว)",
    `โมเดล: ${params.modelName}`,
    ...(adjusted.length > 0 ? [adjusted.join(" · ")] : []),
    ...(price ? [price] : []),
    "",
    "ยืนยันด้วยข้อความนี้:",
    `ยืนยัน VIDEO ${params.result.code}`,
    "หมายเหตุ: รหัส VIDEO ก่อนหน้าถูกยกเลิกแล้ว",
  ].join("\n");
}
