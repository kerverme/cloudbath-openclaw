/**
 * Two LINE groups under one `agent:main`.
 *
 * Production reported a brand new group behaving as if it carried the main
 * agent's workspace: it reached other conversations' history and the agent-wide
 * memory index. The session key was never the problem — it is already derived
 * from the native LINE conversation id — so these tests pin the two things that
 * actually decide isolation: the key each group routes to, and the tool surface
 * each group is handed.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { buildAgentSessionKey, buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { resolveLineGroupToolPolicy } from "./group-tool-policy.js";

/** Group A is established and busy; group B is the newly added one. */
const GROUP_A = "Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_B = "Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function sessionKeyFor(groupId: string) {
  return buildAgentSessionKey({
    agentId: "main",
    channel: "line",
    accountId: "default",
    peer: { kind: "group", id: groupId },
  });
}

describe("a new LINE group routes to its own session", () => {
  it("keys the session by the native LINE conversation id", () => {
    expect(sessionKeyFor(GROUP_B)).toBe(`agent:main:line:group:${GROUP_B.toLowerCase()}`);
  });

  it("gives two groups different session keys under the same agent", () => {
    expect(sessionKeyFor(GROUP_A)).not.toBe(sessionKeyFor(GROUP_B));
  });

  it("keys group history separately too", () => {
    const historyFor = (groupId: string) =>
      buildGroupHistoryKey({
        channel: "line",
        accountId: "default",
        peerKind: "group",
        peerId: groupId,
      });

    expect(historyFor(GROUP_A)).not.toBe(historyFor(GROUP_B));
  });

  it("does not collapse groups onto the shared agent main key", () => {
    // `agent:main` is the DM/main session. A group landing there is what
    // "inherits the main agent workspace" would actually look like.
    expect(sessionKeyFor(GROUP_B)).not.toBe("agent:main:main");
  });
});

describe("group B cannot reach group A through a tool", () => {
  const cfg = { channels: { line: {} } } as unknown as OpenClawConfig;
  const policyFor = (groupId: string) =>
    resolveLineGroupToolPolicy({ cfg, groupId, accountId: "default", senderId: "Usomeone" });

  it("has no cross-session history tool", () => {
    // Session keys alone do not isolate anything while a tool can read any
    // other session by key; this is the gate that makes the key meaningful.
    expect(policyFor(GROUP_B)?.deny).toContain("sessions_history");
    expect(policyFor(GROUP_B)?.deny).toContain("sessions_list");
  });

  it("has no agent-wide memory search", () => {
    // memory_search is scoped per agent, not per conversation, so leaving it on
    // makes every group searchable from every other group.
    expect(policyFor(GROUP_B)?.deny).toContain("memory_search");
    expect(policyFor(GROUP_B)?.deny).toContain("memory_get");
  });

  it("cannot send into group A's session", () => {
    expect(policyFor(GROUP_B)?.deny).toContain("sessions_send");
  });

  it("cannot read the agent workspace off disk", () => {
    for (const tool of ["read", "exec", "process"]) {
      expect(policyFor(GROUP_B)?.deny).toContain(tool);
    }
  });

  it("applies independently of whether group A was ever active", () => {
    expect(policyFor(GROUP_B)).toEqual(policyFor(GROUP_A));
  });
});
