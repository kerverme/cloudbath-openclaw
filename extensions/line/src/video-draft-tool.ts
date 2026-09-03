/**
 * Owner-only "video prompt director" tool (two-stage generation, stage A).
 *
 * The chat LLM calls this to turn a user's natural-language video idea into a
 * final prompt/settings and persist a DRAFT — see video-draft-store.ts. This
 * tool makes zero calls to OpenRouter's paid video-generation endpoint: it
 * only reads the live (free) model-catalog endpoint to validate settings and
 * estimate cost. Nothing is submitted until the owner sends the exact
 * confirmation code back (video-confirmation.ts), and the confirmed
 * prompt/settings are exactly what gets frozen and submitted then — this
 * tool's output is never silently rewritten by a second LLM pass.
 */
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logInfo, redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type TSchema } from "typebox";
import { resolveLineAccount } from "./accounts.js";
import { offerFalStoryboardDefault } from "./fal-storyboard-seam.js";
import { falSeedanceDurations } from "./fal-video-registry.js";
import { LINE_OPENROUTER_PROVIDER_ID, resolveLineProviderApiKey } from "./openrouter-auth.js";
import { resolveLineVideoMaxEstimatedCostUsd } from "./video-cost-guard.js";
import { createLineVideoDraft, type LineVideoDraftStore } from "./video-draft-store.js";
import {
  resolveLineVideoActiveJobLock,
  type LineVideoActiveJobLockStore,
} from "./video-job-store.js";
import {
  buildLineVideoConversationKey,
  type LineVideoModelPreferenceStore,
} from "./video-model-preference.js";

const DEFAULT_DURATION_SECONDS = 8;
const DEFAULT_ASPECT_RATIO = "16:9";
const DEFAULT_RESOLUTION = "1080p";

const VideoDraftToolProperties = {
  prompt: Type.String({
    description:
      "Final video prompt, already translated from the user's request. Not shown to the LLM again after confirmation.",
  }),
  image: Type.Optional(
    Type.String({
      description:
        "Exact local path of the inbound reference image for image-to-video, if the user attached one. Never substitute a different image.",
    }),
  ),
  durationSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  aspectRatio: Type.Optional(Type.String()),
  resolution: Type.Optional(Type.String()),
  audio: Type.Optional(Type.Boolean()),
} satisfies Record<string, TSchema>;

function formatDraftPreview(params: {
  draftId: string;
  modelName: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  audio: boolean;
  estimatedCostUsd: number;
  prompt: string;
}): string {
  return [
    "🎬 Video draft",
    "",
    `Model: ${params.modelName}`,
    `Duration: ${params.durationSeconds} sec`,
    `Resolution: ${params.resolution}`,
    `Aspect: ${params.aspectRatio}`,
    `Audio: ${params.audio ? "On" : "Off"}`,
    "",
    `Estimated cost: $${params.estimatedCostUsd.toFixed(2)}`,
    "",
    "Prompt:",
    params.prompt,
    "",
    `ยืนยัน VIDEO ${params.draftId}`,
    "เพื่อเริ่มสร้าง",
  ].join("\n");
}

/** Provider whose credentials this tool needs. Named in every auth-failure result. */
const VIDEO_PROVIDER_ID = LINE_OPENROUTER_PROVIDER_ID;

/**
 * Closed set of draft outcomes. Exactly one is logged per attempt and returned
 * to the model, so a LINE-visible failure can always be traced to a specific
 * branch instead of being re-invented by the LLM.
 */
type LineVideoDraftResolution =
  | "draft_created"
  | "invalid_input"
  | "context_unavailable"
  | "already_running"
  | "image_unavailable"
  | "provider_auth_unavailable"
  | "model_unavailable"
  | "unsupported_duration"
  | "unknown_cost"
  | "over_limit";

/**
 * Deterministic owner-facing text for infrastructure failures.
 *
 * The tool returns this verbatim so the LLM relays a true cause instead of
 * inventing one. The production regression this prevents: a provider-credential
 * failure surfaced in LINE as "ระบบสร้างวิดีโอขอยืนยันสิทธิ์การใช้งานไม่สำเร็จ"
 * ("authorization check failed"), which reads as a LINE owner-permission
 * problem and is simply wrong -- owner authorization had already succeeded.
 */
