import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  applyLineNaturalModelSwitch,
  formatLineNaturalModelSwitchResult,
  isLineNaturalModelControlLike,
  loadOpenRouterUserModelCatalog,
  parseLineNaturalModelIntent,
  resolveAuthorizedLineNaturalModelAction,
  resolveLineNaturalLanguageModelAction,
  toOpenClawOpenRouterRef,
  type LineNaturalModelSessionStore,
  type OpenRouterCatalogCandidate,
  type OpenRouterUserModel,
} from "./natural-language-model.js";

const DEFAULT_MODEL = "openrouter/openai/gpt-5.6-luna";
const CFG: OpenClawConfig = {
  agents: { defaults: { model: { primary: DEFAULT_MODEL } } },
  channels: { line: { allowFrom: ["*"] } },
  commands: { ownerAllowFrom: ["owner-user"] },
};

const MODELS: OpenRouterUserModel[] = [
  { id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna", supportsTools: true },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Anthropic: Claude Sonnet 4.6",
    supportsTools: true,
  },
  {
    id: "anthropic/claude-sonnet-4-7",
    name: "Anthropic: Claude Sonnet 4.7",
    supportsTools: true,
  },
  { id: "google/gemini-3-pro", name: "Google: Gemini 3 Pro", supportsTools: true },
  { id: "future-labs/nebulon-x", name: "Future Labs: Nebulon X", supportsTools: true },
  { id: "text-labs/plain-chat", name: "Text Labs: Plain Chat", supportsTools: false },
];

const loadCatalog = vi.fn(async () => MODELS);

function lineContext(senderId: string) {
  return {
    Surface: "line",
    Provider: "line",
    OriginatingChannel: "line",
    AccountId: "default",
    SenderId: senderId,
    From: "line:group:pilot",
    To: "line:group:pilot",
    ChatType: "group",
  };
}

function candidate(id = "future-labs/nebulon-x"): OpenRouterCatalogCandidate {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) {
    throw new Error("missing fixture");
  }
  return {
    ...model,
    ref: `openrouter/${model.id}`,
    score: 200,
    source: "openrouter-user-catalog",
  };
}

function memoryStore(initial: SessionEntry): {
  adapter: LineNaturalModelSessionStore;
  current: () => SessionEntry;
} {
  const entry = structuredClone(initial);
  return {
    adapter: {
      read: async () => structuredClone(entry),
      update: async (_path, _key, mutate) => {
        mutate(entry);
        return structuredClone(entry);
      },
    },
    current: () => structuredClone(entry),
  };
}

