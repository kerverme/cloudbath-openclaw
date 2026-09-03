/**
 * Runs a CONFIRMED LINE video job: one paid provider call, then archive, then
 * delivery — as four separately-recoverable stages (see video-job-store.ts's
 * `LineVideoJobStage`).
 *
 * Split from video-confirmation.ts, which owns the gate: deciding whether a
 * `ยืนยัน VIDEO ####` may spend money is a different concern from carrying out
 * the spend, and only the latter runs in the background, minutes after the
 * webhook turn has returned.
 *
 * The stage boundaries are the point. `provider_generation` is the only stage
 * that costs anything; everything after it works on bytes already paid for, so
 * a failure past it is recoverable work, never a reason to generate again.
 */
import fs from "node:fs/promises";
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import type { resolveLineAccount } from "./accounts.js";
import { sendMessageLine } from "./send.js";
import type { LineVideoDraft } from "./video-draft-store.js";
import {
  releaseLineVideoActiveJobLock,
  updateLineVideoJob,
  type LineVideoActiveJobLockStore,
  type LineVideoJobStore,
} from "./video-job-store.js";
import type { LineVideoLibrary, LineVideoLibraryRecord } from "./video-library-notion.js";
import { normalizeLineVideoConversationId } from "./video-model-preference.js";
import {
  signArchivedLineVideoUrl,
  stageLineOutboundVideo,
  stageLineVideoPreviewImage,
} from "./video-outbound-staging.js";
import { resolveLineVideoReferenceUrls } from "./video-reference-urls.js";
import type { LineVideoNotionTarget, LineVideoUgcScope } from "./video-ugc-scope.js";

const log = createSubsystemLogger("line/video-job");

const MAX_FAILURE_REASON_LENGTH = 200;
// Strips patterns that look like bearer tokens/API keys before a raw
// provider/SDK error message ever reaches the user-facing failure reply.
const SENSITIVE_TOKEN_PATTERN = /\b(?:bearer\s+\S+|sk-[a-z0-9_-]{8,})/giu;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b[a-z0-9_]*(?:token|api[_-]?key|access[_-]?key|secret)[a-z0-9_]*\s*[=:]\s*\S+/giu;

/** Renders a caught error as a short, safe-to-display failure reason. */
function sanitizeLineVideoFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/gu, " ").trim();
  const redacted = singleLine
    .replace(SENSITIVE_TOKEN_PATTERN, "[redacted]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "[redacted]");
  return redacted.length > MAX_FAILURE_REASON_LENGTH
    ? `${redacted.slice(0, MAX_FAILURE_REASON_LENGTH)}…`
    : redacted;
}

/** Deterministic, code-only failure acknowledgement -- never LLM-composed. */
function formatLineVideoFailureReply(reason: string): string {
  return [
    "❌ สร้างวิดีโอไม่สำเร็จ",
    `สาเหตุ: ${reason}`,
    "",
    "งานนี้ถูกปิดสถานะเป็น Failed แล้ว",
    "สามารถสร้าง Draft ใหม่ได้",
  ].join("\n");
}

/**
 * The fal endpoint a confirmed draft is locked to.
 *
 * READ, never recomputed: re-deriving the model at submission time could send
 * the paid job to an endpoint whose price and capability check the owner never
 * saw. A draft that carries no fal route is not submittable at all — this flow
 * generates video on fal only, so there is nothing else to fall back to.
 */
export function confirmedFalModelId(draft: LineVideoDraft): string | undefined {
  return draft.providerRoute?.provider === "fal" ? draft.providerRoute.modelId : undefined;
}

/** What the provider stage produced, plus what it takes to recover it. */
type ProviderGenerationOutcome = Readonly<{
  provider: string;
  source: Buffer | string;
  actualCostUsd?: number;
  /**
   * fal's own identifiers for the completed generation.
   *
   * Persisted so a later failure can fetch THIS generation's existing result
   * instead of paying for another one. `resultUrl` is fal's queue response
   * URL; `requestId` identifies the request in fal's queue.
   */
  recovery?: Readonly<{ requestId?: string; resultUrl?: string }>;
}>;

