// Openrouter tests cover account catalog discovery and row projection.
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenrouterAccountProvider,
  projectOpenRouterAccountModel,
} from "./account-catalog.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";

// Synthetic /models/user rows shaped like the authenticated account response.
const GPT_6_LUNA_ROW = {
  id: "openai/gpt-6-luna",
  name: "OpenAI: GPT-6 Luna",
  context_length: 400_000,
  architecture: {
    modality: "text+image+file->text",
    input_modalities: ["text", "image", "file"],
    output_modalities: ["text"],
  },
  pricing: {
    prompt: "0.000002",
    completion: "0.000008",
    input_cache_read: "0.0000005",
  },
  top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
  supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "tool_choice", "tools"],
};

const IMAGE_ONLY_ROW = {
  id: "openai/gpt-image-2",
  name: "OpenAI: GPT Image 2",
  architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
  supported_parameters: ["max_tokens"],
};

const STATIC_COLLISION_ROW = {
  id: "moonshotai/kimi-k2.6",
  name: "Account copy of Kimi",
  context_length: 1_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools"],
};

function accountResponse(rows: readonly unknown[]) {
  return Response.json({ data: rows, links: {}, total_count: rows.length });
}

function createFetchGuard(respond: () => Response | Promise<Response>) {
  return vi.fn<LiveModelCatalogFetchGuard>(async (params) => ({
    response: await respond(),
    finalUrl: params.url,
    release: async () => undefined,
  }));
}

function requireModel<T extends { id: string }>(models: readonly T[], id: string): T {
  const model = models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`expected model ${id}`);
  }
  return model;
}

