/**
 * A LINE model-state question is answered before any model is called.
 *
 * Registers the real Cloudbath and LINE plugin entries into one host hook
 * registry -- Cloudbath first, the load order that would favor it -- and
 * drives the real core dispatch. Cloudbath's referent LLM call can only run
 * inside its before_dispatch handler, and the main agent and every tool it
 * could call (web_search included) sit behind the reply resolver, so both are
 * observed directly rather than inferred.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const OWNER_ID = "U-owner-model-state";
const GROUP_ID = "C22222222222222222222222222222222";
const SESSION_KEY = `agent:main:line:group:${GROUP_ID.toLowerCase()}`;
const CATALOG_URL = "https://openrouter.ai/api/v1/models/user";
const CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openrouter/deepseek/deepseek-v4-flash-0731" },
      models: { "openrouter/openai/gpt-5.6-luna": { alias: "luna" } },
    },
  },
} as OpenClawConfig;

vi.mock("openclaw/plugin-sdk/channel-entry-contract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-entry-contract")>();
  return {
    ...actual,
    // Loading a bundled channel's sync facade inside a Vitest worker can
    // deadlock it; run the entry's real registerFull callback instead.
    defineBundledChannelEntry: (options: {
      id: string;
      registerFull?: (api: OpenClawPluginApi) => void;
    }) => ({
      id: options.id,
      register(api: OpenClawPluginApi) {
        options.registerFull?.(api);
      },
    }),
  };
});
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => CONFIG }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-openrouter-key" }),
}));

const cloudbathEntry = (await import("../extensions/cloudbath-line-image-archive/index.js"))
  .default;
const lineEntry = (await import("../extensions/line/index.js")).default;
const { dispatchReplyFromConfig } = await import("../src/auto-reply/reply/dispatch-from-config.js");
const { createReplyDispatcher } = await import("../src/auto-reply/reply/reply-dispatcher.js");
const { buildTestCtx } = await import("../src/auto-reply/reply/test-ctx.js");
const { initializeGlobalHookRunner, resetGlobalHookRunner } =
  await import("../src/plugins/hook-runner-global.js");
const { addTestHook } = await import("../src/plugins/hooks.test-helpers.js");
const { createEmptyPluginRegistry } = await import("../src/plugins/registry-empty.js");
const { resetPluginRuntimeStateForTest } = await import("../src/plugins/runtime.js");

function openKeyedStore<T>(): PluginStateKeyedStore<T> {
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
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
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
      return [...values].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

type Harness = {
  ask(text: string): Promise<string[]>;
  /** Every before_dispatch handler that ran, as `<plugin>:<registration index>`. */
  beforeDispatchCalls: string[];
  replyResolver: ReturnType<typeof vi.fn>;
  requestedUrls: string[];
};

