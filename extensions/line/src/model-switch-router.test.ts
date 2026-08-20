import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  LINE_MODEL_SELECTION_TTL_MS,
  type LinePendingModelSelection,
} from "./model-catalog-tool.js";
import {
  classifyLineModelControlIntent,
  createLineModelSwitchIntentRouter,
} from "./model-switch-router.js";

const SECRET = "test-secret-never-log";

type CatalogFixture = { id: string; name: string };

function catalogResponse(data: CatalogFixture[]) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Slugs/names below are single tokens that normalize to an exact match against
// the corresponding extracted query ("gemini", "claude", "grok", "deepseek",
// "gpt"), so these fixtures exercise the picker's direct-switch path.
function defaultCatalog(): CatalogFixture[] {
  return [
    { id: "google/gemini", name: "Google Gemini" },
    { id: "anthropic/claude", name: "Anthropic Claude" },
    { id: "x-ai/grok", name: "xAI Grok" },
    { id: "deepseek/deepseek", name: "DeepSeek" },
    { id: "openai/gpt", name: "OpenAI GPT" },
  ];
}

// None of these slugs/names normalize to exactly "luna pro", so a "Luna Pro"
// query matches all three as partial candidates instead of one exact match —
// this exercises the numbered-choices/pending-selection path.
function ambiguousLunaProCatalog(): CatalogFixture[] {
  return [
    { id: "openai/luna-pro-max", name: "Luna Pro Max" },
    { id: "openai/luna-pro-mini", name: "Luna Pro Mini" },
    { id: "future-labs/luna-pro-preview", name: "Luna Pro Preview" },
  ];
}

function createMemoryPendingStore(params?: {
  now?: () => number;
}): PluginStateKeyedStore<LinePendingModelSelection> {
  const now = params?.now ?? Date.now;
  const values = new Map<string, { value: LinePendingModelSelection; expiresAt: number }>();
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
      values.set(key, {
        value,
        expiresAt: now() + (options?.ttlMs ?? LINE_MODEL_SELECTION_TTL_MS),
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
        return entry ? [{ key, ...entry, createdAt: 0 }] : [];
      });
    },
    async clear() {
      values.clear();
    },
  };
}

type SessionModelApplier = (model: { id: string }) => Promise<boolean>;

function createRouter(overrides?: {
  pendingStore?: PluginStateKeyedStore<LinePendingModelSelection>;
  catalog?: CatalogFixture[];
  applySessionModel?: SessionModelApplier;
  now?: () => number;
}) {
  const pendingStore = overrides?.pendingStore ?? createMemoryPendingStore({ now: overrides?.now });
  const applySessionModel =
    overrides?.applySessionModel ?? vi.fn(async (_model: { id: string }) => true);
  const fetchImpl = vi.fn(async () => catalogResponse(overrides?.catalog ?? defaultCatalog()));
  const router = createLineModelSwitchIntentRouter({
    pendingStore,
    resolveApiKey: async () => SECRET,
    buildSessionModelApplier: () => applySessionModel,
    fetchImpl,
    now: overrides?.now,
  });
  return { router, pendingStore, applySessionModel, fetchImpl };
}

function ownerEvent(body: string, overrides?: Record<string, unknown>) {
  return {
    content: body,
    body,
    channel: "line",
    senderId: "owner-1",
    senderIsOwner: true,
    sessionKey: "line-session-a",
    ...overrides,
  };
}

const ctxFor = (sessionKey = "line-session-a") => ({ sessionKey, agentId: "agent-1" });

