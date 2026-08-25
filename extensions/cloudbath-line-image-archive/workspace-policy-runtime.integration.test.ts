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
import {
  createMockPluginRegistry,
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginHookHandlerMap } from "openclaw/plugin-sdk/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { tryGetCloudbathWorkspacePolicyRuntime } from "./src/workspace-policy-runtime.js";

type StoredValue = { value: unknown; createdAt: number; expiresAt?: number };
type BeforeDispatchHook = PluginHookHandlerMap["before_dispatch"];
type BeforeToolCallHook = PluginHookHandlerMap["before_tool_call"];
type AfterToolCallHook = PluginHookHandlerMap["after_tool_call"];

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
  beforeToolCall: BeforeToolCallHook;
  afterToolCall: AfterToolCallHook;
} {
  let service: OpenClawPluginService | undefined;
  let beforeDispatch: BeforeDispatchHook | undefined;
  let beforeToolCall: BeforeToolCallHook | undefined;
  let afterToolCall: AfterToolCallHook | undefined;
  const on: OpenClawPluginApi["on"] = (hookName, handler) => {
    if (hookName === "before_dispatch") {
      beforeDispatch = handler as BeforeDispatchHook;
    } else if (hookName === "before_tool_call") {
      beforeToolCall = handler as BeforeToolCallHook;
    } else if (hookName === "after_tool_call") {
      afterToolCall = handler as AfterToolCallHook;
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
  if (!service || !beforeDispatch || !beforeToolCall || !afterToolCall) {
    throw new Error("Cloudbath plugin did not register its service and workspace hooks");
  }
  return { service, beforeDispatch, beforeToolCall, afterToolCall };
}

function runGlobalPairingHook(hook: BeforeDispatchHook) {
  const registry = createMockPluginRegistry([
    {
      hookName: "before_dispatch",
      handler: hook,
      pluginId: "cloudbath-line-image-archive",
    },
  ]);
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);
  const runner = getGlobalHookRunner();
  if (!runner) {
    throw new Error("Global hook runner did not initialize");
  }
  return runner.runBeforeDispatch(
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
}

const startedServices: OpenClawPluginService[] = [];

beforeEach(() => {
  vi.stubEnv("CLOUDBATH_IMAGE_ARCHIVE_ENABLED", "false");
  vi.stubEnv("CLOUDBATH_IMAGE_ANALYSIS_ENABLED", "false");
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "test-value");
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  for (const service of startedServices.splice(0).toReversed()) {
    await service.stop?.(serviceContext());
  }
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudbath workspace policy runtime across plugin registries", () => {
  it("serves pairing through the global hook owned by an unstarted prewarm registry", async () => {
    const state = createStateRuntime();
    const gateway = registerPlugin(state);
    await gateway.service.start(serviceContext());
    startedServices.push(gateway.service);
    const gatewayRuntime = tryGetCloudbathWorkspacePolicyRuntime();
    expect(gatewayRuntime?.workspaceRegistry).toBeDefined();

    const prewarm = registerPlugin(state);
    const result = await runGlobalPairingHook(prewarm.beforeDispatch);

    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toMatch(/^Pairing code for UGC:/u);
    expect(result?.text).not.toBe("Workspace policy service is unavailable.");
    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(gatewayRuntime);
  });

  it("does not let an unstarted duplicate registry clear the active runtime", async () => {
    const state = createStateRuntime();
    const gateway = registerPlugin(state);
    await gateway.service.start(serviceContext());
    startedServices.push(gateway.service);
    const active = tryGetCloudbathWorkspacePolicyRuntime();

    const prewarm = registerPlugin(state);
    await prewarm.service.stop?.(serviceContext());

    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(active);
  });

  it("resolves UGC tool hooks from the active gateway runtime", async () => {
    const state = createStateRuntime();
    const gateway = registerPlugin(state);
    await gateway.service.start(serviceContext());
    startedServices.push(gateway.service);
    const workflow = tryGetCloudbathWorkspacePolicyRuntime()?.ugcWorkflow;
    if (!workflow) {
      throw new Error("Gateway UGC workflow did not initialize");
    }
    const before = vi
      .spyOn(workflow, "beforeToolCall")
      .mockResolvedValue({ block: true, blockReason: "active-runtime" });
    const after = vi.spyOn(workflow, "afterToolCall").mockResolvedValue();
    const prewarm = registerPlugin(state);

    const beforeResult = await prewarm.beforeToolCall(
      { toolName: "line_video_draft", params: {} },
      { toolName: "line_video_draft", sessionKey: "session-key" },
    );
    await prewarm.afterToolCall(
      { toolName: "line_video_draft", params: {}, result: { ok: true } },
      { toolName: "line_video_draft", sessionKey: "session-key" },
    );

    expect(beforeResult).toEqual({ block: true, blockReason: "active-runtime" });
    expect(before).toHaveBeenCalledWith({
      toolName: "line_video_draft",
      toolParams: {},
      sessionKey: "session-key",
    });
    expect(after).toHaveBeenCalledWith({
      toolName: "line_video_draft",
      result: { ok: true },
      sessionKey: "session-key",
    });
  });

  it("clears the runtime when its owning service stops", async () => {
    const gateway = registerPlugin(createStateRuntime());
    await gateway.service.start(serviceContext());
    expect(tryGetCloudbathWorkspacePolicyRuntime()).not.toBeNull();

    await gateway.service.stop?.(serviceContext());

    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBeNull();
  });

  it("keeps a replacement runtime when the stale service stops", async () => {
    const state = createStateRuntime();
    const first = registerPlugin(state);
    const replacement = registerPlugin(state);
    await first.service.start(serviceContext());
    const firstRuntime = tryGetCloudbathWorkspacePolicyRuntime();
    await replacement.service.start(serviceContext());
    startedServices.push(replacement.service);
    const replacementRuntime = tryGetCloudbathWorkspacePolicyRuntime();

    expect(replacementRuntime).not.toBe(firstRuntime);
    await first.service.stop?.(serviceContext());
    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(replacementRuntime);

    const prewarm = registerPlugin(state);
    const result = await runGlobalPairingHook(prewarm.beforeDispatch);
    expect(result?.text).toMatch(/^Pairing code for UGC:/u);
  });
});
