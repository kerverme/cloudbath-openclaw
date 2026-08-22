import { deliverOutboundPayloads } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Production-seam regression for the exact LINE video-draft failure.
 *
 * Unlike the older relay-only acceptance test, this registers the real bundled
 * LINE entry, materializes its real `line_video_draft` tool, initializes the
 * host hook runner from that registry, and sends the model's production
 * paraphrase through the durable outbound delivery path used by `message`.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createPluginRecord,
  createPluginRuntimeMock,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const GROUP_ID = "C-production-seam";
const SESSION_KEY = `agent:main:line:group:${GROUP_ID}`;
const PRODUCTION_REQUEST = "ช่วยทำ วีดีโอ แมวนั่ง อยู่บนน้ำ ให้หน่อย 5 วิ";
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
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line-delivery-test",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            capabilities: { chatTypes: ["group"] },
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text }) => {
                visible.push(text);
                return { channel: "line", messageId: `m-${visible.length}` };
              },
              sendMedia: async ({ text }) => {
                visible.push(text);
                return { channel: "line", messageId: `m-${visible.length}` };
              },
            },
          }),
        },
      ]),
    );

    const factory = toolFactories.get(LINE_VIDEO_DRAFT_TOOL_NAME);
    expect(factory).toBeDefined();
    const materialized = factory!({
      config: { channels: { line: { enabled: true } } },
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
      expect(deterministicPreview).toContain("🎬 Video draft");

      await deliverOutboundPayloads({
        cfg: { channels: { line: { enabled: true } } },
        channel: "line",
        to: GROUP_ID,
        accountId: "acct-1",
        payloads: [{ text: PRODUCTION_PARAPHRASE }],
        session: { key: SESSION_KEY },
        skipQueue: true,
      });
      await deliverOutboundPayloads({
        cfg: { channels: { line: { enabled: true } } },
        channel: "line",
        to: GROUP_ID,
        accountId: "acct-1",
        payloads: [{ text: "สร้าง draft แล้วครับ" }],
        session: { key: SESSION_KEY },
        skipQueue: true,
      });

      expect(visible).toEqual([deterministicPreview]);
      expect(visible[0]).not.toContain("กรุณาส่งข้อความยืนยันนี้");
      expect(visible[0]).toContain("Model: ByteDance: Seedance 2.5");
      expect(visible[0]).toContain("Duration: 5 sec");
      expect(visible[0]).toContain("Resolution: 480p");
      expect(visible[0]).toContain("Aspect: 16:9");
      expect(visible[0]).toContain("Estimated cost: $0.51");
      expect(visible[0]).toContain("a cat sitting on water");

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

      expect(
        requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models")),
      ).toHaveLength(0);
      expect(generateVideoMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
