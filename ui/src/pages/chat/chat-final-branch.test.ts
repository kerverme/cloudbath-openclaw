/**
 * Naming the branch that can show an answer twice.
 *
 * `handleChatEvent` has three paths for a final and they do not agree: two
 * reconcile against what is already rendered, and `appended_foreign_run` adds
 * a message with no dedupe at all. This is the label, so a duplicate is
 * reproducible from a trace rather than from re-reading the conditions.
 */
import { describe, expect, it } from "vitest";
import { classifyChatFinalBranch } from "./chat-final-branch.js";

describe("classifyChatFinalBranch", () => {
  it("names the non-deduping append when a final belongs to another run", () => {
    expect(
      classifyChatFinalBranch({
        sessionMatches: true,
        activeRunMatches: false,
        activeRunId: "run-a",
        payloadRunId: "run-b",
      }),
    ).toBe("appended_foreign_run");
  });

  it("names the reconciled path for the run being rendered", () => {
    expect(
      classifyChatFinalBranch({
        sessionMatches: true,
        activeRunMatches: true,
        activeRunId: "run-a",
        payloadRunId: "run-a",
      }),
    ).toBe("reconciled_active_run");
  });

  it("treats an adopted run as the active one", () => {
    // A LINE turn arrives with no client run; the UI takes the payload's.
    expect(
      classifyChatFinalBranch({
        sessionMatches: true,
        activeRunMatches: false,
        activeRunId: null,
        payloadRunId: "run-line",
      }),
    ).toBe("reconciled_active_run");
  });

  it("names the cache path for a session that is not open", () => {
    expect(
      classifyChatFinalBranch({
        sessionMatches: false,
        activeRunMatches: false,
        activeRunId: "run-a",
        payloadRunId: "run-b",
      }),
    ).toBe("cached_other_session");
  });
});