const DRAFT_FAILURE_TEXT: Partial<Record<LineVideoDraftResolution, string>> = {
  context_unavailable: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: LINE runtime context ไม่ครบ",
  provider_auth_unavailable:
    "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ระบบไม่พบการเชื่อมต่อ fal.ai สำหรับ Video",
  model_unavailable: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ไม่พบ Video Model ที่รองรับใน fal.ai",
  // Says explicitly that NO draft exists. The cost guard runs BEFORE
  // createLineVideoDraft, so any "draft created" wording here would be false --
  // which is exactly what the LLM produced in production
  // ("สร้างคำขอวิดีโอไว้แล้ว...") when it was left to narrate this branch.
  unknown_cost:
    "❌ ยังไม่ได้สร้าง Video Draft\nสาเหตุ: ระบบยังคำนวณค่าใช้จ่ายของ Video Model นี้ไม่ได้\nยังไม่มีการส่งคำขอสร้างวิดีโอและยังไม่มีค่าใช้จ่าย",
};

/** Presence marker for diagnostics; never emits the value itself. */
function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

type CreateLineVideoDraftToolParams = {
  messageChannel?: string;
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  sessionId?: string;
  /** Trusted LINE-native group/room/user id for the active inbound turn. */
  nativeConversationId?: string;
  /**
   * Host session key. The one identity shared with the outbound
   * `message_sending` hook, so it is what the relay correlates on.
   */
  sessionKey?: string;
  accountId?: string;
  /** LINE-native `to` address for the trusted active delivery route, if known. */
  deliveryTo?: string;
  cfg?: OpenClawConfig;
  draftStore?: LineVideoDraftStore;
  preferenceStore?: LineVideoModelPreferenceStore;
  activeJobLockStore?: LineVideoActiveJobLockStore;
  /** Overrides canonical OpenRouter credential resolution (tests only). */
  resolveApiKey?: () => Promise<string | undefined>;
  /** Direct fal credential check; preferred over `resolveApiKey` when supplied. */
  resolveFalAuth?: () => Promise<boolean>;
  /** ctx.hasAuthForProvider, for diagnostics only -- never gates the flow. */
  hasProviderAuth?: (providerId: string) => boolean;
  /**
   * Whether the agent tool context supplied resolveApiKeyForProvider. Recorded
   * so production logs can confirm the auth-profile-only closure's presence
   * without it deciding anything.
   */
  contextApiKeyResolverAvailable?: boolean;
  /**
   * Arms the deterministic reply relay (video-draft-reply-relay.ts). Every
   * text below that states a price, or states whether a draft exists at all,
   * must reach the owner verbatim; as tool content alone it is only a
   * suggestion to the model, which rewrote both in production.
   */
  recordDeterministicText?: (params: { sessionKey?: string; text: string }) => void | Promise<void>;
  resolveAccount?: typeof resolveLineAccount;
  fetchImpl?: typeof fetch;
  fileExists?: (path: string) => Promise<boolean>;
  now?: () => number;
};

export const LINE_VIDEO_DRAFT_TOOL_NAME = "line_video_draft";