function readStringField(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The owner's own attached image, when a draft carries one and no scene does. */
async function loadDraftSourceImages(
  draft: LineVideoDraft,
): Promise<Array<{ buffer: Buffer; role: "reference_image" }>> {
  if (!draft.sourceImagePath) {
    return [];
  }
  try {
    return [{ buffer: await fs.readFile(draft.sourceImagePath), role: "reference_image" }];
  } catch {
    return [];
  }
}

/**
 * The one paid call: fal's reference-to-video endpoint the draft named.
 *
 * Submitted through core's registered `fal` provider (`extensions/fal`), which
 * already implements this endpoint family's queue submit, poll,
 * reference-count caps and SSRF-guarded artifact download. There is no
 * cross-provider fallback edge on purpose — a fal failure never re-submits
 * anywhere else, because that would bill a second job the owner did not
 * confirm.
 *
 * fal's endpoint takes reference URLs, not bytes, so the frozen Character
 * Library assets are published as short-lived signed R2 URLs in the SAME order
 * the draft's prompt markers were compiled against.
 */
async function runProviderGeneration(params: {
  draft: LineVideoDraft;
  jobId: string;
  ugcScope?: LineVideoUgcScope;
}): Promise<ProviderGenerationOutcome> {
  const modelId = confirmedFalModelId(params.draft);
  if (!modelId) {
    throw new Error("Confirmed video draft has no fal model bound");
  }
  // A scene that casts Character Library identities publishes those frozen
  // assets as short-lived signed R2 URLs, in the SAME order the draft's prompt
  // markers were compiled against. A draft with no scope carries at most the
  // owner's own attached image, and is submitted with whatever it has rather
  // than being refused here -- the endpoint is the authority on what it needs.
  const references = params.ugcScope
    ? await resolveLineVideoReferenceUrls(params.ugcScope, { correlationId: params.jobId })
    : [];
  const inputImages =
    references.length > 0
      ? references.map((reference) => ({
          url: reference.url,
          mimeType: reference.mimeType,
          role: "reference_image" as const,
        }))
      : await loadDraftSourceImages(params.draft);
  const result = await generateVideo({
    cfg: getRuntimeConfig(),
    prompt: params.draft.prompt,
    agentDir: resolveOpenClawAgentDir(),
    modelOverride: `fal/${modelId}`,
    aspectRatio: params.draft.aspectRatio,
    resolution: params.draft.resolution,
    durationSeconds: params.draft.durationSeconds,
    audio: params.draft.audio,
    ...(inputImages.length > 0 ? { inputImages } : {}),
    // The confirmed draft is model-locked; a silent substitution here would
    // violate "the confirmed prompt/settings must be exactly what gets
    // submitted", and would bill an endpoint that was never quoted.
    autoProviderFallback: false,
  });
  const video = result.videos[0];
  const source = video?.buffer ?? video?.url;
  if (!source) {
    throw new Error("fal video generation returned no video asset");
  }
  const requestId = readStringField(result.metadata, "requestId");
  // Whatever fal returned is TRANSIENT -- a signed artifact URL or its bytes.
  // The caller re-stages it in R2 before LINE sees any URL.
  return {
    provider: "fal",
    source,
    ...(requestId || video?.url
      ? {
          recovery: Object.freeze({
            ...(requestId ? { requestId } : {}),
            ...(video?.url ? { resultUrl: video.url } : {}),
          }),
        }
      : {}),
  };
}

/** Pushes an already-archived, already-signed R2 video to the conversation. */
async function deliverArchivedLineVideo(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  account: ReturnType<typeof resolveLineAccount>;
  deliveryTo?: string;
  videoUrl: string;
  actualCostUsd?: number;
}): Promise<void> {
  if (!params.deliveryTo) {
    return;
  }
  const preview = await stageLineVideoPreviewImage();
  const costLine =
    params.actualCostUsd !== undefined ? `\nActual cost: $${params.actualCostUsd.toFixed(2)}` : "";
  await sendMessageLine(params.deliveryTo, `🎬 วิดีโอเสร็จแล้ว${costLine}`, {
    cfg: params.cfg,
    accountId: params.account.accountId,
    channelAccessToken: params.account.channelAccessToken,
    mediaUrl: params.videoUrl,
    mediaKind: "video",
    previewImageUrl: preview.url,
  });
}

