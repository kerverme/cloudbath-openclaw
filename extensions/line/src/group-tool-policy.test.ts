/**
 * The tool surface a LINE group actually gets.
 *
 * Production shape: two groups under the same `agent:main`, one never
 * configured. The unconfigured one is the case that shipped privileged tools —
 * ordinary messages in a brand new group reached shell, cross-session history
 * and agent-wide memory because no group entry existed to restrict them.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import {
  LINE_UNBOUND_GROUP_DENIED_TOOLS,
  resolveLineGroupToolPolicy,
} from "./group-tool-policy.js";

const GROUP_A = "Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_B = "Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function policyFor(cfg: unknown, groupId: string, senderId = "Uowner") {
  return resolveLineGroupToolPolicy({
    cfg: cfg as OpenClawConfig,
    groupId,
    accountId: "default",
    senderId,
  });
}

describe("an unbound LINE group does not inherit the agent's privileged tools", () => {
  it("denies shell and host access in a group with no config at all", () => {
    const policy = policyFor({ channels: { line: {} } }, GROUP_B);

    for (const tool of ["exec", "process", "code_execution", "read", "write"]) {
      expect(policy?.deny).toContain(tool);
    }
  });

  it("denies the tools that reach other conversations", () => {
    const policy = policyFor({ channels: { line: {} } }, GROUP_B);

    // These are the exact tools the production transcript showed a new group
    // invoking on its first ordinary messages.
    for (const tool of ["sessions_history", "memory_search", "session_status"]) {
      expect(policy?.deny).toContain(tool);
    }
  });

  it("denies agent-wide memory and goal state", () => {
    const policy = policyFor({ channels: { line: {} } }, GROUP_B);

    for (const tool of ["memory_get", "get_goal", "create_goal", "update_goal", "update_plan"]) {
      expect(policy?.deny).toContain(tool);
    }
  });

  it("denies operator and remote-control surfaces", () => {
    const policy = policyFor({ channels: { line: {} } }, GROUP_B);

    for (const tool of ["gateway", "cron", "nodes", "agents_list", "browser", "computer"]) {
      expect(policy?.deny).toContain(tool);
    }
  });

  it("leaves conversation, media and plugin tools available", () => {
    const policy = policyFor({ channels: { line: {} } }, GROUP_B);

    // The baseline is a deny list, so anything absent from it stays available:
    // normal chat, image and storyboard work must keep working in a new group.
    for (const tool of [
      "message",
      "image",
      "image_generate",
      "video_generate",
      "tts",
      "web_search",
      "cloudbath_storyboard",
    ]) {
      expect(policy?.deny).not.toContain(tool);
    }
    expect(policy?.allow).toBeUndefined();
  });

  it("applies the same baseline when the channel is absent from config entirely", () => {
    expect(policyFor({}, GROUP_B)?.deny).toContain("exec");
  });

  it("applies to every group id, not a remembered one", () => {
    expect(policyFor({ channels: { line: {} } }, GROUP_A)?.deny).toEqual(
      policyFor({ channels: { line: {} } }, GROUP_B)?.deny,
    );
  });
});

describe("configured group policy is the operator's decision and wins whole", () => {
  const cfg = {
    channels: {
      line: {
        groups: {
          [GROUP_A]: { tools: { alsoAllow: ["exec"] } },
        },
      },
    },
  };

  it("honours an explicit group tools entry instead of the baseline", () => {
    const policy = policyFor(cfg, GROUP_A);

    expect(policy).toEqual({ alsoAllow: ["exec"] });
    expect(policy?.deny).toBeUndefined();
  });

  it("does not leak that grant to a different group", () => {
    // Group B was never configured, so Group A's exec grant must not reach it.
    expect(policyFor(cfg, GROUP_B)?.deny).toContain("exec");
  });

  it("honours a wildcard group entry as an explicit operator choice", () => {
    const wildcard = {
      channels: { line: { groups: { "*": { tools: { deny: ["image_generate"] } } } } },
    };

    expect(policyFor(wildcard, GROUP_B)).toEqual({ deny: ["image_generate"] });
  });

  it("honours a per-sender policy ahead of the group entry", () => {
    const bySender = {
      channels: {
        line: {
          groups: {
            [GROUP_A]: {
              tools: { deny: ["exec"] },
              toolsBySender: { "id:Uowner": { alsoAllow: ["exec"] } },
            },
          },
        },
      },
    };

    expect(policyFor(bySender, GROUP_A, "Uowner")).toEqual({ alsoAllow: ["exec"] });
    expect(policyFor(bySender, GROUP_A, "Ustranger")).toEqual({ deny: ["exec"] });
  });

  it("falls back to the baseline when a group entry sets no tools policy", () => {
    // requireMention alone is not a statement about tools, so the group is
    // still unbound for this purpose.
    const mentionOnly = {
      channels: { line: { groups: { [GROUP_A]: { requireMention: true } } } },
    };

    expect(policyFor(mentionOnly, GROUP_A)?.deny).toContain("exec");
  });
});

describe("the baseline list itself", () => {
  it("is frozen so a caller cannot widen it at runtime", () => {
    expect(Object.isFrozen(LINE_UNBOUND_GROUP_DENIED_TOOLS)).toBe(true);
  });

  it("hands out a copy, so mutating one group's policy cannot affect the next", () => {
    const first = policyFor({}, GROUP_A);
    first?.deny?.push("message");

    expect(policyFor({}, GROUP_B)?.deny).not.toContain("message");
  });
});
