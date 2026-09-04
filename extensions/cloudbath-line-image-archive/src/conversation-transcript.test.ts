/**
 * What is allowed to leave the transcript and reach a model prompt.
 *
 * The reader is the one place this flow touches conversation history, and its
 * output is serialized into a prompt, so the projection is the safety boundary:
 * text only, both sides only, bounded in count and in length, newest last.
 * These exercise that projection directly — the arbitration suites use a double
 * that calls this same function, so a bug here fails there too.
 */
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TURN_MAX_CHARS,
  mergeConversationTurns,
  projectRecentTurns,
} from "./conversation-transcript.js";

function text(role: string, value: string) {
  return { role, message: { content: [{ type: "text", text: value }] } };
}

describe("the recent-turn projection", () => {
  it("keeps both sides in reading order, newest last", () => {
    const turns = projectRecentTurns(
      [text("user", "หนึ่ง"), text("assistant", "สอง"), text("user", "สาม")],
      8,
      "single-sender",
    );

    expect(turns).toEqual([
      { role: "owner", text: "หนึ่ง" },
      { role: "assistant", text: "สอง" },
      { role: "owner", text: "สาม" },
    ]);
  });

  it("keeps the MOST RECENT turns when the window is full", () => {
    const turns = projectRecentTurns(
      Array.from({ length: 10 }, (_, index) => text("user", `t${index}`)),
      3,
      "single-sender",
    );

    expect(turns.map((turn) => turn.text)).toEqual(["t7", "t8", "t9"]);
  });

  it("drops everything that is not a side of the conversation", () => {
    const turns = projectRecentTurns(
      [text("system", "policy"), text("tool", "{...}"), text("user", "จริง")],
      8,
      "single-sender",
    );

    expect(turns).toEqual([{ role: "owner", text: "จริง" }]);
  });

  it("takes text blocks only, so no attachment or tool payload travels", () => {
    const turns = projectRecentTurns(
      [
        {
          role: "user",
          message: {
            content: [
              { type: "image", source: { data: "BASE64BYTES", mediaType: "image/png" } },
              { type: "text", text: "ดูรูปนี้" },
              { type: "tool_use", id: "t1", name: "video_generate", input: { secret: "sk-x" } },
            ],
          },
        },
      ],
      8,
      "single-sender",
    );

    expect(turns).toEqual([{ role: "owner", text: "ดูรูปนี้" }]);
    expect(JSON.stringify(turns)).not.toContain("BASE64BYTES");
    expect(JSON.stringify(turns)).not.toContain("sk-x");
  });

  it("truncates a long turn rather than dropping or forwarding it whole", () => {
    const turns = projectRecentTurns([text("user", "ก".repeat(2_000))], 8, "single-sender");

    expect(turns[0]!.text).toHaveLength(CONVERSATION_TURN_MAX_CHARS);
  });

  it("skips a turn with no readable text at all", () => {
    const turns = projectRecentTurns(
      [{ role: "user", message: { content: [] } }, text("assistant", "ตอบ")],
      8,
      "single-sender",
    );

    expect(turns).toEqual([{ role: "assistant", text: "ตอบ" }]);
  });

  it("reads a plain string body, which older messages carry", () => {
    const turns = projectRecentTurns(
      [{ role: "user", message: { content: "เก่า" } }],
      8,
      "single-sender",
    );

    expect(turns).toEqual([{ role: "owner", text: "เก่า" }]);
  });
});

describe("who a persisted user turn may be attributed to", () => {
  it("drops user turns on a shared session, where they have no provable author", () => {
    const turns = projectRecentTurns(
      [
        text("user", "ข้อความของสมาชิกอีกคน"),
        text("assistant", "ต้องการความยาวเท่าไร?"),
        text("user", "ของเจ้าของ"),
      ],
      8,
      "shared",
    );

    // A LINE group routes every member onto one session key and the canonical
    // UserMessage carries no author, so neither user turn may be presented as
    // the owner's. The assistant's own output is attributable and stays.
    expect(turns).toEqual([{ role: "assistant", text: "ต้องการความยาวเท่าไร?" }]);
  });

  it("keeps user turns on a single-sender session, where the session IS the sender", () => {
    const turns = projectRecentTurns([text("user", "ของฉัน")], 8, "single-sender");

    expect(turns).toEqual([{ role: "owner", text: "ของฉัน" }]);
  });

  it("carries the transcript's own timestamp so two sources can be interleaved", () => {
    const turns = projectRecentTurns(
      [{ ...text("assistant", "ก่อน"), createdAt: "2026-09-04T10:00:00.000Z" }],
      8,
      "shared",
    );

    expect(turns[0]!.at).toBe(Date.parse("2026-09-04T10:00:00.000Z"));
  });
});

describe("merging the two attributable sources", () => {
  it("orders dated turns by time, newest last", () => {
    const merged = mergeConversationTurns(
      [{ role: "assistant", text: "ถาม", at: 2_000 }],
      [
        { role: "owner", text: "แรก", at: 1_000 },
        { role: "owner", text: "ตอบ", at: 3_000 },
      ],
      8,
    );

    expect(merged.map((turn) => turn.text)).toEqual(["แรก", "ถาม", "ตอบ"]);
  });

  it("keeps an undated turn ahead of dated ones rather than inventing a time", () => {
    const merged = mergeConversationTurns(
      [{ role: "assistant", text: "ไม่มีเวลา" }],
      [{ role: "owner", text: "มีเวลา", at: 5_000 }],
      8,
    );

    expect(merged.map((turn) => turn.text)).toEqual(["ไม่มีเวลา", "มีเวลา"]);
  });

  it("keeps the most recent when the window is full", () => {
    const merged = mergeConversationTurns(
      [],
      Array.from({ length: 5 }, (_, index) => ({
        role: "owner" as const,
        text: `t${index}`,
        at: index,
      })),
      2,
    );

    expect(merged.map((turn) => turn.text)).toEqual(["t3", "t4"]);
  });
});
