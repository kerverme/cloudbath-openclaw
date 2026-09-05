/**
 * The legacy single-shot draft must not answer storyboard-first intent.
 *
 * In production an unbound LINE group's "make me a video" reached the model,
 * which called `line_video_draft` and replied "🎬 Video draft" — a different
 * product from the storyboard flow the owner was meant to get. The tool is now
 * reachable only through an explicit marker, so ordinary natural intent has no
 * legacy path to fall into.
 *
 * A marker, not a phrase: the gate reads one closed token, never Thai wording,
 * so it cannot drift into the phrase matching this flow is built to avoid.
 */
import { describe, expect, it } from "vitest";
import {
  createLineLegacyVideoDraftGate,
  hasLegacyVideoDraftMarker,
  LINE_LEGACY_VIDEO_DRAFT_MARKER,
} from "./video-draft-tool.js";

const SESSION_KEY = "line:group:C1234567890abcdef";
const LINE_CONTEXT = { channelId: "line", sessionKey: SESSION_KEY };

/** Natural owner video requests, in the wordings production actually saw. */
const NATURAL_REQUESTS = [
  "ช่วยทำวิดีโอให้หน่อย",
  "อยากได้วิดีโอแมวเดินในสวน",
  "ทำวิดีโอหน่อย",
  "make me a video",
] as const;

describe("the explicit legacy marker", () => {
  it.each(NATURAL_REQUESTS)("does not open the legacy path for %s", (content) => {
    const gate = createLineLegacyVideoDraftGate();

    gate.beginTurn({ channel: "line", content }, LINE_CONTEXT);

    expect(hasLegacyVideoDraftMarker(content)).toBe(false);
    expect(gate.isLegacyTurn(SESSION_KEY)).toBe(false);
  });

  it("opens it only for a turn that carries the marker", () => {
    const gate = createLineLegacyVideoDraftGate();

    gate.beginTurn(
      { channel: "line", content: `${LINE_LEGACY_VIDEO_DRAFT_MARKER} ทำวิดีโอหน่อย` },
      LINE_CONTEXT,
    );

    expect(gate.isLegacyTurn(SESSION_KEY)).toBe(true);
  });

  it("closes again on the next unmarked turn", () => {
    const gate = createLineLegacyVideoDraftGate();
    gate.beginTurn({ channel: "line", content: LINE_LEGACY_VIDEO_DRAFT_MARKER }, LINE_CONTEXT);

    // Per turn, not per conversation: one marked request must not leave the
    // legacy path open for everything the owner says afterwards.
    gate.beginTurn({ channel: "line", content: "ทำวิดีโอหน่อย" }, LINE_CONTEXT);

    expect(gate.isLegacyTurn(SESSION_KEY)).toBe(false);
  });

  it("keeps one conversation's marker out of another's", () => {
    const gate = createLineLegacyVideoDraftGate();

    gate.beginTurn({ channel: "line", content: LINE_LEGACY_VIDEO_DRAFT_MARKER }, LINE_CONTEXT);

    expect(gate.isLegacyTurn("line:group:C-other")).toBe(false);
    expect(gate.isLegacyTurn(undefined)).toBe(false);
  });

  it("ignores a marked turn that is not on LINE at all", () => {
    const gate = createLineLegacyVideoDraftGate();

    gate.beginTurn(
      { channel: "discord", content: LINE_LEGACY_VIDEO_DRAFT_MARKER },
      {
        channelId: "discord",
        sessionKey: SESSION_KEY,
      },
    );

    expect(gate.isLegacyTurn(SESSION_KEY)).toBe(false);
  });

  it("reads the body a channel delivers, not only the rendered content", () => {
    const gate = createLineLegacyVideoDraftGate();

    gate.beginTurn(
      { channel: "line", content: "ทำวิดีโอหน่อย", body: LINE_LEGACY_VIDEO_DRAFT_MARKER },
      LINE_CONTEXT,
    );

    expect(gate.isLegacyTurn(SESSION_KEY)).toBe(true);
  });
});