/**
 * Delivery-only failure: the video exists and was paid for.
 *
 * The job is parked in `delivery_failed`, NOT `failed`, and the owner is told
 * the video was generated and that only sending it failed -- saying
 * "สร้างวิดีโอไม่สำเร็จ" here would be false, and would invite them to pay for a
 * regeneration of a video that already exists in R2.
 */
async function handleLineVideoDeliveryFailure(params: {
  jobStore: LineVideoJobStore;
  jobId: string;
  cfg: ReturnType<typeof getRuntimeConfig>;
  account: ReturnType<typeof resolveLineAccount>;
  error: unknown;
  deliveryTo?: string;
  actualCostUsd?: number;
}): Promise<void> {
  const reason = sanitizeLineVideoFailureReason(params.error);
  const job = await updateLineVideoJob({
    store: params.jobStore,
    jobId: params.jobId,
    patch: {
      status: "delivery_failed",
      stage: "line_delivery",
      error: reason,
      deliveryAttempts: 1,
      ...(params.actualCostUsd !== undefined ? { actualCostUsd: params.actualCostUsd } : {}),
    },
  });
  log.info("LINE video delivery failed", {
    correlationId: params.jobId,
    jobId: params.jobId,
    stage: "line_delivery",
    provider: job?.provider,
    reason,
  });
  if (!params.deliveryTo) {
    return;
  }
  await sendMessageLine(
    params.deliveryTo,
    [
      "⚠️ สร้างวิดีโอสำเร็จแล้ว แต่ส่งเข้าห้องแชทไม่สำเร็จ",
      `สาเหตุ: ${reason}`,
      "",
      "วิดีโอถูกเก็บไว้ใน Cloudbath แล้ว ไม่ต้องสร้างใหม่และไม่มีค่าใช้จ่ายเพิ่ม",
      "พิมพ์ “ส่งวิดีโออีกครั้ง” เพื่อให้ส่งใหม่",
    ].join("\n"),
    {
      cfg: params.cfg,
      accountId: params.account.accountId,
      channelAccessToken: params.account.channelAccessToken,
    },
  ).catch(() => {});
}

/** Why a delivery retry did not send. Closed set; every one is non-billing. */
export type LineVideoDeliveryRetryResult =
  | Readonly<{ kind: "delivered"; jobId: string }>
  | Readonly<{ kind: "no_recoverable_job" }>
  | Readonly<{ kind: "failed"; jobId: string; reason: string }>;

/**
 * Resumes a job whose paid generation already SUCCEEDED. Never generates.
 *
 * Resumption starts at the furthest stage that completed, which is why each
 * stage is recorded separately:
 *
 *   - archived in R2 -> re-sign and send. The original signed URL has its own
 *     lifetime, so the durable object key is what is persisted and re-signed.
 *   - generated but never archived -> re-fetch fal's OWN existing result and
 *     archive that.
 *
 * In neither case is a generate call made. The video was already bought.
 */
