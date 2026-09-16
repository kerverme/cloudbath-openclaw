/**
 * Resolving the expected reply language for a LINE conversation.
 *
 * The expectation must come from configuration, never from the model's output —
 * a reply written entirely in Russian answered a Thai question and passed
 * validation precisely because the validator asked the output what language it
 * was. These tests pin the hierarchy, and pin that adding this field changes
 * nothing about tools or authorization.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { resolveLineGroupToolPolicy } from "./group-tool-policy.js";
import { resolveLineReplyLanguage } from "./reply-language.js";

const GROUP_A = "Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_B = "Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const resolve = (cfg: unknown, groupId?: string, accountId = "default") =>
  resolveLineReplyLanguage({
    cfg: cfg as OpenClawConfig,
    accountId,
    ...(groupId ? { groupId } : {}),
  });

describe("nothing configured asserts no expectation", () => {
  it("reports source none when the channel is absent", () => {
    expect(resolve({})).toEqual({ source: "none" });
  });

  it("reports source none when LINE is configured without a language", () => {
    expect(resolve({ channels: { line: {} } }, GROUP_A)).toEqual({ source: "none" });
  });

  it("never invents an expectation from an unrelated group entry", () => {
    const cfg = { channels: { line: { groups: { [GROUP_A]: { requireMention: true } } } } };

    expect(resolve(cfg, GROUP_A)).toEqual({ source: "none" });
  });
});

describe("the account default applies to every group", () => {
  const cfg = { channels: { line: { replyLanguage: "th" } } };

  it("resolves the account default", () => {
    expect(resolve(cfg, GROUP_A)).toEqual({ language: "th", source: "account" });
  });

  it("applies to a group that has no entry at all", () => {
    expect(resolve(cfg, GROUP_B)).toEqual({ language: "th", source: "account" });
  });

  it("applies outside any group", () => {
    expect(resolve(cfg)).toEqual({ language: "th", source: "account" });
  });

  it("reads the per-account value ahead of the channel root", () => {
    const scoped = {
      channels: {
        line: { replyLanguage: "en", accounts: { default: { replyLanguage: "th" } } },
      },
    };

    expect(resolve(scoped, GROUP_A)).toEqual({ language: "th", source: "account" });
  });
});

describe("an explicit group override wins", () => {
  const cfg = {
    channels: {
      line: {
        replyLanguage: "th",
        groups: { [GROUP_A]: { replyLanguage: "en" } },
      },
    },
  };

  it("uses the group value for that group", () => {
    expect(resolve(cfg, GROUP_A)).toEqual({ language: "en", source: "group" });
  });

  it("leaves other groups on the account default", () => {
    expect(resolve(cfg, GROUP_B)).toEqual({ language: "th", source: "account" });
  });

  it("inherits the account default when a group entry omits the field", () => {
    // Absence of a field is not a statement about language.
    const partial = {
      channels: {
        line: { replyLanguage: "th", groups: { [GROUP_A]: { requireMention: true } } },
      },
    };

    expect(resolve(partial, GROUP_A)).toEqual({ language: "th", source: "account" });
  });

  it("honours a wildcard group entry as an explicit operator choice", () => {
    const wildcard = { channels: { line: { groups: { "*": { replyLanguage: "th" } } } } };

    expect(resolve(wildcard, GROUP_B)).toEqual({ language: "th", source: "group" });
  });
});

describe("tags are normalized to a primary subtag", () => {
  it("accepts a regional tag and keeps the primary subtag", () => {
    for (const tag of ["th-TH", "th_TH", "TH", " th "]) {
      expect(resolve({ channels: { line: { replyLanguage: tag } } })).toEqual({
        language: "th",
        source: "account",
      });
    }
  });

  it("rejects a value that cannot be a language subtag", () => {
    // A typo must read as "not configured" rather than become a policy.
    for (const bad of ["", "   ", "thai-language-please", "1", "t", "th!"]) {
      expect(resolve({ channels: { line: { replyLanguage: bad } } })).toEqual({ source: "none" });
    }
  });

  it("rejects a non-string value", () => {
    expect(resolve({ channels: { line: { replyLanguage: 42 } } })).toEqual({ source: "none" });
  });
});

describe("the language field does not widen tools or authorization", () => {
  it("leaves the unbound-group tool baseline exactly as it was", () => {
    // A group that states only a language is still unbound for tool purposes.
    const withLanguage = {
      channels: { line: { groups: { [GROUP_A]: { replyLanguage: "th" } } } },
    } as unknown as OpenClawConfig;
    const withoutLanguage = { channels: { line: {} } } as unknown as OpenClawConfig;
    const policyFor = (cfg: OpenClawConfig) =>
      resolveLineGroupToolPolicy({ cfg, groupId: GROUP_A, accountId: "default", senderId: "U1" });

    expect(policyFor(withLanguage)).toEqual(policyFor(withoutLanguage));
    expect(policyFor(withLanguage)?.deny).toContain("exec");
    expect(policyFor(withLanguage)?.deny).toContain("memory_search");
  });

  it("does not grant a tool even when paired with a tools policy", () => {
    const cfg = {
      channels: {
        line: {
          groups: { [GROUP_A]: { replyLanguage: "th", tools: { deny: ["image_generate"] } } },
        },
      },
    } as unknown as OpenClawConfig;

    // The operator's tools policy still wins whole; language is orthogonal.
    expect(
      resolveLineGroupToolPolicy({ cfg, groupId: GROUP_A, accountId: "default", senderId: "U1" }),
    ).toEqual({ deny: ["image_generate"] });
  });
});

describe("group config does not reach a direct conversation", () => {
  // `groups["*"]` is the operator's statement about GROUPS. A direct message has
  // no group identity, so applying it there would let group policy decide a
  // one-to-one conversation's language — a scope the operator never wrote.
  const wildcard = {
    channels: { line: { replyLanguage: "en", groups: { "*": { replyLanguage: "th" } } } },
  };

  it("keeps the account default when there is no group or room at all", () => {
    expect(resolve(wildcard)).toEqual({ language: "en", source: "account" });
  });

  it("keeps the account default when the group id is blank", () => {
    for (const blank of ["", "   "]) {
      expect(resolve(wildcard, blank)).toEqual({ language: "en", source: "account" });
    }
  });

  it("asserts nothing in a direct conversation when only a wildcard group is configured", () => {
    const groupsOnly = { channels: { line: { groups: { "*": { replyLanguage: "th" } } } } };

    expect(resolve(groupsOnly)).toEqual({ source: "none" });
  });

  it("still applies the wildcard inside a real group", () => {
    expect(resolve(wildcard, GROUP_B)).toEqual({ language: "th", source: "group" });
  });
});
