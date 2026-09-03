// Line type declarations define plugin contracts.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";

export type LineTokenSource = "config" | "env" | "file" | "none";

interface LineThreadBindingsConfig {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSessions?: boolean;
  defaultSpawnContext?: "isolated" | "fork";
  /** @deprecated Use spawnSessions instead. */
  spawnSubagentSessions?: boolean;
  /** @deprecated Use spawnSessions instead. */
  spawnAcpSessions?: boolean;
}

/**
 * Owner-only LINE video-generation cost guard. `maxEstimatedCostUsd` bounds
 * confirmation-time spend before any paid OpenRouter video request is
 * submitted (see video-cost-guard.ts); `defaultModel` seeds a conversation's
 * first video-model preference (video-model-preference.ts) before the owner
 * ever switches it explicitly.
 */
interface LineVideoGenerationConfig {
  maxEstimatedCostUsd?: number;
  defaultModel?: string;
  /** Operator-declared fal rates, per endpoint. A model with none is not payable. */
  falPricing?: {
    models?: Record<
      string,
      {
        usdPerSecond?: number;
        byResolution?: Record<string, number>;
        source?: string;
      }
    >;
  };
  /** Operator declarations for capabilities fal's published schema omits. */
  falModels?: Record<
    string,
    {
      durationSeconds?: number[];
      audio?: "controllable" | "always_on";
      enabled?: boolean;
    }
  >;
}

interface LineAccountBaseConfig {
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  responsePrefix?: string;
  mediaMaxMb?: number;
  webhookPath?: string;
  threadBindings?: LineThreadBindingsConfig;
  groups?: Record<string, LineGroupConfig>;
  videoGeneration?: LineVideoGenerationConfig;
}

export interface LineConfig extends LineAccountBaseConfig {
  accounts?: Record<string, LineAccountConfig>;
  defaultAccount?: string;
}

export interface LineAccountConfig extends LineAccountBaseConfig {}

export interface LineGroupConfig {
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  requireMention?: boolean;
  systemPrompt?: string;
  skills?: string[];
}

export interface ResolvedLineAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: LineTokenSource;
  config: LineConfig & LineAccountConfig;
}

export interface LineSendResult {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
}

export type LineProbeResult = BaseProbeResult<string> & {
  bot?: {
    displayName?: string;
    userId?: string;
    basicId?: string;
    pictureUrl?: string;
  };
};

type LineFlexMessagePayload = {
  altText: string;
  contents: unknown;
};

export type LineTemplateMessagePayload =
  | {
      type: "confirm";
      text: string;
      confirmLabel: string;
      confirmData: string;
      cancelLabel: string;
      cancelData: string;
      altText?: string;
    }
  | {
      type: "buttons";
      title: string;
      text: string;
      actions: Array<{
        type: "message" | "uri" | "postback";
        label: string;
        data?: string;
        uri?: string;
      }>;
      thumbnailImageUrl?: string;
      altText?: string;
    }
  | {
      type: "carousel";
      columns: Array<{
        title?: string;
        text: string;
        thumbnailImageUrl?: string;
        actions: Array<{
          type: "message" | "uri" | "postback";
          label: string;
          data?: string;
          uri?: string;
        }>;
      }>;
      altText?: string;
    };

export type LineChannelData = {
  quickReplies?: string[];
  location?: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  flexMessage?: LineFlexMessagePayload;
  templateMessage?: LineTemplateMessagePayload;
};