export async function recoverLineVideoJob(params: {
  jobStore: LineVideoJobStore;
  jobId: string;
  account: ReturnType<typeof resolveLineAccount>;
  deliveryTo?: string;
  cfg?: ReturnType<typeof getRuntimeConfig>;
  signUrl?: typeof signArchivedLineVideoUrl;
  archive?: typeof stageLineOutboundVideo;
  deliver?: typeof deliverArchivedLineVideo;
}): Promise<LineVideoDeliveryRetryResult> {
  const job = await params.jobStore.lookup(params.jobId);
  if (!job || job.status === "completed") {
    return { kind: "no_recoverable_job" };
  }
  // Recoverable means the paid generation actually finished. A job that failed
  // before that has nothing bought to resume from, and resuming it would mean
  // submitting again -- which is exactly what this function exists to avoid.
  const archived = job.r2ObjectKey;
  const providerArtifact = job.providerResultUrl;
  if (!archived && !providerArtifact) {
    return { kind: "no_recoverable_job" };
  }
  const cfg = params.cfg ?? getRuntimeConfig();
  const deliveryTo = params.deliveryTo ?? undefined;
  try {
    // Resume from the furthest stage that already succeeded. An archived
    // object only needs re-signing; a completed generation whose artifact was
    // never archived is re-fetched from fal's OWN result URL, not regenerated.
    let objectKey = archived;
    if (!objectKey) {
      const staged = await (params.archive ?? stageLineOutboundVideo)(providerArtifact!);
      objectKey = staged.objectKey;
      await updateLineVideoJob({
        store: params.jobStore,
        jobId: params.jobId,
        patch: { stage: "r2_archive", r2ObjectKey: staged.objectKey, videoUrl: staged.url },
      });
    }
    const videoUrl = await (params.signUrl ?? signArchivedLineVideoUrl)(objectKey);
    await (params.deliver ?? deliverArchivedLineVideo)({
      cfg,
      account: params.account,
      ...(deliveryTo ? { deliveryTo } : {}),
      videoUrl,
      ...(job.actualCostUsd !== undefined ? { actualCostUsd: job.actualCostUsd } : {}),
    });
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { status: "completed", stage: "line_delivery", videoUrl },
    });
    return { kind: "delivered", jobId: params.jobId };
  } catch (error) {
    const reason = sanitizeLineVideoFailureReason(error);
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        status: "delivery_failed",
        stage: "line_delivery",
        error: reason,
        deliveryAttempts: (job.deliveryAttempts ?? 0) + 1,
      },
    });
    return { kind: "failed", jobId: params.jobId, reason };
  }
}

