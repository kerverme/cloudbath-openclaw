// Line tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { LineConfigSchema } from "./config-schema.js";

describe("LineConfigSchema", () => {
  it('rejects dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });

    if (result.success) {
      throw new Error("Expected config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });

  it('accepts dmPolicy="open" with wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it('rejects account dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      accounts: {
        work: {
          channelAccessToken: "token",
          channelSecret: "secret",
          dmPolicy: "open",
        },
      },
    });

    if (result.success) {
      throw new Error("Expected account config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["accounts", "work", "allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });
});

describe("replyLanguage", () => {
  it("accepts an account default and a per-group override", () => {
    // Both schemas are strict, so an unknown key would fail outright: this
    // proves the field is actually part of the config contract.
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      replyLanguage: "th",
      groups: { Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { replyLanguage: "en" } },
    });

    expect(result.success).toBe(true);
  });

  it("accepts a per-account default", () => {
    const result = LineConfigSchema.safeParse({
      accounts: {
        default: { channelAccessToken: "token", channelSecret: "secret", replyLanguage: "th" },
      },
    });

    expect(result.success).toBe(true);
  });

  it("still rejects an unknown neighbouring key", () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      replyLanguag: "th",
    });

    expect(result.success).toBe(false);
  });
});
