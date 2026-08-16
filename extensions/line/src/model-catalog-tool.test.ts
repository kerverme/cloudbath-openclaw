import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createLineModelCatalogTool,
  type LinePendingModelSelection,
  LINE_MODEL_CATALOG_TOOL_NAME,
  LINE_MODEL_SELECTION_TTL_MS,
  loadOpenRouterAccountModels,
} from "./model-catalog-tool.js";

const SECRET = "test-secret-never-log";

type CatalogFixture = {
  id: string;
  name: string;
  supported_parameters?: string[];
};

function catalogResponse(data: CatalogFixture[] = defaultCatalog()) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultCatalog(): CatalogFixture[] {
  return [
    {
      id: "openai/gpt-5.6-luna-pro",
      name: "OpenAI: GPT-5.6 Luna Pro",
      supported_parameters: ["tools"],
    },
    { id: "anthropic/claude-opus-4", name: "Anthropic: Claude Opus 4" },
    { id: "google/gemini-flash", name: "Google: Gemini Flash" },
    { id: "x-ai/grok-4", name: "xAI: Grok 4" },
    { id: "future-labs/nebulon-x", name: "Future Labs: Nebulon X" },
    { id: "invalid raw text", name: "Invalid" },
  ];
}

function deepSeekCatalog(count: number): CatalogFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = String(index + 1).padStart(2, "0");
    return {
      id: `deepseek/deepseek-v4-${sequence}`,
      name: `DeepSeek V4 ${sequence}`,
    };
  });
}

function createMemoryPendingStore(params?: {
  now?: () => number;
}): PluginStateKeyedStore<LinePendingModelSelection> {
  const now = params?.now ?? Date.now;
  const values = new Map<
    string,
    { value: LinePendingModelSelection; createdAt: number; expiresAt: number }
  >();
  const read = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async register(key, value, options) {
      const createdAt = now();
      values.set(key, {
        value,
        createdAt,
        expiresAt: createdAt + (options?.ttlMs ?? LINE_MODEL_SELECTION_TTL_MS),
      });
    },
    async registerIfAbsent(key, value, options) {
      if (read(key)) {
        return false;
      }
      await this.register(key, value, options);
      return true;
    },
    async lookup(key) {
      return read(key)?.value;
    },
    async consume(key) {
      const value = read(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.keys()].flatMap((key) => {
        const entry = read(key);
        return entry ? [{ key, ...entry }] : [];
      });
    },
    async clear() {
      values.clear();
    },
  };
}

type ToolParams = Parameters<typeof createLineModelCatalogTool>[0];

function ownerTool(overrides: Partial<ToolParams> = {}) {
  return createLineModelCatalogTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: "owner-1",
    sessionId: "session-a",
    pendingStore: createMemoryPendingStore(),
    resolveApiKey: async () => SECRET,
    fetchImpl: vi.fn(async () => catalogResponse()),
    ...overrides,
  });
}

function readJsonResult(
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof ownerTool>>["execute"]>>,
): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("missing JSON tool result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function readModels(data: Record<string, unknown>) {
  return data.models as Array<{
    id?: string;
    ref?: string;
    name: string;
    selection?: number;
    supportsTools?: boolean;
  }>;
}