export function createLineVideoDraftTool(params: CreateLineVideoDraftToolParams) {
  if (params.messageChannel !== "line" || params.senderIsOwner !== true) {
    return null;
  }
  const resolveAccount = params.resolveAccount ?? resolveLineAccount;
  /**
   * Proves fal credentials exist before a payable code is minted.
   *
   * `resolveApiKey` is still accepted so the existing wiring and tests keep
   * their injection point; whatever it returns is treated only as "credentials
   * are present". The key itself is never read into this module or logged.
   */
  const resolveFalAuth = async (): Promise<boolean> => {
    if (params.resolveFalAuth) {
      return await params.resolveFalAuth();
    }
    const resolve = params.resolveApiKey ?? (() => resolveLineProviderApiKey(VIDEO_PROVIDER_ID));
    return Boolean((await resolve())?.trim());
  };
  const fileExists =
    params.fileExists ??
    (async (path: string) => {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    });

  return {
    name: LINE_VIDEO_DRAFT_TOOL_NAME,
    label: "LINE Video Draft",
    description:
      "OWNER-ONLY. Creates a video-generation DRAFT for owner confirmation. Never triggers paid generation — call this whenever the owner asks to make/generate a video, with a finished prompt and settings you have derived from their request. Include `image` with the exact attached image's local path for image-to-video; never invent a different image path.",
    parameters: Type.Object(VideoDraftToolProperties),
    execute: async (_toolCallId: string, rawInput: unknown) => {
      // Presence-only attempt record. Railway could not previously tell which
      // branch a LINE draft failed on; identifiers are hashed, never raw, and
      // no credential value is ever read here.
      logInfo(
        `[line/video-draft] event=video_draft_attempt channel=line ` +
          `accountId=${redactIdentifier(params.accountId)} ` +
          `sessionId=${redactIdentifier(params.sessionId)} ` +
          `requesterSenderId=${redactIdentifier(params.requesterSenderId)} ` +
          `senderIsOwner=${params.senderIsOwner === true} ` +
          `deliveryTo=${present(params.deliveryTo)} ` +
          `contextApiKeyResolver=${params.contextApiKeyResolverAvailable === true} ` +
          `hasAuthForProvider=${params.hasProviderAuth?.(VIDEO_PROVIDER_ID) ?? "unknown"}`,
      );

      /** Logs exactly one resolution per attempt, then returns the tool result. */
      const finish = <T>(resolution: LineVideoDraftResolution, result: T): T => {
        logInfo(
          `[line/video-draft] event=video_draft_result channel=line resolution=${resolution}`,
        );
        return result;
      };

      /**
       * Infrastructure failure: return the deterministic Thai cause as tool
       * text so the model relays it verbatim, plus structured details naming
       * the provider so "auth" can never be read as LINE owner authorization.
       */
      /**
       * Pins tool-owned text onto this turn's outbound LINE payload. Every
       * deterministic branch routes through here, so the model can never
       * substitute its own wording for a cost or a did-this-happen statement.
       */
      const recordDeterministicText = async (text: string): Promise<void> => {
        // Awaited by every caller below. The relay is lazily loaded by the
        // plugin entrypoint, so arming can be async; it must COMPLETE before
        // this tool returns, or the model's reply can reach the outbound hook
        // first and the paraphrase ships instead of this text.
        await params.recordDeterministicText?.({
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          text,
        });
      };

      const failDeterministic = async (
        resolution: LineVideoDraftResolution,
        details?: Record<string, unknown>,
      ) => {
        const text = DRAFT_FAILURE_TEXT[resolution] ?? "";
        await recordDeterministicText(text);
        return finish(resolution, {
          content: [{ type: "text" as const, text }],
          details: { resolution, ...details },
        });
      };

      const input =
        rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) {
        return finish(
          "invalid_input",
          jsonResult({ resolution: "invalid_input", reason: "prompt is required" }),
        );
      }
      const requesterSenderId = params.requesterSenderId?.trim();
      const accountId = params.accountId?.trim();
      const deliveryTo = params.deliveryTo?.trim();
      const nativeConversationId = (params.nativeConversationId ?? deliveryTo)?.trim();
      if (
        !nativeConversationId ||
        !requesterSenderId ||
        !accountId ||
        !deliveryTo ||
        !params.draftStore ||
        !params.preferenceStore ||
        !params.activeJobLockStore
      ) {
        return failDeterministic("context_unavailable");
      }
      const conversationKey = buildLineVideoConversationKey({
        accountId,
        conversationId: nativeConversationId,
      });
      const deliveryConversationKey = buildLineVideoConversationKey({
        accountId,
        conversationId: deliveryTo,
      });
      if (!conversationKey || deliveryConversationKey !== conversationKey) {
        return failDeterministic("context_unavailable");
      }

      // A previous confirmed job for this conversation is still running
      // (or was, before a stale lock got auto-cleared) -- refuse a new draft
      // rather than let the owner start a second concurrent paid job. Once
      // that job reaches a terminal state (completed or failed), the lock is
      // released and this check passes again immediately; no separate
      // "unstick" step is needed.
      const activeLock = await resolveLineVideoActiveJobLock({
        store: params.activeJobLockStore,
        conversationKey,
        ...(params.now ? { now: params.now } : {}),
      });
      if (activeLock) {
        return finish(
          "already_running",
          jsonResult({ resolution: "already_running", jobId: activeLock.jobId }),
        );
      }

      const imagePath = typeof input.image === "string" ? input.image.trim() : undefined;
      if (imagePath && !(await fileExists(imagePath))) {
        return finish(
          "image_unavailable",
          jsonResult({ resolution: "image_unavailable", image: imagePath }),
        );
      }

      // Strictly a missing fal provider credential. Owner authorization was
      // already enforced at factory time and has NOT failed here. Proven
      // before a payable code exists, so the owner is never handed one that
      // dies on credentials once they commit to it.
      if (!(await resolveFalAuth())) {
        return failDeterministic("provider_auth_unavailable", { provider: VIDEO_PROVIDER_ID });
      }

      const account = resolveAccount({ cfg: params.cfg ?? getRuntimeConfig(), accountId });
      const cfg = account.config;
      const requestedDurationSeconds =
        typeof input.durationSeconds === "number" ? input.durationSeconds : undefined;
      const durationSeconds = requestedDurationSeconds ?? DEFAULT_DURATION_SECONDS;
      const aspectRatio =
        typeof input.aspectRatio === "string" ? input.aspectRatio : DEFAULT_ASPECT_RATIO;
      const resolution =
        typeof input.resolution === "string" ? input.resolution : DEFAULT_RESOLUTION;
      const audio = typeof input.audio === "boolean" ? input.audio : false;

      // The same capability-aware selection the storyboard flow uses, against
      // the same fal registry: one place decides which endpoint can execute a
      // request, so the two owner paths cannot bind different models.
      const requirements = {
        durationSeconds,
        aspectRatio,
        resolution,
        audio: audio ? ("full" as const) : ("off" as const),
        spokenDialogue: false,
        // This path carries at most the owner's own attached image, which is
        // not a Character Library identity lock.
        identityReferenceCount: 0,
      };
      const offer = offerFalStoryboardDefault(cfg, requirements);
      if (offer.kind !== "offered") {
        const supported = falSeedanceDurations();
        const text = [
          "❌ ยังไม่ได้สร้าง Video Draft",
          `สาเหตุ: ไม่มีโมเดลที่รองรับคำขอนี้ (ความยาว ${durationSeconds} วินาที)`,
          `ระยะเวลาที่รองรับ: ${supported.join(", ")} วินาที`,
          "ยังไม่มีการส่งคำขอสร้างวิดีโอและยังไม่มีค่าใช้จ่าย",
        ].join("\n");
        await recordDeterministicText(text);
        return finish("unsupported_duration", {
          content: [{ type: "text" as const, text }],
          details: {
            resolution: "unsupported_duration",
            requestedDurationSeconds: durationSeconds,
            supportedDurationSeconds: supported,
          },
        });
      }
      const model = offer.model;
      if (offer.estimatedCostUsd === undefined) {
        logInfo(
          `[line/video-draft] event=video_cost_unknown model=${model.modelId} ` +
            `durationSeconds=${durationSeconds} resolution=${resolution} audio=${audio}`,
        );
        return failDeterministic("unknown_cost", { model: model.modelId });
      }
      const maxAllowedUsd = resolveLineVideoMaxEstimatedCostUsd(cfg);
      if (offer.estimatedCostUsd > maxAllowedUsd) {
        return finish(
          "over_limit",
          jsonResult({
            resolution: "over_limit",
            estimatedCostUsd: offer.estimatedCostUsd,
            maxAllowedUsd,
          }),
        );
      }
      const estimatedCostUsd = offer.estimatedCostUsd;

      const draft = await createLineVideoDraft({
        store: params.draftStore,
        accountId,
        conversationKey,
        ownerSenderId: requesterSenderId,
        model: model.modelId,
        providerRoute: Object.freeze({ provider: "fal", modelId: model.modelId }),
        prompt,
        ...(imagePath ? { sourceImagePath: imagePath } : {}),
        durationSeconds,
        aspectRatio,
        resolution,
        audio,
        estimatedCostUsd,
        deliveryTo,
        ...(params.now ? { now: params.now } : {}),
      });

      const preview = formatDraftPreview({
        draftId: draft.draftId,
        modelName: model.displayName,
        durationSeconds,
        resolution,
        aspectRatio,
        audio,
        estimatedCostUsd,
        prompt,
      });
      await recordDeterministicText(preview);
      return finish("draft_created", {
        content: [{ type: "text" as const, text: preview }],
        details: {
          resolution: "draft_created",
          draftId: draft.draftId,
          model: model.modelId,
          estimatedCostUsd,
        },
      });
    },
  };
}