describe("OpenRouter account catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("reads the authenticated account endpoint, not the public model list", async () => {
    const fetchGuard = createFetchGuard(() => accountResponse([GPT_6_LUNA_ROW]));

    await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });

    const request = fetchGuard.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://openrouter.ai/api/v1/models/user");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-or-account");
  });

  it("authenticates with the resolved secret while keeping the provider's key marker", async () => {
    const fetchGuard = createFetchGuard(() => accountResponse([GPT_6_LUNA_ROW]));

    const provider = await buildOpenrouterAccountProvider({
      apiKey: "OPENROUTER_API_KEY",
      discoveryApiKey: "sk-or-resolved",
      fetchGuard,
    });

    const headers = new Headers(fetchGuard.mock.calls[0]?.[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-or-resolved");
    expect(provider.apiKey).toBe("OPENROUTER_API_KEY");
  });

  it("adds live-only account models to the static catalog", async () => {
    const provider = await buildOpenrouterAccountProvider({
      apiKey: "sk-or-account",
      fetchGuard: createFetchGuard(() => accountResponse([GPT_6_LUNA_ROW])),
    });

    const staticIds = buildOpenrouterProvider().models.map((model) => model.id);
    expect(staticIds).not.toContain("openai/gpt-6-luna");
    expect(provider.models.map((model) => model.id)).toEqual([...staticIds, "openai/gpt-6-luna"]);
    expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider.api).toBe("openai-completions");
  });

  it("maps architecture, parameters, pricing, and limits into the model row", () => {
    const model = projectOpenRouterAccountModel(GPT_6_LUNA_ROW);

    expect(model).toMatchObject({
      id: "openai/gpt-6-luna",
      name: "OpenAI: GPT-6 Luna",
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsTools: true },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(model?.cost.input).toBeCloseTo(2);
    expect(model?.cost.output).toBeCloseTo(8);
    expect(model?.cost.cacheRead).toBeCloseTo(0.5);
    expect(model?.cost.cacheWrite).toBe(0);
  });

  it("falls back from missing top-provider limits and reads the legacy modality string", () => {
    const model = projectOpenRouterAccountModel({
      id: "example/text-only",
      context_length: 32_768,
      architecture: { modality: "text->text" },
      pricing: { prompt: "-1", completion: "-1" },
    });

    expect(model).toEqual({
      id: "example/text-only",
      name: "example/text-only",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: 8192,
    });
  });

  it("marks tools unsupported only when the row lists its parameters", () => {
    expect(
      projectOpenRouterAccountModel({
        ...GPT_6_LUNA_ROW,
        supported_parameters: ["max_tokens"],
      })?.compat,
    ).toEqual({ supportsTools: false });
    expect(
      projectOpenRouterAccountModel({ ...GPT_6_LUNA_ROW, supported_parameters: undefined })?.compat,
    ).toBeUndefined();
  });

  it("skips models that cannot produce text", async () => {
    expect(projectOpenRouterAccountModel(IMAGE_ONLY_ROW)).toBeUndefined();
    expect(projectOpenRouterAccountModel({ id: "example/no-architecture" })).toBeUndefined();

    const provider = await buildOpenrouterAccountProvider({
      apiKey: "sk-or-account",
      fetchGuard: createFetchGuard(() => accountResponse([IMAGE_ONLY_ROW, GPT_6_LUNA_ROW])),
    });
    expect(provider.models.map((model) => model.id)).not.toContain("openai/gpt-image-2");
  });

  it("keeps one row with static metadata when the account also lists a static model", async () => {
    const provider = await buildOpenrouterAccountProvider({
      apiKey: "sk-or-account",
      fetchGuard: createFetchGuard(() =>
        accountResponse([STATIC_COLLISION_ROW, GPT_6_LUNA_ROW, GPT_6_LUNA_ROW]),
      ),
    });

    const ids = provider.models.map((model) => model.id);
    expect(ids.filter((id) => id === "moonshotai/kimi-k2.6")).toHaveLength(1);
    expect(ids.filter((id) => id === "openai/gpt-6-luna")).toHaveLength(1);
    expect(requireModel(provider.models, "moonshotai/kimi-k2.6")).toEqual(
      requireModel(buildOpenrouterProvider().models, "moonshotai/kimi-k2.6"),
    );
  });

  it("orders account models by id so the persisted catalog does not churn", async () => {
    const provider = await buildOpenrouterAccountProvider({
      apiKey: "sk-or-account",
      fetchGuard: createFetchGuard(() =>
        accountResponse([
          { ...GPT_6_LUNA_ROW, id: "zeta/model" },
          { ...GPT_6_LUNA_ROW, id: "alpha/model" },
        ]),
      ),
    });

    expect(provider.models.slice(-2).map((model) => model.id)).toEqual([
      "alpha/model",
      "zeta/model",
    ]);
  });

  it.each([
    ["an HTTP error", () => new Response("unauthorized", { status: 401 })],
    ["an unexpected body", () => Response.json({ models: [] })],
    [
      "a network failure",
      () => {
        throw new Error("socket hang up");
      },
    ],
  ])("returns the static catalog after %s", async (_label, respond) => {
    const provider = await buildOpenrouterAccountProvider({
      apiKey: "sk-or-account",
      fetchGuard: createFetchGuard(respond),
    });

    expect(provider).toEqual({ ...buildOpenrouterProvider(), apiKey: "sk-or-account" });
  });

  it("retries after a failed discovery instead of caching the failure", async () => {
    let attempt = 0;
    const fetchGuard = createFetchGuard(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("unavailable", { status: 503 })
        : accountResponse([GPT_6_LUNA_ROW]);
    });

    await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });
    const provider = await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(provider.models.map((model) => model.id)).toContain("openai/gpt-6-luna");
  });

  it("serves repeated reads from the TTL cache, scoped by credential", async () => {
    const fetchGuard = createFetchGuard(() => accountResponse([GPT_6_LUNA_ROW]));

    await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });
    await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });
    await buildOpenrouterAccountProvider({ apiKey: "sk-or-account", fetchGuard });
    expect(fetchGuard).toHaveBeenCalledTimes(1);

    await buildOpenrouterAccountProvider({ apiKey: "sk-or-other-account", fetchGuard });
    expect(fetchGuard).toHaveBeenCalledTimes(2);
  });
});
