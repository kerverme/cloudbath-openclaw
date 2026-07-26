import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { analyzeImageWithCurrentModel } from "./src/analysis.js";
import { resolveArchiveConfig } from "./src/config.js";
import { extractInboundLineImage, isAuthorizedLineGroup } from "./src/inbound.js";
import { NotionArchiveClient } from "./src/notion.js";
import { ArchivePipeline } from "./src/pipeline.js";
import { R2ArchiveClient } from "./src/r2.js";
import type { ArchiveConfig, InboundImageJob, SafeLogger } from "./src/types.js";

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
  description: "Archives authorized LINE group images to private R2 storage and Notion",
  register(api: OpenClawPluginApi) {
    const logger = structuredLogger(api.logger);
    let pipeline: ArchivePipeline | undefined;
    let activeConfig: ArchiveConfig | undefined;

    api.registerService({
      id: "cloudbath-line-image-archive",
      start: async (ctx) => {
        const config = resolveArchiveConfig(process.env);
        if (!config.enabled) {
          logger.info("archive_disabled");
          return;
        }
        activeConfig = config;
        const store = api.runtime.state.openKeyedStore({
          namespace: "archive-jobs",
          maxEntries: 100_000,
          overflowPolicy: "evict-oldest",
        });
        const r2 = new R2ArchiveClient(config.r2, config.retry, logger);
        const notion = new NotionArchiveClient(config.notion, config.retry, logger);
        pipeline = new ArchivePipeline({
          config,
          stateDir: ctx.stateDir,
          store,
          r2,
          notion,
          logger,
          analyze: config.analysisEnabled
            ? async (job, filePath) => await analyzeImageWithCurrentModel({ api, job, filePath })
            : undefined,
          sendAcknowledgement: async (job, text) => {
            await sendLineAcknowledgement(api, job, text);
          },
        });
        const recovered = await pipeline.recoverIncomplete();
        logger.info("archive_started", {
          allowedGroupCount: config.allowedGroupIds.size,
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
        if (!isAuthorizedLineGroup(job.groupId, config.allowedGroupIds)) {
          logger.info("unauthorized_group_ignored", {
            messageId: job.messageId,
            groupId: job.groupId,
          });
          return;
        }
        await activePipeline.enqueue(job);
      },
      { timeoutMs: 10_000 },
    );
  },
});

export { extractInboundLineImage, resolveArchiveConfig };
