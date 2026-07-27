import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { extractSchemaFieldsWithCurrentModel } from "./src/analysis.js";
import { resolveArchiveConfig } from "./src/config.js";
import { extractInboundLineImage } from "./src/inbound.js";
import { NotionArchiveClient } from "./src/notion.js";
import { ArchivePipeline } from "./src/pipeline.js";
import { resolveSchemaForAgent } from "./src/profiles.js";
import { R2ArchiveClient } from "./src/r2.js";
import type {
  AgentProfile,
  ArchiveConfig,
  InboundImageJob,
  PersistedArchiveRecord,
  SafeLogger,
  SchemaProfile,
} from "./src/types.js";

function structuredLogger(logger: PluginLogger): SafeLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (event: string, fields: Record<string, unknown> = {}) => {
      const message = JSON.stringify({
        component: "cloudbath-line-image-archive",
        event,
        ...fields,
      });
      if (level === "debug") {
        logger.debug?.(message);
      } else {
        logger[level](message);
      }
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

async function sendLineAcknowledgement(
  api: OpenClawPluginApi,
  job: InboundImageJob,
  text: string,
): Promise<void> {
  const adapter = await api.runtime.channel.outbound.loadAdapter("line");
  if (!adapter?.sendText) {
    throw new Error("LINE outbound text adapter is unavailable");
  }
  await adapter.sendText({
    cfg: api.runtime.config.current() as OpenClawConfig,
    to: job.lineTarget,
    text,
    accountId: job.accountId,
  });
}

export default definePluginEntry({
  id: "cloudbath-line-image-archive",
  name: "Cloudbath LINE Image Archive",
  description: "Archives universal LINE image assets and profile-scoped Notion records",
  register(api: OpenClawPluginApi) {
    const logger = structuredLogger(api.logger);
    let pipeline: ArchivePipeline | undefined;
    let activeConfig: ArchiveConfig | undefined;

    api.registerService({
      id: "cloudbath-line-image-archive",
      start: async (ctx) => {
        const config = resolveArchiveConfig(process.env, api.pluginConfig ?? {});
        if (!config.enabled) {
          logger.info("archive_disabled");
          return;
        }
        activeConfig = config;
        const store = api.runtime.state.openKeyedStore<PersistedArchiveRecord>({
          namespace: "archive-jobs-v2",
          maxEntries: 100_000,
          overflowPolicy: "evict-oldest",
        });
        pipeline = new ArchivePipeline({
          config,
          stateDir: ctx.stateDir,
          store,
          r2: new R2ArchiveClient(config.r2, config.retry, logger),
          notion: new NotionArchiveClient(config.notion.apiKey, config.retry, logger),
          logger,
          extract: config.analysisEnabled
            ? async (
                job: InboundImageJob,
                filePath: string,
                agentProfile: AgentProfile,
                schemaProfile: SchemaProfile,
              ) =>
                await extractSchemaFieldsWithCurrentModel({
                  api,
                  job,
                  filePath,
                  agentProfile,
                  schemaProfile,
                })
            : undefined,
          sendAcknowledgement: async (job, text) => {
            await sendLineAcknowledgement(api, job, text);
          },
        });
        const recovered = await pipeline.recoverIncomplete();
        logger.info("archive_started", {
          activeAgentProfileCount: config.profiles.agentProfiles.filter((profile) => profile.active)
            .length,
          authorizedGroupCount: config.profiles.activeProfilesByGroupId.size,
          schemaProfileCount: config.profiles.schemaProfiles.length,
          analysisEnabled: config.analysisEnabled,
          recovered,
        });
      },
      stop: async () => {
        await pipeline?.waitForIdle();
        pipeline = undefined;
        activeConfig = undefined;
        logger.info("archive_stopped");
      },
    });

    api.on(
      "message_received",
      async (event, ctx) => {
        const activePipeline = pipeline;
        const config = activeConfig;
        if (!activePipeline || !config) {
          return;
        }
        const job = extractInboundLineImage(event, ctx);
        if (!job) {
          return;
        }
        const agentProfile = config.profiles.activeProfilesByGroupId.get(job.groupId);
        if (!agentProfile) {
          logger.info("unrouted_group_ignored", {
            messageId: job.messageId,
            groupId: job.groupId,
          });
          return;
        }
        const schemaProfile = resolveSchemaForAgent(config.profiles, agentProfile);
        await activePipeline.enqueue(job, agentProfile, schemaProfile);
      },
      { timeoutMs: 10_000 },
    );
  },
});

export { extractInboundLineImage, resolveArchiveConfig, resolveSchemaForAgent };