describe("classifyLineModelControlIntent", () => {
  // "explicit" tracks whether the wording alone (the "เปลี่ยนเป็น"/"switch to"/
  // "change to" construction, or an explicit "model"/"โมเดล" word) is trustworthy
  // without catalog corroboration. A bare "เปลี่ยน"/"ลอง"/"ใช้"/"ลองใช้" verb is
  // only tentative — see the router-level "credible catalog evidence" tests below.
  it.each([
    ["เปลี่ยนเป็น gemini หน่อย", "gemini", true],
    ["เปลี่ยนเป็น Gemini", "Gemini", true],
    ["ลองใช้ Claude", "Claude", false],
    ["switch to Grok", "Grok", true],
    ["ใช้ DeepSeek ตัวใหม่", "DeepSeek", false],
    ["เปลี่ยน model เป็น GPT", "GPT", true],
    ["ลอง Grok", "Grok", false],
    ["switch to Claude", "Claude", true],
    ["ใช้ Grok ให้หน่อย", "Grok", false],
    ["switch to DeepSeek", "DeepSeek", true],
  ])("extracts the literal switch term from %s", (text, expectedQuery, expectedExplicit) => {
    expect(classifyLineModelControlIntent(text)).toEqual({
      kind: "switch",
      query: expectedQuery,
      explicit: expectedExplicit,
    });
  });

  it.each([
    "Gemini ดีไหม",
    "Claude กับ Gemini ต่างกันยังไง",
    "ตอนนี้ Gemini รุ่นไหนน่าสนใจ",
    "Grok เก่งกว่า Claude ไหม",
  ])("treats ordinary model discussion as no intent: %s", (text) => {
    expect(classifyLineModelControlIntent(text)).toEqual({ kind: "none" });
  });

  it("classifies a bare number as a numeric selection", () => {
    expect(classifyLineModelControlIntent("2")).toEqual({ kind: "numeric", selection: 2 });
  });

  // Bare tentative-verb messages with no model connector are still classified as
  // "switch" here (classification is purely lexical) — it's the router's live
  // catalog check, not the classifier, that tells these apart from real switch
  // requests like "ลอง gemini". See the router-level tests below.
  it.each([
    ["ลองคิดดูหน่อย", "คิด"],
    ["ใช้เวลานานไหม", "เวลานานไหม"],
    ["เปลี่ยนแผนหน่อย", "แผน"],
    ["เปลี่ยนเสื้อ", "เสื้อ"],
    ["ลองใช้แอปนี้", "แอปนี้"],
  ])("classifies ordinary phrase %s as tentative (not explicit)", (text, expectedQuery) => {
    expect(classifyLineModelControlIntent(text)).toEqual({
      kind: "switch",
      query: expectedQuery,
      explicit: false,
    });
  });
});

