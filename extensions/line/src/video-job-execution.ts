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
import type { VideoGenerationSourceAsset } from "openclaw/plugin-sdk/video-generation";
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
import type { LineVideoProviderRoute } from "./video-provider-routing.js";
import { resolveLineVideoReferenceUrls } from "./video-reference-urls.js";
import {
  materializeLineVideoUgcReferences,
  type LineVideoNotionTarget,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";

const log = createSubsystemLogger("line/video-job");

/** Reads `metadata.usage.cost` from generateVideo()'s result without unsafe optional-chained casts. */
function readOpenRouterUsageCost(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  const usage = metadata?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" ? cost : undefined;
}

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

async function loadSourceImageAsset(path: string): Promise<VideoGenerationSourceAsset | undefined> {
  try {
    const buffer = await fs.readFile(path);
    return { buffer };
  } catch {
    return undefined;
  }
}

/**
 * The route a confirmed draft is locked to.
 *
 * A draft minted before provider routing existed carries none; it was quoted
 * against OpenRouter, so that is what it submits to. The route is READ here,
 * never recomputed: re-deriving it at submission time could send the paid job
 * to a provider whose price the owner never saw.
 */
export function confirmedDraftRoute(draft: LineVideoDraft): LineVideoProviderRoute {
  return draft.providerRoute ?? { provider: "openrouter", modelId: draft.model };
}

/** What one provider stage produced. `source` is bytes or a transient URL. */
type ProviderGenerationOutcome = Readonly<{
  provider: string;
  source: Buffer | string;
  actualCostUsd?: number;
}>;

/**
 * The one paid call, dispatched on the draft's frozen route.
 *
 * There is no cross-provider fallback edge on purpose: a fal failure does not
 * retry on OpenRouter and vice versa. Either would be a second paid job the
 * owner never confirmed, billed at a price they were never quoted.
 */
async function runProviderGeneration(params: {
  draft: LineVideoDraft;
  jobId: string;
  ugcScope?: LineVideoUgcScope;
}): Promise<ProviderGenerationOutcome> {
  const route = confirmedDraftRoute(params.draft);
  if (route.provider === "fal") {
    return await runFalGeneration({ ...params, route });
  }
  const cfg = getRuntimeConfig();
  const inputImages: VideoGenerationSourceAsset[] = [];
  if (params.ugcScope) {
    inputImages.push(
      ...(await materializeLineVideoUgcReferences(params.ugcScope, {
        correlationId: params.jobId,
      })),
    );
  }
  if (params.draft.sourceImagePath) {
    const asset = await loadSourceImageAsset(params.draft.sourceImagePath);
    if (asset) {
      inputImages.push(asset);
    }
  }
  const result = await generateVideo({
    cfg,
    prompt: params.draft.prompt,
    agentDir: resolveOpenClawAgentDir(),
    modelOverride: `openrouter/${params.draft.model}`,
    aspectRatio: params.draft.aspectRatio,
    resolution: params.draft.resolution,
    durationSeconds: params.draft.durationSeconds,
    audio: params.draft.audio,
    inputImages: inputImages.length > 0 ? inputImages : undefined,
    // The confirmed draft is model/provider-locked; a silent fallback
    // substitution here would violate "the confirmed prompt/settings must
    // be exactly what gets submitted".
    autoProviderFallback: false,
  });
  const video = result.videos[0];
  if (!video) {
    throw new Error("OpenRouter video generation returned no video asset");
  }
  const source = video.buffer ?? video.url;
  if (!source) {
    throw new Error("Generated video has neither a buffer nor a deliverable URL");
  }
  const actualCostUsd = readOpenRouterUsageCost(result.metadata);
  return {
    provider: "openrouter",
    source,
    ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
  };
}

/**
 * fal's reference-to-video path, through core's registered `fal` provider.
 *
 * This plugin holds no fal client: `extensions/fal` already implements the
 * endpoint's queue submit, poll, reference-count caps and SSRF-guarded
 * artifact download, and core resolves its FAL_KEY the same way it resolves
 * every other provider's credential.
 *
 * What IS this plugin's job is the reference images. fal's endpoint takes
 * URLs, not bytes, so they are published as SHORT-LIVED signed R2 URLs from
 * the same frozen Character Library assets and in the same order the
 * OpenRouter path submits, and passed through as `url` assets so the provider
 * forwards them verbatim instead of inlining megabytes of base64.
 */
async function runFalGeneration(params: {
  draft: LineVideoDraft;
  jobId: string;
  ugcScope?: LineVideoUgcScope;
  route: Extract<LineVideoProviderRoute, { provider: "fal" }>;
}): Promise<ProviderGenerationOutcome> {
  if (!params.ugcScope) {
    throw new Error("fal reference-to-video requires a frozen reference scope");
  }
  const references = await resolveLineVideoReferenceUrls(params.ugcScope, {
    correlationId: params.jobId,
  });
  const result = await generateVideo({
    cfg: getRuntimeConfig(),
    prompt: params.draft.prompt,
    agentDir: resolveOpenClawAgentDir(),
    modelOverride: `fal/${params.route.modelId}`,
    aspectRatio: params.draft.aspectRatio,
    resolution: params.draft.resolution,
    durationSeconds: params.draft.durationSeconds,
    audio: params.draft.audio,
    inputImages: references.map((reference) => ({
      url: reference.url,
      mimeType: reference.mimeType,
      role: "reference_image" as const,
    })),
    autoProviderFallback: false,
  });
  const video = result.videos[0];
  const source = video?.buffer ?? video?.url;
  if (!source) {
    throw new Error("fal video generation returned no video asset");
  }
  // Whatever fal returned is TRANSIENT -- a signed artifact URL or its bytes.
  // The caller re-stages it in R2 before LINE sees any URL.
  return { provider: "fal", source };
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
 * Re-sends a video that is ALREADY archived in R2. Calls no provider, ever.
 *
 * The signed URL the original attempt used has its own lifetime, so the object
 * key -- not that URL -- is what is persisted and re-signed here. This is the
 * whole reason `r2_archive` is a stage of its own: a delivery failure is
 * recoverable work on bytes already paid for, not a reason to bill again.
 */
export async function retryLineVideoDelivery(params: {
  jobStore: LineVideoJobStore;
  jobId: string;
  account: ReturnType<typeof resolveLineAccount>;
  deliveryTo?: string;
  cfg?: ReturnType<typeof getRuntimeConfig>;
  signUrl?: typeof signArchivedLineVideoUrl;
  deliver?: typeof deliverArchivedLineVideo;
}): Promise<LineVideoDeliveryRetryResult> {
  const job = await params.jobStore.lookup(params.jobId);
  if (!job?.r2ObjectKey || job.status === "completed") {
    return { kind: "no_recoverable_job" };
  }
  const cfg = params.cfg ?? getRuntimeConfig();
  const deliveryTo = params.deliveryTo ?? undefined;
  try {
    const videoUrl = await (params.signUrl ?? signArchivedLineVideoUrl)(job.r2ObjectKey);
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

    // STAGE provider_generation -- the only stage that spends money.
    const generated = await runProviderGeneration(params);
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: { stage: "provider_generation", provider: generated.provider },
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
