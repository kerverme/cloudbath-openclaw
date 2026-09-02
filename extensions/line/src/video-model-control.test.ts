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
import type { LinePendingRequoteState } from "./video-model-requote.js";

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

  it.each([
    ["English 'video model status'", "video model status"],
    ["English 'current video model'", "current video model"],
    ["Thai 'ตอนนี้ใช้ video model อะไร'", "ตอนนี้ใช้ video model อะไร"],
    ["Thai 'ตอนนี้ใช้ video model รุ่นไหนอยู่'", "ตอนนี้ใช้ video model รุ่นไหนอยู่"],
    ["Thai 'เช็ก video model ปัจจุบัน'", "เช็ก video model ปัจจุบัน"],
    ["Thai 'เช็กโมเดลสร้างวิดีโอ'", "เช็กโมเดลสร้างวิดีโอ"],
    ["Thai 'โมเดลวิดีโอตอนนี้คืออะไร'", "โมเดลวิดีโอตอนนี้คืออะไร"],
  ])("classifies %s as a status question, not a search", (_label, text) => {
    expect(classifyLineVideoModelControlIntent(text)).toEqual({ kind: "status" });
  });

  it("still treats bare 'video model' as a list/switch request, not status", () => {
    expect(classifyLineVideoModelControlIntent("video model")).toEqual({
      kind: "switch",
      query: "",
    });
  });

  it("still treats an explicit switch target as a search, not status", () => {
    expect(classifyLineVideoModelControlIntent("เปลี่ยน video model เป็น seedance 2.5")).toEqual({
      kind: "switch",
      query: "seedance 2.5",
    });
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

describe("createLineVideoModelControlRouter — status intent", () => {
  it("7: reports the persisted model after an explicit switch", async () => {
    const { router, preferenceStore } = createRouterFixture({ models: [seedanceModel()] });
    await router(baseEvent({ body: "เปลี่ยน video model เป็น seedance 2.5" }), CTX);
    expect(await preferenceStore.lookup("acct-1|grp-a")).toMatchObject({
      model: "bytedance/seedance-2.5",
    });

    const result = await router(baseEvent({ body: "ตอนนี้ใช้ video model อะไร" }), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("🎬 Video model ปัจจุบัน\nSeedance 2.5\nbytedance/seedance-2.5");
  });

  it("8: 'ตอนนี้ใช้ video model รุ่นไหนอยู่' is status, not a fuzzy search", async () => {
    const { router, pendingStore } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "ตอนนี้ใช้ video model รุ่นไหนอยู่" }), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("🎬 Video model ปัจจุบัน");
    // A fuzzy search over "ตอนนี้ รุ่นไหนอยู่" would find zero catalog matches
    // and either report no_match or create pending candidate state; status
    // must do neither.
    expect((await pendingStore.entries()).length).toBe(0);
  });

  it("9: 'เช็กโมเดลสร้างวิดีโอ' is status, not an LLM fallthrough", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "เช็กโมเดลสร้างวิดีโอ" }), CTX);

    // A defined, handled result is what prevents before_dispatch from
    // falling through to the main agent/LLM.
    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("🎬 Video model ปัจจุบัน");
  });

  it("10: 'video model status' is status", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "video model status" }), CTX);
    expect(result?.text).toContain("🎬 Video model ปัจจุบัน");
  });

  it("11: bare 'video model' still shows the existing catalog/list, not status", async () => {
    const { router, pendingStore } = createRouterFixture({
      models: [
        seedanceModel(),
        seedanceModel({ id: "bytedance/seedance-2.0", name: "Seedance 2.0" }),
      ],
    });
    const result = await router(baseEvent({ body: "video model" }), CTX);

    expect(result?.text).not.toContain("🎬 Video model ปัจจุบัน");
    expect(result?.text).toContain("1.");
    expect(result?.text).toContain("2.");
    expect((await pendingStore.entries()).length).toBe(1);
  });

  it("12: status never changes the selected model", async () => {
    const { router, preferenceStore } = createRouterFixture({
      models: [
        seedanceModel(),
        seedanceModel({ id: "bytedance/seedance-2.0", name: "Seedance 2.0" }),
      ],
    });
    await router(baseEvent({ body: "เปลี่ยน video model เป็น seedance 2.5" }), CTX);
    await router(baseEvent({ body: "video model status" }), CTX);

    expect(await preferenceStore.lookup("acct-1|grp-a")).toMatchObject({
      model: "bytedance/seedance-2.5",
    });
  });

  it("13: status never creates pending candidate-selection state", async () => {
    const { router, pendingStore } = createRouterFixture({ models: [seedanceModel()] });
    await router(baseEvent({ body: "current video model" }), CTX);
    expect((await pendingStore.entries()).length).toBe(0);
  });

  it("14: status is owner-only and does not resolve for a non-owner", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(
      baseEvent({ body: "video model status", senderId: MEMBER_ID, senderIsOwner: false }),
      CTX,
    );
    expect(result).toBeUndefined();
  });

  it("15: Group A and Group B video-model status remain isolated", async () => {
    const { router, preferenceStore } = createRouterFixture({
      models: [
        seedanceModel(),
        seedanceModel({ id: "bytedance/seedance-2.0", name: "Seedance 2.0" }),
      ],
    });
    const CTX_A = { accountId: "acct-1", conversationId: "grp-a" };
    const CTX_B = { accountId: "acct-1", conversationId: "grp-b" };

    await router(baseEvent({ body: "เปลี่ยน video model เป็น seedance 2.5" }), CTX_A);
    await router(baseEvent({ body: "เปลี่ยน video model เป็น seedance 2.0" }), CTX_B);

    const statusA = await router(baseEvent({ body: "video model status" }), CTX_A);
    const statusB = await router(baseEvent({ body: "video model status" }), CTX_B);

    expect(statusA?.text).toContain("bytedance/seedance-2.5");
    expect(statusB?.text).toContain("bytedance/seedance-2.0");
    expect(await preferenceStore.lookup("acct-1|grp-a")).toMatchObject({
      model: "bytedance/seedance-2.5",
    });
    expect(await preferenceStore.lookup("acct-1|grp-b")).toMatchObject({
      model: "bytedance/seedance-2.0",
    });
  });

  it("16: missing explicit preference reports the actual default model", async () => {
    const { router } = createRouterFixture({ models: [seedanceModel()] });
    const result = await router(baseEvent({ body: "video model status" }), CTX);

    expect(result?.text).toBe("🎬 Video model ปัจจุบัน\nSeedance 2.5\nbytedance/seedance-2.5");
  });

  it("17: degrades gracefully to the raw model id if the catalog is unavailable", async () => {
    const { preferenceStore, pendingStore } = createRouterFixture({ models: [seedanceModel()] });
    const router = createLineVideoModelControlRouter({
      preferenceStore,
      pendingStore,
      resolveApiKey: async () => undefined,
    });
    const result = await router(baseEvent({ body: "video model status" }), CTX);

    expect(result?.handled).toBe(true);
    expect(result?.text).toBe("🎬 Video model ปัจจุบัน\nbytedance/seedance-2.5");
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

/**
 * Live-catalog picker: fuzzy candidates, refinement while the picker is open,
 * and the isolation guarantees that keep this disjoint from chat-model switching.
 */
describe("createLineVideoModelControlRouter — live fuzzy picker", () => {
  const MINIMAX = [
    seedanceModel({ id: "minimax/hailuo-h3", name: "MiniMax: Hailuo H3" }),
    seedanceModel({ id: "minimax/hailuo-h3-fast", name: "MiniMax: Hailuo H3 Fast" }),
    seedanceModel({ id: "minimax/hailuo-02", name: "MiniMax: Hailuo 02" }),
    seedanceModel(),
    seedanceModel({ id: "kuaishou/kling-2.1", name: "Kling 2.1" }),
  ];

  async function openPicker() {
    const fixture = createRouterFixture({ models: MINIMAX });
    const reply = await fixture.router(
      baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }),
      CTX,
    );
    return { ...fixture, reply };
  }

  it("A: offers only MiniMax candidates and applies nothing yet", async () => {
    const { reply, preferenceStore } = await openPicker();

    expect(reply?.handled).toBe(true);
    expect(reply?.text).toContain("minimax h3");
    expect(reply?.text).toContain("MiniMax: Hailuo H3");
    expect(reply?.text).not.toContain("Kling");
    expect(reply?.text).not.toContain("Seedance");
    // Ambiguous never auto-applies onto the paid path.
    expect(await preferenceStore.lookup("acct-1|grp-a")).toBeUndefined();
  });

  it("D: textual refinement while the picker is open stays inside the picker", async () => {
    const { router, preferenceStore } = await openPicker();

    // No "video model" wording at all — this used to fall through to chat.
    const refined = await router(baseEvent({ content: "MiniMax: Hailuo H3" }), CTX);

    expect(refined?.handled).toBe(true);
    expect(refined?.text).toContain("MiniMax: Hailuo H3");
    expect((await preferenceStore.lookup("acct-1|grp-a"))?.model).toBe("minimax/hailuo-h3");
  });

  it("E: a numeric reply persists the real OpenRouter id", async () => {
    const { router, preferenceStore, pendingStore } = await openPicker();
    const pending = (await pendingStore.entries())[0]?.value;
    const expected = pending?.candidates[1]?.id;

    const chosen = await router(baseEvent({ content: "2" }), CTX);

    expect(chosen?.handled).toBe(true);
    expect(expected).toMatch(/^minimax\//u);
    expect((await preferenceStore.lookup("acct-1|grp-a"))?.model).toBe(expected);
  });

  it("K: another owner or group never sees this picker", async () => {
    const { router, preferenceStore } = await openPicker();

    const otherGroup = await router(baseEvent({ content: "MiniMax: Hailuo H3" }), {
      accountId: "acct-1",
      conversationId: "grp-b",
    });
    const nonOwner = await router(
      baseEvent({ content: "MiniMax: Hailuo H3", senderIsOwner: false }),
      CTX,
    );

    expect(otherGroup).toBeUndefined();
    expect(nonOwner).toBeUndefined();
    expect(await preferenceStore.lookup("acct-1|grp-b")).toBeUndefined();
  });

  it("L: ordinary chat is untouched, with and without a picker open", async () => {
    const fresh = createRouterFixture({ models: MINIMAX });
    expect(await fresh.router(baseEvent({ content: "สวัสดีครับ" }), CTX)).toBeUndefined();
    expect(await fresh.router(baseEvent({ content: "เปลี่ยนเป็น gemini หน่อย" }), CTX)).toBeUndefined();

    const { router } = await openPicker();
    // A picker being open must not turn unrelated chat into a model answer.
    expect(await router(baseEvent({ content: "วันนี้อากาศดีนะ" }), CTX)).toBeUndefined();
    expect(await router(baseEvent({ content: "เปลี่ยนเป็น gemini หน่อย" }), CTX)).toBeUndefined();
  });

  it("applies a confident exact request without asking", async () => {
    const { router, preferenceStore } = createRouterFixture({ models: MINIMAX });

    const reply = await router(baseEvent({ content: "video model Seedance 2.5" }), CTX);

    expect(reply?.text).toContain("Seedance 2.5");
    expect((await preferenceStore.lookup("acct-1|grp-a"))?.model).toBe("bytedance/seedance-2.5");
  });
});

/**
 * Model change while a Final Video Draft is already open.
 *
 * The archive seam is stubbed so these stay LINE-side and provider-free; the
 * seam's own behaviour is covered in the archive suite. The invariant under
 * test throughout: the previous payable code is only ever retired by a
 * replacement that actually got allocated.
 */
describe("createLineVideoModelControlRouter — active-draft re-quote", () => {
  const MODELS = [
    seedanceModel({ id: "minimax/hailuo-h3", name: "MiniMax: Hailuo H3" }),
    seedanceModel({ id: "minimax/hailuo-h3-fast", name: "MiniMax: Hailuo H3 Fast" }),
    seedanceModel(),
  ];

  type SeamCall = { overrides?: Record<string, unknown> };

  function fixture(results: Array<Record<string, unknown>>) {
    const calls: SeamCall[] = [];
    const preferenceStore = createMemoryStore<LineVideoModelPreferenceState>();
    const pendingStore = createMemoryStore<LinePendingVideoModelSelection>();
    const requotePendingStore = createMemoryStore<LinePendingRequoteState>();
    const queued = [...results];
    const router = createLineVideoModelControlRouter({
      preferenceStore,
      pendingStore,
      requotePendingStore,
      resolveApiKey: async () => "sk-test",
      fetchImpl: fakeCatalogFetch(MODELS),
      requoteActiveDraft: async (request) => {
        calls.push(request.overrides ? { overrides: request.overrides } : {});
        return (queued.shift() ?? { kind: "no_active_storyboard" }) as never;
      },
    });
    return { router, preferenceStore, requotePendingStore, calls };
  }

  const CREATED = { kind: "created", code: "8821", estimatedCostUsd: 1.5 };

  it("G/H: selecting a model re-quotes the SAME storyboard and shows the new code", async () => {
    const h = fixture([CREATED]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);

    const chosen = await h.router(baseEvent({ content: "1" }), CTX);

    expect(h.calls).toHaveLength(1);
    expect(chosen?.text).toContain("เปลี่ยน Video Model เป็น MiniMax: Hailuo H3 แล้ว");
    expect(chosen?.text).toContain("ยืนยัน VIDEO 8821");
    // Superseding the old code is the allocator's job, done as part of that
    // allocation; this side only reports it.
    expect(chosen?.text).toContain("รหัส VIDEO ก่อนหน้าถูกยกเลิกแล้ว");
    expect((await h.preferenceStore.lookup("acct-1|grp-a"))?.model).toBe("minimax/hailuo-h3");
  });

  it("J: an unsupported duration asks, mints nothing, and keeps the old code", async () => {
    const h = fixture([
      {
        kind: "incompatible",
        incompatibility: { kind: "duration", requested: "15", supported: ["6", "10"] },
      },
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);

    const asked = await h.router(baseEvent({ content: "1" }), CTX);

    expect(asked?.text).toContain("ไม่รองรับ 15 วินาที");
    expect(asked?.text).toContain("รองรับ 6 หรือ 10 วินาที");
    // No replacement code anywhere in the reply: the old one is still the only
    // payable draft and must stay that way.
    expect(asked?.text).not.toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(asked?.text).not.toContain("ยกเลิกแล้ว");
    expect(await h.requotePendingStore.entries()).toHaveLength(1);
  });

  it("K: answering with a supported duration creates the replacement", async () => {
    const h = fixture([
      {
        kind: "incompatible",
        incompatibility: { kind: "duration", requested: "15", supported: ["6", "10"] },
      },
      CREATED,
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);
    await h.router(baseEvent({ content: "1" }), CTX);

    const answered = await h.router(baseEvent({ content: "10 วิ" }), CTX);

    expect(answered?.text).toContain("ยืนยัน VIDEO 8821");
    expect(answered?.text).toContain("ยกเลิกแล้ว");
    // The owner's answer reached the seam as an explicit override.
    expect(h.calls[1]?.overrides).toEqual({ durationSeconds: 10 });
    expect(await h.requotePendingStore.entries()).toHaveLength(0);
  });

  it("L: unsupported audio asks before anything is turned off", async () => {
    const h = fixture([
      { kind: "incompatible", incompatibility: { kind: "audio", requested: "on", supported: [] } },
      CREATED,
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);

    const asked = await h.router(baseEvent({ content: "1" }), CTX);
    expect(asked?.text).toContain("ไม่รองรับ Audio");
    expect(asked?.text).toContain("ต้องการสร้างแบบไม่มีเสียงไหม?");
    expect(asked?.text).not.toMatch(/ยืนยัน VIDEO \d{4}/u);

    const agreed = await h.router(baseEvent({ content: "ไม่มีเสียง" }), CTX);
    expect(agreed?.text).toContain("ยืนยัน VIDEO 8821");
    // Audio is only dropped because the owner said so.
    expect(h.calls[1]?.overrides).toEqual({ audio: false });
  });

  it("M: unrelated chat during a pending question is not swallowed", async () => {
    const h = fixture([
      {
        kind: "incompatible",
        incompatibility: { kind: "duration", requested: "15", supported: ["6", "10"] },
      },
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);
    await h.router(baseEvent({ content: "1" }), CTX);

    expect(await h.router(baseEvent({ content: "วันนี้อากาศดีนะ" }), CTX)).toBeUndefined();
    // A length the model does not offer is not an answer either.
    expect(await h.router(baseEvent({ content: "25 วิ" }), CTX)).toBeUndefined();
    // The question is still open, so the old code is still the payable one.
    expect(await h.requotePendingStore.entries()).toHaveLength(1);
  });

  it("Q: the exact paid confirmation is never taken by a pending question", async () => {
    const h = fixture([
      {
        kind: "incompatible",
        incompatibility: { kind: "duration", requested: "15", supported: ["6", "10"] },
      },
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);
    await h.router(baseEvent({ content: "1" }), CTX);

    // Must fall through to the confirmation gate, which owns this exact phrase.
    expect(await h.router(baseEvent({ content: "ยืนยัน VIDEO 4716" }), CTX)).toBeUndefined();
  });

  it("N: a pending question never answers to another group or sender", async () => {
    const h = fixture([
      {
        kind: "incompatible",
        incompatibility: { kind: "duration", requested: "15", supported: ["6", "10"] },
      },
    ]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);
    await h.router(baseEvent({ content: "1" }), CTX);

    expect(
      await h.router(baseEvent({ content: "10 วิ" }), {
        accountId: "acct-1",
        conversationId: "grp-b",
      }),
    ).toBeUndefined();
    expect(
      await h.router(baseEvent({ content: "10 วิ", senderIsOwner: false }), CTX),
    ).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it("O: with no active storyboard the model change is preference-only", async () => {
    const h = fixture([{ kind: "no_active_storyboard" }]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);

    const chosen = await h.router(baseEvent({ content: "1" }), CTX);

    expect(chosen?.text).toBe("เปลี่ยน Video Model เป็น MiniMax: Hailuo H3 แล้ว");
    expect(chosen?.text).not.toMatch(/ยืนยัน VIDEO/u);
    expect((await h.preferenceStore.lookup("acct-1|grp-a"))?.model).toBe("minimax/hailuo-h3");
  });

  it("a failed quote keeps the preference and says the old code still works", async () => {
    const h = fixture([{ kind: "unavailable", reason: "catalog_unavailable" }]);
    await h.router(baseEvent({ content: "เปลี่ยน video model เป็น minimax h3" }), CTX);

    const chosen = await h.router(baseEvent({ content: "1" }), CTX);

    expect(chosen?.text).toContain("รหัส VIDEO เดิมยังใช้ได้อยู่");
    expect(chosen?.text).not.toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect((await h.preferenceStore.lookup("acct-1|grp-a"))?.model).toBe("minimax/hailuo-h3");
  });
});
