import { describe, expect, it, vi } from "vitest";
import {
  createLineModelCatalogTool,
  LINE_MODEL_CATALOG_TOOL_NAME,
  loadOpenRouterAccountModels,
} from "./model-catalog-tool.js";

const SECRET = "test-secret-never-log";

function catalogResponse() {
  return new Response(
    JSON.stringify({
      data: [
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
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function ownerTool(fetchImpl = vi.fn(async () => catalogResponse())) {
  return createLineModelCatalogTool({
    messageChannel: "line",
    senderIsOwner: true,
    resolveApiKey: async () => SECRET,
    fetchImpl,
  });
}

function readJsonResult(
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof ownerTool>>["execute"]>>,
) {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("missing JSON tool result");
  }
  return JSON.parse(first.text) as {
    source: string;
    authoritativeForCandidateIds: boolean;
    currentModelAuthoritativeSource: string;
    totalMatches: number;
    models: Array<{ id: string; ref: string; name: string; supportsTools?: boolean }>;
  };
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
    const data = readJsonResult(await tool!.execute("catalog", { query: "luna pro" }));

    expect(data.source).toBe("openrouter-user-account");
    expect(data.authoritativeForCandidateIds).toBe(true);
    expect(data.currentModelAuthoritativeSource).toBe("session_status");
    expect(data.models).toEqual([
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
    const data = readJsonResult(await tool!.execute("catalog", { query }));
    expect(data.models).toContainEqual(expect.objectContaining({ id, ref: `openrouter/${id}` }));
  });

  it("never exposes the credential in sanitized provider errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const tool = ownerTool(fetchImpl);
    let message = "";
    try {
      await tool!.execute("catalog", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("OPENROUTER_ACCOUNT_CATALOG_HTTP_403");
    expect(message).not.toContain(SECRET);
  });

  it("fails safely when authenticated OpenRouter access is unavailable", async () => {
    const tool = createLineModelCatalogTool({
      messageChannel: "line",
      senderIsOwner: true,
      resolveApiKey: async () => undefined,
    });
    await expect(tool!.execute("catalog", {})).rejects.toThrow(
      "OPENROUTER_ACCOUNT_CATALOG_AUTH_UNAVAILABLE",
    );
  });

  it("does not turn human wording into a model ID", async () => {
    const tool = ownerTool();
    const data = readJsonResult(
      await tool!.execute("catalog", { query: "please invent my imaginary model" }),
    );
    expect(data.totalMatches).toBe(0);
    expect(data.models).toEqual([]);
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
