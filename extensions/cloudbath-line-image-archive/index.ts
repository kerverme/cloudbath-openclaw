import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { extractSchemaFieldsWithCurrentModel } from "./src/analysis.js";
import {
  createCharacterViewRouteHandler,
  type CharacterAssetViewRuntime,
} from "./src/character-view-route.js";
import { CLOUDBATH_CHARACTER_VIEW_ROUTE } from "./src/character-view-url.js";
import { resolveArchiveConfig, resolveWorkspacePolicyConfig } from "./src/config.js";
import type { CloudbathConversationRouter } from "./src/conversation-router.js";
import { createCloudbathConversationRouter } from "./src/conversation-runtime.js";
import { createConversationSemanticResolver } from "./src/conversation-semantic-resolver.js";
import { createConversationTranscriptReader } from "./src/conversation-transcript.js";
import {
  createCloudbathCreativeSpecialists,
  readGeneratedImageAttachment,
} from "./src/creative-specialists.js";
import {
  isWorkspacePolicyCommand,
  LineGroupWorkspacePolicyRegistry,
} from "./src/group-workspace-policy.js";
import { extractInboundLineImage } from "./src/inbound.js";
import { KeepWatchingNotionWriter, KeepWatchingPipeline } from "./src/keep-watching.js";
import {
  clearCloudbathLineVideoWorkspaceRuntime,
  installCloudbathLineVideoWorkspaceRuntime,
} from "./src/line-video-workspace-runtime.js";
import { CLOUDBATH_NOTION_TOOL_NAMES, createCloudbathNotionTools } from "./src/notion-tools.js";
import { NotionArchiveClient } from "./src/notion.js";
import { ArchivePipeline } from "./src/pipeline.js";
import { CLOUDBATH_PREVIS_ACTIVE_MAX_ENTRIES } from "./src/previs-line-router.js";
import {
  CLOUDBATH_PREVIS_DISPLAY_NAMES_NAMESPACE,
  createPrevisProjectResolver,
  type PrevisDisplayNameRecord,
} from "./src/previs-project-resolver.js";
import { createPrevisReviewRouteHandler, type PrevisReviewRuntime } from "./src/previs-route.js";
import {
  CLOUDBATH_PREVIS_HEAD_NAMESPACE,
  CLOUDBATH_PREVIS_MAX_ENTRIES,
  CLOUDBATH_PREVIS_VERSION_NAMESPACE,
  PrevisStore,
} from "./src/previs-store.js";
import type { PrevisProjectHead, PrevisVersion } from "./src/previs-types.js";
import { CLOUDBATH_PREVIS_VIEW_ROUTE } from "./src/previs-url.js";
import { resolveSchemaForAgent } from "./src/profiles.js";
import { R2ArchiveClient } from "./src/r2.js";
import type { CloudbathStoryboardLineRouter } from "./src/storyboard-line-router.js";
import { StoryboardLlmPlanner } from "./src/storyboard-planner.js";
import {
  createCloudbathStoryboardLineRouter,
  openStoryboardConversationStores,
} from "./src/storyboard-runtime.js";
import { createStoryboardTool, STORYBOARD_TOOL_NAME } from "./src/storyboard-tool.js";
import type { StoryboardVersion } from "./src/storyboard-types.js";
import {
  createStoryboardVisualRouteHandler,
  type StoryboardVisualRouteRuntime,
} from "./src/storyboard-visual-route.js";
import {
  CLOUDBATH_STORYBOARD_VISUAL_NAMESPACE,
  StoryboardVisualService,
  type StoryboardVisualArtifact,
} from "./src/storyboard-visual.js";
import type {
  AgentProfile,
  ActiveUgcLineSession,
  ArchiveConfig,
  InboundImageJob,
  PersistedArchiveRecord,
  KeepWatchingJobRecord,
  LineGroupPairingGrant,
  LineGroupPolicyBinding,
  SafeLogger,
  SchemaProfile,
  FrozenUgcVideoScope,
  PendingUgcVideoScope,
  ActiveUgcProject,
  UgcProjectCharacterLock,
  UgcProjectInstance,
} from "./src/types.js";
import {
  CLOUDBATH_UGC_CHARACTER_IMAGE_MAX_ENTRIES,
  CLOUDBATH_UGC_LATEST_CHARACTER_IMAGE_NAMESPACE,
  type LatestCharacterImage,
  UgcCharacterImageWorkflow,
} from "./src/ugc-character-image.js";
import {
  CLOUDBATH_UGC_DRAFT_SCOPE_NAMESPACE,
  CLOUDBATH_UGC_ACTIVE_SESSION_NAMESPACE,
  CLOUDBATH_UGC_ACTIVE_PROJECT_NAMESPACE,
  CLOUDBATH_UGC_PROJECT_INSTANCE_NAMESPACE,
  CLOUDBATH_UGC_PROJECT_LOCK_NAMESPACE,
  CLOUDBATH_UGC_PENDING_NAMESPACE,
  CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
  CLOUDBATH_UGC_PROJECT_FINALIZE_TOOL_NAME,
  CLOUDBATH_UGC_VIDEO_PREPARE_TOOL_NAME,
  CloudbathUgcVideoWorkflow,
  UgcNotionWorkflowClient,
} from "./src/ugc-workflow.js";
import {
  clearCloudbathWorkspacePolicyRuntime,
  createCloudbathWorkspacePolicyRuntimeOwner,
  installCloudbathWorkspacePolicyRuntime,
  tryGetCloudbathWorkspacePolicyRuntime,
} from "./src/workspace-policy-runtime.js";

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
    const runtimeOwner = createCloudbathWorkspacePolicyRuntimeOwner();
    let pipeline: ArchivePipeline | undefined;
    let keepWatchingPipeline: KeepWatchingPipeline | undefined;
    let workspaceRegistry: LineGroupWorkspacePolicyRegistry | undefined;
    let ugcWorkflow: CloudbathUgcVideoWorkflow | undefined;
    let ugcCharacterWorkflow: UgcCharacterImageWorkflow | undefined;
    let characterAssetView: CharacterAssetViewRuntime | undefined;
    let previsReview: PrevisReviewRuntime | undefined;
    let storyboardLineRouter: CloudbathStoryboardLineRouter | undefined;
    let storyboardVisualRoute: StoryboardVisualRouteRuntime | undefined;
    let conversationRouter: CloudbathConversationRouter | undefined;
    let activeConfig: ArchiveConfig | undefined;

    api.registerHttpRoute({
      path: `${CLOUDBATH_CHARACTER_VIEW_ROUTE}/`,
      auth: "plugin",
      match: "prefix",
      handler: createCharacterViewRouteHandler(
        () => tryGetCloudbathWorkspacePolicyRuntime()?.characterAssetView,
      ),
    });

    api.registerHttpRoute({
      path: "/plugins/cloudbath/storyboard-visual/",
      auth: "plugin",
      match: "prefix",
      handler: createStoryboardVisualRouteHandler(() => storyboardVisualRoute),
    });

    api.registerHttpRoute({
      path: `${CLOUDBATH_PREVIS_VIEW_ROUTE}/`,
      auth: "plugin",
      match: "prefix",
      handler: createPrevisReviewRouteHandler(
        () => tryGetCloudbathWorkspacePolicyRuntime()?.previsReview,
      ),
    });

    api.registerTool(
      (ctx) => {
        const runtime = tryGetCloudbathWorkspacePolicyRuntime();
        return createStoryboardTool(
          ctx,
          runtime?.storyboardLineRouter,
          runtime?.conversationRouter,
        );
      },
      { names: [STORYBOARD_TOOL_NAME] },
    );

    api.registerTool(() => createCloudbathNotionTools(), {
      names: [...CLOUDBATH_NOTION_TOOL_NAMES],
      optional: true,
    });
    api.registerTool(
      (ctx) =>
        tryGetCloudbathWorkspacePolicyRuntime()?.ugcWorkflow?.createTool({
          messageChannel: ctx.messageChannel,
          senderIsOwner: ctx.senderIsOwner,
          requesterSenderId: ctx.requesterSenderId,
          sessionKey: ctx.sessionKey,
          accountId: ctx.agentAccountId,
          nativeConversationId: ctx.nativeChannelId ?? ctx.deliveryContext?.to,
        }) ?? null,
      { names: [CLOUDBATH_UGC_VIDEO_PREPARE_TOOL_NAME], optional: true },
    );
    api.registerTool(
      (ctx) =>
        tryGetCloudbathWorkspacePolicyRuntime()?.ugcWorkflow?.createFinalizeTool({
          messageChannel: ctx.messageChannel,
          senderIsOwner: ctx.senderIsOwner,
          requesterSenderId: ctx.requesterSenderId,
          sessionKey: ctx.sessionKey,
          accountId: ctx.agentAccountId,
          nativeConversationId: ctx.nativeChannelId ?? ctx.deliveryContext?.to,
        }) ?? null,
      { names: [CLOUDBATH_UGC_PROJECT_FINALIZE_TOOL_NAME], optional: true },
    );

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

        let ugcDraftScopes: PluginStateKeyedStore<FrozenUgcVideoScope> | undefined;

        if (workspaceConfig.ugc) {
          if (!config.notion.apiKey) {
            throw new Error("UGC is configured but OPEN_CLAW_NOTION_WRITE_TOKEN is missing");
          }
          const pending = api.runtime.state.openKeyedStore<PendingUgcVideoScope>({
            namespace: CLOUDBATH_UGC_PENDING_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          ugcDraftScopes = api.runtime.state.openKeyedStore<FrozenUgcVideoScope>({
            namespace: CLOUDBATH_UGC_DRAFT_SCOPE_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          const activeSessions = api.runtime.state.openKeyedStore<ActiveUgcLineSession>({
            namespace: CLOUDBATH_UGC_ACTIVE_SESSION_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          // No TTL: a project's frozen cast must outlive every scope window, or
          // a later scene would re-resolve references and silently recast.
          const projectLocks = api.runtime.state.openKeyedStore<UgcProjectCharacterLock>({
            namespace: CLOUDBATH_UGC_PROJECT_LOCK_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          // Project identity and the conversation's active project both outlive
          // any scope window: "ต่อ Scene 2" must land on the same project after
          // a restart.
          const projectInstances = api.runtime.state.openKeyedStore<UgcProjectInstance>({
            namespace: CLOUDBATH_UGC_PROJECT_INSTANCE_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          const activeProjects = api.runtime.state.openKeyedStore<ActiveUgcProject>({
            namespace: CLOUDBATH_UGC_ACTIVE_PROJECT_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_SCOPE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          const latestCharacterImages = api.runtime.state.openKeyedStore<LatestCharacterImage>({
            namespace: CLOUDBATH_UGC_LATEST_CHARACTER_IMAGE_NAMESPACE,
            maxEntries: CLOUDBATH_UGC_CHARACTER_IMAGE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          const ugcNotion = new UgcNotionWorkflowClient(config.notion.apiKey, config.retry, logger);
          const r2 = new R2ArchiveClient(config.r2, config.retry, logger);
          const storyboardVisualArtifacts =
            api.runtime.state.openKeyedStore<StoryboardVisualArtifact>({
              namespace: CLOUDBATH_STORYBOARD_VISUAL_NAMESPACE,
              maxEntries: 40_000,
              overflowPolicy: "reject-new",
            });
          /**
           * Reads a frozen first frame back as bytes, through the same
           * integrity check every other consumer uses.
           *
           * Scoped to the version's own owner triple, so a handle can only ever
           * resolve media that owner put in that conversation.
           */
          const runtimeSourceImageBytes = async (
            version: StoryboardVersion,
            mediaId: string,
          ): Promise<{ buffer: Buffer; mimeType: string } | undefined> => {
            const resolved =
              await tryGetCloudbathWorkspacePolicyRuntime()?.ugcCharacterWorkflow?.resolveSelectedSourceImage(
                {
                  accountId: version.accountId,
                  lineGroupId: version.lineGroupId,
                  ownerSenderId: version.ownerSenderId,
                },
                mediaId,
              );
            if (!resolved) {
              throw new Error("Selected storyboard source image is unavailable");
            }
            // The type the store proved from the bytes, never assumed: a PNG
            // handed over as JPEG declares a type the file does not have.
            return { buffer: await readFile(resolved.path), mimeType: resolved.mimeType };
          };
          const storyboardVisuals = config.publicAssetBaseUrl
            ? new StoryboardVisualService({
                artifacts: storyboardVisualArtifacts,
                now: Date.now,
                logger,
                generate: async ({ version, shotIndex, identityReferences, sourceImage }) => {
                  const identityImages = await Promise.all(
                    identityReferences.map(async (reference) => {
                      if (reference.source !== "r2") {
                        throw new Error("Visual storyboard identity reference must be an R2 asset");
                      }
                      const media = await r2.fetchPrivateObject({
                        bucketName: config.r2.bucketName,
                        objectKey: reference.locator,
                        maxBytes: config.imageMaxBytes,
                        contentTypePrefix: "image/",
                      });
                      return { buffer: Buffer.from(media.bytes), mimeType: media.contentType };
                    }),
                  );
                  // The owner's chosen first frame, read from the storyboard
                  // plugin's own media store. It is a separate input from the
                  // identity references above and never joins characterLocks:
                  // it says what the shot looks like, not who is in it. An
                  // unreadable selection fails the render rather than quietly
                  // producing a shot that ignores the image the owner chose.
                  const firstFrame = sourceImage
                    ? await runtimeSourceImageBytes(version, sourceImage.mediaId)
                    : undefined;
                  const visualReferences = version.document.visualPresentation?.references ?? [];
                  const referenceImages = await Promise.all(
                    visualReferences.map(async (reference) => {
                      const media = await r2.fetchPrivateObject({
                        bucketName: config.r2.bucketName,
                        objectKey: reference.objectKey,
                        maxBytes: config.imageMaxBytes,
                        contentTypePrefix: "image/",
                      });
                      return { buffer: Buffer.from(media.bytes), mimeType: media.contentType };
                    }),
                  );
                  const inputImages = [
                    ...identityImages,
                    ...referenceImages,
                    ...(firstFrame ? [firstFrame] : []),
                  ];
                  const beat = version.document.beats[shotIndex - 1]!;
                  const generated = await api.runtime.imageGeneration.generate({
                    cfg: api.runtime.config.current() as OpenClawConfig,
                    prompt: [
                      `Storyboard shot ${shotIndex}. Depict only this shot, not the entire sheet.`,
                      `Environment: ${beat.environmentNote ?? version.document.environment}.`,
                      `Framing: ${beat.framing}. Camera: ${beat.camera}. Action: ${beat.action}.`,
                      `Story and art direction: ${version.document.scenePrompt}.`,
                      `Preserve identity and outfit from the first ${identityImages.length} frozen cast references.`,
                      ...visualReferences.map(
                        (reference, index) =>
                          `Reference ${identityImages.length + index + 1}: ${
                            reference.role === "identity"
                              ? "preserve these characters and outfits throughout the sequence"
                              : "use visual style only; do not copy its characters or events; the contact sheet layout is composed separately"
                          }.`,
                      ),
                      ...(beat.dialogue
                        ? [`Render this dialogue legibly in speech balloons: ${beat.dialogue}.`]
                        : []),
                      ...(firstFrame
                        ? [
                            "The last reference image is this scene's opening frame; use it as scene context while depicting the specified action.",
                          ]
                        : []),
                    ].join(" "),
                    inputImages,
                    aspectRatio: version.document.aspectRatio,
                    outputFormat: "jpeg",
                    count: 1,
                    autoProviderFallback: false,
                  });
                  const image = generated.images[0]!;
                  const metadata = await api.runtime.media.getImageMetadata(image.buffer);
                  if (!metadata?.width || !metadata.height) {
                    throw new Error("Generated storyboard image metadata is unavailable");
                  }
                  return {
                    bytes: image.buffer,
                    mimeType: image.mimeType,
                    width: metadata.width,
                    height: metadata.height,
                    provider: generated.provider,
                    model: generated.model,
                  };
                },
                normalize: async ({ bytes, maxWidth, maxHeight }) => {
                  const resized = await api.runtime.media.resizeToJpeg({
                    buffer: Buffer.from(bytes),
                    maxSide: Math.min(maxWidth, maxHeight),
                    quality: 88,
                    withoutEnlargement: true,
                  });
                  const metadata = await api.runtime.media.getImageMetadata(resized);
                  if (!metadata?.width || !metadata.height) {
                    throw new Error("Normalized storyboard image metadata is unavailable");
                  }
                  return {
                    bytes: resized,
                    mimeType: "image/jpeg" as const,
                    width: metadata.width,
                    height: metadata.height,
                  };
                },
                persist: async ({ objectKey, bytes, contentType, sha256 }) => {
                  await r2.ensureObject({
                    body: bytes,
                    bucketName: config.r2.bucketName,
                    objectKey,
                    contentType,
                    contentLength: bytes.byteLength,
                    sha256,
                  });
                },
                read: async ({ objectKey }) => {
                  const media = await r2.fetchPrivateObject({
                    bucketName: config.r2.bucketName,
                    objectKey,
                    maxBytes: config.imageMaxBytes,
                    contentTypePrefix: "image/",
                  });
                  return { bytes: media.bytes, mimeType: media.contentType };
                },
              })
            : undefined;
          if (storyboardVisuals) {
            storyboardVisualRoute = {
              artifacts: storyboardVisualArtifacts,
              r2,
              bucketName: config.r2.bucketName,
              maxBytes: config.imageMaxBytes,
            };
          }
          // Display names are durable per project instance and shared by both
          // flows, so the storyboard and previs resolvers must read the SAME
          // record rather than each keeping its own idea of who "Twong" is.
          const previsDisplayNames = api.runtime.state.openKeyedStore<PrevisDisplayNameRecord>({
            namespace: CLOUDBATH_PREVIS_DISPLAY_NAMES_NAMESPACE,
            maxEntries: CLOUDBATH_PREVIS_ACTIVE_MAX_ENTRIES,
            overflowPolicy: "evict-oldest",
          });
          ugcWorkflow = new CloudbathUgcVideoWorkflow(
            workspaceConfig.ugc,
            workspaceRegistry,
            ugcNotion,
            pending,
            ugcDraftScopes,
            activeSessions,
            projectLocks,
            projectInstances,
            activeProjects,
            Date.now,
            { endpoint: config.r2.endpoint, bucketName: config.r2.bucketName },
          );
          // Opened once and shared: the router and the inbound-capture
          // narrowing must read the SAME rows, or "is storyboard work open?"
          // would be answerable two ways.
          const storyboardConversationStores = openStoryboardConversationStores(api.runtime.state);
          ugcCharacterWorkflow = new UgcCharacterImageWorkflow(
            workspaceRegistry,
            latestCharacterImages,
            r2,
            ugcNotion,
            workspaceConfig.ugc.capabilities,
            ctx.stateDir,
            config.imageMaxBytes,
            {
              endpoint: config.r2.endpoint,
              bucketName: config.r2.bucketName,
              accessKeyId: config.r2.accessKeyId,
              secretAccessKey: config.r2.secretAccessKey,
            },
            logger,
            config.publicAssetBaseUrl,
            undefined,
            undefined,
            // Late-bound: the resolver is built just below, and this only ever
            // runs on a later inbound turn. Saving a Character is exactly when
            // its name memo is stale, and the owner names the new character in
            // their very next message.
            () => storyboardResolver.invalidateCharacterNames(),
            // The unbound-capture narrowing. Both rows exist only because a
            // dispatch turn already proved `senderIsOwner`, so this is the
            // closest thing to an owner predicate available at an inbound image
            // — and it is a NEED predicate, not an identity claim.
            async (claim) => {
              const key = `${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}`;
              const [active, director] = await Promise.all([
                storyboardConversationStores.active.lookup(`storyboard-active:${key}`),
                storyboardConversationStores.director.lookup(`storyboard-director:${key}`),
              ]);
              return Boolean(active) || Boolean(director && !director.closed);
            },
          );
          // Storyboard is the DEFAULT natural-language video flow and needs no
          // engine, bucket or public URL, so it is wired before the previs block
          // rather than inside its infrastructure gate.
          const storyboardResolver = createPrevisProjectResolver({
            workflow: ugcWorkflow,
            notion: ugcNotion,
            capabilities: workspaceConfig.ugc.capabilities,
            displayNames: previsDisplayNames,
          });
          storyboardLineRouter = createCloudbathStoryboardLineRouter({
            state: api.runtime.state,
            resolver: storyboardResolver,
            workspaceRegistry,
            logger,
            persistVisualReference: async (reference, claim) => {
              // Use the SDK's bounded media loader: no arbitrary local-root or
              // SSRF bypass. Freeze bytes into R2 so a temporary image survives edits.
              const media = await api.runtime.media.loadWebMedia(reference.image, {
                maxBytes: config.imageMaxBytes,
                optimizeImages: false,
              });
              if (media.kind !== "image" || !media.contentType?.startsWith("image/")) {
                throw new Error("Storyboard references must be images");
              }
              const sha256 = createHash("sha256").update(media.buffer).digest("hex");
              const scope = createHash("sha256").update(JSON.stringify(claim)).digest("hex");
              const objectKey = `storyboards/references/${scope}/${sha256}`;
              await r2.ensureObject({
                body: media.buffer,
                bucketName: config.r2.bucketName,
                objectKey,
                contentType: media.contentType,
                contentLength: media.buffer.byteLength,
                sha256,
              });
              return { role: reference.role, objectKey };
            },
            planner: new StoryboardLlmPlanner(
              async (request) =>
                await api.runtime.llm.complete({
                  ...request,
                  messages: [...request.messages],
                }),
            ),
            // The confirmation gate reads a draft's scope from this store; the
            // storyboard path writes into the same one the UGC tool path uses,
            // so there is one scope contract rather than two.
            ...(ugcDraftScopes ? { draftScopes: ugcDraftScopes } : {}),
            ugcCapabilities: workspaceConfig.ugc.capabilities,
            // The image the owner put in THIS conversation, from the durable
            // record the character workflow already captures for the same
            // trusted triple. One authoritative media store, read here rather
            // than a second one grown beside it.
            readLatestInboundImage: async (claim) =>
              await tryGetCloudbathWorkspacePolicyRuntime()?.ugcCharacterWorkflow?.readLatestInboundImage(
                claim,
              ),
            ...(storyboardVisuals && config.publicAssetBaseUrl
              ? {
                  visuals: storyboardVisuals,
                  publicAssetBaseUrl: config.publicAssetBaseUrl,
                  sendVisualImage: async (image) => {
                    const adapter = await api.runtime.channel.outbound.loadAdapter("line");
                    if (!adapter?.sendMedia) {
                      throw new Error("LINE outbound image adapter is unavailable");
                    }
                    await adapter.sendMedia({
                      cfg: api.runtime.config.current() as OpenClawConfig,
                      to: image.to,
                      text: "",
                      mediaUrl: image.originalContentUrl,
                      previewImageUrl: image.previewImageUrl,
                      mediaAlreadyPersistent: true,
                      accountId: image.accountId,
                    });
                  },
                }
              : {}),
          });
          const creativeSpecialists = createCloudbathCreativeSpecialists({
            storyboard: storyboardLineRouter,
            ...(storyboardVisuals ? { visuals: storyboardVisuals } : {}),
            listCharacterNames: (claim) => storyboardResolver.listCharacterNames(claim),
          });
          // Referent arbitration runs AHEAD of every handler, and reads the
          // storyboard flow's own stores rather than a copy, so "which question
          // is open" has exactly one answer. The paid seam is resolved per call:
          // a build without the LINE plugin simply has no job to report on.
          conversationRouter = createCloudbathConversationRouter({
            state: api.runtime.state,
            ...storyboardConversationStores,
            registry: {
              lookup: async (accountId, groupId) =>
                await workspaceRegistry?.lookup(accountId, groupId),
            },
            resolver: storyboardResolver,
            resolveStoryboardReferent: (params) =>
              creativeSpecialists.storyboard.resolveReferent(params),
            isStoryboardRevisionCandidate: (params) =>
              creativeSpecialists.storyboard.isRevisionCandidate(params),
            transcript: createConversationTranscriptReader(),
            semanticResolver: createConversationSemanticResolver(
              async (request) =>
                await api.runtime.llm.complete({
                  ...request,
                  messages: [...request.messages],
                }),
            ),
            now: Date.now,
            randomId: () => randomUUID().replaceAll("-", "").slice(0, 16),
            logger,
          });
          if (
            config.publicAssetBaseUrl &&
            config.r2.bucketName &&
            config.r2.accessKeyId &&
            config.r2.secretAccessKey &&
            config.r2.endpoint
          ) {
            characterAssetView = {
              notion: ugcNotion,
              r2,
              capabilities: workspaceConfig.ugc.capabilities,
              publicAssetBaseUrl: config.publicAssetBaseUrl,
              bucketName: config.r2.bucketName,
              maxBytes: config.imageMaxBytes,
            };
            // Previs history outlives any scope window: an owner comparing v1
            // against v3 must still find v1, so neither store carries a TTL.
            //
            // Both namespaces reject new rows at the limit instead of evicting.
            // "evict-oldest" deletes the oldest row in the NAMESPACE, protecting
            // only the key just written -- it would silently delete v1 of a live
            // project whose head still references it, or drop a head and orphan
            // a project behind its stable URL. Immutable history has to fail
            // closed: refusing a new previs is recoverable, losing an approved
            // version an owner is comparing against is not.
            const previsStore = new PrevisStore({
              heads: api.runtime.state.openKeyedStore<PrevisProjectHead>({
                namespace: CLOUDBATH_PREVIS_HEAD_NAMESPACE,
                maxEntries: CLOUDBATH_PREVIS_MAX_ENTRIES,
                overflowPolicy: "reject-new",
              }),
              versions: api.runtime.state.openKeyedStore<PrevisVersion>({
                namespace: CLOUDBATH_PREVIS_VERSION_NAMESPACE,
                maxEntries: CLOUDBATH_PREVIS_MAX_ENTRIES,
                overflowPolicy: "reject-new",
              }),
              now: Date.now,
              // Storage identity of artifacts ALREADY in R2, not a live
              // dependency. Renaming it would orphan every previs version an
              // owner can still open behind its stable review URL.
              artifactKeyPrefix: "previs/cozyclay",
            });
            // Read-only from here on. The render engine was CozyClay, which is
            // no longer part of the product, so nothing constructs a
            // `previsService`/`previsLineRouter` and no new version is ever
            // written. The store stays wired because previs history is
            // immutable and already-approved versions are still addressable
            // behind their stable review URLs.
            previsReview = { store: previsStore };
          }
          await ugcCharacterWorkflow.cleanupExpiredPendingImages();
        }

        if (workspaceConfig.keepWatching) {
          const requiredRuntimeValues = {
            R2_ACCOUNT_ID: config.r2.accountId,
            R2_ACCESS_KEY_ID: config.r2.accessKeyId,
            R2_SECRET_ACCESS_KEY: config.r2.secretAccessKey,
            R2_BUCKET_NAME: config.r2.bucketName,
            R2_ENDPOINT: config.r2.endpoint,
            OPEN_CLAW_NOTION_WRITE_TOKEN: config.notion.apiKey,
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

        const installRuntime = () => {
          const registry = workspaceRegistry;
          if (!registry) {
            throw new Error("Workspace policy registry did not initialize");
          }
          installCloudbathWorkspacePolicyRuntime(runtimeOwner, {
            workspaceRegistry: registry,
            ...(ugcWorkflow ? { ugcWorkflow } : {}),
            ...(ugcCharacterWorkflow ? { ugcCharacterWorkflow } : {}),
            ...(characterAssetView ? { characterAssetView } : {}),
            ...(previsReview ? { previsReview } : {}),
            ...(storyboardLineRouter ? { storyboardLineRouter } : {}),
            ...(conversationRouter ? { conversationRouter } : {}),
            ...(keepWatchingPipeline ? { keepWatchingPipeline } : {}),
            ...(pipeline ? { pipeline } : {}),
            ...(activeConfig ? { activeConfig } : {}),
          });
          installCloudbathLineVideoWorkspaceRuntime(runtimeOwner, {
            lookupBinding: async (accountId, groupId) => await registry.lookup(accountId, groupId),
            ...(ugcDraftScopes ? { ugcScopeStore: ugcDraftScopes } : {}),
            // Read through the router so the seam always sees the CURRENT one;
            // capturing it here would pin a stale router across a restart.
            requoteActiveStoryboardDraft: async (request) =>
              (await tryGetCloudbathWorkspacePolicyRuntime()?.storyboardLineRouter?.requoteActiveDraft(
                request,
              )) ?? { kind: "no_active_storyboard" },
            resolveStoryboardSourceImage: async (request) => {
              const groupId = request.conversationId.replace(/^line:group:/u, "");
              return await tryGetCloudbathWorkspacePolicyRuntime()?.ugcCharacterWorkflow?.resolveSelectedSourceImage(
                {
                  accountId: request.accountId,
                  lineGroupId: groupId,
                  ownerSenderId: request.ownerSenderId,
                },
                request.mediaId,
              );
            },
            readStoryboardVersionNumber: async (request) =>
              await tryGetCloudbathWorkspacePolicyRuntime()?.storyboardLineRouter?.readStoryboardVersionNumber(
                request,
              ),
          });
        };

        if (!config.enabled) {
          installRuntime();
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
        installRuntime();
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
        clearCloudbathWorkspacePolicyRuntime(runtimeOwner);
        clearCloudbathLineVideoWorkspaceRuntime(runtimeOwner);
        await pipeline?.waitForIdle();
        await keepWatchingPipeline?.waitForIdle();
        pipeline = undefined;
        keepWatchingPipeline = undefined;
        workspaceRegistry = undefined;
        storyboardLineRouter = undefined;
        storyboardVisualRoute = undefined;
        conversationRouter = undefined;
        ugcWorkflow = undefined;
        ugcCharacterWorkflow = undefined;
        characterAssetView = undefined;
        activeConfig = undefined;
        logger.info("archive_stopped");
      },
    });

    api.on("before_dispatch", async (event, ctx) => {
      const runtime = tryGetCloudbathWorkspacePolicyRuntime();
      const registry = runtime?.workspaceRegistry;
      if (!registry) {
        return isWorkspacePolicyCommand(event.content)
          ? { handled: true, text: "Workspace policy service is unavailable." }
          : undefined;
      }
      // Referent arbitration runs before every handler: whichever handler
      // recognises a word first must NOT be what decides who a message is for.
      // It either answers a bounded thing itself (job status, a chip that has
      // gone stale) or rewrites the turn into the wording the owning handler
      // already parses, so the handlers below keep exactly one implementation
      // of every decision.
      const conversation = await runtime.conversationRouter?.resolveTurn(event, ctx);
      if (conversation?.kind === "agent") {
        // The main agent has the original text, images and tool history. Do not
        // feed its storyboard request back through a first-frame keyword router.
        return undefined;
      }
      if (conversation?.kind === "answer" || conversation?.kind === "clarify") {
        return { handled: true, text: conversation.text };
      }
      if (conversation?.kind === "route") {
        // The referent was resolved here; the mutation is still the storyboard
        // router's own code, reached through a bounded hint rather than through
        // wording anything composed.
        const routed = await runtime.storyboardLineRouter?.handleContextualRoute(
          conversation.route,
          event,
          ctx,
        );
        if (routed) {
          const presentation = await runtime.conversationRouter?.observeHandledTurn(event, ctx);
          return presentation ? { ...routed, presentation } : routed;
        }
      }
      const routedEvent =
        conversation?.kind === "rewrite"
          ? { ...event, content: conversation.canonicalText }
          : event;
      // How the owner produced this turn, carried alongside it so the handler
      // that claims the turn can say so. A chip and the same words typed are
      // already ONE canonical action by this point; this only records which.
      const routedCtx =
        conversation?.kind === "rewrite" ? { ...ctx, inputSource: conversation.source } : ctx;
      const characterResult = await runtime.ugcCharacterWorkflow?.handleBeforeDispatch(
        routedEvent,
        ctx,
      );
      if (characterResult) {
        return characterResult;
      }
      // Storyboard is the default video flow and runs FIRST, so a natural video
      // request becomes a storyboard rather than a previs. It declines anything
      // prefixed `PREVIS`, and declines edits and draft requests when this owner
      // has no active storyboard. Once a storyboard IS active it also answers
      // bare time-range edits; an explicit `PREVIS <range> ...` still reaches
      // the previs router below.
      let storyboardResult = await runtime.storyboardLineRouter?.handleBeforeDispatch(
        routedEvent,
        routedCtx,
      );
      // A rewrite is a HINT, not a replacement. If the handler it was aimed at
      // declines — its frozen step went stale, the menu it belonged to is gone
      // — the owner's own words must still get their turn. Without this the
      // substituted text simply vanished and the turn ended in silence, which
      // is exactly how a "make it 15 seconds" reached nobody.
      if (!storyboardResult && conversation?.kind === "rewrite") {
        storyboardResult = await runtime.storyboardLineRouter?.handleBeforeDispatch(event, ctx);
      }
      if (storyboardResult) {
        // Whatever the handler just did, the question now open is read back out
        // of ITS stores — never out of the reply text — and its controls travel
        // with the reply as portable actions the channel maps.
        const presentation = await runtime.conversationRouter?.observeHandledTurn(routedEvent, ctx);
        return presentation ? { ...storyboardResult, presentation } : storyboardResult;
      }
      await runtime.ugcWorkflow?.observeTurn({
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        sessionKey: ctx.sessionKey,
        senderId: event.senderId,
        senderIsOwner: event.senderIsOwner,
      });
      return await registry.handleBeforeDispatch(event, ctx);
    });

    api.on("before_tool_call", async (event, ctx) => {
      return await tryGetCloudbathWorkspacePolicyRuntime()?.ugcWorkflow?.beforeToolCall({
        toolName: event.toolName,
        toolParams: event.params,
        sessionKey: ctx.sessionKey,
      });
    });

    api.on("after_tool_call", async (event, ctx) => {
      const runtime = tryGetCloudbathWorkspacePolicyRuntime();
      await runtime?.ugcWorkflow?.afterToolCall({
        toolName: event.toolName,
        result: event.result,
        sessionKey: ctx.sessionKey,
      });
      if (event.toolName !== "image_generate" || event.error) {
        return;
      }
      const image = readGeneratedImageAttachment(event.result);
      const claim = runtime?.conversationRouter?.claimForSession(ctx.sessionKey);
      if (!image || !claim || !runtime?.ugcCharacterWorkflow) {
        return;
      }
      const createdAt = new Date().toISOString();
      const stored = await runtime.ugcCharacterWorkflow.rememberGeneratedImage({
        claim,
        mediaPath: image.path,
        mimeType: image.mimeType,
        createdAt,
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      });
      if (stored) {
        await runtime.conversationRouter?.observeGeneratedImage(
          claim,
          stored.durableMediaKey,
          createdAt,
        );
      }
    });

    api.on("media_generation_completed", async (event) => {
      if (event.mediaType !== "image" || event.artifacts.length !== 1) {
        return;
      }
      const runtime = tryGetCloudbathWorkspacePolicyRuntime();
      const claim = runtime?.conversationRouter?.claimForSession(event.requesterSessionKey);
      const artifact = event.artifacts[0];
      if (!claim || !artifact || !runtime?.ugcCharacterWorkflow) {
        return;
      }
      const stored = await runtime.ugcCharacterWorkflow.rememberGeneratedImage({
        claim,
        mediaPath: artifact.path,
        mimeType: artifact.mimeType,
        createdAt: event.completedAt,
        sessionKey: event.requesterSessionKey,
      });
      if (stored) {
        await runtime.conversationRouter?.observeGeneratedImage(
          claim,
          stored.durableMediaKey,
          event.completedAt,
        );
      }
    });

    api.on(
      "message_received",
      async (event, ctx) => {
        const runtime = tryGetCloudbathWorkspacePolicyRuntime();
        const job = extractInboundLineImage(event, ctx);
        if (!job) {
          return;
        }
        const characterImageTurn = runtime?.ugcCharacterWorkflow?.beginInboundImageTurn(job, {
          messageId: event.messageId ?? ctx.messageId,
          runId: event.runId ?? ctx.runId,
          channelId: ctx.channelId,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
        });
        if (characterImageTurn && (await characterImageTurn)) {
          return;
        }
        const binding = await runtime?.workspaceRegistry.lookup(job.accountId, job.groupId);
        if (binding?.policyId === "KEEP_WATCHING") {
          if (!runtime?.keepWatchingPipeline) {
            logger.error("keep_watching_runtime_unavailable", {
              messageKey: job.messageId,
            });
            return;
          }
          await runtime.keepWatchingPipeline.enqueue(job);
          return;
        }
        const activePipeline = runtime?.pipeline;
        const config = runtime?.activeConfig;
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
