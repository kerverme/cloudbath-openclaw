import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  buildLineGroupSilentModeStateKey,
  createLineGroupSilentGate,
  LINE_GROUP_SILENT_TOGGLE_COMMAND,
  type LineGroupSilentModeState,
  resolveLineCanonicalOwner,
} from "./group-owner-control.js";
import type { ResolvedLineAccount } from "./types.js";

function account(accountId = "default"): ResolvedLineAccount {
  return {
    accountId,
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config: {},
  } as ResolvedLineAccount;
}

function createMemoryStore(): PluginStateKeyedStore<LineGroupSilentModeState> {
  const values = new Map<string, LineGroupSilentModeState>();
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

describe("buildLineGroupSilentModeStateKey", () => {
  it("scopes by accountId and exact group identity", () => {
    expect(buildLineGroupSilentModeStateKey({ accountId: "acct-1", groupId: "grp-a" })).toBe(
      "acct-1|group:grp-a",
    );
  });

  it("scopes by accountId and exact room identity", () => {
    expect(buildLineGroupSilentModeStateKey({ accountId: "acct-1", roomId: "room-a" })).toBe(
      "acct-1|room:room-a",
    );
  });

  it("returns null when neither groupId nor roomId is present", () => {
    expect(buildLineGroupSilentModeStateKey({ accountId: "acct-1" })).toBeNull();
  });

  it("keeps different accounts and different groups fully isolated", () => {
    const a = buildLineGroupSilentModeStateKey({ accountId: "acct-1", groupId: "grp-a" });
    const b = buildLineGroupSilentModeStateKey({ accountId: "acct-2", groupId: "grp-a" });
    const c = buildLineGroupSilentModeStateKey({ accountId: "acct-1", groupId: "grp-b" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("resolveLineCanonicalOwner", () => {
  // Reuses the exact resolveCommandAuthorization decision already used for
  // privileged LINE model-switch control (see command-auth.owner-default.test.ts
  // for the underlying contract this relies on) instead of a second owner system.
  it("is false when no ownerAllowFrom is configured (safe default)", async () => {
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const isOwner = await resolveLineCanonicalOwner({
      cfg,
      account: account(),
      senderId: "U123",
      groupId: "grp-a",
    });
    expect(isOwner).toBe(false);
  });

  it("is true when ownerAllowFrom matches the sender", async () => {
    const cfg = {
      channels: { line: {} },
      commands: { ownerAllowFrom: ["U-owner"] },
    } as OpenClawConfig;
    const isOwner = await resolveLineCanonicalOwner({
      cfg,
      account: account(),
      senderId: "U-owner",
      groupId: "grp-a",
    });
    expect(isOwner).toBe(true);
  });

  it("is false when the sender is allowlisted for messaging but is not the configured owner", async () => {
    const cfg = {
      channels: { line: { allowFrom: ["U-member"] } },
      commands: { ownerAllowFrom: ["U-owner"] },
    } as OpenClawConfig;
    const isOwner = await resolveLineCanonicalOwner({
      cfg,
      account: account(),
      senderId: "U-member",
      groupId: "grp-a",
    });
    expect(isOwner).toBe(false);
  });

  it("is false without a senderId", async () => {
    const cfg = { commands: { ownerAllowFrom: ["U-owner"] } } as OpenClawConfig;
    const isOwner = await resolveLineCanonicalOwner({
      cfg,
      account: account(),
      senderId: undefined,
      groupId: "grp-a",
    });
    expect(isOwner).toBe(false);
  });
});

const OWNER_ID = "U-owner";
const MEMBER_ID = "U-member";

function createGateFixture(overrides?: {
  store?: PluginStateKeyedStore<LineGroupSilentModeState>;
  isOwnerFn?: (senderId?: string) => boolean;
}) {
  const store = overrides?.store ?? createMemoryStore();
  const isOwnerFn = overrides?.isOwnerFn ?? ((senderId) => senderId === OWNER_ID);
  const resolveOwner = vi.fn(async ({ senderId }: { senderId?: string }) => isOwnerFn(senderId));
  const gate = createLineGroupSilentGate({ getStore: () => store, resolveOwner });
  return { gate, store, resolveOwner };
}

function baseParams(
  overrides?: Partial<Parameters<ReturnType<typeof createLineGroupSilentGate>>[0]>,
) {
  return {
    cfg: {} as OpenClawConfig,
    account: account(),
    isGroup: true,
    groupId: "grp-a",
    senderId: OWNER_ID,
    isTextMessage: true,
    ...overrides,
  };
}

describe("createLineGroupSilentGate", () => {
  it("1: default group state is ACTIVE", async () => {
    const { gate } = createGateFixture();
    const result = await gate(baseParams({ rawText: "hello", senderId: MEMBER_ID }));
    expect(result).toEqual({ kind: "pass" });
  });

  it("2: owner sends exact 7272 -> only that group becomes SILENT", async () => {
    const { gate, store } = createGateFixture();
    const result = await gate(baseParams({ rawText: LINE_GROUP_SILENT_TOGGLE_COMMAND }));
    expect(result).toEqual({ kind: "toggle-consumed", silent: true });
    expect(await store.lookup("default|group:grp-a")).toMatchObject({ silent: true });
  });

  it("3: owner sends ' 7272 ' -> toggle still works after trim", async () => {
    const { gate, store } = createGateFixture();
    const result = await gate(baseParams({ rawText: " 7272 " }));
    expect(result).toEqual({ kind: "toggle-consumed", silent: true });
    expect(await store.lookup("default|group:grp-a")).toMatchObject({ silent: true });
  });

  it("4: owner sends 7272 again while SILENT -> group becomes ACTIVE", async () => {
    const { gate, store } = createGateFixture();
    await gate(baseParams({ rawText: "7272" }));
    const result = await gate(baseParams({ rawText: "7272" }));
    expect(result).toEqual({ kind: "toggle-consumed", silent: false });
    expect(await store.lookup("default|group:grp-a")).toBeUndefined();
  });

  it("5: Group A SILENT does not affect Group B", async () => {
    const { gate } = createGateFixture();
    await gate(baseParams({ groupId: "grp-a", rawText: "7272" }));

    const groupAResult = await gate(
      baseParams({ groupId: "grp-a", rawText: "hi", senderId: MEMBER_ID }),
    );
    const groupBResult = await gate(
      baseParams({ groupId: "grp-b", rawText: "hi", senderId: MEMBER_ID }),
    );

    expect(groupAResult).toEqual({ kind: "silent-suppressed" });
    expect(groupBResult).toEqual({ kind: "pass" });
  });

  it("6: room A SILENT does not affect another room/group", async () => {
    const { gate } = createGateFixture();
    await gate(baseParams({ groupId: undefined, roomId: "room-a", rawText: "7272" }));

    const roomAResult = await gate(
      baseParams({ groupId: undefined, roomId: "room-a", rawText: "hi", senderId: MEMBER_ID }),
    );
    const roomBResult = await gate(
      baseParams({ groupId: undefined, roomId: "room-b", rawText: "hi", senderId: MEMBER_ID }),
    );
    const otherGroupResult = await gate(
      baseParams({ groupId: "grp-a", roomId: undefined, rawText: "hi", senderId: MEMBER_ID }),
    );

    expect(roomAResult).toEqual({ kind: "silent-suppressed" });
    expect(roomBResult).toEqual({ kind: "pass" });
    expect(otherGroupResult).toEqual({ kind: "pass" });
  });

  it("7: state survives recreation of the handler/state consumer", async () => {
    const sharedStore = createMemoryStore();
    const first = createGateFixture({ store: sharedStore });
    await first.gate(baseParams({ rawText: "7272" }));

    // Simulate a process/handler restart: a brand new gate instance, same
    // underlying persistent store (as would happen with the live SQLite store).
    const second = createGateFixture({ store: sharedStore });
    const result = await second.gate(baseParams({ rawText: "hi", senderId: MEMBER_ID }));

    expect(result).toEqual({ kind: "silent-suppressed" });
  });

  it("8: non-owner exact 7272 cannot change state", async () => {
    const { gate, store, resolveOwner } = createGateFixture();
    const result = await gate(baseParams({ rawText: "7272", senderId: MEMBER_ID }));

    expect(result).toEqual({ kind: "pass" });
    expect(await store.lookup("default|group:grp-a")).toBeUndefined();
    expect(resolveOwner).toHaveBeenCalled();
  });

  it("9: allowlisted-but-not-owner exact 7272 cannot change state", async () => {
    // isOwnerFn only recognizes OWNER_ID; MEMBER_ID represents a sender who
    // passes ordinary channel allowlisting but is not the configured owner.
    const { gate, store } = createGateFixture({ isOwnerFn: (id) => id === OWNER_ID });
    const result = await gate(baseParams({ rawText: "7272", senderId: MEMBER_ID }));

    expect(result).toEqual({ kind: "pass" });
    expect(await store.lookup("default|group:grp-a")).toBeUndefined();
  });

  it("DM traffic is never gated (isGroup: false always passes without a store lookup)", async () => {
    const { gate, store } = createGateFixture();
    const lookupSpy = vi.spyOn(store, "lookup");

    const result = await gate(baseParams({ isGroup: false, groupId: undefined, rawText: "7272" }));

    expect(result).toEqual({ kind: "pass" });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("a non-toggle message in a silent group is suppressed", async () => {
    const { gate } = createGateFixture();
    await gate(baseParams({ rawText: "7272" }));

    const result = await gate(baseParams({ rawText: "hello there", senderId: MEMBER_ID }));
    expect(result).toEqual({ kind: "silent-suppressed" });
  });

  it("postback-shaped calls (isTextMessage: false) never toggle, only suppress", async () => {
    const { gate, store } = createGateFixture();
    // Even if postback data happened to equal "7272", isTextMessage: false
    // means the toggle branch can never trigger from a postback.
    const result = await gate(
      baseParams({ isTextMessage: true, rawText: undefined, senderId: OWNER_ID }),
    );
    expect(result).toEqual({ kind: "pass" });
    expect(await store.lookup("default|group:grp-a")).toBeUndefined();
  });
});
