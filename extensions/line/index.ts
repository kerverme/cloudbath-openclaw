// Line plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  type OpenClawPluginCommandDefinition,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
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
import { createLineModelSwitchIntentRouter } from "./src/model-switch-router.js";

type RegisteredLineCardCommand = OpenClawPluginCommandDefinition;

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
          resolveApiKey: ctx.resolveApiKeyForProvider,
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
    api.on(
      "before_dispatch",
      createLineModelSwitchIntentRouter({ pendingStore: pendingModelSelectionStore }),
    );

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
