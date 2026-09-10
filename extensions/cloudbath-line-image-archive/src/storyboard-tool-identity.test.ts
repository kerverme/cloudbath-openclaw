/**
 * The production incident: `cloudbath_storyboard` answering
 * "Storyboard is not accessible to this sender" to the very owner whose
 * storyboard it was.
 *
 * Two gates described the same turn and disagreed about it. The tool factory
 * asked only that a conversation id be non-empty; the router's access claim
 * required a GROUP-shaped one. LINE addresses a 1:1 chat by the peer's own `U…`
 * id, so in a direct chat the model was handed a tool that could only ever
 * refuse — while the dispatch path, using the same claim, had already been
 * declining every storyboard turn there for the same reason. The owner saw a
 * storyboard they could not touch and an agent improvising around it.
 *
 * They also disagreed about NOTATION. `before_dispatch` receives the
 * conversation already normalized (`C…`), a tool factory receives the delivery
 * address (`line:group:C…`, `line:U…`). Both must resolve to one value, or the
 * same owner owns two different scopes.
 *
 * Identity is never widened by any of this: every case here proves the claim is
 * built only from trusted runtime context, and that a different sender or a
 * different conversation is still refused.
 */
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  harness,
  OTHER_MEMBER,
  OWNER_SENDER_ID,
  SESSION_KEY,
} from "./storyboard-router.test-support.js";
import { createStoryboardTool } from "./storyboard-tool.js";

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
/** A 1:1 LINE chat is addressed by the peer's own id — a `U…`, not a `C…`. */
const DIRECT = OWNER_SENDER_ID;
const OTHER_GROUP = "C9999999999fedcba";

/** The story the owner actually has, in the shape the tool takes. */
const PANELS = [
  {
    framing: "Wide",
    action: "the swordsman enters the crystal forest",
    caption: "arrival",
    characterIds: [],
  },
  {
    framing: "Medium",
    action: "a shape stirs behind the rocks",
    caption: "something moves",
    characterIds: [],
  },
  {
    framing: "Close-up",
    action: "the two finally face each other",
    caption: "the meeting",
    characterIds: [],
  },
];

type ToolResult = { content?: { text?: string }[] };

