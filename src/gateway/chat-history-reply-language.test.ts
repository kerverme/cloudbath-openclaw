/**
 * The Control UI must not keep showing a reply the turn already rejected.
 *
 * Production: a Thai LINE group turn produced `페이스` — Hangul — inside Thai
 * prose. `validateReplyLanguage` flags it, delivery replaced it, and LINE
 * received the repaired wording. The Control UI showed the Hangul, and kept
 * showing it, because for a LINE turn the UI's view of the conversation is
 * history, and history is the transcript: the provider's raw assistant message,
 * written before the turn's decision existed and never revisited.
 *
 * Fixtures are synthetic. The Hangul token is the one from production because
 * the script is the point; everything around it is invented.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TurnPresentationPolicy } from "../infra/reply-language-policy.js";
import { applyAuthoritativeReplyLanguageToHistory } from "./chat-history-reply-language.js";

const FALLBACK = "ขออภัยครับ ข้อความตอบกลับเมื่อกี้มีปัญหา กรุณาลองอีกครั้ง";
const THAI: TurnPresentationPolicy = {
  expectedReplyLanguage: "th",
  expectedReplyLanguageSource: "account",
  fallbackText: FALLBACK,
};
const CFG = {} as OpenClawConfig;

/** The production token: Korean for "pace", inside Thai prose. */
const HANGUL_REPLY = "เข้าใจแล้ว — 페이스 5 คือ pace 5:00 ต่อกิโลเมตรครับ\nซ้อมตามนี้ได้เลย";
const CLEAN_REPLY = "เดือน 1-2: วิ่งสบาย ๆ 5-7 กิโลเมตร แล้วดู insights กับ engagement ครับ";

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function apply(messages: unknown[], policy: TurnPresentationPolicy = THAI) {
  return applyAuthoritativeReplyLanguageToHistory({
    messages,
    cfg: CFG,
    channel: "line",
    accountId: "default",
    groupId: "C1234567890abcdef",
    sessionKey: "agent:main:line:group:C1234567890abcdef",
    resolvePolicy: () => policy,
  }) as Record<string, unknown>[];
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content)
    ? content
        .map((block) => (block as { text?: unknown }).text)
        .filter((text): text is string => typeof text === "string")
        .join("")
    : "";
}

describe("history shows the reply the turn decided on", () => {
  it("does not render a Hangul token the policy rejects", () => {
    const [, replied] = apply([user("เพจ 5 คืออะไร"), assistant(HANGUL_REPLY)]);

    expect(/\p{Script=Hangul}/u.test(textOf(replied))).toBe(false);
  });

  it("leaves a clean Thai reply with English product terms exactly as written", () => {
    const history = [user("วางแผนซ้อมให้หน่อย"), assistant(CLEAN_REPLY)];

    // Same array back: an ordinary page allocates nothing.
    expect(apply(history)).toBe(history);
  });

  it("leaves the user's own turns alone", () => {
    const [asked] = apply([user(HANGUL_REPLY), assistant(CLEAN_REPLY)]);

    // History is a record of what was said, and the user said it.
    expect(textOf(asked)).toBe(HANGUL_REPLY);
  });

  it("keeps a deliberately multilingual turn intact", () => {
    // The request that declared the override is still right there in history,
    // which is why the policy is resolved per assistant message rather than
    // once per page.
    const korean = "페이스 is 페이스 in Korean";
    const history = [user("แปลเป็นภาษาเกาหลีว่า pace"), assistant(korean)];

    const repaired = applyAuthoritativeReplyLanguageToHistory({
      messages: history,
      cfg: CFG,
      channel: "line",
      resolvePolicy: ({ requestText }) =>
        requestText?.includes("แปล")
          ? {
              ...THAI,
              multilingualOverride: { allowed: true, reason: "request_asks_to_translate" },
            }
          : THAI,
    });

    expect(repaired).toBe(history);
  });

  it("carries a confirmation code into the fallback rather than losing it", () => {
    const [, replied] = apply([
      user("โค้ดอะไร"),
      assistant(`รหัสยืนยัน VIDEO 4821 페이스\n페이스 5 인터벌 훈련을 계속하세요`),
    ]);

    expect(textOf(replied)).toBe(`${FALLBACK}\nVIDEO 4821`);
  });

  it("carries a link into the fallback as its exact span", () => {
    const [, replied] = apply([
      user("ลิงก์"),
      assistant("ดูที่ https://example.com/a 페이스\n페이스 5 인터벌 훈련을 계속하세요"),
    ]);

    expect(textOf(replied)).toBe(`${FALLBACK}\nhttps://example.com/a`);
  });
});

describe("history is left alone when nothing declared an expectation", () => {
  it("returns the same messages with no policy", () => {
    const history = [user("hi"), assistant(HANGUL_REPLY)];

    expect(
      applyAuthoritativeReplyLanguageToHistory({
        messages: history,
        cfg: CFG,
        channel: "line",
        resolvePolicy: () => undefined,
      }),
    ).toBe(history);
  });

  it("returns the same messages with no channel", () => {
    const history = [user("hi"), assistant(HANGUL_REPLY)];

    expect(
      applyAuthoritativeReplyLanguageToHistory({ messages: history, cfg: CFG, channel: null }),
    ).toBe(history);
  });

  it("survives a policy resolver that throws", () => {
    const history = [user("hi"), assistant(HANGUL_REPLY)];

    expect(
      applyAuthoritativeReplyLanguageToHistory({
        messages: history,
        cfg: CFG,
        channel: "line",
        resolvePolicy: () => {
          throw new Error("plugin not loaded");
        },
      }),
    ).toBe(history);
  });

  it("ignores messages that carry no text", () => {
    const history = [{ role: "assistant", content: [{ type: "image", url: "x" }] }];

    expect(apply(history)).toBe(history);
  });
});

describe("the repair does not mutate what it was given", () => {
  it("leaves the caller's own message objects untouched", () => {
    const original = assistant(HANGUL_REPLY);
    const history = [user("เพจ 5 คืออะไร"), original];

    apply(history);

    expect(textOf(original)).toBe(HANGUL_REPLY);
  });
});

describe("the diagnostic names scripts, never characters", () => {
  it("records the decision without the offending token", async () => {
    const emitted: Record<string, unknown>[] = [];
    vi.resetModules();
    vi.doMock("../infra/chat-projection-trace.js", () => ({
      traceChatProjection: (fields: Record<string, unknown>) => emitted.push(fields),
    }));
    const { applyAuthoritativeReplyLanguageToHistory: applyMocked } =
      await import("./chat-history-reply-language.js");

    applyMocked({
      messages: [user("เพจ 5 คืออะไร"), assistant(HANGUL_REPLY)],
      cfg: CFG,
      channel: "line",
      sessionKey: "agent:main:line:group:C1",
      resolvePolicy: () => THAI,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      expectedLanguage: "th",
      expectedLanguageSource: "account",
      validationReason: "foreign_script",
      violatingScripts: ["Hangul"],
    });
    expect(JSON.stringify(emitted[0])).not.toContain("페이스");
    vi.doUnmock("../infra/chat-projection-trace.js");
  });
});
