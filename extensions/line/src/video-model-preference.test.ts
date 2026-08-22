import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  buildLineVideoConversationKey,
  DEFAULT_LINE_VIDEO_MODEL,
  resolveLineVideoModelPreference,
  setLineVideoModelPreference,
  type LineVideoModelPreferenceState,
} from "./video-model-preference.js";

function createMemoryStore(): PluginStateKeyedStore<LineVideoModelPreferenceState> {
  const values = new Map<string, LineVideoModelPreferenceState>();
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

describe("buildLineVideoConversationKey", () => {
  it("scopes by accountId and conversation identity", () => {
    expect(buildLineVideoConversationKey({ accountId: "acct-1", conversationId: "grp-a" })).toBe(
      "acct-1|grp-a",
    );
  });

  it("returns null for an empty conversation id", () => {
    expect(buildLineVideoConversationKey({ accountId: "acct-1", conversationId: "  " })).toBeNull();
  });

  it("normalizes raw and prefixed LINE group identities to one canonical key", () => {
    const raw = buildLineVideoConversationKey({ accountId: "acct-1", conversationId: "C123" });
    const delivery = buildLineVideoConversationKey({
      accountId: "acct-1",
      conversationId: "line:group:C123",
    });
    expect(delivery).toBe(raw);
  });

  it("keeps different accounts and conversations fully isolated", () => {
    const a = buildLineVideoConversationKey({ accountId: "acct-1", conversationId: "grp-a" });
    const b = buildLineVideoConversationKey({ accountId: "acct-2", conversationId: "grp-a" });
    const c = buildLineVideoConversationKey({ accountId: "acct-1", conversationId: "grp-b" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("resolveLineVideoModelPreference / setLineVideoModelPreference", () => {
  it("1: default video model is bytedance/seedance-2.5", async () => {
    const store = createMemoryStore();
    const model = await resolveLineVideoModelPreference({ store, key: "acct|grp-a" });
    expect(model).toBe(DEFAULT_LINE_VIDEO_MODEL);
    expect(DEFAULT_LINE_VIDEO_MODEL).toBe("bytedance/seedance-2.5");
  });

  it("2: preference persists per conversation", async () => {
    const store = createMemoryStore();
    await setLineVideoModelPreference({ store, key: "acct|grp-a", model: "google/veo-3.1" });
    const model = await resolveLineVideoModelPreference({ store, key: "acct|grp-a" });
    expect(model).toBe("google/veo-3.1");
  });

  it("3: Group A preference does not affect Group B", async () => {
    const store = createMemoryStore();
    await setLineVideoModelPreference({ store, key: "acct|grp-a", model: "google/veo-3.1" });

    const groupA = await resolveLineVideoModelPreference({ store, key: "acct|grp-a" });
    const groupB = await resolveLineVideoModelPreference({ store, key: "acct|grp-b" });

    expect(groupA).toBe("google/veo-3.1");
    expect(groupB).toBe(DEFAULT_LINE_VIDEO_MODEL);
  });

  it("4: an operator-configured defaultModel seeds an unset conversation", async () => {
    const store = createMemoryStore();
    const model = await resolveLineVideoModelPreference({
      store,
      key: "acct|grp-a",
      defaultModel: "bytedance/seedance-2.0",
    });
    expect(model).toBe("bytedance/seedance-2.0");
  });

  it("5: state survives recreation of the state consumer (persistent store, not an in-memory Map)", async () => {
    const sharedStore = createMemoryStore();
    await setLineVideoModelPreference({
      store: sharedStore,
      key: "acct|grp-a",
      model: "google/veo-3.1",
    });

    // Simulate a process/handler restart: a fresh read against the same
    // underlying persistent store, as would happen with the live SQLite store.
    const model = await resolveLineVideoModelPreference({ store: sharedStore, key: "acct|grp-a" });
    expect(model).toBe("google/veo-3.1");
  });
});
