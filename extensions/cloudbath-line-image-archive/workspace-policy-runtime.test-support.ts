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
import plugin from "./index.js";
import { tryGetCloudbathWorkspacePolicyRuntime } from "./src/workspace-policy-runtime.js";

type StoredValue = { value: unknown; createdAt: number; expiresAt?: number };
type OpenClawPluginHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
export type BeforeDispatchHook = PluginHookHandlerMap["before_dispatch"];
export type BeforeToolCallHook = PluginHookHandlerMap["before_tool_call"];
export type AfterToolCallHook = PluginHookHandlerMap["after_tool_call"];
export type MessageReceivedHook = PluginHookHandlerMap["message_received"];

const CAPABILITY_IDS = [
  "PRODUCT_LIBRARY",
  "CHARACTER_LIBRARY",
  "UGC_PROJECTS",
  "UGC_SHOTS",
  "AI_VIDEO_LIBRARY",
  "AI_IMAGE_LIBRARY",
] as const;
const NOTION_ID_DIGITS = ["1", "2", "3", "4", "5", "6", "a", "b", "c", "d", "e", "f"];

export function createWorkspacePolicyStateRuntime() {
  const namespaces = new Map<string, Map<string, StoredValue>>();
  // Recorded so a test can assert HOW a namespace was opened, not just what it
  // holds: overflow policy decides whether durable history can be evicted.
  const openedStores = new Map<string, OpenKeyedStoreOptions>();
  const openKeyedStore: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"] = <T>(
    options: OpenKeyedStoreOptions,
  ): PluginStateKeyedStore<T> => {
    openedStores.set(options.namespace, options);
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
  return { openKeyedStore, openedStores };
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

export function createWorkspacePolicyServiceContext(
  stateDir = "/test/state",
): OpenClawPluginServiceContext {
  return {
    config: {},
    stateDir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

export function registerWorkspacePolicyPlugin(
  state: ReturnType<typeof createWorkspacePolicyStateRuntime>,
): {
  service: OpenClawPluginService;
  beforeDispatch: BeforeDispatchHook;
  beforeToolCall: BeforeToolCallHook;
  afterToolCall: AfterToolCallHook;
  messageReceived: MessageReceivedHook;
  httpRoute: OpenClawPluginHttpRouteParams;
  /** Every route the plugin registered, so a test can address one by path. */
  httpRoutes: readonly OpenClawPluginHttpRouteParams[];
  routeFor: (pathPrefix: string) => OpenClawPluginHttpRouteParams;
} {
  let service: OpenClawPluginService | undefined;
  let beforeDispatch: BeforeDispatchHook | undefined;
  let beforeToolCall: BeforeToolCallHook | undefined;
  let afterToolCall: AfterToolCallHook | undefined;
  let messageReceived: MessageReceivedHook | undefined;
  const httpRoutes: OpenClawPluginHttpRouteParams[] = [];
  const on: OpenClawPluginApi["on"] = (hookName, handler) => {
    if (hookName === "before_dispatch") {
      beforeDispatch = handler as BeforeDispatchHook;
    } else if (hookName === "before_tool_call") {
      beforeToolCall = handler as BeforeToolCallHook;
    } else if (hookName === "after_tool_call") {
      afterToolCall = handler as AfterToolCallHook;
    } else if (hookName === "message_received") {
      messageReceived = handler as MessageReceivedHook;
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
    registerHttpRoute(next) {
      httpRoutes.push(next);
    },
    on,
  });
  plugin.register?.(api);
  const httpRoute = httpRoutes[0];
  if (
    !service ||
    !beforeDispatch ||
    !beforeToolCall ||
    !afterToolCall ||
    !messageReceived ||
    !httpRoute
  ) {
    throw new Error("Cloudbath plugin did not register its service and workspace hooks");
  }
  // The plugin registers several prefix routes. Addressing one by its path keeps
  // a test from silently retargeting when another route is added.
  const routeFor = (pathPrefix: string): OpenClawPluginHttpRouteParams => {
    const found = httpRoutes.find((route) => route.path === pathPrefix);
    if (!found) {
      throw new Error(`Cloudbath plugin registered no HTTP route at ${pathPrefix}`);
    }
    return found;
  };
  return {
    service,
    beforeDispatch,
    beforeToolCall,
    afterToolCall,
    messageReceived,
    httpRoute,
    httpRoutes,
    routeFor,
  };
}

export function getWorkspacePolicyRuntimeForTest() {
  return tryGetCloudbathWorkspacePolicyRuntime();
}
