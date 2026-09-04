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
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { estimateFalVideoCostUsd, type FalVideoPricingConfig } from "./fal-video-pricing.js";
import {
  FAL_PROVIDER_ID,
  resolveFalVideoModel,
  type FalVideoModelConfig,
} from "./fal-video-registry.js";
import { resolveLineVideoMaxEstimatedCostUsd } from "./video-cost-guard.js";
import {
  consumeLineVideoDraft,
  type LineVideoDraft,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import { confirmedFalModelId, executeConfirmedLineVideoJob } from "./video-job-execution.js";
import {
  claimLineVideoActiveJobLock,
  createLineVideoJob,
  resolveLineVideoActiveJobLock,
  type LineVideoActiveJobLockStore,
  type LineVideoJobStore,
} from "./video-job-store.js";
import { createLineVideoLibraryNotion, type LineVideoLibrary } from "./video-library-notion.js";
import { buildLineVideoConversationKey } from "./video-model-preference.js";
import {
  hasCloudbathLineGroupWorkspacePolicies,
  resolveCloudbathUgcCapabilities,
  validateLineVideoUgcScope,
  type LineVideoNotionTarget,
} from "./video-ugc-scope.js";
import {
  tryGetLineVideoWorkspaceRuntime,
  type LineVideoWorkspaceRuntime,
} from "./video-workspace-runtime.js";

const CONFIRMATION_PATTERN = /^ยืนยัน\s+VIDEO\s+(\d{4})$/iu;
const log = createSubsystemLogger("line/video-confirmation");

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

/**
 * Pre-submit revalidation outcome.
 *
 * `refused` carries the exact owner-facing text, so every refusal is written
 * where the check that produced it lives instead of being re-derived from a
 * reason code at the call site.
 */
type ConfirmedDraftRevalidation =
  | Readonly<{ kind: "ok"; estimatedCostUsd: number }>
  | Readonly<{ kind: "refused"; text: string }>;

/**
 * Re-checks a frozen draft against fal's registry and the operator's rate.
 *
 * There is no catalog call: fal publishes no live catalog, and the endpoint's
 * accepted values are fixed by its own published schema, which the registry
 * already encoded when the draft was minted. What CAN change between quote and
 * confirmation is the operator's configuration — a retired model, a changed
 * rate — so both are re-read, and either one failing refuses here exactly as it
 * would have at draft time rather than submitting a job whose cost or
 * capability is no longer established.
 */
function revalidateFalDraft(
  draft: LineVideoDraft,
  cfg: { videoGeneration?: { maxEstimatedCostUsd?: number } } & FalVideoPricingConfig &
    FalVideoModelConfig,
): ConfirmedDraftRevalidation {
  const modelId = confirmedFalModelId(draft);
  if (!modelId) {
    // Every payable draft in this flow is fal-bound. One that is not was
    // minted by an older build against a provider this flow no longer
    // generates on, and it must be re-drafted rather than submitted anywhere.
    return {
      kind: "refused",
      text: "video draft นี้ผูกกับผู้ให้บริการเดิม กรุณาสร้าง draft ใหม่ก่อนยืนยัน",
    };
  }
  const model = resolveFalVideoModel(cfg, modelId);
  if (!model) {
    return { kind: "refused", text: `video model ${modelId} ไม่พร้อมใช้งานแล้ว` };
  }
  const price = estimateFalVideoCostUsd({
    cfg,
    model,
    durationSeconds: draft.durationSeconds,
    resolution: draft.resolution,
    // Re-quoted from the SAME frozen inputs the owner confirmed, reference
    // count included, so this check cannot drift from the number they saw.
    ...(draft.referenceImageCount === undefined
      ? {}
      : { referenceImageCount: draft.referenceImageCount }),
  });
  if (price.kind !== "available") {
    return {
      kind: "refused",
      text: "ไม่สามารถประเมินค่าใช้จ่ายได้อย่างปลอดภัย ยกเลิกการสร้างวิดีโอ",
    };
  }
  const maxAllowedUsd = resolveLineVideoMaxEstimatedCostUsd(cfg);
  if (price.amountUsd > maxAllowedUsd) {
    return {
      kind: "refused",
      text: `ค่าใช้จ่ายโดยประมาณ ($${price.amountUsd.toFixed(2)}) เกินวงเงินที่ตั้งไว้ ($${maxAllowedUsd.toFixed(2)})`,
    };
  }
  return price.amountUsd === draft.estimatedCostUsd
    ? { kind: "ok", estimatedCostUsd: price.amountUsd }
    : {
        kind: "refused",
        text: "ค่าใช้จ่ายของ video draft เปลี่ยนไป กรุณาสร้าง draft ใหม่ก่อนยืนยัน",
      };
}

/**
 * Whether a payable code still quotes the storyboard version that exists now.
 *
 * A closed shape rather than a boolean: "the scene was revised" and "currency
 * could not be established" are different things to tell the owner, and both
 * have to stop the submission.
 */
type StoryboardCurrency =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "revised"; versionNumber: number }>
  | Readonly<{ kind: "unprovable" }>;

