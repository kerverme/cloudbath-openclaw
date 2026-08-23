// Line plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  type OpenClawPluginCommandDefinition,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createLineModelCatalogTool,
  createLineSessionModelApplier,
  type LinePendingModelSelection,
  LINE_MODEL_CATALOG_TOOL_NAME,
  LINE_MODEL_SELECTION_MAX_ENTRIES,
  LINE_MODEL_SELECTION_NAMESPACE,
  LINE_MODEL_SELECTION_TTL_MS,
  createLineModelSwitchGuard,
} from "./src/model-catalog-tool.js";
import {
  LINE_VIDEO_DRAFT_MAX_ENTRIES,
  LINE_VIDEO_DRAFT_NAMESPACE,
  type LineVideoDraft,
} from "./src/video-draft-store.js";
import {
  createLineVideoDraftTool,
  createLineVideoGenerationGuard,
  LINE_VIDEO_DRAFT_TOOL_NAME,
} from "./src/video-draft-tool.js";
import {
  LINE_VIDEO_ACTIVE_JOB_MAX_ENTRIES,
  LINE_VIDEO_ACTIVE_JOB_NAMESPACE,
  LINE_VIDEO_JOB_MAX_ENTRIES,
  LINE_VIDEO_JOB_NAMESPACE,
  LINE_VIDEO_JOB_STALE_RUNNING_MS,
  type LineVideoActiveJobLock,
  type LineVideoJob,
} from "./src/video-job-store.js";
import {
  LINE_VIDEO_MODEL_SELECTION_MAX_ENTRIES,
  LINE_VIDEO_MODEL_SELECTION_NAMESPACE,
  type LinePendingVideoModelSelection,
} from "./src/video-model-control.js";
import {
  LINE_VIDEO_MODEL_PREFERENCE_MAX_ENTRIES,
  LINE_VIDEO_MODEL_PREFERENCE_NAMESPACE,
  type LineVideoModelPreferenceState,
} from "./src/video-model-preference.js";

type RegisteredLineCardCommand = OpenClawPluginCommandDefinition;
// Inline `import(...)` type (no top-level `./src/` import statement) keeps this
// bundled channel entrypoint on the dynamic-import boundary: the shape guard
// (src/channels/plugins/bundled.shape-guard.test.ts) forbids a static
// import/export line referencing "./src/" here, the same reason the card
// command below is loaded through `createLazyRuntimeModule` instead of a
// top-level import.
type LineModelSwitchIntentRouter = ReturnType<
  typeof import("./src/model-switch-router.js").createLineModelSwitchIntentRouter
>;
type LineVideoModelControlRouter = ReturnType<
  typeof import("./src/video-model-control.js").createLineVideoModelControlRouter
>;
type LineVideoConfirmationGate = ReturnType<
  typeof import("./src/video-confirmation.js").createLineVideoConfirmationGate
>;
type LineVideoDraftReplyRelay = ReturnType<
  typeof import("./src/video-draft-reply-relay.js").createLineVideoDraftReplyRelay
>;

function createLineModelSwitchIntentRouterLoader(
  pendingStore: PluginStateKeyedStore<LinePendingModelSelection>,
) {
  return createLazyRuntimeModule<LineModelSwitchIntentRouter>(async () => {
    const { createLineModelSwitchIntentRouter } = await import("./src/model-switch-router.js");
    return createLineModelSwitchIntentRouter({ pendingStore });
  });
}

function createLineVideoModelControlRouterLoader(deps: {
  preferenceStore: PluginStateKeyedStore<LineVideoModelPreferenceState>;
  pendingStore: PluginStateKeyedStore<LinePendingVideoModelSelection>;
}) {
  return createLazyRuntimeModule<LineVideoModelControlRouter>(async () => {
    const { createLineVideoModelControlRouter } = await import("./src/video-model-control.js");
    return createLineVideoModelControlRouter(deps);
  });
}

function createLineVideoConfirmationGateLoader(deps: {
  draftStore: PluginStateKeyedStore<LineVideoDraft>;
  jobStore: PluginStateKeyedStore<LineVideoJob>;
  activeJobLockStore: PluginStateKeyedStore<LineVideoActiveJobLock>;
}) {
  return createLazyRuntimeModule<LineVideoConfirmationGate>(async () => {
    const { createLineVideoConfirmationGate } = await import("./src/video-confirmation.js");
    return createLineVideoConfirmationGate(deps);
  });
}

/** Lazy facade over process-global relay state; see video-draft-reply-relay.ts. */
function createLineVideoDraftReplyRelayLoader() {
  return createLazyRuntimeModule<LineVideoDraftReplyRelay>(async () => {
    const { createLineVideoDraftReplyRelay } = await import("./src/video-draft-reply-relay.js");
    return createLineVideoDraftReplyRelay();
  });
}

