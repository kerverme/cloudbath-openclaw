import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { createPrevisProjectResolver } from "./previs-project-resolver.js";
import type { PrevisDisplayNameRecord } from "./previs-project-resolver.js";
import { CloudbathStoryboardLineRouter } from "./storyboard-line-router.js";
import { StoryboardStore } from "./storyboard-store.js";
import type {
  ActiveStoryboardContext,
  StoryboardFinalVideoDraft,
  StoryboardHead,
  StoryboardVersion,
} from "./storyboard-types.js";
import type {
  ActiveUgcLineSession,
  ActiveUgcProject,
  AsyncKeyedStore,
  FrozenUgcVideoScope,
  NotionTarget,
  PendingUgcVideoScope,
  UgcCapabilityId,
  UgcProjectCharacterLock,
  UgcProjectInstance,
  WorkspacePolicyConfig,
} from "./types.js";
import { CloudbathUgcVideoWorkflow, type NotionPage } from "./ugc-workflow.js";

/**
 * The production failure of 2026-08-31 17:07 UTC.
 *
 * The owner's active UGC project was frozen to Twong + Twong2. They saved a new
 * character, Manju, then asked for a scene with Twong + Manju. Both attempts
 * returned "สร้าง Storyboard ไม่สำเร็จ", and the deployment logged:
 *
 *   storyboard_create_failed
 *   "This project is already locked to CHAR-6, CHAR-7; start a new project to
 *    change its cast"
 *
 * The lock guard was right -- the casts genuinely differ. The defect is that
 * the storyboard flow had no way to start a new project, and the active-project
 * pointer never expires, so the owner could never cast anyone new again.
 *
 * These drive the REAL workflow, the REAL production resolver and the REAL
 * router; only Notion is faked. No provider is reachable from this file.
 */

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
/** The message the owner actually sent, twice. */
const PRODUCTION_MESSAGE = "ใช้ Twong เดินไปหยิบหัวไม้ 1 แล้วจะตีพลาดไปโดนหัว Manju แทน";

const CAPABILITIES = Object.fromEntries(
  [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ].map((id, index) => [
    id,
    { databaseId: String(index + 1).repeat(32), dataSourceId: String(index + 1).repeat(32) },
  ]),
) as Readonly<Record<UgcCapabilityId, NotionTarget>>;

function characterPage(params: { name: string; number: number }): NotionPage {
  return {
    id: `page-char-${params.number}`,
    last_edited_time: "2026-08-31T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: params.name }] },
      "Character ID": { type: "unique_id", unique_id: { prefix: "CHAR", number: params.number } },
      "Identity Reference R2 Keys": {
        type: "rich_text",
        rich_text: [{ plain_text: `ugc/characters/${params.name}.png` }],
      },
    },
  } as unknown as NotionPage;
}

function mem<T>(): AsyncKeyedStore<T> & PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    register: async (key, value) => void values.set(key, structuredClone(value)),
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    entries: async () => Array.from(values, ([key, value]) => ({ key, value, createdAt: 0 })),
    clear: async () => values.clear(),
  } as AsyncKeyedStore<T> & PluginStateKeyedStore<T>;
}

function harness() {
  // Twong -> CHAR-6, Twong2 -> CHAR-7 exist. Manju is saved later, exactly as
  // the owner did moments before the failure.
  const library: Record<string, NotionPage> = {
    Twong: characterPage({ name: "Twong", number: 6 }),
    Twong2: characterPage({ name: "Twong2", number: 7 }),
  };
  const resolveCalls: string[] = [];
  let sceneCounter = 0;
  const scenePages = new Map<number, NotionPage>();
  let projectSeq = 0;
  const createdProjects: string[] = [];

  const notion = {
    listCharacterNames: async () => Object.keys(library),
    resolveNamedRecord: async ({ name }: { name: string }) => {
      resolveCalls.push(name);
      const page = library[name];
      if (!page) {
        throw new Error("CHARACTER_LIBRARY record not found");
      }
      return page;
    },
    readProjectPage: async () => ({ id: `page-project-${projectSeq}` }) as unknown as NotionPage,
    createProject: async () => {
      projectSeq += 1;
      const id = `page-project-${projectSeq}`;
      createdProjects.push(id);
      // A new project restarts scene numbering, like production.
      sceneCounter = 0;
      scenePages.clear();
      return { id } as unknown as NotionPage;
    },
    latestSceneNumber: async () => sceneCounter,
    findSceneByOrder: async ({ sceneNumber }: { sceneNumber: number }) =>
      scenePages.get(sceneNumber),
    createOrReuseScene: async ({ sceneNumber }: { sceneNumber: number }) => {
      sceneCounter = Math.max(sceneCounter, sceneNumber);
      const page = { id: `scene-${projectSeq}-${sceneNumber}` } as unknown as NotionPage;
      scenePages.set(sceneNumber, page);
      return page;
    },
  };

  const projectLocks = mem<UgcProjectCharacterLock>();
  const projectInstances = mem<UgcProjectInstance>();
  const workflow = new CloudbathUgcVideoWorkflow(
    { capabilities: CAPABILITIES } as NonNullable<WorkspacePolicyConfig["ugc"]>,
    {} as never,
    notion as never,
    mem<PendingUgcVideoScope>(),
    mem<FrozenUgcVideoScope>(),
    mem<ActiveUgcLineSession>(),
    projectLocks,
    projectInstances,
    mem<ActiveUgcProject>(),
    () => Date.UTC(2026, 7, 31),
  );

  const resolver = createPrevisProjectResolver({
    workflow,
    notion: notion as never,
    capabilities: CAPABILITIES,
    displayNames: mem<PrevisDisplayNameRecord>(),
    now: () => Date.UTC(2026, 7, 31),
  });

  const router = new CloudbathStoryboardLineRouter({
    store: new StoryboardStore({
      heads: mem<StoryboardHead>(),
      versions: mem<StoryboardVersion>(),
      now: () => Date.UTC(2026, 7, 31),
    }),
    resolver,
    active: mem<ActiveStoryboardContext>(),
    drafts: mem<StoryboardFinalVideoDraft>(),
    dedupe: mem<{ reply: string }>(),
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => Date.UTC(2026, 7, 31),
    paidDraftRuntime: null,
  });

  let seq = 0;
  const send = async (content: string) =>
    await router.handleBeforeDispatch(
      {
        content,
        senderId: OWNER,
        senderIsOwner: true,
        isGroup: true,
        messageId: `m-${(seq += 1)}`,
      },
      { channelId: "line", accountId: ACCOUNT, conversationId: GROUP },
    );

  /**
   * The owner saving a new Character Library row, moments before the request.
   *
   * Mirrors production: the save path notifies the resolver, which is what
   * makes the new name visible to the very next message. The clock is frozen
   * here, so a stale memo can never expire on its own -- which is exactly the
   * "saved seconds ago" case.
   */
  const saveCharacter = (name: string, number: number) => {
    library[name] = characterPage({ name, number });
    resolver.invalidateCharacterNames();
  };

  /** A save that does NOT notify, i.e. the pre-fix behaviour. */
  const saveCharacterWithoutInvalidation = (name: string, number: number) => {
    library[name] = characterPage({ name, number });
  };

  const lockedCasts = async () =>
    (await projectLocks.entries()).map((entry) =>
      entry.value.characterLocks.map((lock) => lock.code),
    );

  return {
    send,
    saveCharacter,
    saveCharacterWithoutInvalidation,
    lockedCasts,
    projectInstances,
    resolveCalls,
    createdProjects,
  };
}