describe("LINE model-switch intent router (before_dispatch)", () => {
  it("1: routes an explicit Thai switch request to the validated picker", async () => {
    const { router, applySessionModel } = createRouter();
    const result = await router(ownerEvent("เปลี่ยนเป็น gemini หน่อย"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("เปลี่ยนเป็น Google Gemini แล้ว");
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google/gemini" }),
    );
  });

  it("2: routes an explicit English switch request to the validated picker", async () => {
    const { router, applySessionModel } = createRouter();
    const result = await router(ownerEvent("switch to Claude"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("เปลี่ยนเป็น Anthropic Claude แล้ว");
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "anthropic/claude" }),
    );
  });

  it("3: routes natural Thai shorthand ('ลอง Grok') to the validated picker", async () => {
    const { router, applySessionModel } = createRouter();
    const result = await router(ownerEvent("ลอง Grok"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("เปลี่ยนเป็น xAI Grok แล้ว");
    expect(applySessionModel).toHaveBeenCalledWith(expect.objectContaining({ id: "x-ai/grok" }));
  });

  it("4: returns numbered choices and creates a pending selection on multiple catalog matches", async () => {
    const { router, pendingStore, applySessionModel } = createRouter({
      catalog: ambiguousLunaProCatalog(),
    });
    const result = await router(ownerEvent("เปลี่ยนเป็น Luna Pro"), ctxFor());

    expect(result?.handled).toBe(true);
    // The picker's own "query" field is normalized (lowercased) text.
    expect(result?.text).toContain("เจอ luna pro หลายรุ่น:");
    // Candidates are numbered in catalog name order (Max, Mini, Preview).
    expect(result?.text).toContain("1. Luna Pro Max");
    expect(result?.text).toContain("2. Luna Pro Mini");
    expect(result?.text).toContain("3. Luna Pro Preview");
    expect(result?.text).toContain("ต้องการใช้รุ่นไหน?");
    expect(applySessionModel).not.toHaveBeenCalled();
    const stored = await pendingStore.entries();
    expect(stored).toHaveLength(1);
  });

  it("5: resolves a numeric reply against the active pending selection to the correct canonical model", async () => {
    const { router, applySessionModel } = createRouter({ catalog: ambiguousLunaProCatalog() });
    await router(ownerEvent("เปลี่ยนเป็น Luna Pro"), ctxFor());

    const result = await router(ownerEvent("2"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("เปลี่ยนเป็น Luna Pro Mini แล้ว");
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openai/luna-pro-mini" }),
    );
  });

  it("6: treats a numeric message with no active pending selection as ordinary chat", async () => {
    const { router, applySessionModel } = createRouter();
    const result = await router(ownerEvent("2"), ctxFor());

    expect(result).toBeUndefined();
    expect(applySessionModel).not.toHaveBeenCalled();
  });

  it("7: rejects a numeric selection from a different LINE session (not reused)", async () => {
    const catalog = ambiguousLunaProCatalog();
    const pendingStore = createMemoryPendingStore();
    const { router: routerA } = createRouter({ pendingStore, catalog });
    await routerA(
      ownerEvent("เปลี่ยนเป็น Luna Pro", { sessionKey: "line-session-a" }),
      ctxFor("line-session-a"),
    );

    const { router: routerB, applySessionModel: applyB } = createRouter({ pendingStore, catalog });
    const result = await routerB(
      ownerEvent("2", { sessionKey: "line-session-b" }),
      ctxFor("line-session-b"),
    );

    expect(result).toBeUndefined();
    expect(applyB).not.toHaveBeenCalled();
  });

  it("8: a non-owner switch request cannot use the privileged picker", async () => {
    const { router, applySessionModel, fetchImpl } = createRouter();
    const result = await router(ownerEvent("switch to Claude", { senderIsOwner: false }), ctxFor());

    expect(result).toBeUndefined();
    expect(applySessionModel).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("9: an expired pending selection cannot switch and falls through as ordinary chat", async () => {
    const catalog = ambiguousLunaProCatalog();
    let now = 1_000;
    const pendingStore = createMemoryPendingStore({ now: () => now });
    const { router, applySessionModel } = createRouter({ pendingStore, catalog, now: () => now });
    await router(ownerEvent("เปลี่ยนเป็น Luna Pro"), ctxFor());

    now += LINE_MODEL_SELECTION_TTL_MS + 1;
    const result = await router(ownerEvent("1"), ctxFor());

    expect(result).toBeUndefined();
    expect(applySessionModel).not.toHaveBeenCalled();
  });

  it("10: a catalog change before selection makes a stale candidate unable to switch", async () => {
    const initialCatalog = ambiguousLunaProCatalog();
    const pendingStore = createMemoryPendingStore();
    const applySessionModel = vi.fn(async (_model: { id: string }) => true);
    let fetchCall = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCall += 1;
      // The candidate picked at search time (index 1) is gone from the
      // account catalog by the time the numbered reply re-fetches it.
      return catalogResponse(fetchCall === 1 ? initialCatalog : [initialCatalog[0]!]);
    });
    const router = createLineModelSwitchIntentRouter({
      pendingStore,
      resolveApiKey: async () => SECRET,
      buildSessionModelApplier: () => applySessionModel,
      fetchImpl,
    });

    await router(ownerEvent("เปลี่ยนเป็น Luna Pro"), ctxFor());
    const result = await router(ownerEvent("2"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("ตัวเลือกที่เลือกไม่มีในบัญชีแล้ว กรุณาค้นหาใหม่อีกครั้ง");
    expect(applySessionModel).not.toHaveBeenCalled();
  });

  it("11: an exact canonical catalog match switches directly without a numbered prompt", async () => {
    const { router, applySessionModel } = createRouter();
    const result = await router(ownerEvent("เปลี่ยนเป็น google/gemini"), ctxFor());

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("เปลี่ยนเป็น Google Gemini แล้ว");
    expect(applySessionModel).toHaveBeenCalledOnce();
  });

  it("12: ordinary model discussion is not routed and falls through to the normal agent", async () => {
    const { router, applySessionModel, fetchImpl } = createRouter();
    const result = await router(ownerEvent("Gemini กับ Claude ต่างกันยังไง"), ctxFor());

    expect(result).toBeUndefined();
    expect(applySessionModel).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("13: tentative generic-verb messages require credible catalog evidence", () => {
    it.each([
      ["ลองคิดดูหน่อย", "ordinary Thai request, not model-related"],
      ["ใช้เวลานานไหม", "ordinary Thai question, not model-related"],
      ["เปลี่ยนแผนหน่อย", "bare เปลี่ยน, not model-related"],
      ["เปลี่ยนเสื้อ", "bare เปลี่ยน, not model-related"],
      ["ลองใช้แอปนี้", "ลองใช้ with no catalog match"],
    ])("falls through to the normal agent: %s (%s)", async (text) => {
      const { router, applySessionModel, fetchImpl } = createRouter();
      const result = await router(ownerEvent(text), ctxFor());

      // The tentative verb still triggers a live catalog search (this is the
      // whole point — resolving via the live catalog rather than a static
      // model-name list) but a no_match result on a tentative message must
      // fall through instead of hijacking the reply.
      expect(fetchImpl).toHaveBeenCalled();
      expect(result).toBeUndefined();
      expect(applySessionModel).not.toHaveBeenCalled();
    });

    it.each([
      ["เปลี่ยนเป็น deepseek", "deepseek/deepseek"],
      ["ลองใช้ claude", "anthropic/claude"],
      ["ลอง gemini", "google/gemini"],
      ["ใช้ gpt", "openai/gpt"],
      ["เปลี่ยน model เป็น claude", "anthropic/claude"],
    ])("still switches on a credible catalog match: %s", async (text, expectedModelId) => {
      const { router, applySessionModel } = createRouter();
      const result = await router(ownerEvent(text), ctxFor());

      expect(result?.handled).toBe(true);
      expect(applySessionModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: expectedModelId }),
      );
    });

    it("explicit wording still reports model-not-found on a genuine no_match (does not fall through)", async () => {
      const { router, applySessionModel } = createRouter();
      const result = await router(ownerEvent("เปลี่ยนเป็น totallynonexistentmodel"), ctxFor());

      expect(result?.handled).toBe(true);
      expect(result?.text).toContain("totallynonexistentmodel");
      expect(applySessionModel).not.toHaveBeenCalled();
    });

    it("a tentative verb with multiple credible catalog candidates still creates a numbered pending picker", async () => {
      const { router, pendingStore, applySessionModel } = createRouter({
        catalog: ambiguousLunaProCatalog(),
      });
      const result = await router(ownerEvent("ลอง Luna Pro"), ctxFor());

      expect(result?.handled).toBe(true);
      expect(result?.text).toContain("เจอ luna pro หลายรุ่น:");
      expect(applySessionModel).not.toHaveBeenCalled();
      const stored = await pendingStore.entries();
      expect(stored).toHaveLength(1);
    });

    it("pending numeric selection created via a tentative-verb search still resolves exactly as before", async () => {
      const { router, applySessionModel } = createRouter({ catalog: ambiguousLunaProCatalog() });
      await router(ownerEvent("ลอง Luna Pro"), ctxFor());

      const result = await router(ownerEvent("2"), ctxFor());

      expect(result?.handled).toBe(true);
      expect(result?.text).toBe("เปลี่ยนเป็น Luna Pro Mini แล้ว");
      expect(applySessionModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "openai/luna-pro-mini" }),
      );
    });
  });

  it("14/15: applies the model through the session-only applier, not a global mutation, and never restarts Gateway", async () => {
    const applySessionModel = vi.fn(async (_model: { id: string }) => true);
    const { router } = createRouter({ applySessionModel });
    const result = await router(ownerEvent("switch to Claude"), ctxFor("line-session-x"));

    expect(result?.handled).toBe(true);
    // The router only ever calls the injected session-model applier — no
    // gateway/config tool, no restart primitive, is reachable from here.
    expect(applySessionModel).toHaveBeenCalledOnce();
    expect(applySessionModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "anthropic/claude" }),
    );
  });

  it("ignores non-LINE channels entirely", async () => {
    const { router, applySessionModel, fetchImpl } = createRouter();
    const result = await router(ownerEvent("switch to Claude", { channel: "telegram" }), ctxFor());

    expect(result).toBeUndefined();
    expect(applySessionModel).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails safe and falls through when catalog auth is unavailable", async () => {
    const pendingStore = createMemoryPendingStore();
    const router = createLineModelSwitchIntentRouter({
      pendingStore,
      resolveApiKey: async () => undefined,
      fetchImpl: vi.fn(async () => catalogResponse(defaultCatalog())),
    });

    const result = await router(ownerEvent("switch to Claude"), ctxFor());

    expect(result).toBeUndefined();
  });
});
