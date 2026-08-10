// Tests secure natural-language LINE model selection without provider credentials.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  parseLineNaturalModelIntent,
  resolveAuthorizedLineNaturalModelAction,
  resolveLineNaturalLanguageModelAction,
} from "./natural-language-model.js";

const DEFAULT_MODEL = "openrouter/openai/gpt-5.6-luna";
const CFG: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: DEFAULT_MODEL },
    },
  },
  channels: {
    line: {
      allowFrom: ["*"],
    },
  },
  commands: {
    ownerAllowFrom: ["owner-user"],
  },
};

function catalog(): ModelsProviderData {
  const models = [
    ["openai/gpt-5.6-luna", "OpenAI: GPT-5.6 Luna", true],
    ["openai/gpt-5.6-luna-pro", "OpenAI: GPT-5.6 Luna Pro", true],
    ["anthropic/claude-sonnet-4-6", "Anthropic: Claude Sonnet 4.6", true],
    ["anthropic/claude-sonnet-4-7", "Anthropic: Claude Sonnet 4.7", true],
    ["google/gemini-3-pro", "Google: Gemini 3 Pro", true],
    ["future-labs/nebulon-x", "Future Labs: Nebulon X", true],
    ["text-labs/plain-chat", "Text Labs: Plain Chat", false],
  ] as const;
  const refs = models.map(([id]) => id);
  return {
    byProvider: new Map([["openrouter", new Set(refs)]]),
    providers: ["openrouter"],
    resolvedDefault: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
    modelNames: new Map(models.map(([id, name]) => [`openrouter/${id}`, name])),
    modelCapabilities: new Map(
      models.map(([id, , supportsTools]) => [`openrouter/${id}`, { supportsTools }]),
    ),
    runtimeChoicesByProvider: new Map(),
  };
}

const loadCatalog = vi.fn(async () => catalog());

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

describe("LINE natural-language model switching", () => {
  it("lets the verified owner switch using Thai natural language", async () => {
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "เปลี่ยนเป็น Luna Pro หน่อย",
      cfg: CFG,
      ctx: lineContext("owner-user"),
      loadCatalog,
    });

    expect(action).toEqual({
      kind: "directive",
      command: "/model openrouter/openai/gpt-5.6-luna-pro",
    });
  });

  it("lets the verified owner switch using English natural language", async () => {
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "switch to Gemini 3 Pro",
      cfg: CFG,
      ctx: lineContext("owner-user"),
      loadCatalog,
    });

    expect(action).toEqual({
      kind: "directive",
      command: "/model openrouter/google/gemini-3-pro",
    });
  });

  it("resolves future catalog models without a hard-coded model list", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "use Nebulon X",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });

    expect(action).toEqual({
      kind: "directive",
      command: "/model openrouter/future-labs/nebulon-x",
    });
  });

  it("requires clarification for ambiguous model families", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "ใช้ Claude Sonnet",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });

    expect(action.kind).toBe("reply");
    if (action.kind === "reply") {
      expect(action.text).toContain("เจอ 2 รุ่น");
      expect(action.text).toContain("claude-sonnet-4-6");
      expect(action.text).toContain("claude-sonnet-4-7");
    }
  });

  it("routes current-model questions through the authoritative model status path", async () => {
    await expect(
      resolveLineNaturalLanguageModelAction({
        text: "ตอนนี้ใช้โมเดลอะไร",
        cfg: CFG,
        ownerAuthorized: true,
        loadCatalog,
      }),
    ).resolves.toEqual({ kind: "directive", command: "/model status" });
  });

  it("routes return-to-default requests through the existing session reset path", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch back to default",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(action).toEqual({ kind: "directive", command: "/model default" });

    const sessionEntry: Parameters<typeof applyModelOverrideToSessionEntry>[0]["entry"] = {
      sessionId: "line-session",
      updatedAt: 1,
      providerOverride: "openrouter",
      modelOverride: "future-labs/nebulon-x",
      modelOverrideSource: "user",
    };
    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: {
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        isDefault: true,
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
  });

  it("does not treat ordinary chat as model control", async () => {
    const privateLoader = vi.fn(async () => catalog());
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "ช่วยสรุปงานวันนี้",
      cfg: CFG,
      ctx: lineContext("owner-user"),
      loadCatalog: privateLoader,
    });

    expect(action).toEqual({ kind: "none" });
    expect(privateLoader).not.toHaveBeenCalled();
  });

  it("does not intercept or resolve catalog entries for non-owners", async () => {
    const privateLoader = vi.fn(async () => catalog());
    const action = await resolveAuthorizedLineNaturalModelAction({
      text: "เปลี่ยนเป็น Luna Pro",
      cfg: CFG,
      ctx: lineContext("ordinary-member"),
      loadCatalog: privateLoader,
    });

    expect(action).toEqual({ kind: "none" });
    expect(privateLoader).not.toHaveBeenCalled();
  });

  it("produces an existing session-scoped directive that changes only the session entry", async () => {
    const configSnapshot = structuredClone(CFG);
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch to Nebulon X",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(action.kind).toBe("directive");
    if (action.kind !== "directive") {
      return;
    }

    const selected = action.command.slice("/model ".length);
    const [provider, ...modelParts] = selected.split("/");
    const sessionEntry: Parameters<typeof applyModelOverrideToSessionEntry>[0]["entry"] = {
      sessionId: "line-session",
      updatedAt: 1,
    };
    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: {
        provider: provider ?? "",
        model: modelParts.join("/"),
      },
      selectionSource: "user",
    });

    expect(sessionEntry).toMatchObject({
      providerOverride: "openrouter",
      modelOverride: "future-labs/nebulon-x",
      modelOverrideSource: "user",
    });
    expect(CFG).toEqual(configSnapshot);
  });

  it("keeps the existing slash model command untouched", () => {
    expect(parseLineNaturalModelIntent("/model openrouter/openai/gpt-5.6-luna")).toEqual({
      kind: "none",
    });
  });

  it("surfaces a catalog-declared tool limitation before switching", async () => {
    const warning = await resolveLineNaturalLanguageModelAction({
      text: "use Plain Chat",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });
    expect(warning.kind).toBe("reply");
    if (warning.kind === "reply") {
      expect(warning.text).toContain("does not support tools");
    }

    await expect(
      resolveLineNaturalLanguageModelAction({
        text: "confirm use Plain Chat",
        cfg: CFG,
        ownerAuthorized: true,
        loadCatalog,
      }),
    ).resolves.toEqual({
      kind: "directive",
      command: "/model openrouter/text-labs/plain-chat",
    });
  });

  it("returns sanitized catalog failures and never exposes credentials", async () => {
    const secret = "unit-openrouter-secret";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch to Nebulon X",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog: async () => {
        throw new Error(`Authorization: Bearer ${secret}`);
      },
    });

    expect(action).toEqual({
      kind: "reply",
      text: "The model catalog is unavailable right now.",
    });
    expect(JSON.stringify(action)).not.toContain(secret);
    expect([...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ")).not.toContain(secret);
  });

  it("returns a clear no-match reply without changing the default", async () => {
    const action = await resolveLineNaturalLanguageModelAction({
      text: "switch to Model That Does Not Exist",
      cfg: CFG,
      ownerAuthorized: true,
      loadCatalog,
    });

    expect(action).toEqual({
      kind: "reply",
      text: "No matching OpenRouter model is available to this account.",
    });
    expect(CFG.agents.defaults.model.primary).toBe(DEFAULT_MODEL);
  });
});
