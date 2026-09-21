/**
 * The chat projection trace records identities, never what was said.
 *
 * The Control UI has shown the same answer twice and the shipped logs cannot
 * say whether the gateway broadcast one final or two. These pin the fields
 * that answer it and pin that a caller holding a whole chat payload cannot
 * leak its message through this seam.
 */
import { describe, expect, it } from "vitest";
import {
  buildChatProjectionTraceRecord,
  resolveChatProjectionState,
  type ChatProjectionTraceFields,
} from "./chat-projection-trace.js";

const REPLY_TEXT = "เดือน 1-2: วิ่งสบาย ๆ 5-7 กิโลเมตร";
const SECRET = "sk-live-0123456789abcdef";

describe("the trace answers the duplicate question", () => {
  it("carries the state, run identity, seq and session", () => {
    expect(
      buildChatProjectionTraceRecord({
        state: "final",
        runId: "run-1",
        sourceRunId: "run-1",
        seq: 4,
        sessionKey: "agent:main:line:U6b",
        branch: "appended_foreign_run",
        broadcast: true,
      }),
    ).toStrictEqual({
      event: "chat_projection",
      state: "final",
      runId: "run-1",
      sourceRunId: "run-1",
      seq: 4,
      sessionKey: "agent:main:line:U6b",
      branch: "appended_foreign_run",
      broadcast: true,
    });
  });

  it("keeps seq 0 rather than dropping it", () => {
    // seq is how two finals for one answer are told apart; zero is a value.
    expect(buildChatProjectionTraceRecord({ seq: 0 })).toMatchObject({ seq: 0 });
  });

  it("omits fields the caller did not supply", () => {
    expect(
      Object.keys(buildChatProjectionTraceRecord({ runId: "run-1" })).toSorted(),
    ).toStrictEqual(["event", "runId"]);
  });

  it.each([
    ["delta", "delta"],
    ["final", "final"],
    ["aborted", "aborted"],
    ["error", "error"],
    [undefined, "unknown"],
    ["something-else", "unknown"],
  ])("reads the payload state %s as %s", (state, expected) => {
    expect(resolveChatProjectionState({ state })).toBe(expected);
  });

  it("reads nothing else off the payload", () => {
    const payload = { state: "final", message: { content: [{ type: "text", text: REPLY_TEXT }] } };

    expect(resolveChatProjectionState(payload)).toBe("final");
  });
});

describe("the trace never carries content", () => {
  it("has no field that accepts a message, even past the types", () => {
    const smuggled = {
      runId: "run-1",
      message: { role: "assistant", content: [{ type: "text", text: REPLY_TEXT }] },
      deltaText: REPLY_TEXT,
      token: SECRET,
    } as unknown as ChatProjectionTraceFields;

    const emitted = JSON.stringify(buildChatProjectionTraceRecord(smuggled));

    expect(emitted).not.toContain(REPLY_TEXT);
    expect(emitted).not.toContain(SECRET);
  });
});
