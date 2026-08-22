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
import { LINE_OPENROUTER_PROVIDER_ID, resolveLineProviderApiKey } from "./openrouter-auth.js";
import { evaluateLineVideoCostGuard, resolveLineVideoOutputSize } from "./video-cost-guard.js";
import { createLineVideoDraft, type LineVideoDraftStore } from "./video-draft-store.js";
import {
  resolveLineVideoActiveJobLock,
  type LineVideoActiveJobLockStore,
} from "./video-job-store.js";
import { loadOpenRouterVideoModels, type OpenRouterVideoModel } from "./video-model-catalog.js";
import {
  buildLineVideoConversationKey,
  resolveLineVideoModelPreference,
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

function nearestSupported(values: readonly number[], requested: number): number {
  if (values.length === 0) {
    return requested;
  }
  return values.reduce((best, current) =>
    Math.abs(current - requested) < Math.abs(best - requested) ? current : best,
  );
}

function resolveDuration(model: OpenRouterVideoModel, requested: number | undefined): number {
  const supported = model.supportedDurationSeconds;
  const target = requested ?? DEFAULT_DURATION_SECONDS;
  return supported.length > 0 ? nearestSupported(supported, target) : target;
}

function resolveChoice(
  supported: readonly string[],
  requested: string | undefined,
  fallback: string,
): string {
  if (requested && (supported.length === 0 || supported.includes(requested))) {
    return requested;
  }
  return supported.length > 0 && supported[0] ? supported[0] : fallback;
}

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
  | "catalog_unavailable"
  | "model_unavailable"
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
    "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ระบบไม่พบการเชื่อมต่อ OpenRouter สำหรับ Video",
  catalog_unavailable:
    "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: โหลดรายการ Video Model จาก OpenRouter ไม่สำเร็จ",
  model_unavailable: "❌ ยังสร้าง Video Draft ไม่ได้\nสาเหตุ: ไม่พบ Video Model ที่เลือกไว้ใน OpenRouter",
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
  /**
   * Host session key. The one identity shared with the outbound
   * `reply_payload_sending` hook, so it is what the relay correlates on.
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
  // Canonical resolver by default; tests inject their own.
  const resolveApiKey =
    params.resolveApiKey ?? (() => resolveLineProviderApiKey(VIDEO_PROVIDER_ID));
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
      const sessionId = params.sessionId?.trim();
      const requesterSenderId = params.requesterSenderId?.trim();
      const accountId = params.accountId?.trim();
      if (
        !sessionId ||
        !requesterSenderId ||
        !accountId ||
        !params.draftStore ||
        !params.preferenceStore ||
        !params.activeJobLockStore
      ) {
        return failDeterministic("context_unavailable");
      }
      const conversationKey = buildLineVideoConversationKey({
        accountId,
        conversationId: sessionId,
      });
      if (!conversationKey) {
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

      // Renamed from the ambiguous "auth_unavailable": this is strictly a
      // missing OpenRouter provider credential. Owner authorization was already
      // enforced at factory time and has NOT failed here.
      const apiKey = await resolveApiKey();
      if (!apiKey?.trim()) {
        return failDeterministic("provider_auth_unavailable", { provider: VIDEO_PROVIDER_ID });
      }

      let models: OpenRouterVideoModel[];
      try {
        models = await loadOpenRouterVideoModels({ apiKey, fetchImpl: params.fetchImpl });
      } catch {
        return failDeterministic("catalog_unavailable", { provider: VIDEO_PROVIDER_ID });
      }

      const modelId = await resolveLineVideoModelPreference({
        store: params.preferenceStore,
        key: conversationKey,
      });
      const model = models.find((entry) => entry.id === modelId);
      if (!model) {
        return failDeterministic("model_unavailable", {
          provider: VIDEO_PROVIDER_ID,
          model: modelId,
        });
      }

      const durationSeconds = resolveDuration(
        model,
        typeof input.durationSeconds === "number" ? input.durationSeconds : undefined,
      );
      const aspectRatio = resolveChoice(
        model.supportedAspectRatios,
        typeof input.aspectRatio === "string" ? input.aspectRatio : undefined,
        DEFAULT_ASPECT_RATIO,
      );
      const resolution = resolveChoice(
        model.supportedResolutions,
        typeof input.resolution === "string" ? input.resolution : undefined,
        DEFAULT_RESOLUTION,
      );
      const audio = typeof input.audio === "boolean" ? input.audio : false;

      // Token-priced models bill by output pixel area, so the concrete size --
      // not just the "720p" label -- is part of the estimate.
      const outputSize = resolveLineVideoOutputSize({
        supportedSizes: model.supportedSizes,
        resolution,
        aspectRatio,
      });

      const account = resolveAccount({ cfg: params.cfg ?? getRuntimeConfig(), accountId });
      const costGuard = evaluateLineVideoCostGuard({
        model,
        selector: {
          durationSeconds,
          ...(outputSize ? { size: outputSize } : {}),
          resolution,
          audio,
        },
        cfg: { videoGeneration: account.config.videoGeneration },
      });
      if (!costGuard.allowed) {
        if (costGuard.reason === "unknown_cost") {
          // Pricing-shape diagnostics only: SKU KEYS, never values, plus the
          // request dimensions that select a SKU. Lets an unrecognized future
          // pricing shape be identified from logs without a repro.
          logInfo(
            `[line/video-draft] event=video_cost_unknown model=${model.id} ` +
              `pricingSkusPresent=${model.pricingSkus !== undefined} ` +
              `pricingSkuKeys=${
                Object.keys(model.pricingSkus ?? {})
                  .toSorted()
                  .join("|") || "-"
              } ` +
              `durationSeconds=${durationSeconds} resolution=${resolution} ` +
              `size=${outputSize ?? "-"} audio=${audio}`,
          );
        }
        if (costGuard.reason === "unknown_cost") {
          return failDeterministic("unknown_cost", { model: model.id });
        }
        return finish(
          costGuard.reason,
          jsonResult({
            resolution: costGuard.reason,
            estimatedCostUsd: costGuard.estimatedCostUsd,
            maxAllowedUsd: costGuard.maxAllowedUsd,
          }),
        );
      }

      const draft = await createLineVideoDraft({
        store: params.draftStore,
        accountId,
        conversationKey,
        ownerSenderId: requesterSenderId,
        model: model.id,
        prompt,
        ...(imagePath ? { sourceImagePath: imagePath } : {}),
        durationSeconds,
        aspectRatio,
        resolution,
        audio,
        estimatedCostUsd: costGuard.estimatedCostUsd,
        ...(params.deliveryTo ? { deliveryTo: params.deliveryTo } : {}),
        ...(params.now ? { now: params.now } : {}),
      });

      const preview = formatDraftPreview({
        draftId: draft.draftId,
        modelName: model.name,
        durationSeconds,
        resolution,
        aspectRatio,
        audio,
        estimatedCostUsd: costGuard.estimatedCostUsd,
        prompt,
      });
      await recordDeterministicText(preview);
      return finish("draft_created", {
        content: [{ type: "text" as const, text: preview }],
        details: {
          resolution: "draft_created",
          draftId: draft.draftId,
          model: model.id,
          estimatedCostUsd: costGuard.estimatedCostUsd,
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
