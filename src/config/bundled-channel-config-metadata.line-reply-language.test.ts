/**
 * The canonical config schema must accept the LINE fields the plugin declares.
 *
 * `channels.<id>` is validated against the JSON Schema baked into
 * `bundled-channel-config-metadata.generated.ts`, not against the plugin's Zod
 * schema at runtime. That generated file went stale when `replyLanguage` and
 * `replyLanguageAllowedTerms` were added, so the deployed CLI refused the very
 * key the plugin had just started reading:
 *
 *   channels.line: invalid config: must not have additional properties: "replyLanguage"
 *
 * These cases pin the shapes an operator actually writes. The schema stays
 * strict — the neighbouring typo must still be refused — so this is a
 * regeneration guard, not a relaxation.
 */
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

/** The smallest LINE block the schema accepts; both keys are required. */
const LINE_BASE = { dmPolicy: "open", groupPolicy: "allowlist" } as const;

function validateLine(line: Record<string, unknown>): string[] {
  const result = validateConfigObjectRaw(
    { channels: { line } } as never,
    { validateBundledChannels: true } as never,
  );
  return result.ok
    ? []
    : result.issues
        .filter((issue) => (issue.severity ?? "error") === "error")
        .map((issue) => `${issue.path}: ${issue.message}`);
}

describe("the canonical schema accepts LINE reply-language config", () => {
  it.each([
    ["channel-level replyLanguage", { ...LINE_BASE, replyLanguage: "th" }],
    [
      "channel-level replyLanguageAllowedTerms",
      { ...LINE_BASE, replyLanguageAllowedTerms: ["Cloudbath", "ไลน์"] },
    ],
    [
      "account-level replyLanguage",
      { ...LINE_BASE, accounts: { default: { ...LINE_BASE, replyLanguage: "th" } } },
    ],
    ["group-level replyLanguage", { ...LINE_BASE, groups: { Cabc: { replyLanguage: "th" } } }],
    [
      "group-level replyLanguageAllowedTerms",
      { ...LINE_BASE, groups: { Cabc: { replyLanguageAllowedTerms: ["Storyboard"] } } },
    ],
  ])("accepts %s", (_label, line) => {
    expect(validateLine(line as Record<string, unknown>)).toStrictEqual([]);
  });

  it("still refuses a neighbouring typo", () => {
    // The schema must stay strict: accepting the real key is a regeneration,
    // not a loosening of channels.line to unknown properties.
    expect(validateLine({ ...LINE_BASE, replyLangauge: "th" })).toContainEqual(
      expect.stringContaining('must not have additional properties: "replyLangauge"'),
    );
  });

  it("still refuses an unknown group-level key", () => {
    expect(validateLine({ ...LINE_BASE, groups: { Cabc: { replyLanguag: "th" } } })).toContainEqual(
      expect.stringContaining("must not have additional properties"),
    );
  });
});