/** Runs the actual paid submission + delivery in the background (never awaited by the webhook handler). */
export async function executeConfirmedLineVideoJob(params: {
  draft: LineVideoDraft;
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  jobId: string;
  jobCreatedAt: number;
  account: ReturnType<typeof resolveLineAccount>;
  createNotionLibrary: (target: LineVideoNotionTarget) => LineVideoLibrary;
  videoLibraryTarget: LineVideoNotionTarget;
  ugcScope?: LineVideoUgcScope;
  now: () => number;
}): Promise<void> {
  const cfg = getRuntimeConfig();
  const account = params.account;

  // Whatever happens below -- success, provider rejection, or a polling
  // failure -- the job reaches a terminal state and the active-job lock is
  // released in the same pass, so a failed job can never remain an active
  // blocker: the very next draft attempt for this conversation sees no lock.
  let notionLibrary: LineVideoLibrary | undefined;
  let notionRecord: LineVideoLibraryRecord | undefined;
  try {
    const conversationId = normalizeLineVideoConversationId(params.draft.deliveryTo);
    if (!conversationId) {
      throw new Error("LINE video conversation identity is unavailable");
    }
    // Validate the one-time administrator-provisioned database before the
    // paid provider call. A missing or incompatible Notion target therefore
    // fails closed without spending money or weakening confirmation policy.
    notionLibrary = params.createNotionLibrary(params.videoLibraryTarget);
    await notionLibrary.validate();
    if (params.ugcScope) {
      if (!notionLibrary.markUgcProcessing) {
        throw new Error("UGC video library workflow is unavailable");
      }
      await notionLibrary.markUgcProcessing(params.ugcScope);
    }

    // STAGE provider_submission -- the only stage that spends money.
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { stage: "provider_submission", provider: "fal" },
    });
    const generated = await runProviderGeneration(params);
    // The video now EXISTS and is paid for. Recording that, with fal's own
    // identifiers, is what makes every later failure recoverable instead of
    // billable: nothing downstream may re-enter submission.
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        stage: "provider_generation_completed",
        provider: generated.provider,
        ...(generated.recovery?.requestId
          ? { providerRequestId: generated.recovery.requestId }
          : {}),
        ...(generated.recovery?.resultUrl
          ? { providerResultUrl: generated.recovery.resultUrl }
          : {}),
      },
    });
    const actualCostUsd = generated.actualCostUsd;

    // The provider has completed successfully, but R2 work has not started:
    // create the one persistent audit row in Processing first, keyed by the
    // immutable SQLite video job id for duplicate-safe recovery.
    notionRecord = await notionLibrary.createProcessing({
      jobId: params.jobId,
      accountId: params.draft.accountId,
      conversationId,
      model: params.draft.model,
      prompt: params.draft.prompt,
      durationSeconds: params.draft.durationSeconds,
      resolution: params.draft.resolution,
      aspectRatio: params.draft.aspectRatio,
      audio: params.draft.audio,
      estimatedCostUsd: params.draft.estimatedCostUsd,
      ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      createdAt: params.jobCreatedAt,
      ...(params.ugcScope ? { ugcScope: params.ugcScope } : {}),
    });
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        notionPageId: notionRecord.pageId,
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      },
    });

    // STAGES artifact_retrieval + r2_archive. Both provider buffers and
    // transient provider URLs converge here: a URL result is downloaded
    // through the SSRF guard and its validated bytes are archived in the
    // existing R2 bucket before LINE sees any URL.
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { stage: "artifact_retrieval" },
    });
    const stagedVideo = await stageLineOutboundVideo(generated.source);
    const videoUrl = stagedVideo.url;
    // Persisted BEFORE delivery is attempted. This key is what a delivery
    // retry re-signs from, and it is the reason a failed send never needs the
    // provider again.
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { stage: "r2_archive", r2ObjectKey: stagedVideo.objectKey, videoUrl },
    });

    await notionLibrary.markCompleted(notionRecord, {
      r2Url: videoUrl,
      r2ObjectKey: stagedVideo.objectKey,
      ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      completedAt: params.now(),
    });
    if (params.ugcScope) {
      if (!notionLibrary.markUgcCompleted) {
        throw new Error("UGC video library workflow is unavailable");
      }
      // Scene ledger records the archived R2 key, not the transient provider
      // URL, and only for the scene this confirmation approved.
      await notionLibrary.markUgcCompleted(params.ugcScope, actualCostUsd, {
        r2ObjectKey: stagedVideo.objectKey,
        assetUrl: videoUrl,
        completedAt: params.now(),
        model: params.draft.model,
      });
    }

    // STAGE line_delivery, in its own guard. Past this point the video EXISTS
    // and has been paid for, so a send failure must not fall into the
    // generation-failure handler below: that would tell the owner the video
    // was never made and drop the R2 object on the floor.
    try {
      await deliverArchivedLineVideo({
        cfg,
        account,
        deliveryTo: params.draft.deliveryTo,
        videoUrl,
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      });
    } catch (deliveryError) {
      await handleLineVideoDeliveryFailure({
        jobStore: params.jobStore,
        jobId: params.jobId,
        account,
        cfg,
        error: deliveryError,
        ...(params.draft.deliveryTo ? { deliveryTo: params.draft.deliveryTo } : {}),
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      });
      return;
    }
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        status: "completed",
        stage: "line_delivery",
        videoUrl,
        r2ObjectKey: stagedVideo.objectKey,
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      },
    });
  } catch (error) {
    const reason = sanitizeLineVideoFailureReason(error);
    if (notionLibrary && notionRecord) {
      await notionLibrary.markFailed(notionRecord, reason).catch(() => {});
    }
    if (notionLibrary?.markUgcFailed && params.ugcScope) {
      await notionLibrary.markUgcFailed(params.ugcScope, reason).catch(() => {});
    }
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { status: "failed", error: reason },
    });
    if (params.draft.deliveryTo) {
      await sendMessageLine(params.draft.deliveryTo, formatLineVideoFailureReply(reason), {
        cfg,
        accountId: account.accountId,
        channelAccessToken: account.channelAccessToken,
      }).catch(() => {});
    }
  } finally {
    // Releases unconditionally on every exit path (success and failure
    // alike), so a failed generation never leaves the conversation's active
    // lock held -- the next line_video_draft call sees no lock and proceeds.
    await releaseLineVideoActiveJobLock({
      store: params.activeJobLockStore,
      conversationKey: params.draft.conversationKey,
    });
  }
}
