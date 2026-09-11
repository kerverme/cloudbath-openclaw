/**
 * Storyboard state across two LINE groups on one `agent:main`.
 *
 * Group A builds a storyboard; group B is added afterwards and must start
 * empty. Production reported the opposite — a new group answering as though it
 * already had work in progress — so these tests drive the real store and the
 * real claim resolver rather than asserting on the session key alone.
 */
import { describe, expect, it } from "vitest";
import { resolveStoryboardAccessClaim } from "./storyboard-line-router.js";
import {
  activeStoryboardKey,
  storyboardHeadKey,
  StoryboardStore,
  type StoryboardStoreDeps,
} from "./storyboard-store.js";
import type { StoryboardDocument, StoryboardHead, StoryboardVersion } from "./storyboard-types.js";

class MemoryStore<T> {
  readonly values = new Map<string, T>();
  async lookup(key: string) {
    return this.values.get(key);
  }
  async register(key: string, value: T) {
    this.values.set(key, value);
  }
  async registerIfAbsent(key: string, value: T) {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, value);
    return true;
  }
}

const ACCOUNT = "account";
const GROUP_A = "Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_B = "Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = "Uowner00000000000000000000000000";

const claimIn = (lineGroupId: string, ownerSenderId = OWNER) => ({
  accountId: ACCOUNT,
  lineGroupId,
  ownerSenderId,
});

const document: StoryboardDocument = Object.freeze({
  version: 1,
  scenePrompt: "นักดาบเดินเข้าป่าคริสตัล",
  durationSeconds: 8,
  aspectRatio: "9:16",
  resolution: "1080p",
  environment: "ป่าคริสตัล",
  audio: "ambient",
  cast: Object.freeze([]),
  beats: Object.freeze([
    {
      beatId: "beat-1",
      startSeconds: 0,
      endSeconds: 4,
      kind: "establishing" as const,
      framing: "wide",
      action: "นักดาบเดินเข้าป่าคริสตัล",
      caption: "ฉากที่ 1",
    },
  ]),
});

function storeHarness() {
  const heads = new MemoryStore<StoryboardHead>();
  const versions = new MemoryStore<StoryboardVersion>();
  const deps = { heads, versions, now: () => 1 } as unknown as StoryboardStoreDeps;
  return { heads, versions, store: new StoryboardStore(deps) };
}

describe("a storyboard belongs to the group that created it", () => {
  it("refuses to read group A's storyboard under group B's claim", async () => {
    const h = storeHarness();
    const created = await h.store.createStoryboard({
      document,
      claim: claimIn(GROUP_A),
      characterLocks: [],
    });

    await expect(
      h.store.readLatest({ storyboardId: created.head.storyboardId, claim: claimIn(GROUP_B) }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("still serves it to the group that owns it", async () => {
    const h = storeHarness();
    const created = await h.store.createStoryboard({
      document,
      claim: claimIn(GROUP_A),
      characterLocks: [],
    });

    const read = await h.store.readLatest({
      storyboardId: created.head.storyboardId,
      claim: claimIn(GROUP_A),
    });

    expect(read.lineGroupId).toBe(GROUP_A);
  });

  it("refuses it to a different sender inside the same group", async () => {
    // Group scoping is not enough on its own: the head is owner scoped too.
    const h = storeHarness();
    const created = await h.store.createStoryboard({
      document,
      claim: claimIn(GROUP_A),
      characterLocks: [],
    });

    await expect(
      h.store.readLatest({
        storyboardId: created.head.storyboardId,
        claim: claimIn(GROUP_A, "Uother0000000000000000000000000"),
      }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("keys the head by storyboard id, never by agent or account alone", async () => {
    const h = storeHarness();
    const created = await h.store.createStoryboard({
      document,
      claim: claimIn(GROUP_A),
      characterLocks: [],
    });

    expect(h.heads.values.has(storyboardHeadKey(created.head.storyboardId))).toBe(true);
    expect(created.head.lineGroupId).toBe(GROUP_A);
  });
});

describe("the active-storyboard pointer is per group", () => {
  it("gives two groups different active keys", () => {
    expect(activeStoryboardKey(claimIn(GROUP_A))).not.toBe(activeStoryboardKey(claimIn(GROUP_B)));
  });

  it("names the group in the key, so a lookup cannot cross groups", () => {
    expect(activeStoryboardKey(claimIn(GROUP_B))).toContain(GROUP_B);
    expect(activeStoryboardKey(claimIn(GROUP_B))).not.toContain(GROUP_A);
  });

  it("gives two senders in one group different active keys", () => {
    expect(activeStoryboardKey(claimIn(GROUP_A))).not.toBe(
      activeStoryboardKey(claimIn(GROUP_A, "Uother0000000000000000000000000")),
    );
  });
});

describe("a claim is built from this turn's conversation, not a remembered one", () => {
  const turn = (conversationId: string, senderIsOwner = true) =>
    resolveStoryboardAccessClaim(
      { content: "", senderId: OWNER, senderIsOwner },
      { channelId: "line", accountId: ACCOUNT, conversationId, sessionKey: "session" },
    );

  it("claims the group the message arrived in", () => {
    expect(turn(`line:group:${GROUP_B}`)?.lineGroupId).toBe(GROUP_B);
  });

  it("never yields group A's id for a group B turn", () => {
    expect(turn(`line:group:${GROUP_B}`)?.lineGroupId).not.toBe(GROUP_A);
  });

  it("yields nothing for a non-owner, so an ordinary member opens no storyboard", () => {
    expect(turn(`line:group:${GROUP_B}`, false)).toBeUndefined();
  });
});
