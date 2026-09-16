/**
 * Preparing the trusted storyboard summary before the turn is finalized.
 *
 * The scoping cases matter more than the happy path: the storyboard store is
 * keyed by (account, group, owner), so these pin that a turn which cannot name
 * all three prepares nothing, and that no turn can reach another account's,
 * another group's, or another sender's storyboard.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveStoryboardAccessClaim } from "./storyboard-line-router.js";
import { prepareStoryboardRegeneration } from "./storyboard-regeneration-prepare.js";

const SUMMARY = "ฉาก 1 · 0-3 วิ · ปูฉาก\nแมวเดินในสวนครับ";
const CORRUPTED = "ฉาก 1 · 0-3 วิ · ปูฉาก ใช่ไಮೈ";
const GROUP = "C1234567890abcdef";
const OWNER = "Uowner1234567890";

/** One storyboard, readable only through its exact claim triple. */
const STORED: Readonly<Record<string, string>> = {
  [`default|${GROUP}|${OWNER}`]: SUMMARY,
};

function createDeps() {
  const prepare = vi.fn();
  const readStoryboardLanguage = vi.fn(
    async (
      context: { channelId: string; accountId: string; conversationId: string },
      options: { ownerSenderId: string },
    ) => {
      // Mirrors the router: no claim, no read.
      const claim = resolveStoryboardAccessClaim(
        { content: "", senderId: options.ownerSenderId, senderIsOwner: true } as never,
        context as never,
      );
      if (!claim) {
        return undefined;
      }
      const summary = STORED[`${claim.accountId}|${claim.lineGroupId}|${claim.ownerSenderId}`];
      return summary ? { summary } : undefined;
    },
  );
  return {
    prepare,
    readStoryboardLanguage,
    deps: { prepare, readStoryboardLanguage, isRebuildTarget: () => true },
  };
}

const CTX = {
  accountId: "default",
  senderId: OWNER,
  chatId: `line:group:${GROUP}`,
  channel: "line",
  sessionKey: "agent:main:line:group:C1234567890abcdef",
} as const;

const EVENT = { runId: "run-1", lastAssistantMessage: CORRUPTED } as const;

const run = (
  overrides: { ctx?: Partial<typeof CTX>; event?: Partial<typeof EVENT> } = {},
  harness = createDeps(),
) =>
  prepareStoryboardRegeneration({
    event: { ...EVENT, ...overrides.event },
    ctx: { ...CTX, ...overrides.ctx },
    deps: harness.deps,
  }).then((prepared) => ({ prepared, ...harness }));

describe("a fully identified owner turn prepares regeneration", () => {
  it("resolves this conversation's storyboard and prepares it", async () => {
    const { prepared, prepare } = await run();

    expect(prepared).toBe(true);
    expect(prepare).toHaveBeenCalledWith({
      runId: "run-1",
      sourceText: CORRUPTED,
      regeneratedText: SUMMARY,
    });
  });

  it("reads with the owner identity the run already trusts", async () => {
    const { readStoryboardLanguage } = await run();

    expect(readStoryboardLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", conversationId: `line:group:${GROUP}` }),
      { ownerSenderId: OWNER },
    );
  });
});

describe("an incompletely identified turn prepares nothing", () => {
  it.each([
    ["blank accountId", { accountId: "" }],
    ["whitespace accountId", { accountId: "   " }],
    ["blank senderId", { senderId: "" }],
    ["blank conversation", { chatId: "" }],
    ["a non-LINE channel", { channel: "discord" }],
  ])("refuses on %s", async (_label, ctx) => {
    const { prepared, prepare, readStoryboardLanguage } = await run({ ctx });

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    if (_label !== "a non-LINE channel") {
      expect(readStoryboardLanguage).not.toHaveBeenCalled();
    }
  });

  it("refuses without a run to attach the decision to", async () => {
    const { prepared, prepare } = await run({ event: { runId: "" } });

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("no turn reaches another scope's storyboard", () => {
  it("cannot read another account's storyboard", async () => {
    const { prepared, prepare } = await run({ ctx: { accountId: "other-account" } });

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("isolates the same owner speaking in a different group", async () => {
    const { prepared, prepare } = await run({
      ctx: { chatId: "line:group:Cffffffffffffffffffffffffffffffff" },
    });

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("denies a different sender in the same group", async () => {
    const { prepared, prepare } = await run({ ctx: { senderId: "Uintruder00000000" } });

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("a turn with no storyboard stays generic", () => {
  it("prepares nothing when this conversation owns none", async () => {
    const harness = createDeps();
    harness.readStoryboardLanguage.mockResolvedValue(undefined);
    const { prepared, prepare } = await run({}, harness);

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("prepares nothing when the reply is not the summary's own operation", async () => {
    const harness = createDeps();
    const { prepared, prepare } = await prepareStoryboardRegeneration({
      event: EVENT,
      ctx: CTX,
      deps: { ...harness.deps, isRebuildTarget: () => false },
    }).then((p) => ({ prepared: p, ...harness }));

    expect(prepared).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("survives a store read that throws rather than failing the turn", async () => {
    const harness = createDeps();
    harness.readStoryboardLanguage.mockRejectedValue(new Error("store down"));

    await expect(run({}, harness)).resolves.toMatchObject({ prepared: false });
  });
});
