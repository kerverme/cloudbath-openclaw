/**
 * Owner-only video-draft confirmation (two-stage generation, stage B).
 *
 * On an exact "ยืนยัน VIDEO <code>" message from the canonical owner: re-checks
 * ownership, atomically consumes the draft (so a replayed/duplicate
 * confirmation webhook can never resubmit it — see video-draft-store.ts's
 * `consumeLineVideoDraft`, on top of the existing LINE webhook replay/dedupe
 * cache), verifies it has not expired, re-fetches live model
 * capability/pricing, re-enforces the cost guard, freezes the confirmed
 * prompt/settings exactly as drafted (no second LLM rewrite), submits
 * through core's `generateVideo()`, and delivers the result back to the
 * originating LINE conversation. Submission runs in the background — the
 * webhook handler replies immediately with a "started" acknowledgment
 * instead of blocking on a job that can take minutes.
 */
import fs from "node:fs/promises";
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { VideoGenerationSourceAsset } from "openclaw/plugin-sdk/video-generation";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { resolveLineAccount } from "./accounts.js";
import { resolveLineProviderApiKey } from "./openrouter-auth.js";
import { sendMessageLine } from "./send.js";
import { evaluateLineVideoCostGuard, resolveLineVideoOutputSize } from "./video-cost-guard.js";
import {
  consumeLineVideoDraft,
  type LineVideoDraft,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import {
  claimLineVideoActiveJobLock,
  createLineVideoJob,
  releaseLineVideoActiveJobLock,
  resolveLineVideoActiveJobLock,
  updateLineVideoJob,
  type LineVideoActiveJobLockStore,
  type LineVideoJobStore,
} from "./video-job-store.js";
import {
  createLineVideoLibraryNotion,
  type LineVideoLibrary,
  type LineVideoLibraryRecord,
} from "./video-library-notion.js";
import { loadOpenRouterVideoModels, type OpenRouterVideoModel } from "./video-model-catalog.js";
import {
  buildLineVideoConversationKey,
  normalizeLineVideoConversationId,
} from "./video-model-preference.js";
import { stageLineOutboundVideo, stageLineVideoPreviewImage } from "./video-outbound-staging.js";

const CONFIRMATION_PATTERN = /^ยืนยัน\s+VIDEO\s+(\d{4})$/iu;

type LineBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

type LineBeforeDispatchContext = {
  sessionKey?: string;
  accountId?: string;
  conversationId?: string;
};

type LineBeforeDispatchResult = { handled: boolean; text?: string };

function lineVideoDraftsMatch(left: LineVideoDraft, right: LineVideoDraft): boolean {
  return (
    left.version === right.version &&
    left.draftId === right.draftId &&
    left.accountId === right.accountId &&
    left.conversationKey === right.conversationKey &&
    left.ownerSenderId === right.ownerSenderId &&
    left.model === right.model &&
    left.prompt === right.prompt &&
    left.sourceImagePath === right.sourceImagePath &&
    left.durationSeconds === right.durationSeconds &&
    left.aspectRatio === right.aspectRatio &&
    left.resolution === right.resolution &&
    left.audio === right.audio &&
    left.estimatedCostUsd === right.estimatedCostUsd &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    left.status === right.status &&
    left.deliveryTo === right.deliveryTo
  );
}

export function parseLineVideoConfirmationCode(rawText: string): string | null {
  const match = CONFIRMATION_PATTERN.exec(rawText.trim());
  return match?.[1] ?? null;
}

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

/** Runs the actual paid submission + delivery in the background (never awaited by the webhook handler). */
async function executeConfirmedLineVideoJob(params: {
  draft: LineVideoDraft;
  model: OpenRouterVideoModel;
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  jobId: string;
  jobCreatedAt: number;
  account: ReturnType<typeof resolveLineAccount>;
  createNotionLibrary: () => LineVideoLibrary;
  now: () => number;
}): Promise<void> {
  const cfg = getRuntimeConfig();
  const account = params.account;
  const inputImages: VideoGenerationSourceAsset[] = [];
  if (params.draft.sourceImagePath) {
    const asset = await loadSourceImageAsset(params.draft.sourceImagePath);
    if (asset) {
      inputImages.push(asset);
    }
  }

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
    notionLibrary = params.createNotionLibrary();
    await notionLibrary.validate();

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
    const actualCostUsd = readOpenRouterUsageCost(result.metadata);

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
    });
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        notionPageId: notionRecord.pageId,
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      },
    });

    const generatedSource = video.buffer ?? video.url;
    if (!generatedSource) {
      throw new Error("Generated video has neither a buffer nor a deliverable URL");
    }
    // Both provider buffers and transient provider URLs converge here. URL
    // results are downloaded through the SSRF guard and their validated bytes
    // are archived in the existing R2 bucket before LINE sees any URL.
    const stagedVideo = await stageLineOutboundVideo(generatedSource);
    const videoUrl = stagedVideo.url;

    await notionLibrary.markCompleted(notionRecord, {
      r2Url: videoUrl,
      r2ObjectKey: stagedVideo.objectKey,
      ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      completedAt: params.now(),
    });

    if (params.draft.deliveryTo) {
      const preview = await stageLineVideoPreviewImage();
      const costLine =
        actualCostUsd !== undefined ? `\nActual cost: $${actualCostUsd.toFixed(2)}` : "";
      await sendMessageLine(params.draft.deliveryTo, `🎬 วิดีโอเสร็จแล้ว${costLine}`, {
        cfg,
        accountId: account.accountId,
        channelAccessToken: account.channelAccessToken,
        mediaUrl: videoUrl,
        mediaKind: "video",
        previewImageUrl: preview.url,
      });
    }
    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        status: "completed",
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

