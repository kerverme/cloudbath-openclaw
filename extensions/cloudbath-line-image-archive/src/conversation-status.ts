/**
 * How far a paid video job has got, in words the owner can act on.
 *
 * Read from the LINE job record through the paid seam, never from anything this
 * plugin remembers: the job's own store is the only thing that knows whether
 * fal has answered, so a status sentence built from conversation state would go
 * stale exactly when it matters.
 *
 * Only stages the record can PROVE are reported. fal's seam does not tell us
 * whether a submitted request is sitting in a queue or already rendering, so
 * there is no "อยู่ในคิว" here: it would be a guess dressed as a fact, and a
 * wrong stage is worse than a coarse one.
 */

import type { StoryboardVideoJobSnapshot } from "./storyboard-paid-draft-runtime.js";

/** A failure sentence is capped so a provider message cannot flood the chat. */
const FAILURE_REASON_MAX = 160;

/**
 * One sentence per stage the record can prove. Two stages share a sentence
 * where the difference is not something the owner can act on: whether the bytes
 * are still being fetched or already being archived is the same wait.
 */
const RUNNING_STAGE: Readonly<
  Record<NonNullable<StoryboardVideoJobSnapshot["stage"]> | "preparing", string>
> = Object.freeze({
  preparing: "กำลังเตรียมไฟล์อ้างอิง",
  provider_submission: "ส่งงานให้ fal.ai แล้ว กำลังสร้างวิดีโอ",
  provider_generation_completed: "สร้างเสร็จแล้ว กำลังเก็บเข้า R2",
  artifact_retrieval: "สร้างเสร็จแล้ว กำลังเก็บเข้า R2",
  r2_archive: "กำลังส่งเข้า LINE",
  line_delivery: "กำลังส่งเข้า LINE",
});

function failureTail(snapshot: StoryboardVideoJobSnapshot): string {
  const reason = snapshot.failureReason?.trim();
  return reason ? `: ${reason.slice(0, FAILURE_REASON_MAX)}` : "";
}

/**
 * The sentence for one job.
 *
 * `delivery_failed` is deliberately not a generation failure: the video exists
 * and is paid for, so the owner is told that rather than "ไม่สำเร็จ", which
 * would read as "nothing was made" about something they were charged for.
 */
export function describeVideoJobStatus(snapshot: StoryboardVideoJobSnapshot): string {
  const code = `VIDEO ${snapshot.draftId}`;
  if (snapshot.status === "completed") {
    return `${code}: เสร็จแล้ว`;
  }
  if (snapshot.status === "delivery_failed") {
    return `${code}: สร้างเสร็จแล้ว (จ่ายแล้ว) แต่ส่งเข้า LINE ไม่สำเร็จ${failureTail(snapshot)}`;
  }
  if (snapshot.status === "failed") {
    return `${code}: ล้มเหลว${failureTail(snapshot)}`;
  }
  return `${code}: ${RUNNING_STAGE[snapshot.stage ?? "preparing"]}`;
}