/** The tool returns a JSON envelope; suites assert on the payload it carries. */
function payload(result: unknown): Record<string, unknown> {
  const text = (result as ToolResult).content?.[0]?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * A storyboard owned by this conversation, plus the tool as the agent runtime
 * would build it.
 *
 * `conversationId` is what the tool factory sees — the delivery address in
 * production — while the harness dispatches under the normalized id, exactly
 * the split that produced the incident.
 */
async function ownerWithStoryboard(
  options: { conversation?: string; toolConversationId?: string } = {},
) {
  const conversation = options.conversation ?? GROUP;
  const h = harness({ binding: null, conversationId: conversation });
  const saved = await h.storyboardRouter.handleAgentTool(
    { action: "save", brief: "a swordsman meets something in a crystal forest", panels: PANELS },
    { content: "", senderId: OWNER_SENDER_ID, senderIsOwner: true },
    {
      channelId: "line",
      accountId: ACCOUNT,
      conversationId: conversation,
      sessionKey: SESSION_KEY,
    },
  );

  const toolContext = (
    over: Partial<OpenClawPluginToolContext> = {},
  ): OpenClawPluginToolContext => ({
    messageChannel: "line",
    agentAccountId: ACCOUNT,
    requesterSenderId: OWNER_SENDER_ID,
    senderIsOwner: true,
    nativeChannelId: options.toolConversationId ?? conversation,
    sessionKey: SESSION_KEY,
    ...over,
  });
  return { h, saved, toolContext, conversation };
}

describe("the agent tool reaches the storyboard its own owner created", () => {
  it("reads it back in a group, addressed the way delivery addresses it", async () => {
    // The factory sees `line:group:C…`; the storyboard was created under `C…`.
    const { h, toolContext } = await ownerWithStoryboard({
      toolConversationId: `line:group:${GROUP}`,
    });

    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    expect(tool).not.toBeNull();
    const read = payload(await tool.execute("read-1", { action: "read" }));

    expect(read.versionNumber).toBe(1);
    expect((read.document as { beats: unknown[] }).beats).toHaveLength(3);
  });

  it("reads it back in a 1:1 chat, where the conversation is a U id", async () => {
    // The whole class of conversation the old claim could not express.
    const { h, toolContext } = await ownerWithStoryboard({
      conversation: DIRECT,
      toolConversationId: `line:${DIRECT}`,
    });

    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    expect(tool).not.toBeNull();
    const read = payload(await tool.execute("read-1", { action: "read" }));

    expect(read.versionNumber).toBe(1);
    expect(read.storyboardId).toEqual(expect.any(String));
  });

  it("revises it through the tool, keeping the same storyboard and advancing the version", async () => {
    const { h, toolContext } = await ownerWithStoryboard({
      conversation: DIRECT,
      toolConversationId: `line:${DIRECT}`,
    });
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    const before = payload(await tool.execute("read-1", { action: "read" }));

    const revised = payload(
      await tool.execute("save-1", {
        action: "save",
        brief: "a swordsman meets something in a crystal forest",
        baseVersionNumber: before.versionNumber,
        panels: [
          ...PANELS,
          {
            framing: "Wide",
            action: "they leave together as the light fades",
            caption: "departure",
            characterIds: [],
          },
        ],
      }),
    );

    expect(revised.storyboardId).toBe(before.storyboardId);
    expect(revised.versionNumber).toBe(2);
    const latest = await h.latest();
    expect(latest.document.beats).toHaveLength(4);
  });
});

describe("a claim is still the only way in", () => {
  it("refuses a different sender in the same conversation", async () => {
    const { h, toolContext } = await ownerWithStoryboard();

    // Another member's turn: the runtime says they are not the owner, so no
    // tool is offered at all, and the router refuses the call regardless.
    expect(
      createStoryboardTool(
        toolContext({ requesterSenderId: OTHER_MEMBER, senderIsOwner: false }),
        h.storyboardRouter,
      ),
    ).toBeNull();
    await expect(
      h.storyboardRouter.handleAgentTool(
        { action: "read" },
        { content: "", senderId: OTHER_MEMBER, senderIsOwner: false },
        { channelId: "line", accountId: ACCOUNT, conversationId: GROUP, sessionKey: SESSION_KEY },
      ),
    ).rejects.toThrow("not accessible to this sender");
  });

  it("does not let one conversation read another's storyboard", async () => {
    const { h, toolContext } = await ownerWithStoryboard();

    // Same owner, same account, different LINE conversation: a claim resolves,
    // but it is a different scope, so there is nothing of theirs to find.
    const elsewhere = createStoryboardTool(
      toolContext({ nativeChannelId: `line:group:${OTHER_GROUP}` }),
      h.storyboardRouter,
    )!;
    const read = payload(await elsewhere.execute("read-1", { action: "read" }));

    expect(read.status).toBe("no_saved_storyboard");
    expect(read.versionNumber).toBeUndefined();
  });

  it("refuses an identity that is not LINE-native at all", async () => {
    const { h, toolContext } = await ownerWithStoryboard();

    // OpenClaw's own chat ids live in a different namespace. No claim, no tool
    // — a storyboard scope is never minted from one.
    for (const nativeChannelId of ["oc_native_chat", "web-session-1", "discord:1234567890"]) {
      expect(createStoryboardTool(toolContext({ nativeChannelId }), h.storyboardRouter)).toBeNull();
    }
  });

  it("takes identity only from runtime context, never from the model's arguments", async () => {
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;

    // The schema is closed, so an identity the model invents is not even a
    // valid call — it can never reach the claim.
    await expect(
      tool.execute("inject-1", {
        action: "read",
        ownerSenderId: OTHER_MEMBER,
        conversationId: OTHER_GROUP,
        accountId: "someone-else",
      }),
    ).rejects.toThrow("Invalid storyboard tool input");
  });
});

describe("an incomplete save cannot replace a real storyboard", () => {
  /** Whatever word a stalled model reaches for, it fills every field with it. */
  const filler = { framing: "TBD", action: "TBD", caption: "TBD", characterIds: [] };

  it("refuses a panel that repeats one value as framing, action and caption", async () => {
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    const before = payload(await tool.execute("read-1", { action: "read" }));

    await expect(
      tool.execute("save-1", {
        action: "save",
        brief: "change the storyboard",
        baseVersionNumber: before.versionNumber,
        panels: [filler],
      }),
    ).rejects.toThrow("describes no shot");

    // The owner's story is untouched: still three panels at version 1.
    const latest = await h.latest();
    expect(latest.versionNumber).toBe(1);
    expect(latest.document.beats).toHaveLength(3);
  });

  it("refuses it on a brand-new storyboard too, so nothing empty is ever created", async () => {
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;

    await expect(
      tool.execute("save-1", {
        action: "save",
        newStoryboard: true,
        brief: "six scenes please",
        panels: [filler],
      }),
    ).rejects.toThrow("describes no shot");
  });

  it("refuses padding the requested count with duplicate panels", async () => {
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    const real = PANELS[0]!;

    await expect(
      tool.execute("save-1", {
        action: "save",
        newStoryboard: true,
        brief: "six scenes please",
        panels: [real, real, real, real, real, real],
      }),
    ).rejects.toThrow("identical");
  });

  it("refuses collapsing a multi-panel storyboard into a single panel", async () => {
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    const before = payload(await tool.execute("read-1", { action: "read" }));

    await expect(
      tool.execute("save-1", {
        action: "save",
        brief: "change the storyboard",
        baseVersionNumber: before.versionNumber,
        panels: [
          { framing: "Wide", action: "the forest, empty now", caption: "after", characterIds: [] },
        ],
      }),
    ).rejects.toThrow("newStoryboard");

    const latest = await h.latest();
    expect(latest.versionNumber).toBe(1);
    expect(latest.document.beats).toHaveLength(3);
  });

  it("still saves a real multi-panel revision", async () => {
    // The guards are about substance, not size: six distinct scenes go through.
    const { h, toolContext } = await ownerWithStoryboard();
    const tool = createStoryboardTool(toolContext(), h.storyboardRouter)!;
    const before = payload(await tool.execute("read-1", { action: "read" }));

    const six = Array.from({ length: 6 }, (_, index) => ({
      framing: index % 2 === 0 ? "Wide" : "Close-up",
      action: `episode ${index + 1}: the swordsman travels further in`,
      caption: `part ${index + 1}`,
      characterIds: [],
    }));
    const saved = payload(
      await tool.execute("save-1", {
        action: "save",
        brief: "six episodes",
        baseVersionNumber: before.versionNumber,
        panels: six,
      }),
    );

    expect(saved.versionNumber).toBe(2);
    expect((await h.latest()).document.beats).toHaveLength(6);
  });
});
