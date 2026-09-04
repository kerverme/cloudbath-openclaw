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
import { CONVERSATION_TURN_MAX_CHARS, projectRecentTurns } from "./conversation-transcript.js";

function text(role: string, value: string) {
  return { role, message: { content: [{ type: "text", text: value }] } };
}

describe("the recent-turn projection", () => {
  it("keeps both sides in reading order, newest last", () => {
    const turns = projectRecentTurns(
      [text("user", "หนึ่ง"), text("assistant", "สอง"), text("user", "สาม")],
      8,
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
    );

    expect(turns.map((turn) => turn.text)).toEqual(["t7", "t8", "t9"]);
  });

  it("drops everything that is not a side of the conversation", () => {
    const turns = projectRecentTurns(
      [text("system", "policy"), text("tool", "{...}"), text("user", "จริง")],
      8,
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
    );

    expect(turns).toEqual([{ role: "owner", text: "ดูรูปนี้" }]);
    expect(JSON.stringify(turns)).not.toContain("BASE64BYTES");
    expect(JSON.stringify(turns)).not.toContain("sk-x");
  });

  it("truncates a long turn rather than dropping or forwarding it whole", () => {
    const turns = projectRecentTurns([text("user", "ก".repeat(2_000))], 8);

    expect(turns[0]!.text).toHaveLength(CONVERSATION_TURN_MAX_CHARS);
  });

  it("skips a turn with no readable text at all", () => {
    const turns = projectRecentTurns(
      [{ role: "user", message: { content: [] } }, text("assistant", "ตอบ")],
      8,
    );

    expect(turns).toEqual([{ role: "assistant", text: "ตอบ" }]);
  });

  it("reads a plain string body, which older messages carry", () => {
    const turns = projectRecentTurns([{ role: "user", message: { content: "เก่า" } }], 8);

    expect(turns).toEqual([{ role: "owner", text: "เก่า" }]);
  });
});