describe("authoritative OpenRouter user catalog", () => {
  it("loads only exact IDs from the authenticated user-visible endpoint", async () => {
    const secret = "unit-openrouter-secret";
    let requestUrl = "";
    let authorization = "";
    const models = await loadOpenRouterUserModelCatalog(CFG, undefined, {
      resolveAuth: vi.fn(async () => ({
        apiKey: secret,
        source: "unit-test",
        mode: "api-key" as const,
      })),
      fetchImpl: vi.fn(async (input, init) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "future-labs/nebulon-x",
                name: "Future Labs: Nebulon X",
                supported_parameters: ["tools"],
              },
              { id: "human phrase", name: "invalid" },
              { id: "openrouter/fabricated/extra", name: "invalid" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });

    expect(requestUrl).toBe("https://openrouter.ai/api/v1/models/user");
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(models).toEqual([
      {
        id: "future-labs/nebulon-x",
        name: "Future Labs: Nebulon X",
        supportsTools: true,
      },
    ]);
    expect(JSON.stringify(models)).not.toContain(secret);
  });

  it("returns only sanitized errors and never leaks a credential or response body", async () => {
    const secret = "unit-openrouter-secret";
    const responseSecret = "provider-body-secret";
    await expect(
      loadOpenRouterUserModelCatalog(CFG, undefined, {
        resolveAuth: vi.fn(async () => ({
          apiKey: secret,
          source: "unit-test",
          mode: "api-key" as const,
        })),
        fetchImpl: vi.fn(
          async () => new Response(responseSecret, { status: 401, statusText: responseSecret }),
        ),
      }),
    ).rejects.toThrow("OPENROUTER_USER_CATALOG_HTTP_401");
  });

  it("applies the OpenClaw provider prefix exactly once to an exact catalog ID", () => {
    expect(toOpenClawOpenRouterRef("openai/example-model")).toBe("openrouter/openai/example-model");
    expect(toOpenClawOpenRouterRef("openrouter/openai/example-model")).toBeNull();
    expect(toOpenClawOpenRouterRef("Luna pro")).toBeNull();
  });
});

describe("LINE natural-language model resolution", () => {
  it.each([
    ["สลับไปใช้ Luna Pro", "Luna Pro"],
    ["สลับเป็น Claude", "Claude"],
    ["สลับโมเดลเป็น Gemini", "Gemini"],
    ["เปลี่ยนโมเดลเป็น Claude", "Claude"],
    ["เปลี่ยนตัว AI เป็น Gemini", "Gemini"],
    ["ขอใช้ Grok แทน", "Grok"],
    ["เอาเป็น Claude หน่อย", "Claude"],
    ["กลับมาใช้ Luna", "Luna"],
    ["ใช้ Claude แทน", "Claude"],
    ["ขอเปลี่ยนเป็น DeepSeek", "DeepSeek"],
  ])("captures Thai model control %s", (text, query) => {
    expect(parseLineNaturalModelIntent(text)).toMatchObject({
      kind: "switch",
      query,
      locale: "th",
    });
    expect(isLineNaturalModelControlLike(text)).toBe(true);
  });

  it.each([
    "Claude รุ่นไหนเก่ง",
    "Luna Pro ต่างจาก Luna ยังไง",
    "OpenRouter คืออะไร",
    "เปรียบเทียบ Gemini กับ Claude",
  ])("leaves model discussion as ordinary chat: %s", (text) => {
    expect(parseLineNaturalModelIntent(text)).toEqual({ kind: "none" });
    expect(isLineNaturalModelControlLike(text)).toBe(false);
  });

  it("contains malformed explicit model control instead of passing it to the agent", async () => {
    const privateLoader = vi.fn(async () => MODELS);
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "ช่วยเปลี่ยน model ให้หน่อย",
      cfg: CFG,
      ctx: lineContext("owner-user"),
      loadCatalog: privateLoader,
    });
    expect(action).toMatchObject({ kind: "reply" });
    expect(privateLoader).not.toHaveBeenCalled();
  });

  it("reproduces and closes the exact production defect", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "อยากลองเปลี่ยนเป็น Luna pro ได้ไหม",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog: async () => [MODELS[0]!],
    });

    expect(action.kind).toBe("reply");
    expect(JSON.stringify(action)).not.toContain("openrouter/luna pro");
    expect(JSON.stringify(action)).not.toContain("openrouter/openrouter/Luna pro");
    expect(JSON.stringify(action)).not.toContain("เปลี่ยนเป็น");
  });

  it("selects only the exact ID returned by the catalog", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch to Nebulon X",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(action).toMatchObject({
      kind: "switch",
      candidate: {
        id: "future-labs/nebulon-x",
        ref: "openrouter/future-labs/nebulon-x",
        source: "openrouter-user-catalog",
      },
    });
  });

  it("never promotes human text into a model ID", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch to Imaginary Human Name",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(action.kind).toBe("reply");
    expect(JSON.stringify(action)).not.toContain("openrouter/Imaginary Human Name");
  });

  it("asks for clarification when multiple catalog models are plausible", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "ใช้ Claude Sonnet",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(action.kind).toBe("reply");
    if (action.kind === "reply") {
      expect(action.text).toContain("1.");
      expect(action.text).toContain("2.");
    }
  });

  it("keeps tool capability warnings before a switch", async () => {
    const warning = await resolveLineNaturalLanguageModelAction({
      text: "use Plain Chat",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(warning.kind).toBe("reply");
    expect(warning.kind === "reply" ? warning.text : "").toContain("does not support tools");
  });

  it("keeps current/default requests and slash commands on existing paths", async () => {
    await expect(
      resolveLineNaturalLanguageModelAction({
        text: "ตอนนี้ใช้โมเดลอะไร",
        cfg: CFG,
        ownerAuthorized: true,
        loadCatalog,
      }),
    ).resolves.toEqual({ kind: "directive", command: "/model status" });
    await expect(
      resolveLineNaturalLanguageModelAction({
        text: "switch back to default",
        cfg: CFG,
        ownerAuthorized: true,
        loadCatalog,
      }),
    ).resolves.toEqual({ kind: "directive", command: "/model default" });
    expect(parseLineNaturalModelIntent("/model openrouter/openai/gpt-5.6-luna")).toEqual({
      kind: "none",
    });
  });

  it("requires verified owner and authorized sender before catalog access", async () => {
    const privateLoader = vi.fn(async () => MODELS);
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "เปลี่ยนเป็น Nebulon X",
      cfg: CFG,
      ctx: lineContext("ordinary-member"),
      loadCatalog: privateLoader,
    });
    expect(action).toEqual({ kind: "blocked" });
    expect(privateLoader).not.toHaveBeenCalled();
  });

  it("does not grant command authorization to ordinary chat", async () => {
    const privateLoader = vi.fn(async () => MODELS);
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "ช่วยสรุปงานวันนี้",
      cfg: CFG,
      ctx: lineContext("owner-user"),
      loadCatalog: privateLoader,
    });
    expect(action).toEqual({ kind: "none" });
    expect(privateLoader).not.toHaveBeenCalled();
  });
});

