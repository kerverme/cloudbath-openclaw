/**
 * Model control is answered before any model is called, on LINE and in the
 * Control UI.
 *
 * Registers the real Cloudbath and LINE plugin entries into one host hook
 * registry -- Cloudbath first, the load order that would favor it -- and
 * drives the real core dispatch with the inbound context each surface builds.
 * Cloudbath's referent LLM call can only run inside its before_dispatch
 * handler, and the main agent and every tool it could call (web_search
 * included) sit behind the reply resolver, so both are observed directly
 * rather than inferred.
 *
 * Production: in the Control UI, viewing a LINE group's session on DeepSeek,
 * "เปลี่ยนเป็น openai luna หน่อย" went to the main model, which called
 * web_search and a second model turn (~30 s) and changed nothing.
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
const OTHER_GROUP_ID = "C33333333333333333333333333333333";
const SESSION_KEY = `agent:main:line:group:${GROUP_ID.toLowerCase()}`;
const OTHER_SESSION_KEY = `agent:main:line:group:${OTHER_GROUP_ID.toLowerCase()}`;
const MAIN_SESSION_KEY = "agent:main:main";
const CATALOG_URL = "https://openrouter.ai/api/v1/models/user";
const DEEPSEEK = { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash" };
const LUNA_5_6 = { id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" };
const LUNA_6 = { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" };
const CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openrouter/deepseek/deepseek-v4-flash-0731" },
      models: { "openrouter/*": {} },
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

type Surface = "line" | "webchat";

type Harness = {
  ask(text: string, options?: { surface?: Surface; sessionKey?: string }): Promise<string[]>;
  /** Every before_dispatch handler that ran, as `<plugin>:<registration index>`. */
  beforeDispatchCalls: string[];
  replyResolver: ReturnType<typeof vi.fn>;
  requestedUrls: string[];
  /** Forget the calls and requests so far, to observe one turn alone. */
  reset(): void;
};

let messageCounter = 0;

/** The inbound context each surface builds for an owner's turn. */
function inboundContext(text: string, surface: Surface, sessionKey: string) {
  messageCounter += 1;
  const body = {
    Body: text,
    BodyForAgent: text,
    BodyForCommands: text,
    CommandBody: text,
    RawBody: text,
    SessionKey: sessionKey,
    MessageSid: `m-${messageCounter}`,
  };
  if (surface === "webchat") {
    // chat.send (src/gateway/server-methods/chat.ts) for a Control UI send:
    // internal surface, no SenderId for operator UI clients, owner through the
    // operator.admin scope, on the session key the operator is viewing.
    return buildTestCtx({
      ...body,
      From: undefined,
      To: undefined,
      AgentId: "main",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandSource: undefined,
      CommandAuthorized: true,
      CommandTurn: { kind: "normal", source: "message", authorized: false, body: text },
      GatewayClientScopes: ["operator.admin"],
    });
  }
  const groupId = sessionKey === OTHER_SESSION_KEY ? OTHER_GROUP_ID : GROUP_ID;
  return buildTestCtx({
    ...body,
    From: `line:group:${groupId}`,
    To: `line:group:${groupId}`,
    SenderId: OWNER_ID,
    OwnerAllowFrom: [OWNER_ID],
    ChatType: "group",
    Provider: "line",
    Surface: "line",
    AccountId: "default",
  });
}

function createHarness(
  catalog: ReadonlyArray<{ id: string; name: string }> = [LUNA_5_6, DEEPSEEK],
) {
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
    return new Response(JSON.stringify({ data: catalog }), { status: 200 });
  }) as typeof fetch;

  return Object.assign(harness, {
    reset() {
      harness.beforeDispatchCalls.length = 0;
      harness.requestedUrls.length = 0;
      harness.replyResolver.mockClear();
    },
    async ask(text: string, options: { surface?: Surface; sessionKey?: string } = {}) {
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      await dispatchReplyFromConfig({
        ctx: inboundContext(text, options.surface ?? "line", options.sessionKey ?? SESSION_KEY),
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
  }) satisfies Harness;
}

async function seedDeepSeekSession(sessionKey: string): Promise<void> {
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    entry: {
      sessionId: `sess-${sessionKey}`,
      providerOverride: "openrouter",
      modelOverride: DEEPSEEK.id,
      modelOverrideSource: "user",
      // Recent: session-store maintenance on a later write prunes stale rows.
      updatedAt: Date.now(),
    } as SessionEntry,
  });
}

function storedModel(sessionKey = SESSION_KEY) {
  clearSessionStoreCacheForTest();
  const entry = getSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
  return {
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    liveModelSwitchPending: entry?.liveModelSwitchPending,
  };
}