/**
 * Agent-run context for the LINE video guard. `channel` is the
 * host-authoritative channel/plugin id stamped on channel-originated runs
 * (`PluginHookAgentContext.channel`); `channelId` on the tool-call context is
 * NOT a reliable substitute (see the guard doc below).
 */
type AgentRunContext = {
  channel?: string;
  runId?: string;
  sessionId?: string;
};

type BeforeToolCallEvent = { toolName: string };
type BeforeToolCallResult = { block: boolean; blockReason?: string };

const BLOCKED_VIDEO_GENERATE_TOOL_NAME = "video_generate";

function agentRunContextKeys(ctx: AgentRunContext): string[] {
  return [
    ctx.runId ? `run:${ctx.runId}` : "",
    ctx.sessionId ? `session:${ctx.sessionId}` : "",
  ].filter(Boolean);
}

/**
 * Blocks the core `video_generate` agent tool from ever firing directly
 * within a LINE-channel agent session. Video generation costs money, so the
 * only path to an actual paid OpenRouter video request on LINE is the
 * deterministic owner-only draft/confirm flow above (this tool +
 * video-confirmation.ts) — the chat LLM must never be able to trigger
 * generation on its own by calling the generic tool.
 *
 * LINE-ness is captured at `before_agent_run`, where the host stamps the
 * authoritative `ctx.channel`, and matched later by run/session key. It is
 * deliberately NOT read from the tool-call context's `channelId`: that field
 * is populated only from `hookChannelId ?? currentChannelId`
 * (src/agents/agent-tools.ts:1184), `hookChannelId` is never assigned
 * anywhere in the tree, and `currentChannelId` carries a delivery target on
 * some paths rather than a channel id. A `ctx.channelId !== "line"` test
 * therefore FAILS OPEN whenever the field is absent — which is how a paid
 * `video_generate` run reached the provider in production. Keying off the
 * recorded run instead fails closed for every LINE execution path, while
 * non-LINE runs are never recorded and stay completely unaffected.
 *
 * Mirrors model-catalog-tool.ts's createLineModelSwitchGuard, which already
 * uses this same before_agent_run/agent_end context-tracking shape for the
 * identical "is this tool call inside a LINE run" question.
 */
export function createLineVideoGenerationGuard() {
  const activeLineContexts = new Set<string>();
  return {
    beforeAgentRun: (_event: unknown, ctx: AgentRunContext): void => {
      if (ctx.channel !== "line") {
        return;
      }
      for (const key of agentRunContextKeys(ctx)) {
        activeLineContexts.add(key);
      }
    },
    beforeToolCall: (
      event: BeforeToolCallEvent,
      ctx: AgentRunContext,
    ): BeforeToolCallResult | undefined => {
      if (event.toolName !== BLOCKED_VIDEO_GENERATE_TOOL_NAME) {
        return undefined;
      }
      const isActiveLineContext = agentRunContextKeys(ctx).some((key) =>
        activeLineContexts.has(key),
      );
      if (!isActiveLineContext) {
        return undefined;
      }
      return {
        block: true,
        blockReason:
          "LINE video generation requires the owner-only draft/confirm flow (create a draft, then send the exact confirmation code); direct video_generate calls are blocked on this channel.",
      };
    },
    agentEnd: (_event: unknown, ctx: AgentRunContext): void => {
      for (const key of agentRunContextKeys(ctx)) {
        activeLineContexts.delete(key);
      }
    },
  };
}
