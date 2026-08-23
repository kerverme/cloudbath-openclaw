import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { extractSchemaFieldsWithCurrentModel } from "./src/analysis.js";
import { resolveArchiveConfig, resolveWorkspacePolicyConfig } from "./src/config.js";
import {
  isWorkspacePolicyCommand,
  LineGroupWorkspacePolicyRegistry,
} from "./src/group-workspace-policy.js";
import { extractInboundLineImage } from "./src/inbound.js";
import { KeepWatchingNotionWriter, KeepWatchingPipeline } from "./src/keep-watching.js";
import { CLOUDBATH_NOTION_TOOL_NAMES, createCloudbathNotionTools } from "./src/notion-tools.js";
import { NotionArchiveClient } from "./src/notion.js";
import { ArchivePipeline } from "./src/pipeline.js";
import { resolveSchemaForAgent } from "./src/profiles.js";
import { R2ArchiveClient } from "./src/r2.js";
import type {
  AgentProfile,
  ArchiveConfig,
  InboundImageJob,
  PersistedArchiveRecord,
  KeepWatchingJobRecord,
  LineGroupPairingGrant,
  LineGroupPolicyBinding,
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
    let keepWatchingPipeline: KeepWatchingPipeline | undefined;
    let workspaceRegistry: LineGroupWorkspacePolicyRegistry | undefined;
    let activeConfig: ArchiveConfig | undefined;

    api.registerTool(() => createCloudbathNotionTools(), {
      names: [...CLOUDBATH_NOTION_TOOL_NAMES],
      optional: true,
    });

    api.registerService({
      id: "cloudbath-line-image-archive",
      start: async (ctx) => {
        const config = resolveArchiveConfig(process.env, api.pluginConfig ?? {});
        const workspaceConfig = resolveWorkspacePolicyConfig(api.pluginConfig ?? {});
        const bindings = api.runtime.state.openKeyedStore<LineGroupPolicyBinding>({
          namespace: "line-group-policy-bindings-v1",
          maxEntries: 10_000,
          overflowPolicy: "reject-new",
        });
        const pairingGrants = api.runtime.state.openKeyedStore<LineGroupPairingGrant>({
          namespace: "line-group-policy-pairings-v1",
          maxEntries: 1_000,
          overflowPolicy: "evict-oldest",
        });
        workspaceRegistry = new LineGroupWorkspacePolicyRegistry(
          workspaceConfig,
          bindings,
          pairingGrants,
        );

        if (workspaceConfig.keepWatching) {
          const requiredRuntimeValues = {
            R2_ACCOUNT_ID: config.r2.accountId,
            R2_ACCESS_KEY_ID: config.r2.accessKeyId,
            R2_SECRET_ACCESS_KEY: config.r2.secretAccessKey,
            R2_BUCKET_NAME: config.r2.bucketName,
            R2_ENDPOINT: config.r2.endpoint,
            OPENCLAW_NOTION_WRITE_TOKEN: config.notion.apiKey,
          };
          const missing = Object.entries(requiredRuntimeValues)
            .filter(([, value]) => !value)
            .map(([name]) => name);
          if (missing.length > 0) {
            throw new Error(
              `KEEP_WATCHING is configured but required runtime configuration is missing: ${missing.join(", ")}`,
            );
          }
          const keepWatchingStore = api.runtime.state.openKeyedStore<KeepWatchingJobRecord>({
            namespace: "keep-watching-jobs-v1",
            maxEntries: 100_000,
            overflowPolicy: "evict-oldest",
          });
          keepWatchingPipeline = new KeepWatchingPipeline({
            stateDir: ctx.stateDir,
            imageMaxBytes: config.imageMaxBytes,
            bucketName: config.r2.bucketName,
            policy: workspaceConfig.keepWatching,
            store: keepWatchingStore,
            r2: new R2ArchiveClient(config.r2, config.retry, logger),
            notion: new KeepWatchingNotionWriter(config.notion.apiKey, config.retry, logger),
            logger,
          });
        }

        if (!config.enabled) {
          logger.info("archive_disabled", {
            groupPolicyRegistryEnabled: true,
            keepWatchingConfigured: Boolean(workspaceConfig.keepWatching),
            ugcConfigured: Boolean(workspaceConfig.ugc),
          });
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
        await keepWatchingPipeline?.waitForIdle();
        pipeline = undefined;
        keepWatchingPipeline = undefined;
        workspaceRegistry = undefined;
        activeConfig = undefined;
        logger.info("archive_stopped");
      },
    });

    api.on("before_dispatch", async (event, ctx) => {
      const registry = workspaceRegistry;
      if (!registry) {
        return isWorkspacePolicyCommand(event.content)
          ? { handled: true, text: "Workspace policy service is unavailable." }
          : undefined;
      }
      return await registry.handleBeforeDispatch(event, ctx);
    });

    api.on(
      "message_received",
      async (event, ctx) => {
        const job = extractInboundLineImage(event, ctx);
        if (!job) {
          return;
        }
        const binding = await workspaceRegistry?.lookup(job.accountId, job.groupId);
        if (binding?.policyId === "KEEP_WATCHING") {
          if (!keepWatchingPipeline) {
            logger.error("keep_watching_runtime_unavailable", {
              messageKey: job.messageId,
            });
            return;
          }
          await keepWatchingPipeline.enqueue(job);
          return;
        }
        const activePipeline = pipeline;
        const config = activeConfig;
        if (!activePipeline || !config) {
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