const ON_DEEPSEEK = {
  providerOverride: "openrouter",
  modelOverride: DEEPSEEK.id,
  liveModelSwitchPending: undefined,
};
const switchedTo = (model: { id: string }) => ({
  providerOverride: "openrouter",
  modelOverride: model.id,
  liveModelSwitchPending: true,
});
/** LINE's per-turn reset, then model control: Cloudbath and the agent never ran. */
const CLAIMED_BEFORE_REFERENT = ["line:0", "line:1"];
/** Every handler in order: Cloudbath's arbitration, LINE's video gates, late model control. */
const FULL_CHAIN = [
  "line:0",
  "line:1",
  "cloudbath-line-image-archive:0",
  "line:2",
  "line:3",
  "line:4",
  "line:5",
];

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
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
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
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
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
    harness.reset();

    const delivered = await harness.ask("เปลี่ยนให้หน่อย");

    expect(delivered).toEqual(["เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    // The switch re-reads the account catalog before applying; nothing else.
    expect(harness.requestedUrls).toEqual([CATALOG_URL]);
    expect(storedModel()).toEqual(switchedTo(LUNA_5_6));
  });

  it("still hands ordinary chat to Cloudbath and then the agent", async () => {
    const harness = createHarness();

    const delivered = await harness.ask("สวัสดีครับ");

    // Priority first, then registration order: Cloudbath registered first, so
    // its arbitration precedes LINE's video gates and late model control.
    expect(harness.beforeDispatchCalls).toEqual(FULL_CHAIN);
    expect(harness.replyResolver).toHaveBeenCalledOnce();
    expect(delivered).toEqual(["agent reply"]);
    expect(harness.requestedUrls).toEqual([]);
  });
});

