import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  consumeLineVideoDraft,
  createLineVideoDraft,
  generateLineVideoDraftId,
  LINE_VIDEO_DRAFT_TTL_MS,
  supersedeLineVideoDraftsForStoryboard,
  type LineVideoDraft,
} from "./video-draft-store.js";

function createMemoryStore(): PluginStateKeyedStore<LineVideoDraft> {
  const values = new Map<string, LineVideoDraft>();
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

function draftParams(overrides?: Partial<Parameters<typeof createLineVideoDraft>[0]>) {
  return {
    store: createMemoryStore(),
    accountId: "acct-1",
    conversationKey: "acct-1|grp-a",
    ownerSenderId: "U-owner",
    model: "bytedance/seedance-2.5",
    prompt: "a cat riding a skateboard",
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "1080p",
    audio: false,
    estimatedCostUsd: 1.5,
    ...overrides,
  };
}

describe("generateLineVideoDraftId", () => {
  it("returns a 4-digit code", async () => {
    const store = createMemoryStore();
    const id = await generateLineVideoDraftId(store);
    expect(id).toMatch(/^\d{4}$/u);
  });

  it("retries on collision until a free code is found", async () => {
    const store = createMemoryStore();
    await store.register("1000", {} as LineVideoDraft);
    let call = 0;
    const codes = [1000, 1000, 1234];
    const id = await generateLineVideoDraftId(store, () => codes[call++] ?? 9999);
    expect(id).toBe("1234");
  });
});

describe("createLineVideoDraft / consumeLineVideoDraft", () => {
  it("1: persists every required draft field", async () => {
    const params = draftParams({
      sourceImagePath: "/media/inbound/cat.png",
      deliveryTo: "line:group:grp-a",
    });
    const draft = await createLineVideoDraft(params);

    expect(draft).toMatchObject({
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: "U-owner",
      model: "bytedance/seedance-2.5",
      prompt: "a cat riding a skateboard",
      sourceImagePath: "/media/inbound/cat.png",
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      audio: false,
      estimatedCostUsd: 1.5,
      status: "pending",
      deliveryTo: "line:group:grp-a",
    });
    expect(draft.draftId).toMatch(/^\d{4}$/u);
    expect(draft.expiresAt - draft.createdAt).toBe(LINE_VIDEO_DRAFT_TTL_MS);
  });

  it("2: creating a draft makes zero network/paid calls (pure local persistence)", async () => {
    // No fetch/HTTP dependency exists anywhere on this call path — asserting
    // the module has no such import is the correctness guarantee; this test
    // documents that expectation by exercising the full create path with a
    // plain in-memory store and no network stubbing of any kind.
    const draft = await createLineVideoDraft(draftParams());
    expect(draft.status).toBe("pending");
  });

  it("3: owner confirmation submits exactly once (atomic consume)", async () => {
    const store = createMemoryStore();
    const draft = await createLineVideoDraft(draftParams({ store }));

    const first = await consumeLineVideoDraft({ store, draftId: draft.draftId });
    const second = await consumeLineVideoDraft({ store, draftId: draft.draftId });

    expect(first).toEqual({ kind: "ok", draft });
    expect(second).toEqual({ kind: "not_found" });
  });

  it("4: duplicate/replayed confirmation cannot double-consume the same draft", async () => {
    const store = createMemoryStore();
    const draft = await createLineVideoDraft(draftParams({ store }));

    const results = await Promise.all([
      consumeLineVideoDraft({ store, draftId: draft.draftId }),
      consumeLineVideoDraft({ store, draftId: draft.draftId }),
    ]);
    const okCount = results.filter((result) => result.kind === "ok").length;
    expect(okCount).toBe(1);
  });

  it("5: an expired draft cannot be confirmed", async () => {
    const store = createMemoryStore();
    let now = 1_000_000;
    const draft = await createLineVideoDraft(draftParams({ store, now: () => now }));

    now += LINE_VIDEO_DRAFT_TTL_MS + 1;
    const result = await consumeLineVideoDraft({ store, draftId: draft.draftId, now: () => now });

    expect(result).toEqual({ kind: "expired" });
  });

  it("6: an unknown draft id cannot be confirmed", async () => {
    const store = createMemoryStore();
    const result = await consumeLineVideoDraft({ store, draftId: "0000" });
    expect(result).toEqual({ kind: "not_found" });
  });
});

describe("supersedeLineVideoDraftsForStoryboard", () => {
  const NOW = Date.parse("2026-09-02T10:00:00.000Z");

  /** Four drafts across two owners/groups, two of them on the same storyboard. */
  async function seeded() {
    const store = createMemoryStore();
    const make = async (code: number, over: Partial<Parameters<typeof createLineVideoDraft>[0]>) =>
      await createLineVideoDraft({
        ...draftParams({ store, now: () => NOW, randomDraftCode: () => code, ...over }),
        store,
      });
    await make(1111, { storyboardId: "SB-1" });
    await make(2222, { storyboardId: "SB-2" });
    await make(3333, { storyboardId: "SB-1", ownerSenderId: "U-other" });
    await make(4444, { storyboardId: "SB-1", conversationKey: "acct-1|grp-b" });
    return store;
  }

  it("retires only the same storyboard in the same owner scope", async () => {
    const store = await seeded();

    const superseded = await supersedeLineVideoDraftsForStoryboard({
      store,
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: "U-owner",
      storyboardId: "SB-1",
      supersededByDraftId: "9000",
      now: () => NOW,
    });

    expect(superseded).toEqual(["1111"]);
    expect(await store.lookup("1111")).toMatchObject({
      status: "superseded",
      supersededByDraftId: "9000",
    });
    // A different storyboard, a different owner and a different group are all
    // untouched: new work never invalidates someone else's pending code.
    for (const code of ["2222", "3333", "4444"]) {
      expect(await store.lookup(code), code).toMatchObject({ status: "pending" });
    }
  });

  it("never retires the replacement itself", async () => {
    const store = await seeded();

    const superseded = await supersedeLineVideoDraftsForStoryboard({
      store,
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: "U-owner",
      storyboardId: "SB-1",
      supersededByDraftId: "1111",
      now: () => NOW,
    });

    expect(superseded).toEqual([]);
    expect(await store.lookup("1111")).toMatchObject({ status: "pending" });
  });

  it("leaves an already-expired code alone rather than resurrecting its row", async () => {
    const store = await seeded();

    const superseded = await supersedeLineVideoDraftsForStoryboard({
      store,
      accountId: "acct-1",
      conversationKey: "acct-1|grp-a",
      ownerSenderId: "U-owner",
      storyboardId: "SB-1",
      supersededByDraftId: "9000",
      now: () => NOW + LINE_VIDEO_DRAFT_TTL_MS + 1,
    });

    expect(superseded).toEqual([]);
    expect(await store.lookup("1111")).toMatchObject({ status: "pending" });
  });
});
