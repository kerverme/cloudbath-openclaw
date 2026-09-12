// Pure channel contract types used by plugin implementations and tests.
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAgentTool,
  ChannelAccountSnapshot,
  ChannelApprovalAdapter,
  ChannelApprovalCapability,
  ChannelCommandConversationContext,
  ChannelCapabilities,
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelGroupContext,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelReplyPresentationContext,
  ChannelMessageToolSchemaContribution,
  ChannelMeta,
  ChannelStructuredComponents,
  ChannelStatusIssue,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "../channels/plugins/types.public.js";
export type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
/** Turn-level presentation policy carried on `ChannelAgentPromptAdapter`. */
export type { TurnPresentationPolicy } from "../infra/reply-language-policy.js";

export type {
  ChannelDirectoryAdapter,
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorEmptyAllowlistAccountContext,
  ChannelDoctorLegacyConfigRule,
  ChannelDoctorSequenceResult,
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadHint,
  ChannelStatusAdapter,
} from "../channels/plugins/types.adapters.js";
export type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