function createHarness(): Harness {
  const registry = createEmptyPluginRegistry();
  const harness = {
    beforeDispatchCalls: [] as string[],
    replyResolver: vi.fn(async () => ({ text: "agent reply" })),
    requestedUrls: [] as string[],
  };
  for (const [entry, pluginId] of [
    [cloudbathEntry, "cloudbath-line-image-archive"],
    [lineEntry, "line"],
  ] as const) {
    let beforeDispatchIndex = 0;
    entry.register(
      createTestPluginApi({
        id: pluginId,
        name: pluginId,
        source: "test",
        config: CONFIG,
        registrationMode: "full",
        runtime: { state: { openKeyedStore } } as unknown as OpenClawPluginApi["runtime"],
        on(hookName, handler, options) {
          const label = `${pluginId}:${beforeDispatchIndex}`;
          if (hookName === "before_dispatch") {
            beforeDispatchIndex += 1;
          }
          const observed =
            hookName === "before_dispatch"
              ? (((...args: unknown[]) => {
                  harness.beforeDispatchCalls.push(label);
                  return (handler as (...params: unknown[]) => unknown)(...args);
                }) as typeof handler)
              : handler;
          addTestHook({
            registry,
            pluginId,
            hookName,
            handler: observed,
            // The priority each plugin really registers with.
            ...(options?.priority !== undefined ? { priority: options.priority } : {}),
          });
        },
      }),
    );
  }
  initializeGlobalHookRunner(registry);

  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    harness.requestedUrls.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return new Response(
      JSON.stringify({
        data: [
          { id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" },
          { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash" },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  return Object.assign(harness, {
    async ask(text: string) {
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: text,
          BodyForAgent: text,
          BodyForCommands: text,
          CommandBody: text,
          RawBody: text,
          From: `line:group:${GROUP_ID}`,
          To: `line:group:${GROUP_ID}`,
          SenderId: OWNER_ID,
          OwnerAllowFrom: [OWNER_ID],
          ChatType: "group",
          Provider: "line",
          Surface: "line",
          AccountId: "default",
          SessionKey: SESSION_KEY,
          MessageSid: `m-${text.length}-${Date.now()}`,
        }),
        // The registry above IS the plugin set; without this the dispatch
        // would load the configured plugins and replace the global hook runner.
        cfg: { ...CONFIG, plugins: { enabled: false } },
        dispatcher,
        replyResolver: harness.replyResolver,
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return delivered;
    },
  });
}

let tempDir: string;
let previousStateDir: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-model-state-")));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDir;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("LINE model-state questions through the real dispatch", () => {
  it("answers GPT-6 Luna as NOT AVAILABLE with no referent, agent or web call", async () => {
    const harness = createHarness();

    const delivered = await harness.ask("อันนี้ละมีไหม OpenAI: GPT-6 Luna");

    expect(delivered).toEqual([
      'ไม่มี "OpenAI: GPT-6 Luna" ในแคตตาล็อก OpenRouter ของบัญชีนี้\nรุ่นอื่นที่มีชื่อคล้ายกัน (ไม่ใช่รุ่นที่ถาม): OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)',
    ]);
    // LINE's per-turn reset, then the model-state answer. Cloudbath's handler --
    // the only place its referent resolver runs -- is never reached.
    expect(harness.beforeDispatchCalls).toEqual(["line:0", "line:1"]);
    // The main agent -- and web_search, which exists only inside it -- never ran.
    expect(harness.replyResolver).not.toHaveBeenCalled();
    // The only network request was the authoritative account catalog.
    expect(harness.requestedUrls).toEqual([CATALOG_URL]);
  });

  it("answers the current model from the session without any request at all", async () => {
    const harness = createHarness();

    const delivered = await harness.ask("ตอนนี้ใช้โมเดลอะไร");

    expect(delivered).toEqual([
      "ตอนนี้ใช้โมเดล deepseek/deepseek-v4-flash-0731 ผ่าน openrouter\nการเลือก: ค่าเริ่มต้นของระบบ",
    ]);
    expect(harness.beforeDispatchCalls).toEqual(["line:0", "line:1"]);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(harness.requestedUrls).toEqual([]);
  });

  it("switches on the production follow-up with no referent, agent or web call", async () => {
    const harness = createHarness();
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      entry: {
        sessionId: "sess-line-owner",
        providerOverride: "openrouter",
        modelOverride: "deepseek/deepseek-v4-flash-0731",
        modelOverrideSource: "user",
        updatedAt: 1,
      } as SessionEntry,
    });
    await harness.ask("มี GPT-5.6 Luna ไหม");
    harness.beforeDispatchCalls.length = 0;
    harness.requestedUrls.length = 0;

    const delivered = await harness.ask("เปลี่ยนให้หน่อย");

    expect(delivered).toEqual(["เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(["line:0", "line:1"]);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    // The switch re-reads the account catalog before applying; nothing else.
    expect(harness.requestedUrls).toEqual([CATALOG_URL]);
    clearSessionStoreCacheForTest();
    const entry = getSessionEntry({
      agentId: "main",
      sessionKey: SESSION_KEY,
      readConsistency: "latest",
    });
    expect(entry?.providerOverride).toBe("openrouter");
    expect(entry?.modelOverride).toBe("openai/gpt-5.6-luna");
  });

  it("still hands ordinary chat to Cloudbath and then the agent", async () => {
    const harness = createHarness();

    const delivered = await harness.ask("สวัสดีครับ");

    // Priority first, then registration order: Cloudbath registered first, so
    // its arbitration precedes LINE's video gates and switch router.
    expect(harness.beforeDispatchCalls).toEqual([
      "line:0",
      "line:1",
      "cloudbath-line-image-archive:0",
      "line:2",
      "line:3",
      "line:4",
      "line:5",
    ]);
    expect(harness.replyResolver).toHaveBeenCalledOnce();
    expect(delivered).toEqual(["agent reply"]);
    expect(harness.requestedUrls).toEqual([]);
  });
});