/**
 * Proves a storyboard-backed draft against the storyboard's own version chain.
 *
 * This is the authoritative stale-content guard, and it is deliberately NOT the
 * `superseded` tombstone: that tombstone is written proactively when a scene
 * changes, and a proactive write can fail. Currency is therefore established
 * here, on the confirmation turn, before anything paid is reached — so an old
 * code for a revised scene is refused even when nothing ever retired it.
 *
 * Everything that is not a positive match refuses, including a draft minted
 * before the version was frozen and a storyboard service that cannot answer.
 * Submitting on an unproven quote is the outcome this exists to prevent.
 */
async function verifyStoryboardCurrency(params: {
  draft: LineVideoDraft;
  runtime: LineVideoWorkspaceRuntime | null | undefined;
  accountId: string;
  conversationId: string;
  ownerSenderId: string;
}): Promise<StoryboardCurrency> {
  const storyboardId = params.draft.storyboardId;
  if (!storyboardId) {
    // Not a storyboard draft. The image-to-video tool freezes its own inputs
    // and has no version chain to drift from.
    return { kind: "current" };
  }
  const runtime = params.runtime;
  if (!runtime?.readStoryboardVersionNumber) {
    return { kind: "unprovable" };
  }
  const current = await runtime
    .readStoryboardVersionNumber({
      accountId: params.accountId,
      conversationId: params.conversationId,
      ownerSenderId: params.ownerSenderId,
      storyboardId,
    })
    // A storyboard service that cannot answer has proven nothing. Both a
    // rejection and a throw land here as "not proven", never as "unchanged".
    .catch(() => undefined);
  if (current === undefined) {
    return { kind: "unprovable" };
  }
  return current === params.draft.storyboardVersionNumber
    ? { kind: "current" }
    : { kind: "revised", versionNumber: current };
}

/**
 * Default fal credential check.
 *
 * Goes through core's provider auth exactly as the fal provider itself does,
 * so "configured" here means the same thing it will mean at submission time.
 * The key is never read into this module, logged, or returned.
 */
async function defaultFalAuthCheck(): Promise<boolean> {
  const auth = await resolveApiKeyForProvider({
    provider: FAL_PROVIDER_ID,
    cfg: getRuntimeConfig(),
    agentDir: resolveOpenClawAgentDir(),
  });
  return Boolean(auth.apiKey?.trim());
}

