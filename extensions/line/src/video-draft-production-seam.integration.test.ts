import {
  createMessageTool,
  getRequiredHookHandler,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Production-seam regression for the exact LINE video-draft failure.
 *
 * Unlike the older relay-only acceptance test, this registers the real bundled
 * LINE entry, materializes its real `line_video_draft` tool, initializes the
 * host hook runner from that registry, and sends the model's production
 * paraphrase through the real agent `message` tool and LINE adapter selection.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createPluginRecord,
  createPluginRuntimeMock,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

const generateVideoMock = vi.fn();

vi.mock("openclaw/plugin-sdk/channel-entry-contract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-entry-contract")>();
  return {
    ...actual,
    // Loading a bundled channel's sync facade inside a Vitest worker can
    // deadlock the worker. Keep only that loader out of this test; execute the
    // entry's real registerFull callback against a real host plugin registry.
    defineBundledChannelEntry: (options: {
      id: string;
      name: string;
      description: string;
      registerFull?: (
        api: import("openclaw/plugin-sdk/channel-entry-contract").OpenClawPluginApi,
      ) => void;
    }) => ({
      kind: "bundled-channel-entry" as const,
      id: options.id,
      name: options.name,
      description: options.description,
      register(api: import("openclaw/plugin-sdk/channel-entry-contract").OpenClawPluginApi) {
        options.registerFull?.(api);
      },
    }),
  };
});

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-openrouter-key" }),
}));
vi.mock("./accounts.js", () => ({
  listLineAccountIds: () => ["acct-1"],
  resolveDefaultLineAccountId: () => "acct-1",
  resolveLineAccount: () => ({
    accountId: "acct-1",
    enabled: true,
    channelAccessToken: "test-token",
    channelSecret: "test-secret",
    tokenSource: "config" as const,
    config: {},
  }),
}));

const lineEntry = (await import("../index.js")).default;
const { LINE_VIDEO_DRAFT_TOOL_NAME } = await import("./video-draft-tool.js");
const { LINE_VIDEO_DRAFT_NAMESPACE } = await import("./video-draft-store.js");

const OWNER_ID = "U-owner-production-seam";
const GROUP_ID = "C11111111111111111111111111111111";
const SESSION_KEY = `agent:main:line:group:${GROUP_ID.toLowerCase()}`;
const PRODUCTION_REQUEST = "ช่วยทำวิดีโอแมวนั่งอยู่บนน้ำให้หน่อย 5 วิ";
const PRODUCTION_PARAPHRASE = "กรุณาส่งข้อความยืนยันนี้เพื่อเริ่มสร้างวิดีโอ:\nยืนยัน VIDEO 5343";

const SEEDANCE_25_LIVE = {
  id: "bytedance/seedance-2.5",
  name: "ByteDance: Seedance 2.5",
  supported_resolutions: ["480p", "720p"],
  supported_aspect_ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  supported_sizes: ["854x480", "640x640", "480x854", "1280x720", "720x1280"],
  supported_durations: [4, 5, 6, 7, 8, 9, 10],
  supported_frame_images: ["first_frame", "last_frame"],
  generate_audio: true,
  pricing_skus: {
    video_tokens: "0.0000107",
    video_tokens_without_audio: "0.0000107",
    video_tokens_with_video_input: "0.0000064",
  },
};

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

function createStores() {
  const stores = new Map<string, PluginStateKeyedStore<unknown>>();
  const openKeyedStore = <T>(options: { namespace: string }): PluginStateKeyedStore<T> => {
    const existing = stores.get(options.namespace);
    if (existing) {
      return existing as PluginStateKeyedStore<T>;
    }
    const store = createMemoryStore<T>();
    stores.set(options.namespace, store as PluginStateKeyedStore<unknown>);
    return store;
  };
  return { stores, openKeyedStore };
}

