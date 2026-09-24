/**
 * OpenRouter account models reach the Control UI picker's `models.list` through
 * the real models.json, model catalog, and visibility pipeline. Only plugin
 * loading is replaced: core discovery receives the real OpenRouter plugin.
 */
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../src/agents/agent-scope.js";
import {
  loadModelCatalogSnapshot,
  resetModelCatalogCacheForTest,
} from "../src/agents/model-catalog.js";
import { resetModelsJsonReadyCacheForTest } from "../src/agents/models-config-state.js";
import { ensureOpenClawModelsJson } from "../src/agents/models-config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { modelsHandlers } from "../src/gateway/server-methods/models.js";
import type { RespondFn } from "../src/gateway/server-methods/types.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const discovery = vi.hoisted(() => ({ providers: [] as ProviderPlugin[] }));

vi.mock("../src/plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/provider-discovery.js")>();
  return {
    ...actual,
    resolveRuntimePluginDiscoveryProviders: async () => discovery.providers,
  };
});
// Catalog augmentation and per-row runtime normalization cold-load every bundled
// provider runtime (minutes under Vitest); neither is under test here.
vi.mock("../src/plugins/provider-runtime.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugins/provider-runtime.runtime.js")>()),
  augmentModelCatalogWithProviderPlugins: async () => [],
}));
vi.mock("../src/plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugins/provider-runtime.js")>()),
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
}));

import openrouterPlugin from "../extensions/openrouter/index.js";

const ACCOUNT_MODELS_URL = "https://openrouter.ai/api/v1/models/user";

// Synthetic /models/user rows. GPT-6 Luna is only the regression fixture: it is
// absent from the bundled OpenRouter catalog and present on the account.
function accountRow(id: string, name: string) {
  return {
    id,
    name,
    context_length: 400_000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.000002", completion: "0.000008" },
    top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
    supported_parameters: ["reasoning", "tools"],
  };
}

const ACCOUNT_ROWS = [
  accountRow("openai/gpt-6-luna", "OpenAI: GPT-6 Luna"),
  accountRow("openai/gpt-5.6-luna", "OpenAI: GPT-5.6 Luna"),
  accountRow("moonshotai/kimi-k2.6", "Account copy of Kimi K2.6"),
];

function stubAccountCatalog(respond: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ACCOUNT_MODELS_URL) {
      throw new Error(`unexpected network request: ${url}`);
    }
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function configWithVisibility(models: Record<string, object>): OpenClawConfig {
  return { agents: { defaults: { models } } } as OpenClawConfig;
}

async function listPickerModels(cfg: OpenClawConfig) {
  const respond = vi.fn();
  const readOnlyRequests: boolean[] = [];
  await modelsHandlers["models.list"]({
    req: { type: "req", id: "req-picker", method: "models.list", params: { view: "configured" } },
    params: { view: "configured" },
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot: async (params?: { readOnly?: boolean }) => {
        readOnlyRequests.push(params?.readOnly === true);
        return await loadModelCatalogSnapshot({ config: cfg, readOnly: params?.readOnly });
      },
      logGateway: { debug: vi.fn() },
    } as never,
  });
  const [ok, payload] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  const refs = (payload as { models: Array<{ provider: string; id: string }> }).models.map(
    (model) => `${model.provider}/${model.id}`,
  );
  return { refs, readOnlyRequests };
}

async function withOpenRouterState<T>(run: () => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-openrouter-account-catalog-",
      agentEnv: "main",
      env: { OPENROUTER_API_KEY: "sk-or-integration" },
    },
    run,
  );
}

describe("OpenRouter account catalog in models.list", () => {
  beforeEach(async () => {
    discovery.providers = [await registerSingleProviderPlugin(openrouterPlugin)];
    clearLiveCatalogCacheForTests();
    resetModelsJsonReadyCacheForTest();
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearLiveCatalogCacheForTests();
    resetModelsJsonReadyCacheForTest();
    resetModelCatalogCacheForTest();
  });

  it("shows a live-only account model when the openrouter/* policy allows it", async () => {
    await withOpenRouterState(async () => {
      const fetchMock = stubAccountCatalog(() => Response.json({ data: ACCOUNT_ROWS, links: {} }));
      const cfg = configWithVisibility({ "openrouter/*": {} });

      const { refs, readOnlyRequests } = await listPickerModels(cfg);

      expect(readOnlyRequests).toEqual([false]);
      expect(refs).toContain("openrouter/openai/gpt-6-luna");
      expect(refs).toContain("openrouter/openai/gpt-5.6-luna");
      expect(refs.filter((ref) => ref === "openrouter/moonshotai/kimi-k2.6")).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(new Headers(request?.headers).get("authorization")).toBe("Bearer sk-or-integration");
    });
  });

  it("keeps a live account model hidden under an exact allowlist that omits it", async () => {
    await withOpenRouterState(async () => {
      stubAccountCatalog(() => Response.json({ data: ACCOUNT_ROWS, links: {} }));
      const cfg = configWithVisibility({ "openrouter/openai/gpt-5.6-luna": {} });
      await ensureOpenClawModelsJson(cfg, resolveDefaultAgentDir(cfg));

      const persisted = await loadModelCatalogSnapshot({ config: cfg, readOnly: true });
      expect(persisted.entries.map((entry) => `${entry.provider}/${entry.id}`)).toContain(
        "openrouter/openai/gpt-6-luna",
      );

      const { refs, readOnlyRequests } = await listPickerModels(cfg);

      expect(readOnlyRequests).toEqual([true]);
      expect(refs).toEqual(["openrouter/openai/gpt-5.6-luna"]);
    });
  });

  it("keeps the static and configured picker rows when the account endpoint fails", async () => {
    await withOpenRouterState(async () => {
      const fetchMock = stubAccountCatalog(() => new Response("unavailable", { status: 503 }));
      const cfg = configWithVisibility({
        "openrouter/*": {},
        "openrouter/openai/gpt-5.6-luna": {},
      });

      const { refs } = await listPickerModels(cfg);

      expect(fetchMock).toHaveBeenCalled();
      expect(refs).toEqual(
        expect.arrayContaining([
          "openrouter/openrouter/auto",
          "openrouter/moonshotai/kimi-k2.6",
          "openrouter/openai/gpt-5.6-luna",
        ]),
      );
      expect(refs).not.toContain("openrouter/openai/gpt-6-luna");
    });
  });

  it("serves repeated picker reads without refetching the account catalog", async () => {
    await withOpenRouterState(async () => {
      const fetchMock = stubAccountCatalog(() => Response.json({ data: ACCOUNT_ROWS, links: {} }));
      const cfg = configWithVisibility({ "openrouter/*": {} });

      for (let read = 0; read < 3; read += 1) {
        const { refs } = await listPickerModels(cfg);
        expect(refs).toContain("openrouter/openai/gpt-6-luna");
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
