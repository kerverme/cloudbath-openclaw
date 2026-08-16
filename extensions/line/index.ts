// Line plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  type OpenClawPluginCommandDefinition,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createLineModelCatalogTool,
  type LinePendingModelSelection,
  LINE_MODEL_CATALOG_TOOL_NAME,
  LINE_MODEL_SELECTION_MAX_ENTRIES,
  LINE_MODEL_SELECTION_NAMESPACE,
  LINE_MODEL_SELECTION_TTL_MS,
} from "./src/model-catalog-tool.js";

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
        }),
      {
        names: [LINE_MODEL_CATALOG_TOOL_NAME],
        optional: true,
      },
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
