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
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { VideoGenerationSourceAsset } from "openclaw/plugin-sdk/video-generation";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { resolveLineAccount } from "./accounts.js";
import { sendMessageLine } from "./send.js";
import { evaluateLineVideoCostGuard } from "./video-cost-guard.js";
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
import { loadOpenRouterVideoModels, type OpenRouterVideoModel } from "./video-model-catalog.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";
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

/** Renders a caught error as a short, safe-to-display failure reason. */
function sanitizeLineVideoFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/gu, " ").trim();
  const redacted = singleLine.replace(SENSITIVE_TOKEN_PATTERN, "[redacted]");
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
  account: ReturnType<typeof resolveLineAccount>;
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
  try {
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

    let videoUrl: string | undefined = video.url;
    if (video.buffer) {
      const staged = await stageLineOutboundVideo(video.buffer);
      videoUrl = staged.url;
    }
    if (!videoUrl) {
      throw new Error("Generated video has neither a buffer nor a deliverable URL");
    }

    await updateLineVideoJob({
      store: params.jobStore,
      jobId: params.jobId,
      patch: {
        status: "completed",
        videoUrl,
        ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
      },
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
  } catch (error) {
    const reason = sanitizeLineVideoFailureReason(error);
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

async function resolveLineOpenRouterApiKey(): Promise<string | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: "openrouter",
    cfg: getRuntimeConfig(),
    agentDir: resolveOpenClawAgentDir(),
  });
  return auth.apiKey;
}

export function createLineVideoConfirmationGate(params: {
  draftStore: LineVideoDraftStore;
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  resolveApiKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  scheduleBackgroundWork?: (run: () => Promise<void>) => void;
  resolveAccount?: typeof resolveLineAccount;
  now?: () => number;
}) {
  const resolveApiKey = params.resolveApiKey ?? resolveLineOpenRouterApiKey;
  const resolveAccount = params.resolveAccount ?? resolveLineAccount;
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
    // A non-owner's exact confirmation text never submits anything, even if
    // they somehow know a valid code — it is treated as ordinary chat.
    if (event.senderIsOwner !== true) {
      return undefined;
    }

    const accountId = ctx.accountId?.trim();
    const conversationId = (ctx.conversationId ?? ctx.sessionKey ?? event.sessionKey)?.trim();
    const senderId = event.senderId?.trim();
    if (!accountId || !conversationId || !senderId) {
      return undefined;
    }
    const conversationKey = buildLineVideoConversationKey({ accountId, conversationId });
    if (!conversationKey) {
      return undefined;
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

    const draft = consumeResult.draft;
    // Defense in depth: consume() already scopes by the globally unique
    // draftId, but explicitly re-verify the confirming sender/account/
    // conversation matches the draft's own recorded identity before ever
    // touching a paid API.
    if (
      draft.accountId !== accountId ||
      draft.conversationKey !== conversationKey ||
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
    const costGuard = evaluateLineVideoCostGuard({
      model,
      durationSeconds: draft.durationSeconds,
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

    // Defense in depth against a lock-claim race (two drafts confirmed for
    // the same conversation before video-draft-tool.ts's own active-lock
    // check ever saw the first one): never start a second background job
    // while one is still active for this conversation. The draft was already
    // atomically consumed above, so refusing here still costs nothing extra
    // -- a fresh draft + confirmation is required either way, matching the
    // "retry requires a new draft" rule.
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
        account,
      }),
    );

    return {
      handled: true,
      text: `🎬 เริ่มสร้างวิดีโอแล้ว (ประมาณ $${costGuard.estimatedCostUsd.toFixed(2)}) จะส่งให้เมื่อเสร็จ`,
    };
  };
}
