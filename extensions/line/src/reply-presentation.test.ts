/**
 * The policy LINE hands to core.
 *
 * Core knows no product vocabulary, so everything here is what the channel
 * contributes: the expected language, proper nouns that may stay in another
 * script, the Thai wording used when a reply cannot be repaired, and whether
 * THIS turn was asked for in more than one language.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import {
  requestDeclaresMultilingualTurn,
  resolveLineReplyPresentation,
} from "./reply-presentation.js";

const GROUP_A = "Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";

const resolve = (cfg: unknown, overrides?: { groupId?: string; requestText?: string }) =>
  resolveLineReplyPresentation({
    cfg: cfg as OpenClawConfig,
    accountId: "default",
    groupId: overrides?.groupId ?? null,
    requestText: overrides?.requestText ?? null,
  });

describe("nothing configured means no policy at all", () => {
  it("returns undefined when no reply language is set", () => {
    expect(resolve({ channels: { line: {} } })).toBeUndefined();
  });

  it("returns undefined when LINE is not configured", () => {
    expect(resolve({})).toBeUndefined();
  });
});

describe("a configured language produces a policy", () => {
  const cfg = { channels: { line: { replyLanguage: "th" } } };

  it("carries the language, its source and Thai fallback wording", () => {
    expect(resolve(cfg)).toEqual({
      expectedReplyLanguage: "th",
      expectedReplyLanguageSource: "account",
      fallbackText: FALLBACK,
    });
  });

  it("never claims anything was done in its fallback wording", () => {
    const fallback = resolve(cfg)?.fallbackText ?? "";

    for (const claim of ["เรียบร้อย", "สำเร็จ", "ส่งแล้ว", "บันทึกแล้ว"]) {
      expect(fallback).not.toContain(claim);
    }
  });

  it("falls back in English for a language it has no wording for", () => {
    const policy = resolve({ channels: { line: { replyLanguage: "ja" } } });

    expect(policy?.expectedReplyLanguage).toBe("ja");
    expect(policy?.fallbackText).toBe("Sorry — that reply came out malformed. Please ask again.");
  });

  it("reports a group override as such", () => {
    const scoped = {
      channels: { line: { replyLanguage: "th", groups: { [GROUP_A]: { replyLanguage: "en" } } } },
    };

    expect(resolve(scoped, { groupId: GROUP_A })).toMatchObject({
      expectedReplyLanguage: "en",
      expectedReplyLanguageSource: "group",
    });
  });
});

describe("allowed terms are operator data, not core knowledge", () => {
  it("omits the field when no terms are configured", () => {
    expect(resolve({ channels: { line: { replyLanguage: "th" } } })).not.toHaveProperty(
      "allowedTerms",
    );
  });

  it("merges account and group terms without duplicates", () => {
    const cfg = {
      channels: {
        line: {
          replyLanguage: "th",
          replyLanguageAllowedTerms: ["ライン", " "],
          groups: { [GROUP_A]: { replyLanguageAllowedTerms: ["ライン", "Мойка"] } },
        },
      },
    };

    expect(resolve(cfg, { groupId: GROUP_A })?.allowedTerms).toEqual(["ライン", "Мойка"]);
  });
});

describe("a multilingual turn is declared by the request, never by the reply", () => {
  const cfg = { channels: { line: { replyLanguage: "th" } } };

  it("marks an explicit translation request", () => {
    for (const request of [
      "แปลคำนี้เป็นภาษารัสเซีย",
      "ตอบเป็นภาษาอังกฤษหน่อย",
      "translate this into Russian",
      "please reply in English",
    ]) {
      expect(resolve(cfg, { requestText: request })).toMatchObject({
        allowIntentionalMultilingual: true,
      });
    }
  });

  it("leaves an ordinary request validated", () => {
    for (const request of [
      "ช่วยจัดคิวงานให้หน่อยครับ",
      "ส่งรูปล่าสุดมาให้ดูหน่อย",
      "what happened to the last render?",
    ]) {
      expect(resolve(cfg, { requestText: request })).not.toHaveProperty(
        "allowIntentionalMultilingual",
      );
    }
  });

  it("does not read the model's own output", () => {
    // A reply that drifted into Russian is the bug; it must not excuse itself.
    expect(requestDeclaresMultilingualTurn("Привет, я могу помочь вам с этим.")).toBe(false);
    expect(resolve(cfg, { requestText: null })).not.toHaveProperty("allowIntentionalMultilingual");
  });
});
