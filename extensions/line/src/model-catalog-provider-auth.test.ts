/**
 * Latent-bug regression for openrouter_account_models.
 *
 * The AI-facing registration in extensions/line/index.ts used to inject
 * ctx.resolveApiKeyForProvider, the same narrow auth-profile-only resolver that
 * broke the LINE video draft in production (see video-draft-provider-auth.test.ts).
 * It was not user-visible only because the deterministic before_dispatch router
 * injects its own canonical resolver. These tests pin the AI-facing tool to the
 * shared canonical path so the latent failure cannot resurface, and pin the
 * switch semantics that must NOT change as a result.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Swappable canonical-resolver result; mirrors env/config/profile resolution. */
let providerAuthResult: { apiKey?: string } = { apiKey: "sk-openrouter-canonical" };
const resolveApiKeyForProviderMock = vi.fn(async () => providerAuthResult);

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: (...args: unknown[]) => resolveApiKeyForProviderMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => ({}) }));

const { createLineModelCatalogTool, LINE_MODEL_SELECTION_TTL_MS } =
  await import("./model-catalog-tool.js");
import type { LinePendingModelSelection } from "./model-catalog-tool.js";

function createMemoryPendingStore(): PluginStateKeyedStore<LinePendingModelSelection> {
  const values = new Map<string, { value: LinePendingModelSelection; createdAt: number }>();
  return {
    async register(key, value) {
      values.set(key, { value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      }));
    },
    async clear() {
      values.clear();
    },
  };
}

const CATALOG = [
  { id: "openai/gpt-5.6-luna-pro", name: "OpenAI: GPT-5.6 Luna Pro" },
  { id: "anthropic/claude-opus-4", name: "Anthropic: Claude Opus 4" },
  { id: "deepseek/deepseek-v4-01", name: "DeepSeek V4 01" },
  { id: "deepseek/deepseek-v4-02", name: "DeepSeek V4 02" },
];

/**
 * Builds the tool exactly as index.ts builds it for a real owner LINE turn:
 * NO resolveApiKey injection, so the canonical resolver is what runs.
 */
function buildProductionOwnerCatalogTool(applySessionModel = vi.fn(async () => true)) {
  const requestedAuthHeaders: Array<string | null> = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requestedAuthHeaders.push(headers.get("authorization"));
    return new Response(JSON.stringify({ data: CATALOG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const tool = createLineModelCatalogTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId: "U-owner-real",
    sessionId: "line:grp-real",
    pendingStore: createMemoryPendingStore(),
    applySessionModel,
    fetchImpl,
  });

  return { tool, applySessionModel, requestedAuthHeaders };
}

beforeEach(() => {
  providerAuthResult = { apiKey: "sk-openrouter-canonical" };
  resolveApiKeyForProviderMock.mockClear();
});

describe("openrouter_account_models: canonical OpenRouter auth", () => {
  it("1: resolves credentials without any ctx resolver and lists the account catalog", async () => {
    const { tool, requestedAuthHeaders } = buildProductionOwnerCatalogTool();
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", { action: "search", query: "deepseek" });
    const text = JSON.stringify(result);

    expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
    expect(resolveApiKeyForProviderMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
    });
    // The canonical key actually reached the OpenRouter request.
    expect(requestedAuthHeaders[0]).toBe("Bearer sk-openrouter-canonical");
    expect(text).toContain("deepseek");
  });

  it("2: still works when the narrow ctx resolver would have returned undefined", async () => {
    // Production shape: no authProfileStore, so ctx.resolveApiKeyForProvider is
    // absent entirely and the old wiring resolved to undefined.
    const contextWithoutAuthProfileStore: {
      resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
    } = {};
    await expect(
      contextWithoutAuthProfileStore.resolveApiKeyForProvider?.("openrouter") ??
        Promise.resolve(undefined),
    ).resolves.toBeUndefined();

    const { tool } = buildProductionOwnerCatalogTool();
    const result = await tool!.execute("call-1", { action: "search", query: "claude opus 4" });

    expect(JSON.stringify(result)).toContain("anthropic/claude-opus-4");
  });

  it("3: an explicit injected resolver still wins, so router semantics are unchanged", async () => {
    const injected = vi.fn(async () => "sk-router-injected");
    const requestedAuthHeaders: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requestedAuthHeaders.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: CATALOG }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tool = createLineModelCatalogTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: "U-owner-real",
      sessionId: "line:grp-real",
      pendingStore: createMemoryPendingStore(),
      applySessionModel: vi.fn(async () => true),
      resolveApiKey: injected,
      fetchImpl,
    });
    await tool!.execute("call-1", { action: "search", query: "deepseek" });

    expect(injected).toHaveBeenCalledWith("openrouter");
    expect(requestedAuthHeaders[0]).toBe("Bearer sk-router-injected");
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });
});

describe("openrouter_account_models: switch semantics unchanged", () => {
  it("4: an ambiguous search creates a pending selection and switches nothing", async () => {
    const { tool, applySessionModel } = buildProductionOwnerCatalogTool();

    const result = await tool!.execute("call-1", { action: "search", query: "deepseek" });
    const payload = JSON.stringify(result);

    // Two deepseek entries match, so the user must still choose explicitly.
    expect(payload).toContain("pendingSelection");
    expect(payload).toContain("DeepSeek V4 01");
    expect(applySessionModel).not.toHaveBeenCalled();
  });

  it("5: a switch happens only through the existing explicit selection flow", async () => {
    const { tool, applySessionModel } = buildProductionOwnerCatalogTool();

    await tool!.execute("call-1", { action: "search", query: "deepseek" });
    expect(applySessionModel).not.toHaveBeenCalled();

    await tool!.execute("call-2", { action: "select", selection: 1 });

    expect(applySessionModel).toHaveBeenCalledOnce();
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deepseek/deepseek-v4-01" }),
    );
  });

  it("6: a unique exact match still switches directly, as before", async () => {
    const { tool, applySessionModel } = buildProductionOwnerCatalogTool();

    await tool!.execute("call-1", { action: "search", query: "Anthropic: Claude Opus 4" });

    expect(applySessionModel).toHaveBeenCalledOnce();
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "anthropic/claude-opus-4" }),
    );
  });

  it("7: missing provider credentials switch nothing", async () => {
    providerAuthResult = {};
    const { tool, applySessionModel } = buildProductionOwnerCatalogTool();

    // Pre-existing behavior, unchanged here: the catalog tool throws rather
    // than returning a resolution when no credential is available.
    await expect(
      tool!.execute("call-1", { action: "search", query: "Anthropic: Claude Opus 4" }),
    ).rejects.toThrow("OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE");
    expect(applySessionModel).not.toHaveBeenCalled();
  });
});

describe("openrouter_account_models: owner-only behavior unchanged", () => {
  it("8: a non-owner never gets the tool", () => {
    expect(createLineModelCatalogTool({ messageChannel: "line", senderIsOwner: false })).toBeNull();
  });

  it("9: a non-LINE channel never gets the tool", () => {
    expect(
      createLineModelCatalogTool({ messageChannel: "telegram", senderIsOwner: true }),
    ).toBeNull();
  });

  it("10: the selection TTL contract is untouched", () => {
    expect(LINE_MODEL_SELECTION_TTL_MS).toBeGreaterThan(0);
  });
});