function createLineCardCommandLoader(api: OpenClawPluginApi) {
  return createLazyRuntimeModule<RegisteredLineCardCommand>(async () => {
    let registered: RegisteredLineCardCommand | null = null;
    const { registerLineCardCommand } = await import("./src/card-command.js");
    registerLineCardCommand({
      ...api,
      registerCommand(command: RegisteredLineCardCommand) {
        registered = command;
      },
    });
    if (!registered) {
      throw new Error("LINE card command registration unavailable");
    }
    return registered;
  });
}

export default defineBundledChannelEntry({
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "linePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setLineRuntime",
  },
  registerFull(api) {
    const modelSwitchGuard = createLineModelSwitchGuard();
    api.on("before_agent_run", modelSwitchGuard.beforeAgentRun);
    api.on("before_tool_call", modelSwitchGuard.beforeToolCall);
    api.on("agent_end", modelSwitchGuard.agentEnd);

    // Video generation is expensive: the LLM must never trigger it directly
    // on LINE. Every path to a paid OpenRouter video request runs through the
    // owner-only draft/confirm flow registered below instead. The guard tracks
    // LINE runs via before_agent_run/agent_end (where the host stamps the
    // authoritative ctx.channel) rather than the tool-call context's optional
    // channelId, so it fails closed on every LINE execution path — all three
    // hooks are required for that; registering only before_tool_call would
    // leave it permanently open. See createLineVideoGenerationGuard.
    const videoGenerationGuard = createLineVideoGenerationGuard();
    api.on("before_agent_run", videoGenerationGuard.beforeAgentRun);
    api.on("before_tool_call", videoGenerationGuard.beforeToolCall);
    api.on("agent_end", videoGenerationGuard.agentEnd);

    const videoModelPreferenceStore =
      api.runtime.state.openKeyedStore<LineVideoModelPreferenceState>({
        namespace: LINE_VIDEO_MODEL_PREFERENCE_NAMESPACE,
        maxEntries: LINE_VIDEO_MODEL_PREFERENCE_MAX_ENTRIES,
      });
    const videoModelSelectionStore =
      api.runtime.state.openKeyedStore<LinePendingVideoModelSelection>({
        namespace: LINE_VIDEO_MODEL_SELECTION_NAMESPACE,
        maxEntries: LINE_VIDEO_MODEL_SELECTION_MAX_ENTRIES,
      });
    const videoDraftStore = api.runtime.state.openKeyedStore<LineVideoDraft>({
      namespace: LINE_VIDEO_DRAFT_NAMESPACE,
      maxEntries: LINE_VIDEO_DRAFT_MAX_ENTRIES,
    });
    const videoJobStore = api.runtime.state.openKeyedStore<LineVideoJob>({
      namespace: LINE_VIDEO_JOB_NAMESPACE,
      maxEntries: LINE_VIDEO_JOB_MAX_ENTRIES,
    });
    const videoActiveJobLockStore = api.runtime.state.openKeyedStore<LineVideoActiveJobLock>({
      namespace: LINE_VIDEO_ACTIVE_JOB_NAMESPACE,
      maxEntries: LINE_VIDEO_ACTIVE_JOB_MAX_ENTRIES,
      defaultTtlMs: LINE_VIDEO_JOB_STALE_RUNNING_MS,
    });

    // LINE reply-token sends stay provider-native and reach only
    // reply_payload_sending; durable and model-driven `message` tool sends
    // reach message_sending. The shared relay handles both without allowing a
    // second model-authored gloss through after the deterministic preview.
    const loadVideoDraftReplyRelay = createLineVideoDraftReplyRelayLoader();
    api.on("reply_payload_sending", async (event, ctx) => {
      const relay = await loadVideoDraftReplyRelay();
      return relay.replyPayloadSending(event, ctx);
    });
    api.on("message_sending", async (event, ctx) => {
      const relay = await loadVideoDraftReplyRelay();
      return relay.messageSending(event, ctx);
    });
    api.on("before_dispatch", async (event, ctx) => {
      const relay = await loadVideoDraftReplyRelay();
      relay.beginTurn(event, ctx);
    });

    api.registerTool(
      (ctx) =>
        createLineVideoDraftTool({
          messageChannel: ctx.messageChannel,
          senderIsOwner: ctx.senderIsOwner,
          requesterSenderId: ctx.requesterSenderId,
          sessionId: ctx.sessionId,
          nativeConversationId: ctx.nativeChannelId,
          sessionKey: ctx.sessionKey,
          // Awaited inside execute(): the relay must hold the text before the
          // tool returns, or the model's reply could reach the outbound hook
          // first and ship the paraphrase.
          recordDeterministicText: async (entry) => {
            const relay = await loadVideoDraftReplyRelay();
            relay.record(entry);
          },
          accountId: ctx.agentAccountId,
          deliveryTo: ctx.deliveryContext?.to,
          cfg: ctx.config,
          draftStore: videoDraftStore,
          preferenceStore: videoModelPreferenceStore,
          activeJobLockStore: videoActiveJobLockStore,
          // No resolveApiKey override: the tool resolves OpenRouter credentials
          // through the canonical provider-auth path, matching the LINE model
          // and video-model switch routers. ctx.resolveApiKeyForProvider is
          // deliberately NOT used -- it only reads saved auth profiles, so a
          // deployment holding OpenRouter credentials in env or config got
          // undefined from it and the draft failed as an auth error. Both
          // context fields below feed diagnostics only.
          hasProviderAuth: ctx.hasAuthForProvider,
          contextApiKeyResolverAvailable: typeof ctx.resolveApiKeyForProvider === "function",
        }),
      // Non-optional: the owner-only draft tool is the ONLY sanctioned path to
      // a paid LINE video request (the generic video_generate tool is blocked
      // above), so it must always be present in the LINE agent's default tool
      // set. Marking it optional would hide it behind tools.allow and leave the
      // owner's "make me a video" request with no reachable tool at all.
      { names: [LINE_VIDEO_DRAFT_TOOL_NAME] },
    );

    // Deterministic pre-agent routing, registered before the chat model-switch
    // router below (before_dispatch is first-claim-wins): the exact "ยืนยัน
    // VIDEO <code>" confirmation, then "video model" wording, must be claimed
    // here before the chat router's much broader tentative-verb matching ever
    // sees the message. Both are loaded lazily for the same reason as the
    // chat router (see createLineModelSwitchIntentRouterLoader above) — no
    // static "./src/" import for these heavier modules from this entrypoint.
    const loadVideoConfirmationGate = createLineVideoConfirmationGateLoader({
      draftStore: videoDraftStore,
      jobStore: videoJobStore,
      activeJobLockStore: videoActiveJobLockStore,
    });
    api.on("before_dispatch", async (event, ctx) => {
      const gate = await loadVideoConfirmationGate();
      return gate(event, ctx);
    });
    const loadVideoModelControlRouter = createLineVideoModelControlRouterLoader({
      preferenceStore: videoModelPreferenceStore,
      pendingStore: videoModelSelectionStore,
    });
    api.on("before_dispatch", async (event, ctx) => {
      const router = await loadVideoModelControlRouter();
      return router(event, ctx);
    });

    const pendingModelSelectionStore = api.runtime.state.openKeyedStore<LinePendingModelSelection>({
      namespace: LINE_MODEL_SELECTION_NAMESPACE,
      maxEntries: LINE_MODEL_SELECTION_MAX_ENTRIES,
      defaultTtlMs: LINE_MODEL_SELECTION_TTL_MS,
    });
    api.registerTool(
      (ctx) =>
        createLineModelCatalogTool({
          messageChannel: ctx.messageChannel,
          senderIsOwner: ctx.senderIsOwner,
          requesterSenderId: ctx.requesterSenderId,
          sessionId: ctx.sessionId,
          pendingStore: pendingModelSelectionStore,
          // No resolveApiKey override: the tool resolves OpenRouter credentials
          // through the shared canonical path. ctx.resolveApiKeyForProvider is
          // deliberately NOT used -- it reads only saved auth profiles, so a
          // deployment holding credentials in env/config gets undefined from it.
          applySessionModel: createLineSessionModelApplier({
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
          }),
        }),
      {
        names: [LINE_MODEL_CATALOG_TOOL_NAME],
        optional: true,
      },
    );

    // Deterministic pre-agent routing: an owner's explicit switch request
    // ("เปลี่ยนเป็น gemini หน่อย", "switch to Claude") or a numeric reply to an
    // active pending picker is handled here, before the main agent ever runs,
    // so the flow no longer depends on the active LLM deciding to call the
    // AI-facing picker tool above. Ordinary model discussion is untouched.
    // Loaded lazily (see createLineModelSwitchIntentRouterLoader) so this
    // entrypoint has no static "./src/" import for the router module.
    const loadModelSwitchIntentRouter = createLineModelSwitchIntentRouterLoader(
      pendingModelSelectionStore,
    );
    api.on("before_dispatch", async (event, ctx) => {
      const router = await loadModelSwitchIntentRouter();
      return router(event, ctx);
    });

    const loadLineCardCommand = createLineCardCommandLoader(api);
    api.registerCommand({
      name: "card",
      description: "Send a rich card message (LINE).",
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const command = await loadLineCardCommand();
        return await command.handler(ctx);
      },
    });
  },
});