describe("LINE OpenRouter account catalog adapter", () => {
  it("is available only for a trusted LINE owner", () => {
    expect(
      createLineModelCatalogTool({
        messageChannel: "line",
        senderIsOwner: false,
      }),
    ).toBeNull();
    expect(
      createLineModelCatalogTool({
        messageChannel: "telegram",
        senderIsOwner: true,
      }),
    ).toBeNull();
    expect(ownerTool()?.name).toBe(LINE_MODEL_CATALOG_TOOL_NAME);
  });

  it("returns only canonical account-catalog IDs and applies openrouter once", async () => {
    const tool = ownerTool();
    expect(tool).not.toBeNull();
    const data = readJsonResult(
      await tool!.execute("catalog", { action: "search", query: "luna pro" }),
    );

    expect(data).toMatchObject({
      source: "openrouter-user-account",
      authoritativeForCandidateIds: true,
      currentModelAuthoritativeSource: "session_status",
      resolution: "exact",
      pendingSelection: false,
      totalMatches: 1,
    });
    expect(readModels(data)).toEqual([
      expect.objectContaining({
        id: "openai/gpt-5.6-luna-pro",
        ref: "openrouter/openai/gpt-5.6-luna-pro",
        supportsTools: true,
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain("openrouter/openrouter/");
  });

  it.each([
    ["Claude", "anthropic/claude-opus-4"],
    ["Gemini", "google/gemini-flash"],
    ["Grok", "x-ai/grok-4"],
    ["an unseen future family", "future-labs/nebulon-x"],
  ])("discovers %s without provider-specific resolver code", async (_label, id) => {
    const tool = ownerTool();
    const query = id.split("/").at(-1)!.replaceAll("-", " ");
    const data = readJsonResult(await tool!.execute("catalog", { action: "search", query }));
    expect(readModels(data)).toContainEqual(
      expect.objectContaining({ id, ref: `openrouter/${id}` }),
    );
  });

  it("stores multiple matches and returns a bounded numbered page with an honest total", async () => {
    const tool = ownerTool({
      fetchImpl: vi.fn(async () => catalogResponse(deepSeekCatalog(11))),
    });
    const data = readJsonResult(
      await tool!.execute("catalog", { action: "search", query: "DeepSeek", limit: 4 }),
    );

    expect(data).toMatchObject({
      resolution: "choices",
      pendingSelection: true,
      totalMatches: 11,
      displayedCount: 4,
      displayedFrom: 1,
      displayedTo: 4,
      nextOffset: 4,
      pendingSelectionTtlMs: LINE_MODEL_SELECTION_TTL_MS,
    });
    expect(readModels(data).map((model) => model.selection)).toEqual([1, 2, 3, 4]);
    expect(
      readModels(data).every((model) => model.id === undefined && model.ref === undefined),
    ).toBe(true);
  });

  it("revalidates a numbered choice and clears it only after the verified switch completes", async () => {
    const fetchImpl = vi.fn(async () => catalogResponse(deepSeekCatalog(3)));
    const pendingStore = createMemoryPendingStore();
    const tool = ownerTool({ fetchImpl, pendingStore });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });

    const selected = readJsonResult(
      await tool!.execute("catalog", { action: "select", selection: 2 }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(selected).toMatchObject({
      resolution: "selected",
      pendingSelection: true,
      pendingCompletionAfterVerifiedSwitch: true,
      freshCatalogValidated: true,
      model: {
        id: "deepseek/deepseek-v4-02",
        ref: "openrouter/deepseek/deepseek-v4-02",
      },
    });
    expect(await pendingStore.entries()).toHaveLength(1);

    const completed = readJsonResult(await tool!.execute("catalog", { action: "complete" }));
    expect(completed).toEqual({ resolution: "completed", pendingSelection: false });
    expect(await pendingStore.entries()).toHaveLength(0);
  });

  it("keeps a freshly validated choice pending when the native switch is not completed", async () => {
    const pendingStore = createMemoryPendingStore();
    const tool = ownerTool({
      pendingStore,
      fetchImpl: vi.fn(async () => catalogResponse(deepSeekCatalog(3))),
    });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });
    await tool!.execute("catalog", { action: "select", selection: 2 });

    expect(await pendingStore.entries()).toHaveLength(1);
    expect(
      readJsonResult(await tool!.execute("catalog", { action: "page", offset: 0 })),
    ).toMatchObject({ resolution: "choices", pendingSelection: true });
    expect(readJsonResult(await tool!.execute("catalog", { action: "complete" }))).toEqual({
      resolution: "completion_not_ready",
      pendingSelection: true,
    });
  });

  it("keeps an invalid numbered selection pending without fabricating a model", async () => {
    const fetchImpl = vi.fn(async () => catalogResponse(deepSeekCatalog(5)));
    const tool = ownerTool({ fetchImpl });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });

    const data = readJsonResult(
      await tool!.execute("catalog", { action: "select", selection: 99 }),
    );

    expect(data).toMatchObject({
      resolution: "invalid_selection",
      pendingSelection: true,
      validSelectionRange: [1, 5],
    });
    expect(data).not.toHaveProperty("model");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a number as non-control when that session has no pending selection", async () => {
    const resolveApiKey = vi.fn(async () => SECRET);
    const tool = ownerTool({ resolveApiKey });
    const data = readJsonResult(await tool!.execute("catalog", { action: "select", selection: 2 }));

    expect(data).toEqual({ resolution: "no_pending", pendingSelection: false });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("isolates pending choices by both LINE session and owner", async () => {
    const pendingStore = createMemoryPendingStore();
    const fetchImpl = vi.fn(async () => catalogResponse(deepSeekCatalog(3)));
    const sessionA = ownerTool({ pendingStore, fetchImpl, sessionId: "session-a" });
    const sessionB = ownerTool({ pendingStore, fetchImpl, sessionId: "session-b" });
    const otherOwner = ownerTool({
      pendingStore,
      fetchImpl,
      sessionId: "session-a",
      requesterSenderId: "owner-2",
    });
    await sessionA!.execute("catalog", { action: "search", query: "DeepSeek" });

    expect(
      readJsonResult(await sessionB!.execute("catalog", { action: "select", selection: 1 })),
    ).toEqual({ resolution: "no_pending", pendingSelection: false });
    expect(
      readJsonResult(await otherOwner!.execute("catalog", { action: "select", selection: 1 })),
    ).toEqual({ resolution: "no_pending", pendingSelection: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a remembered candidate that disappeared from the fresh account catalog", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(catalogResponse(deepSeekCatalog(3)))
      .mockResolvedValueOnce(catalogResponse(deepSeekCatalog(1)));
    const tool = ownerTool({ fetchImpl });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });

    const data = readJsonResult(await tool!.execute("catalog", { action: "select", selection: 2 }));

    expect(data).toEqual({
      resolution: "stale_selection",
      pendingSelection: false,
      selectedModelStillAvailable: false,
      freshCatalogValidated: true,
    });
    expect(data).not.toHaveProperty("model");
  });

  it("expires pending choices after ten minutes", async () => {
    let now = 1_000;
    const pendingStore = createMemoryPendingStore({ now: () => now });
    const fetchImpl = vi.fn(async () => catalogResponse(deepSeekCatalog(3)));
    const tool = ownerTool({ pendingStore, fetchImpl, now: () => now });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });
    now += LINE_MODEL_SELECTION_TTL_MS + 1;

    expect(
      readJsonResult(await tool!.execute("catalog", { action: "select", selection: 1 })),
    ).toEqual({ resolution: "no_pending", pendingSelection: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("supports cancellation and a new search replacing an old picker", async () => {
    const pendingStore = createMemoryPendingStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(catalogResponse(deepSeekCatalog(3)))
      .mockResolvedValueOnce(
        catalogResponse([
          { id: "google/gemini-flash", name: "Gemini Flash" },
          { id: "google/gemini-pro", name: "Gemini Pro" },
        ]),
      );
    const tool = ownerTool({ pendingStore, fetchImpl });
    await tool!.execute("catalog", { action: "search", query: "DeepSeek" });
    const replacement = readJsonResult(
      await tool!.execute("catalog", { action: "search", query: "Gemini" }),
    );
    expect(replacement).toMatchObject({ resolution: "choices", query: "gemini" });

    const cancelled = readJsonResult(await tool!.execute("catalog", { action: "cancel" }));
    expect(cancelled).toEqual({
      resolution: "cancelled",
      pendingSelection: false,
      cleared: true,
    });
    expect(await pendingStore.entries()).toHaveLength(0);
  });

  it("paginates large match sets without claiming the displayed page is the total", async () => {
    const tool = ownerTool({
      fetchImpl: vi.fn(async () => catalogResponse(deepSeekCatalog(23))),
    });
    const first = readJsonResult(
      await tool!.execute("catalog", { action: "search", query: "DeepSeek", limit: 8 }),
    );
    expect(first).toMatchObject({ totalMatches: 23, displayedCount: 8, nextOffset: 8 });

    const second = readJsonResult(await tool!.execute("catalog", { action: "page", offset: 8 }));
    expect(second).toMatchObject({
      totalMatches: 23,
      displayedCount: 8,
      displayedFrom: 9,
      displayedTo: 16,
      previousOffset: 0,
      nextOffset: 16,
    });
    expect(readModels(second).map((model) => model.selection)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it("never exposes the credential in sanitized provider errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const tool = ownerTool({ fetchImpl });
    let message = "";
    try {
      await tool!.execute("catalog", { action: "search" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("OPENROUTER_ACCOUNT_CATALOG_HTTP_403");
    expect(message).not.toContain(SECRET);
  });

  it("fails safely when authenticated OpenRouter access is unavailable", async () => {
    const tool = ownerTool({ resolveApiKey: async () => undefined });
    await expect(tool!.execute("catalog", { action: "search" })).rejects.toThrow(
      "OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE",
    );
  });

  it("does not turn human wording into a model ID", async () => {
    const tool = ownerTool();
    const data = readJsonResult(
      await tool!.execute("catalog", {
        action: "search",
        query: "please invent my imaginary model",
      }),
    );
    expect(data).toMatchObject({ resolution: "no_match", totalMatches: 0, models: [] });
  });
});

describe("OpenRouter account catalog transport", () => {
  it("uses the authenticated account endpoint and never returns raw authorization data", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${SECRET}` }));
      return catalogResponse();
    });
    const models = await loadOpenRouterAccountModels({ apiKey: SECRET, fetchImpl });
    expect(models).toContainEqual(
      expect.objectContaining({
        id: "future-labs/nebulon-x",
        ref: "openrouter/future-labs/nebulon-x",
      }),
    );
    expect(JSON.stringify(models)).not.toContain(SECRET);
  });
});