function expectCompleteDraftPreview(text: string) {
  expect(text).toContain("🎬 Video draft");
  expect(text).toContain("Model: ByteDance: Seedance 2.5");
  expect(text).toContain("Duration: 5 sec");
  expect(text).toContain("Resolution: 480p");
  expect(text).toContain("Aspect: 16:9");
  expect(text).toContain("Audio: Off");
  expect(text).toContain("Estimated cost: $0.51");
  expect(text).toContain("Prompt:\na cat sitting on water");
  expect(text).toMatch(/ยืนยัน VIDEO \d{4}/u);
  expect(text).toContain("เพื่อเริ่มสร้าง");
}

beforeEach(() => {
  generateVideoMock.mockReset();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe(`LINE production outbound seam for '${PRODUCTION_REQUEST}'`, () => {
  it("delivers the complete persisted preview exactly once through message_sending", async () => {
    const { stores, openKeyedStore } = createStores();
    const runtime = createPluginRuntimeMock({ state: { openKeyedStore } });
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({
      id: "line",
      origin: "bundled",
      source: "bundled:line",
    });
    registry.plugins.push(record);
    const toolFactories = new Map<string, OpenClawPluginToolFactory>();
    const hookHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    lineEntry.register(
      createTestPluginApi({
        id: "line",
        name: "LINE",
        source: "bundled:line",
        runtime,
        config: { channels: { line: { enabled: true } } },
        registrationMode: "full",
        registerTool(tool, options) {
          if (typeof tool !== "function") {
            return;
          }
          for (const name of options?.names ?? []) {
            toolFactories.set(name, tool);
          }
        },
        on(hookName, handler, options) {
          hookHandlers.set(
            hookName,
            handler as unknown as (event: unknown, ctx: unknown) => unknown,
          );
          addTestHook({
            registry,
            pluginId: "line",
            hookName,
            handler,
            ...(options?.priority !== undefined ? { priority: options.priority } : {}),
          });
        },
      }),
    );
    initializeGlobalHookRunner(registry);

    const visible: string[] = [];
    const cfg = { channels: { line: { enabled: true } } } as OpenClawConfig;
    setLineRuntime({
      channel: {
        line: {
          resolveLineAccount: () => ({
            accountId: "acct-1",
            enabled: true,
            channelAccessToken: "test-token",
            channelSecret: "test-secret",
            tokenSource: "config" as const,
            config: {},
          }),
          pushMessageLine: async (_to: string, text: string) => {
            visible.push(text);
            return { messageId: `m-${visible.length}`, chatId: GROUP_ID };
          },
        },
        text: {
          chunkMarkdownText: (text: string) => [text],
          resolveTextChunkLimit: () => 5000,
        },
      },
    } as unknown as PluginRuntime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line-delivery-test",
          source: "test",
          plugin: linePlugin,
        },
      ]),
    );

    const factory = toolFactories.get(LINE_VIDEO_DRAFT_TOOL_NAME);
    expect(factory).toBeDefined();
    const materialized = factory!({
      config: cfg,
      agentId: "main",
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: OWNER_ID,
      sessionId: GROUP_ID,
      sessionKey: SESSION_KEY,
      agentAccountId: "acct-1",
      deliveryContext: { channel: "line", to: GROUP_ID, accountId: "acct-1" },
    });
    const tools = Array.isArray(materialized) ? materialized : [materialized];
    const tool = tools.find((entry) => entry?.name === LINE_VIDEO_DRAFT_TOOL_NAME);
    expect(tool).toBeDefined();

    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response(JSON.stringify({ data: [SEEDANCE_25_LIVE] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await tool!.execute("call-production-seam", {
        prompt: "a cat sitting on water",
        durationSeconds: 5,
        resolution: "480p",
        aspectRatio: "16:9",
      });
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      const deterministicPreview = content?.find((item) => item.type === "text")?.text ?? "";
      expectCompleteDraftPreview(deterministicPreview);

      const messageTool = createMessageTool({
        config: cfg,
        agentId: "main",
        agentSessionKey: SESSION_KEY,
        sessionId: GROUP_ID,
        agentAccountId: "acct-1",
        currentChannelProvider: "line",
        currentChannelId: GROUP_ID,
        currentChatType: "group",
        currentMessagingTarget: GROUP_ID,
        requesterSenderId: OWNER_ID,
        senderIsOwner: true,
        sourceReplyDeliveryMode: "message_tool_only",
        conversationReadOrigin: "direct-operator",
      });
      await messageTool.execute("message-production-seam", {
        action: "send",
        message: PRODUCTION_PARAPHRASE,
      });
      await messageTool.execute("message-production-seam-duplicate", {
        action: "send",
        message: "สร้าง draft แล้วครับ",
      });

      expect(visible).toEqual([deterministicPreview]);
      expect(visible[0]).not.toContain("กรุณาส่งข้อความยืนยันนี้");
      expectCompleteDraftPreview(visible[0] ?? "");

      expect([...stores.keys()]).toContain(LINE_VIDEO_DRAFT_NAMESPACE);
      const draftStore = stores.get(LINE_VIDEO_DRAFT_NAMESPACE);
      const drafts = await draftStore?.entries();
      expect(drafts).toHaveLength(1);
      const persisted = drafts?.[0]?.value as
        | { draftId?: string; prompt?: string; durationSeconds?: number }
        | undefined;
      const shownCode = /ยืนยัน VIDEO (\d{4})/u.exec(visible[0] ?? "")?.[1];
      expect(shownCode).toBe(persisted?.draftId);
      expect(persisted).toMatchObject({
        prompt: "a cat sitting on water",
        durationSeconds: 5,
      });

      // Exercise the other real outbound seam. Provider-native LINE replies
      // use reply_payload_sending and never enter the durable message tool.
      const replySessionKey = `${SESSION_KEY}:provider-native`;
      const replyGroupId = `${GROUP_ID}-provider-native`;
      const replyToolMaterialized = factory!({
        config: cfg,
        agentId: "main",
        messageChannel: "line",
        senderIsOwner: true,
        requesterSenderId: OWNER_ID,
        sessionId: replyGroupId,
        sessionKey: replySessionKey,
        agentAccountId: "acct-1",
        deliveryContext: { channel: "line", to: replyGroupId, accountId: "acct-1" },
      });
      const replyTools = Array.isArray(replyToolMaterialized)
        ? replyToolMaterialized
        : [replyToolMaterialized];
      const replyTool = replyTools.find((entry) => entry?.name === LINE_VIDEO_DRAFT_TOOL_NAME);
      expect(replyTool).toBeDefined();
      const replyDraftResult = await replyTool!.execute("call-provider-native-seam", {
        prompt: "a cat sitting on water",
        durationSeconds: 5,
        resolution: "480p",
        aspectRatio: "16:9",
      });
      const replyDraftContent = (
        replyDraftResult as { content?: Array<{ type: string; text?: string }> }
      ).content;
      const replyDraftPreview = replyDraftContent?.find((item) => item.type === "text")?.text ?? "";
      expectCompleteDraftPreview(replyDraftPreview);

      const replyPayloadSending = getRequiredHookHandler(hookHandlers, "reply_payload_sending");
      const firstReply = await replyPayloadSending(
        {
          payload: { text: PRODUCTION_PARAPHRASE },
          kind: "final",
          channel: "line",
          sessionKey: replySessionKey,
          runId: "run-provider-native",
        },
        {
          channelId: "line",
          accountId: "acct-1",
          conversationId: replyGroupId,
          sessionKey: replySessionKey,
          runId: "run-provider-native",
        },
      );
      expect(firstReply).toMatchObject({ payload: { text: replyDraftPreview } });
      expectCompleteDraftPreview(
        (firstReply as { payload?: { text?: string } } | undefined)?.payload?.text ?? "",
      );
      const duplicateReply = await replyPayloadSending(
        {
          payload: { text: "สร้าง draft แล้วครับ" },
          kind: "final",
          channel: "line",
          sessionKey: replySessionKey,
          runId: "run-provider-native",
        },
        {
          channelId: "line",
          accountId: "acct-1",
          conversationId: replyGroupId,
          sessionKey: replySessionKey,
          runId: "run-provider-native",
        },
      );
      expect(duplicateReply).toMatchObject({
        cancel: true,
        reason: "line_video_draft_reply_already_sent",
      });

      expect(
        requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models")),
      ).toHaveLength(0);
      expect(generateVideoMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