describe("verified LINE session model transaction", () => {
  it("persists and verifies the exact catalog candidate before reporting success", async () => {
    const state = memoryStore({ sessionId: "line-session", updatedAt: 1 });
    const chosen = candidate();
    const result = await applyLineNaturalModelSwitch({
      cfg: CFG,
      storePath: "sessions.json",
      sessionKey: "line:pilot",
      candidate: chosen,
      loadCatalog,
      store: state.adapter,
    });

    expect(result).toEqual({ ok: true, activeRef: chosen.ref });
    expect(state.current()).toMatchObject({
      providerOverride: "openrouter",
      modelOverride: "future-labs/nebulon-x",
      modelOverrideSource: "user",
    });
    expect(formatLineNaturalModelSwitchResult({ result, candidate: chosen, locale: "en" })).toBe(
      "Switched to Future Labs: Nebulon X.",
    );
    expect(CFG.agents?.defaults?.model).toEqual({ primary: DEFAULT_MODEL });
  });

  it("does not alter the session when authoritative preflight validation fails", async () => {
    const state = memoryStore({
      sessionId: "line-session",
      updatedAt: 1,
      providerOverride: "openrouter",
      modelOverride: "openai/gpt-5.6-luna",
    });
    const before = state.current();
    const result = await applyLineNaturalModelSwitch({
      cfg: CFG,
      storePath: "sessions.json",
      sessionKey: "line:pilot",
      candidate: candidate(),
      loadCatalog: async () => [],
      store: state.adapter,
    });
    expect(result).toEqual({ ok: false, reason: "catalog", rolledBack: false });
    expect(state.current()).toEqual(before);
  });

  it("rolls back to the previous override on immediate provider rejection", async () => {
    const state = memoryStore({
      sessionId: "line-session",
      updatedAt: 1,
      providerOverride: "openrouter",
      modelOverride: "openai/gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    let calls = 0;
    const result = await applyLineNaturalModelSwitch({
      cfg: CFG,
      storePath: "sessions.json",
      sessionKey: "line:pilot",
      candidate: candidate(),
      loadCatalog: async () => {
        calls += 1;
        if (calls === 1) {
          return MODELS;
        }
        throw new Error("Authorization: Bearer secret-must-not-escape");
      },
      store: state.adapter,
    });
    expect(result).toEqual({ ok: false, reason: "provider", rolledBack: true });
    expect(state.current()).toMatchObject({
      providerOverride: "openrouter",
      modelOverride: "openai/gpt-5.6-luna",
    });
    expect(JSON.stringify(result)).not.toContain("secret-must-not-escape");
  });

  it("clears to the configured default when rejection follows a session with no override", async () => {
    const state = memoryStore({ sessionId: "line-session", updatedAt: 1 });
    let calls = 0;
    const chosen = candidate();
    const result = await applyLineNaturalModelSwitch({
      cfg: CFG,
      storePath: "sessions.json",
      sessionKey: "line:pilot",
      candidate: chosen,
      loadCatalog: async () => (++calls === 1 ? MODELS : []),
      store: state.adapter,
    });
    expect(result).toEqual({ ok: false, reason: "provider", rolledBack: true });
    expect(state.current().providerOverride).toBeUndefined();
    expect(state.current().modelOverride).toBeUndefined();
    expect(
      formatLineNaturalModelSwitchResult({ result, candidate: chosen, locale: "th" }),
    ).not.toContain("เปลี่ยนเป็น");
  });
});
