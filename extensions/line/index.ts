// Line plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  type OpenClawPluginCommandDefinition,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createLineModelCatalogTool,
  LINE_MODEL_CATALOG_TOOL_NAME,
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
    api.registerTool(
      (ctx) =>
        createLineModelCatalogTool({
          messageChannel: ctx.messageChannel,
          senderIsOwner: ctx.senderIsOwner,
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