export function createLineVideoConfirmationGate(params: {
  draftStore: LineVideoDraftStore;
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  resolveApiKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  createNotionLibrary?: () => LineVideoLibrary;
  scheduleBackgroundWork?: (run: () => Promise<void>) => void;
  resolveAccount?: typeof resolveLineAccount;
  now?: () => number;
}) {
  const resolveApiKey = params.resolveApiKey ?? (() => resolveLineProviderApiKey());
  const resolveAccount = params.resolveAccount ?? resolveLineAccount;
  const createNotionLibrary = params.createNotionLibrary ?? (() => createLineVideoLibraryNotion());
  const now = params.now ?? Date.now;
  const scheduleBackgroundWork =
    params.scheduleBackgroundWork ?? ((run: () => Promise<void>) => void run());

  return async (
    event: LineBeforeDispatchEvent,
    ctx: LineBeforeDispatchContext,
  ): Promise<LineBeforeDispatchResult | undefined> => {
    if (event.channel !== "line") {
      return undefined;
    }
    const draftId = parseLineVideoConfirmationCode(event.body ?? event.content ?? "");
    if (!draftId) {
      return undefined;
    }
    // An exact confirmation is executable control, not ordinary discussion.
    // Claim and deny it here so an unauthorized sender can never hand the
    // code to the chat model as another route toward paid generation.
    if (event.senderIsOwner !== true) {
      return { handled: true, text: "ไม่มีสิทธิ์ยืนยันการสร้างวิดีโอ" };
    }

    const accountId = ctx.accountId?.trim();
    // before_dispatch's trusted native conversation id is the same LINE
    // group/room/user identity used by the draft tool. Session ids/keys are
    // intentionally excluded: they are OpenClaw lifecycle identities and are
    // not stable aliases for a LINE conversation.
    const conversationId = ctx.conversationId?.trim();
    const senderId = event.senderId?.trim();
    if (!accountId || !conversationId || !senderId) {
      return { handled: true, text: "ยืนยันสิทธิ์เจ้าของสำหรับ video draft นี้ไม่ได้" };
    }
    const conversationKey = buildLineVideoConversationKey({ accountId, conversationId });
    if (!conversationKey) {
      return { handled: true, text: "ยืนยันสิทธิ์เจ้าของสำหรับ video draft นี้ไม่ได้" };
    }

    // Read first, validate every authorization/cost invariant, then atomically
    // consume immediately before job creation. Consuming before these checks
    // lets another authorized owner invalidate a code that is not theirs.
    const draft = await params.draftStore.lookup(draftId);
    if (!draft) {
      return { handled: true, text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว" };
    }
    const confirmationTime = (params.now ?? Date.now)();
    if (draft.expiresAt <= confirmationTime || draft.status !== "pending") {
      return { handled: true, text: "video draft นี้หมดอายุแล้ว กรุณาสร้างใหม่" };
    }

    // A code is bound to the exact owner, LINE account, and conversation that
    // created it. A different authorized owner cannot consume or transfer it.
    if (
      draft.accountId !== accountId ||
      draft.conversationKey !== conversationKey ||
      !draft.deliveryTo ||
      buildLineVideoConversationKey({
        accountId: draft.accountId,
        conversationId: draft.deliveryTo,
      }) !== conversationKey ||
      draft.ownerSenderId !== senderId
    ) {
      return { handled: true, text: "video draft นี้ไม่ตรงกับบทสนทนานี้" };
    }

    const apiKey = await resolveApiKey();
    if (!apiKey?.trim()) {
      return { handled: true, text: "ยังไม่ได้ตั้งค่า OpenRouter API key" };
    }
    let models: OpenRouterVideoModel[];
    try {
      models = await loadOpenRouterVideoModels({ apiKey, fetchImpl: params.fetchImpl });
    } catch {
      return { handled: true, text: "ตรวจสอบ video model ไม่สำเร็จ ลองยืนยันใหม่อีกครั้งได้ไหม?" };
    }
    const model = models.find((entry) => entry.id === draft.model);
    if (!model) {
      return { handled: true, text: `video model ${draft.model} ไม่พร้อมใช้งานแล้ว` };
    }
    if (
      (model.supportedAspectRatios.length > 0 &&
        !model.supportedAspectRatios.includes(draft.aspectRatio)) ||
      (model.supportedResolutions.length > 0 &&
        !model.supportedResolutions.includes(draft.resolution)) ||
      (model.supportedDurationSeconds.length > 0 &&
        !model.supportedDurationSeconds.includes(draft.durationSeconds))
    ) {
      return { handled: true, text: "การตั้งค่าของ draft นี้ไม่รองรับแล้ว กรุณาสร้าง draft ใหม่" };
    }

    const account = resolveAccount({ cfg: getRuntimeConfig(), accountId });
    // Re-estimate against the SAME dimensions the draft froze, so the
    // pre-submit ceiling check matches what the owner confirmed.
    const costGuard = evaluateLineVideoCostGuard({
      model,
      selector: {
        durationSeconds: draft.durationSeconds,
        ...((size) => (size ? { size } : {}))(
          resolveLineVideoOutputSize({
            supportedSizes: model.supportedSizes,
            resolution: draft.resolution,
            aspectRatio: draft.aspectRatio,
          }),
        ),
        resolution: draft.resolution,
        audio: draft.audio,
      },
      cfg: { videoGeneration: account.config.videoGeneration },
    });
    if (!costGuard.allowed) {
      return {
        handled: true,
        text:
          costGuard.reason === "unknown_cost"
            ? "ไม่สามารถประเมินค่าใช้จ่ายได้อย่างปลอดภัย ยกเลิกการสร้างวิดีโอ"
            : `ค่าใช้จ่ายโดยประมาณ ($${costGuard.estimatedCostUsd.toFixed(2)}) เกินวงเงินที่ตั้งไว้ ($${costGuard.maxAllowedUsd.toFixed(2)})`,
      };
    }
    if (costGuard.estimatedCostUsd !== draft.estimatedCostUsd) {
      return {
        handled: true,
        text: "ค่าใช้จ่ายของ video draft เปลี่ยนไป กรุณาสร้าง draft ใหม่ก่อนยืนยัน",
      };
    }

    // Defense in depth against a lock-claim race (two drafts confirmed for
    // the same conversation before video-draft-tool.ts's own active-lock
    // check ever saw the first one): never start a second background job
    // while one is still active for this conversation. Refusing here leaves
    // this valid, owner-bound draft unconsumed.
    const existingLock = await resolveLineVideoActiveJobLock({
      store: params.activeJobLockStore,
      conversationKey,
      now: params.now,
    });
    if (existingLock) {
      return {
        handled: true,
        text: "มีงานสร้างวิดีโออื่นกำลังทำงานอยู่ในบทสนทนานี้ กรุณารอให้เสร็จก่อนเริ่มงานใหม่",
      };
    }

    const consumeResult = await consumeLineVideoDraft({
      store: params.draftStore,
      draftId,
      now: params.now,
    });
    if (consumeResult.kind === "not_found") {
      return { handled: true, text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว" };
    }
    if (consumeResult.kind === "expired") {
      return { handled: true, text: "video draft นี้หมดอายุแล้ว กรุณาสร้างใหม่" };
    }
    if (!lineVideoDraftsMatch(consumeResult.draft, draft)) {
      return { handled: true, text: "video draft เปลี่ยนแปลง กรุณาสร้างใหม่" };
    }

    const job = await createLineVideoJob({
      store: params.jobStore,
      draftId: draft.draftId,
      accountId,
      conversationKey,
      model: draft.model,
      prompt: draft.prompt,
      durationSeconds: draft.durationSeconds,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      audio: draft.audio,
      estimatedCostUsd: costGuard.estimatedCostUsd,
      now: params.now,
    });
    await claimLineVideoActiveJobLock({
      store: params.activeJobLockStore,
      conversationKey,
      jobId: job.jobId,
      now: params.now,
    });

    scheduleBackgroundWork(() =>
      executeConfirmedLineVideoJob({
        draft,
        model,
        jobStore: params.jobStore,
        activeJobLockStore: params.activeJobLockStore,
        jobId: job.jobId,
        jobCreatedAt: job.submittedAt,
        account,
        createNotionLibrary,
        now,
      }),
    );

    return {
      handled: true,
      text: `🎬 เริ่มสร้างวิดีโอแล้ว (ประมาณ $${costGuard.estimatedCostUsd.toFixed(2)}) จะส่งให้เมื่อเสร็จ`,
    };
  };
}
