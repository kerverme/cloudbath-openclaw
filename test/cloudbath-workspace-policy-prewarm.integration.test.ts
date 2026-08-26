import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookHandlerMap } from "openclaw/plugin-sdk/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../extensions/cloudbath-line-image-archive/index.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { addTestHook } from "../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";

type StoredValue = { value: unknown; createdAt: number; expiresAt?: number };
type BeforeDispatchHook = PluginHookHandlerMap["before_dispatch"];

const CAPABILITY_IDS = [
  "PRODUCT_LIBRARY",
  "CHARACTER_LIBRARY",
  "UGC_PROJECTS",
  "UGC_SHOTS",
  "AI_VIDEO_LIBRARY",
  "AI_IMAGE_LIBRARY",
] as const;
const NOTION_ID_DIGITS = ["1", "2", "3", "4", "5", "6", "a", "b", "c", "d", "e", "f"];

function createStateRuntime() {
  const namespaces = new Map<string, Map<string, StoredValue>>();
  const openKeyedStore: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"] = <T>(
    options: OpenKeyedStoreOptions,
  ): PluginStateKeyedStore<T> => {
    let values = namespaces.get(options.namespace);
    if (!values) {
      values = new Map();
      namespaces.set(options.namespace, values);
    }
    const read = (key: string): T | undefined => values.get(key)?.value as T | undefined;
    return {
      async register(key, value, opts) {
        const now = Date.now();
        values.set(key, {
          value,
          createdAt: now,
          ...(opts?.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
        });
      },
      async registerIfAbsent(key, value, opts) {
        if (values.has(key)) {
          return false;
        }
        const now = Date.now();
        values.set(key, {
          value,
          createdAt: now,
          ...(opts?.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
        });
        return true;
      },
      async update(key, updateValue, opts) {
        const next = updateValue(read(key));
        if (next === undefined) {
          return false;
        }
        const now = Date.now();
        values.set(key, {
          value: next,
          createdAt: now,
          ...(opts?.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
        });
        return true;
      },
      async lookup(key) {
        return read(key);
      },
      async consume(key) {
        const value = read(key);
        values.delete(key);
        return value;
      },
      async delete(key) {
        return values.delete(key);
      },
      async entries() {
        return [...values.entries()].map(([key, stored]): PluginStateEntry<T> => {
          const entry: PluginStateEntry<T> = {
            key,
            value: stored.value as T,
            createdAt: stored.createdAt,
          };
          if (stored.expiresAt !== undefined) {
            entry.expiresAt = stored.expiresAt;
          }
          return entry;
        });
      },
      async clear() {
        values.clear();
      },
    };
  };
  return { openKeyedStore };
}

function pluginConfig(): Record<string, unknown> {
  return {
    groupWorkspacePolicies: {
      ugc: {
        capabilities: Object.fromEntries(
          CAPABILITY_IDS.map((id, index) => [
            id,
            {
              databaseId: String(index + 1).repeat(32),
              dataSourceId: NOTION_ID_DIGITS[index + 6]!.repeat(32),
            },
          ]),
        ),
      },
    },
  };
}

function serviceContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    stateDir: "/test/state",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

function registerPlugin(state: ReturnType<typeof createStateRuntime>): {
  service: OpenClawPluginService;
  beforeDispatch: BeforeDispatchHook;
} {
  let service: OpenClawPluginService | undefined;
  let beforeDispatch: BeforeDispatchHook | undefined;
  const on: OpenClawPluginApi["on"] = (hookName, handler) => {
    if (hookName === "before_dispatch") {
      beforeDispatch = handler as BeforeDispatchHook;
    }
  };
  const api = createTestPluginApi({
    id: "cloudbath-line-image-archive",
    name: "Cloudbath LINE Image Archive",
    source: "test",
    pluginConfig: pluginConfig(),
    runtime: {
      state: { openKeyedStore: state.openKeyedStore },
    } as OpenClawPluginApi["runtime"],
    registerService(next) {
      service = next;
    },
    on,
  });
  plugin.register?.(api);
  if (!service || !beforeDispatch) {
    throw new Error("Cloudbath plugin did not register its service and before_dispatch hook");
  }
  return { service, beforeDispatch };
}

let startedService: OpenClawPluginService | undefined;

beforeEach(() => {
  vi.stubEnv("CLOUDBATH_IMAGE_ARCHIVE_ENABLED", "false");
  vi.stubEnv("CLOUDBATH_IMAGE_ANALYSIS_ENABLED", "false");
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "test-value");
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  await startedService?.stop?.(serviceContext());
  startedService = undefined;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudbath global workspace policy hook across plugin registries", () => {
  it("serves pairing through the global hook owned by an unstarted prewarm registry", async () => {
    const state = createStateRuntime();
    const gateway = registerPlugin(state);
    await gateway.service.start(serviceContext());
    startedService = gateway.service;

    const prewarm = registerPlugin(state);
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      hookName: "before_dispatch",
      handler: prewarm.beforeDispatch,
      pluginId: "cloudbath-line-image-archive",
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const runner = getGlobalHookRunner();
    if (!runner) {
      throw new Error("Global hook runner did not initialize");
    }

    const result = await runner.runBeforeDispatch(
      {
        content: "สร้าง pairing UGC",
        senderId: "owner-user",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "Cpilotgroup",
        sessionKey: "agent:main:line:group:Cpilotgroup",
      },
    );

    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toMatch(/^Pairing code for UGC:/u);
    expect(result?.text).not.toBe("Workspace policy service is unavailable.");
  });
});