describe("a newly cast storyboard request opens a new project", () => {
  it("reproduces the 2026-08-31 production failure and now succeeds", async () => {
    const h = harness();

    // The owner's existing project, frozen to Twong + Twong2.
    const first = await h.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ แนวตั้ง");
    expect(first?.text).toContain("Storyboard v1");
    expect(await h.lockedCasts()).toEqual([["CHAR-6", "CHAR-7"]]);

    // Manju is saved with an image reference, exactly as production did.
    h.saveCharacter("Manju", 12);

    // The message that failed twice in production.
    const result = await h.send(PRODUCTION_MESSAGE);
    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("Storyboard v1");
    expect(result?.text).not.toContain("สร้าง Storyboard ไม่สำเร็จ");

    // A SECOND project, with its own canonically frozen cast. The original
    // project keeps its own cast untouched.
    expect(h.createdProjects.length).toBe(2);
    const casts = await h.lockedCasts();
    expect(casts).toContainEqual(["CHAR-6", "CHAR-7"]);
    expect(casts).toContainEqual(["CHAR-6", "CHAR-12"]);
  });

  it("still continues the SAME project when the cast is unchanged", async () => {
    const h = harness();
    await h.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 15 วิ แนวตั้ง");
    await h.send("ใช้ Twong กับ Twong2 ให้ Twong2 นั่งลง 10 วิ แนวตั้ง");

    // One project, one frozen cast: naming the same cast is a continuation,
    // not new work.
    expect(h.createdProjects.length).toBe(1);
    expect(await h.lockedCasts()).toEqual([["CHAR-6", "CHAR-7"]]);
  });

  it("still fails closed on a character the library does not hold", async () => {
    const h = harness();
    await h.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 15 วิ แนวตั้ง");
    const result = await h.send("ใช้ Twong กับ Nobody ให้ Twong เดิน 10 วิ แนวตั้ง");
    // Unknown names are refused before any project is created.
    expect(result?.text).toContain("ไม่พบตัวละคร");
    expect(h.createdProjects.length).toBe(1);
  });

  it("sees a character saved seconds earlier, without waiting for the memo", async () => {
    const h = harness();
    await h.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 15 วิ แนวตั้ง");

    // Without the save-time invalidation the 30s name memo still serves the
    // pre-Manju list, so Manju is silently dropped from the cast -- the scene
    // is built with Twong alone, which is worse than failing.
    h.saveCharacterWithoutInvalidation("Manju", 12);
    await h.send(PRODUCTION_MESSAGE);
    expect(await h.lockedCasts()).toContainEqual(["CHAR-6"]);

    const fresh = harness();
    await fresh.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 15 วิ แนวตั้ง");
    fresh.saveCharacter("Manju", 12);
    await fresh.send(PRODUCTION_MESSAGE);
    expect(await fresh.lockedCasts()).toContainEqual(["CHAR-6", "CHAR-12"]);
  });

  it("resolves each named character exactly once per scene", async () => {
    const h = harness();
    await h.send("ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 15 วิ แนวตั้ง");
    h.saveCharacter("Manju", 12);
    h.resolveCalls.length = 0;

    await h.send(PRODUCTION_MESSAGE);
    // The new-project check reuses the lock guard's resolve; it must not add
    // a second Character Library lookup per name.
    expect(h.resolveCalls).toEqual(["Twong", "Manju"]);
  });
});