describe("LINE typed switches are claimed before Cloudbath's referent arbitration", () => {
  it("switches a unique version-less name directly with no referent, agent or web call", async () => {
    const harness = createHarness();
    await seedDeepSeekSession(SESSION_KEY);

    const delivered = await harness.ask("เปลี่ยนเป็น openai luna หน่อย");

    expect(delivered).toEqual(["เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(harness.requestedUrls).toEqual([CATALOG_URL]);
    expect(storedModel()).toEqual(switchedTo(LUNA_5_6));
  });

  it("offers the nearby model for an absent version, and ใช่ completes the switch", async () => {
    const harness = createHarness();
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("เปลี่ยนเป็น GPT-6 Luna")).toEqual([
      'ไม่มี "GPT-6 Luna" ในแคตตาล็อก OpenRouter ของบัญชีนี้ แต่มี OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)\nต้องการเปลี่ยนเป็น OpenAI: GPT-5.6 Luna ไหมครับ?',
    ]);
    expect(storedModel()).toEqual(ON_DEEPSEEK);
    harness.reset();

    expect(await harness.ask("ใช่")).toEqual(["เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(storedModel()).toEqual(switchedTo(LUNA_5_6));
  });
});

describe("Control UI (webchat) natural-language model control through the real dispatch", () => {
  const webchat = { surface: "webchat" } as const;

  it("RED->GREEN: เปลี่ยนเป็น openai luna หน่อย switches the viewed LINE session, no agent or web", async () => {
    const harness = createHarness([LUNA_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    const delivered = await harness.ask("เปลี่ยนเป็น openai luna หน่อย", webchat);

    expect(delivered).toEqual(["เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
    // The main agent -- and web_search, which exists only inside it -- never ran.
    expect(harness.replyResolver).not.toHaveBeenCalled();
    // The only network request was the authoritative account catalog.
    expect(harness.requestedUrls).toEqual([CATALOG_URL]);
    expect(storedModel()).toEqual(switchedTo(LUNA_6));
    // The session being viewed, not the main session, took the switch.
    expect(storedModel(MAIN_SESSION_KEY).modelOverride).toBeUndefined();
  });

  it("switches in English and answers in English", async () => {
    const harness = createHarness([LUNA_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("switch to GPT-6 Luna", webchat)).toEqual([
      "Switched to OpenAI: GPT-6 Luna (openai/gpt-6-luna).",
    ]);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(storedModel()).toEqual(switchedTo(LUNA_6));
  });

  it("answers the current model of the viewed session without any request", async () => {
    const harness = createHarness([LUNA_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("ตอนนี้ใช้โมเดลอะไร", webchat)).toEqual([
      "ตอนนี้ใช้โมเดล deepseek/deepseek-v4-flash-0731 ผ่าน openrouter\nการเลือก: เลือกเอง",
    ]);
    expect(await harness.ask("what model are you using", webchat)).toEqual([
      "Current model: deepseek/deepseek-v4-flash-0731 via openrouter\nSelection: chosen manually",
    ]);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(harness.requestedUrls).toEqual([]);
  });

  it("answers availability from the catalog, and เปลี่ยนให้หน่อย then switches to it", async () => {
    const harness = createHarness([LUNA_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("มี GPT-6 Luna ไหม", webchat)).toEqual([
      'มี OpenAI: GPT-6 Luna (openai/gpt-6-luna) ในแคตตาล็อก OpenRouter ของบัญชีนี้\nพิมพ์ "เปลี่ยนเป็น openai/gpt-6-luna" ถ้าต้องการใช้',
    ]);
    expect(storedModel()).toEqual(ON_DEEPSEEK);
    harness.reset();

    expect(await harness.ask("เปลี่ยนให้หน่อย", webchat)).toEqual(["เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว"]);
    expect(harness.beforeDispatchCalls).toEqual(CLAIMED_BEFORE_REFERENT);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(storedModel()).toEqual(switchedTo(LUNA_6));
  });

  it("never substitutes an absent version: it offers, and ใช่ confirms", async () => {
    const harness = createHarness([LUNA_5_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("is GPT-6 Luna available", webchat)).toEqual([
      '"GPT-6 Luna" is not in this account\'s OpenRouter catalog\nOther models with similar names (not the one asked for): OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)',
    ]);
    expect(await harness.ask("เปลี่ยนเป็น GPT-6 Luna", webchat)).toEqual([
      'ไม่มี "GPT-6 Luna" ในแคตตาล็อก OpenRouter ของบัญชีนี้ แต่มี OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)\nต้องการเปลี่ยนเป็น OpenAI: GPT-5.6 Luna ไหมครับ?',
    ]);
    expect(storedModel()).toEqual(ON_DEEPSEEK);

    expect(await harness.ask("ใช่", webchat)).toEqual(["เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว"]);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(storedModel()).toEqual(switchedTo(LUNA_5_6));
  });

  it("lists several Luna models as numbered choices; the number completes the switch", async () => {
    const harness = createHarness([LUNA_6, LUNA_5_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);

    expect(await harness.ask("use luna", webchat)).toEqual([
      'Several models match "luna":\n1. OpenAI: GPT-5.6 Luna\n2. OpenAI: GPT-6 Luna\nReply with a number to choose one.',
    ]);
    expect(storedModel()).toEqual(ON_DEEPSEEK);
    harness.reset();

    expect(await harness.ask("2", webchat)).toEqual(["เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว"]);
    // A number is claimed where numbered replies always were: after Cloudbath
    // and the video gates. Cloudbath does not arbitrate webchat turns.
    expect(harness.beforeDispatchCalls).toEqual(FULL_CHAIN);
    expect(harness.replyResolver).not.toHaveBeenCalled();
    expect(storedModel()).toEqual(switchedTo(LUNA_6));
  });

  it.each(["เปลี่ยนเพลงให้หน่อย", "เปลี่ยนสีพื้นหลัง", "ใช้คำนี้แทน", "ช่วยค้นข่าว Luna", "สวัสดีครับ"])(
    "%s is not claimed: the agent answers and no catalog is read",
    async (text) => {
      const harness = createHarness([LUNA_6, DEEPSEEK]);
      await seedDeepSeekSession(SESSION_KEY);

      expect(await harness.ask(text, webchat)).toEqual(["agent reply"]);
      expect(harness.beforeDispatchCalls).toEqual(FULL_CHAIN);
      expect(harness.replyResolver).toHaveBeenCalledOnce();
      expect(harness.requestedUrls).toEqual([]);
      expect(storedModel()).toEqual(ON_DEEPSEEK);
    },
  );

  it("keeps sessions apart: each switch lands only on the session being viewed", async () => {
    const harness = createHarness([LUNA_6, LUNA_5_6, DEEPSEEK]);
    for (const sessionKey of [SESSION_KEY, OTHER_SESSION_KEY, MAIN_SESSION_KEY]) {
      await seedDeepSeekSession(sessionKey);
    }

    await harness.ask("เปลี่ยนเป็น GPT-6 Luna", { ...webchat, sessionKey: OTHER_SESSION_KEY });
    await harness.ask("switch to GPT-5.6 Luna", { ...webchat, sessionKey: MAIN_SESSION_KEY });

    expect(storedModel()).toEqual(ON_DEEPSEEK);
    expect(storedModel(OTHER_SESSION_KEY)).toEqual(switchedTo(LUNA_6));
    expect(storedModel(MAIN_SESSION_KEY)).toEqual(switchedTo(LUNA_5_6));
  });

  it("a follow-up answers only the session and surface that established the model", async () => {
    const harness = createHarness([LUNA_6, DEEPSEEK]);
    await seedDeepSeekSession(SESSION_KEY);
    await seedDeepSeekSession(OTHER_SESSION_KEY);
    await harness.ask("มี GPT-6 Luna ไหม", webchat);

    // Another group's session, and the LINE owner in this one, have no reference.
    expect(await harness.ask("เปลี่ยนให้หน่อย", { ...webchat, sessionKey: OTHER_SESSION_KEY })).toEqual(
      ["agent reply"],
    );
    expect(await harness.ask("เปลี่ยนให้หน่อย")).toEqual(["agent reply"]);
    expect(storedModel(OTHER_SESSION_KEY)).toEqual(ON_DEEPSEEK);

    expect(await harness.ask("เปลี่ยนให้หน่อย", webchat)).toEqual(["เปลี่ยนเป็น OpenAI: GPT-6 Luna แล้ว"]);
    expect(storedModel()).toEqual(switchedTo(LUNA_6));
  });
});