export function createLineVideoConfirmationGate(params: {
  draftStore: LineVideoDraftStore;
  jobStore: LineVideoJobStore;
  activeJobLockStore: LineVideoActiveJobLockStore;
  workspaceRuntime?: LineVideoWorkspaceRuntime;
  /** Proves fal credentials exist before the paid path is entered. */
  resolveFalAuth?: () => Promise<boolean>;
  createNotionLibrary?: (target: LineVideoNotionTarget) => LineVideoLibrary;
  scheduleBackgroundWork?: (run: () => Promise<void>) => void;
  resolveAccount?: typeof resolveLineAccount;
  now?: () => number;
}) {
  const resolveFalAuth = params.resolveFalAuth ?? defaultFalAuthCheck;
  const resolveAccount = params.resolveAccount ?? resolveLineAccount;
  const createNotionLibrary =
    params.createNotionLibrary ??
    ((target: LineVideoNotionTarget) => createLineVideoLibraryNotion({ target }));
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
    // A superseded tombstone is handled after authorization below; every other
    // non-pending status is spent or expired and stops here.
    if (
      draft.expiresAt <= confirmationTime ||
      (draft.status !== "pending" && draft.status !== "superseded")
    ) {
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

    // Placed AFTER the binding check on purpose: the replacement is a LIVE
    // code, so only the owner this one belongs to may be handed it. Read only,
    // never consumed, so a repeated confirmation keeps pointing at the new
    // code and the exactly-once consume below is untouched.
    if (draft.status === "superseded") {
      return {
        handled: true,
        text: draft.supersededByDraftId
          ? `draft นี้ถูกแทนที่แล้ว กรุณายืนยันด้วยรหัสล่าสุด:\nยืนยัน VIDEO ${draft.supersededByDraftId}`
          : "draft นี้ถูกแทนที่แล้ว กรุณาใช้รหัส VIDEO ล่าสุด",
      };
    }

    // Currency before cost, auth or consume: a code that no longer describes
    // the owner's scene must be refused before the paid path is entered at all.
    const workspaceRuntime = params.workspaceRuntime ?? tryGetLineVideoWorkspaceRuntime();
    const currency = await verifyStoryboardCurrency({
      draft,
      runtime: workspaceRuntime,
      accountId,
      conversationId,
      ownerSenderId: senderId,
    });
    if (currency.kind === "revised") {
      return {
        handled: true,
        text: `storyboard นี้ถูกแก้ไขแล้ว (ตอนนี้เป็นเวอร์ชัน ${currency.versionNumber}) รหัส VIDEO นี้เป็นของเวอร์ชันก่อนหน้าและใช้ไม่ได้แล้ว\nพิมพ์ "สร้างวิดีโอ" เพื่อรับรหัสใหม่ของเวอร์ชันล่าสุด`,
      };
    }
    if (currency.kind === "unprovable") {
      return {
        handled: true,
        text: 'ตรวจสอบเวอร์ชันล่าสุดของ storyboard ไม่ได้ จึงยกเลิกการยืนยันเพื่อความปลอดภัย\nพิมพ์ "สร้างวิดีโอ" เพื่อสร้าง draft ใหม่',
      };
    }

    const cfg = getRuntimeConfig();
    const configuredCapabilities = resolveCloudbathUgcCapabilities(cfg);
    const workspacePoliciesConfigured = hasCloudbathLineGroupWorkspacePolicies(cfg);
    const videoLibraryTarget =
      configuredCapabilities?.AI_VIDEO_LIBRARY ??
      (params.createNotionLibrary
        ? { databaseId: "0".repeat(32), dataSourceId: "1".repeat(32) }
        : undefined);
    if (!videoLibraryTarget) {
      return { handled: true, text: "ยังไม่ได้ตั้งค่า AI Video Library" };
    }
    if (workspacePoliciesConfigured && !workspaceRuntime) {
      return { handled: true, text: "Workspace policy service is unavailable." };
    }
    const ugcScope = await workspaceRuntime?.lookupUgcDraftScope(draftId);
    const groupId = conversationId.replace(/^line:group:/u, "");
    const groupBinding = await workspaceRuntime?.lookupBinding(accountId, groupId);
    if (groupBinding?.policyId === "KEEP_WATCHING") {
      return { handled: true, text: "กลุ่มนี้ไม่อนุญาตให้สร้างวิดีโอ" };
    }
    if (groupBinding?.policyId === "UGC" && !ugcScope) {
      return { handled: true, text: "UGC video draft นี้ไม่มี workspace scope ที่ยืนยันแล้ว" };
    }
    const ugcScopeValid =
      !ugcScope ||
      validateLineVideoUgcScope({
        scope: ugcScope,
        cfg,
        binding: groupBinding,
        accountId,
        groupId,
        ownerSenderId: senderId,
        frozenPrompt: draft.prompt,
      });
    if (!ugcScopeValid) {
      return { handled: true, text: "UGC video draft scope ไม่ถูกต้องหรือถูกเปลี่ยน" };
    }

    const account = resolveAccount({ cfg, accountId });
    // fal credentials are proven before the paid path is entered, so a
    // confirmation can never start a job that dies on auth after the owner
    // committed. The draft stays unconsumed and its code stays valid.
    if (!(await resolveFalAuth())) {
      return { handled: true, text: "ยังไม่ได้ตั้งค่า fal.ai API key" };
    }
    // Re-validated against the SAME endpoint and dimensions the draft froze,
    // so the pre-submit ceiling check matches what the owner was quoted.
    const revalidated = revalidateFalDraft(draft, {
      videoGeneration: account.config.videoGeneration,
    });
    if (revalidated.kind === "refused") {
      return { handled: true, text: revalidated.text };
    }
    const estimatedCostUsd = revalidated.estimatedCostUsd;

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
    if (ugcScope) {
      const consumedScope = await workspaceRuntime?.consumeUgcDraftScope(draftId);
      if (!consumedScope || JSON.stringify(consumedScope) !== JSON.stringify(ugcScope)) {
        return { handled: true, text: "UGC video draft scope เปลี่ยนแปลง กรุณาสร้างใหม่" };
      }
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
      estimatedCostUsd,
      provider: "fal",
      ...(draft.deliveryTo ? { deliveryTo: draft.deliveryTo } : {}),
      now: params.now,
    });
    await claimLineVideoActiveJobLock({
      store: params.activeJobLockStore,
      conversationKey,
      jobId: job.jobId,
      now: params.now,
    });
    log.info("LINE video confirmation scheduled", {
      correlationId: job.jobId,
      jobId: job.jobId,
      draftId: draft.draftId,
      confirmationCode: draftId,
      ugc: Boolean(ugcScope),
    });

    scheduleBackgroundWork(() =>
      executeConfirmedLineVideoJob({
        draft,
        jobStore: params.jobStore,
        activeJobLockStore: params.activeJobLockStore,
        jobId: job.jobId,
        jobCreatedAt: job.submittedAt,
        account,
        createNotionLibrary,
        videoLibraryTarget,
        ...(ugcScope ? { ugcScope } : {}),
        now,
      }),
    );

    return {
      handled: true,
      text: `🎬 เริ่มสร้างวิดีโอแล้ว (ประมาณ $${estimatedCostUsd.toFixed(2)}) จะส่งให้เมื่อเสร็จ`,
    };
  };
}
