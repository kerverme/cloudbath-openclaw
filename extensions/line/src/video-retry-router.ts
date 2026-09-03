/**
 * The "ส่งวิดีโออีกครั้ง" command.
 *
 * Re-delivers a video whose paid generation ALREADY succeeded. It never
 * generates: the whole point is that a download, archive or send failure is
 * recoverable work on an artifact the owner already paid for, so this command
 * resumes from the furthest stage that completed
 * (video-job-execution.ts's `recoverLineVideoJob`).
 *
 * Scoping is the security surface. A job is only reachable by the SAME LINE
 * account, the SAME conversation and the SAME owner that confirmed it; the
 * lookup filters on that trusted triple before it considers recency, so a
 * message from another group or another sender cannot resolve, name, or even
 * learn of someone else's job.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { recoverLineVideoJob } from "./video-job-execution.js";
import type { LineVideoJob, LineVideoJobStore } from "./video-job-store.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";

const log = createSubsystemLogger("line/video-retry");

/**
 * "ส่งวิดีโออีกครั้ง" and close phrasings.
 *
 * Anchored so it is a command, not a topic: an ordinary sentence mentioning
 * sending a video again should reach the agent, not silently re-deliver.
 */
const RETRY_COMMAND = /^(?:ส่ง|ขอ)\s*(?:วิดีโอ|วีดีโอ|คลิป|วิดิโอ)\s*(?:ให้)?\s*(?:อีกครั้ง|ใหม่|อีกที|ซ้ำ)\s*$/iu;

export function isLineVideoRetryCommand(content: string): boolean {
  return RETRY_COMMAND.test(content.normalize("NFKC").trim());
}

/**
 * The newest job this owner may recover in this conversation.
 *
 * "Recoverable" means the paid generation finished: an archived R2 object, or
 * fal's own result for a completed generation. A job that failed before that
 * has nothing bought to resend, and offering to "retry" it would mean paying
 * again — so it is not a candidate.
 */
export function resolveRecoverableLineVideoJob(
  jobs: readonly LineVideoJob[],
  scope: Readonly<{ accountId: string; conversationKey: string; ownerSenderId?: string }>,
): LineVideoJob | undefined {
  return jobs
    .filter(
      (job) =>
        job.accountId === scope.accountId &&
        job.conversationKey === scope.conversationKey &&
        job.status !== "completed" &&
        Boolean(job.r2ObjectKey || job.providerResultUrl),
    )
    .toSorted((left, right) => right.submittedAt - left.submittedAt)[0];
}

export type LineVideoRetryDependencies = Readonly<{
  jobStore: LineVideoJobStore;
  resolveAccount?: typeof resolveLineAccount;
  recover?: typeof recoverLineVideoJob;
  cfg?: Parameters<typeof recoverLineVideoJob>[0]["cfg"];
}>;

export type LineVideoRetryReply = Readonly<{ handled: true; text: string }>;

/**
 * Handles one "ส่งวิดีโออีกครั้ง". Returns undefined when it does not apply,
 * so an unrelated message falls through to the rest of the router chain.
 */
export async function handleLineVideoRetryCommand(
  event: Readonly<{
    channel?: string;
    body?: string;
    content?: string;
    senderId?: string;
    senderIsOwner?: boolean;
  }>,
  ctx: Readonly<{ accountId?: string; conversationId?: string }>,
  deps: LineVideoRetryDependencies,
): Promise<LineVideoRetryReply | undefined> {
  if (event.channel !== "line" || !isLineVideoRetryCommand(event.body ?? event.content ?? "")) {
    return undefined;
  }
  // Re-delivering a paid video is owner-only, exactly like confirming one.
  if (!event.senderIsOwner) {
    return undefined;
  }
  const accountId = ctx.accountId;
  const conversationKey = buildLineVideoConversationKey({
    accountId: accountId ?? "",
    conversationId: ctx.conversationId ?? "",
  });
  if (!accountId || !conversationKey) {
    return undefined;
  }
  const entries = await deps.jobStore.entries();
  const job = resolveRecoverableLineVideoJob(
    entries.map((entry) => entry.value),
    { accountId, conversationKey },
  );
  if (!job) {
    // Deliberately the same reply whether nothing exists or the job belongs to
    // someone else: a distinguishing message would confirm that another
    // owner's job exists in this account.
    return { handled: true, text: "ไม่พบวิดีโอที่ส่งซ้ำได้ในห้องนี้" };
  }
  const account = (deps.resolveAccount ?? resolveLineAccount)({
    cfg: deps.cfg ?? ({} as never),
    accountId,
  });
  const result = await (deps.recover ?? recoverLineVideoJob)({
    jobStore: deps.jobStore,
    jobId: job.jobId,
    account,
    ...(job.deliveryTo ? { deliveryTo: job.deliveryTo } : {}),
    ...(deps.cfg ? { cfg: deps.cfg } : {}),
  });
  log.info("LINE video retry requested", {
    correlationId: job.jobId,
    jobId: job.jobId,
    stage: job.stage,
    outcome: result.kind,
  });
  if (result.kind === "delivered") {
    return { handled: true, text: "ส่งวิดีโอให้อีกครั้งแล้ว ไม่มีค่าใช้จ่ายเพิ่ม" };
  }
  return {
    handled: true,
    text:
      result.kind === "failed"
        ? `ส่งวิดีโอไม่สำเร็จ: ${result.reason}\nวิดีโอยังอยู่ใน Cloudbath ลองใหม่ได้`
        : "ไม่พบวิดีโอที่ส่งซ้ำได้ในห้องนี้",
  };
}
