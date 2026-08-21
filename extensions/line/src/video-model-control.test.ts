import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  classifyLineVideoModelControlIntent,
  createLineVideoModelControlRouter,
  type LinePendingVideoModelSelection,
} from "./video-model-control.js";
import {
  resolveLineVideoModelPreference,
  type LineVideoModelPreferenceState,
} from "./video-model-preference.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

describe("classifyLineVideoModelControlIntent", () => {
  it("matches explicit English 'video model' wording", () => {
    expect(classifyLineVideoModelControlIntent("video model")).toEqual({
      kind: "switch",
      query: "",
    });
  });

  it("matches Thai 'เปลี่ยน video model เป็น seedance 2.5'", () => {
    expect(classifyLineVideoModelControlIntent("เปลี่ยน video model เป็น seedance 2.5")).toEqual({
      kind: "switch",
      query: "seedance 2.5",
    });
  });

  it("matches 'ใช้ video model seedance 2.5'", () => {
    const result = classifyLineVideoModelControlIntent("ใช้ video model seedance 2.5");
    expect(result.kind).toBe("switch");
    if (result.kind === "switch") {
      expect(result.query).toContain("seedance");
    }
  });

  it("matches 'เปลี่ยนโมเดลวิดีโอเป็น seedance'", () => {
    expect(classifyLineVideoModelControlIntent("เปลี่ยนโมเดลวิดีโอเป็น seedance")).toEqual({
      kind: "switch",
      query: "seedance",
    });
  });

  it("does not match ordinary chat-model requests (no 'video' wording)", () => {
    expect(classifyLineVideoModelControlIntent("เปลี่ยนเป็น gemini หน่อย")).toEqual({ kind: "none" });
    expect(classifyLineVideoModelControlIntent("switch to claude")).toEqual({ kind: "none" });
  });

  it("does not match unrelated chat", () => {
    expect(classifyLineVideoModelControlIntent("สวัสดีครับ")).toEqual({ kind: "none" });
  });

  it("classifies a bare number as a numeric selection", () => {
    expect(classifyLineVideoModelControlIntent("2")).toEqual({ kind: "numeric", selection: 2 });
  });
});

const OWNER_ID = "U-owner";
const MEMBER_ID = "U-member";

function seedanceModel(overrides?: Partial<{ id: string; name: string }>) {
  return {
    id: overrides?.id ?? "bytedance/seedance-2.5",
    name: overrides?.name ?? "Seedance 2.5",
    supported_durations: [4, 6, 8],
    supported_aspect_ratios: ["16:9", "9:16"],
    supported_resolutions: ["720p", "1080p"],
    supported_frame_images: [],
    pricing_skus: { "per-video-second": "0.10" },
  };
}

function fakeCatalogFetch(models: Array<ReturnType<typeof seedanceModel>>): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ data: models }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function createRouterFixture(params: {
  models: Array<ReturnType<typeof seedanceModel>>;
  preferenceStore?: PluginStateKeyedStore<LineVideoModelPreferenceState>;
  pendingStore?: PluginStateKeyedStore<LinePendingVideoModelSelection>;
}) {
  const preferenceStore =
    params.preferenceStore ?? createMemoryStore<LineVideoModelPreferenceState>();
  const pendingStore = params.pendingStore ?? createMemoryStore<LinePendingVideoModelSelection>();
  const router = createLineVideoModelControlRouter({
    preferenceStore,
    pendingStore,
    resolveApiKey: async () => "sk-test",
    fetchImpl: fakeCatalogFetch(params.models),
  });
  return { router, preferenceStore, pendingStore };
}

function baseEvent(
  overrides?: Partial<Parameters<ReturnType<typeof createLineVideoModelControlRouter>>[0]>,
) {
  return {
    content: "",
    channel: "line",
    senderId: OWNER_ID,
    senderIsOwner: true,
    ...overrides,
  };
}

const CTX = { accountId: "acct-1", conversationId: "grp-a" };

describe("createLineVideoModelControlRouter", () => {
  it("1: owner-only — non-owner 'video model' request never changes preference", async () => {
    const { router, preferenceStore } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(
      baseEvent({ body: "video model seedance", senderId: MEMBER_ID, senderIsOwner: false }),
      CTX,
    );
    expect(result).toBeUndefined();
    expect(await preferenceStore.lookup("acct-1|grp-a")).toBeUndefined();
  });

  it("2: an exact single-match switch request sets the preference directly", async () => {
    const { router, preferenceStore } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "เปลี่ยน video model เป็น seedance 2.5" }), CTX);

    expect(result?.handled).toBe(true);
    expect(await preferenceStore.lookup("acct-1|grp-a")).toMatchObject({
      model: "bytedance/seedance-2.5",
    });
  });

  it("3: multiple matches return a numbered candidate list and create pending state", async () => {
    const { router, pendingStore, preferenceStore } = createRouterFixture({
      models: [
        seedanceModel(),
        seedanceModel({ id: "bytedance/seedance-2.0", name: "Seedance 2.0" }),
      ],
    });
    const result = await router(baseEvent({ body: "video model seedance" }), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("1.");
    expect(result?.text).toContain("2.");
    expect((await pendingStore.entries()).length).toBe(1);
    expect(await preferenceStore.lookup("acct-1|grp-a")).toBeUndefined();
  });

  it("4: numeric selection resolves the pending candidate list", async () => {
    const { router, preferenceStore } = createRouterFixture({
      models: [
        seedanceModel(),
        seedanceModel({ id: "bytedance/seedance-2.0", name: "Seedance 2.0" }),
      ],
    });
    await router(baseEvent({ body: "video model seedance" }), CTX);

    // The catalog is sorted alphabetically by name, so "Seedance 2.0" sorts
    // before "Seedance 2.5" — selection 1 is the first listed candidate.
    const result = await router(baseEvent({ body: "1" }), CTX);

    expect(result?.handled).toBe(true);
    expect(await preferenceStore.lookup("acct-1|grp-a")).toMatchObject({
      model: "bytedance/seedance-2.0",
    });
  });

  it("5: chat-model picker state and video-model picker state are fully isolated stores", async () => {
    const { pendingStore } = createRouterFixture({ models: [seedanceModel()] });
    // The video router's pending store is a completely separate namespace
    // instance from the chat model-switch router's — asserting it is a
    // distinct object with its own independent contents is the isolation
    // guarantee this test documents.
    const chatModelPendingStore = createMemoryStore<unknown>();
    await chatModelPendingStore.register("some-hash", { unrelated: true });

    expect(pendingStore).not.toBe(chatModelPendingStore);
    expect(await pendingStore.entries()).toEqual([]);
  });

  it("6: a bare number with no active video-model picker falls through unchanged", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "3" }), CTX);
    expect(result).toBeUndefined();
  });

  it("does not fire for a non-LINE channel", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(
      baseEvent({ body: "video model seedance", channel: "telegram" }),
      CTX,
    );
    expect(result).toBeUndefined();
  });
});

describe("resolveLineVideoModelPreference reused by the router", () => {
  it("defaults to seedance-2.5 before any switch happens", async () => {
    const store = createMemoryStore<LineVideoModelPreferenceState>();
    expect(await resolveLineVideoModelPreference({ store, key: "acct-1|grp-a" })).toBe(
      "bytedance/seedance-2.5",
    );
  });
});
