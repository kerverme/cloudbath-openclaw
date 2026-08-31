import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  createPrevisProjectResolver,
  type PrevisDisplayNameRecord,
} from "./previs-project-resolver.js";
import {
  CloudbathStoryboardLineRouter,
  type StoryboardDedupeStore,
} from "./storyboard-line-router.js";
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
 * The storyboard flow over the REAL shared UGC lifecycle.
 *
 * Every other storyboard suite stubs `resolveProjectScene`, and the previs
 * production-resolver suite stubs the workflow behind the real resolver. That
 * gap is precisely where the shared cast-lock blocker lived: nothing drove the
 * real lifecycle TWICE against one project, so a second storyboard scene failed
 * in production with "This project is already locked to CHAR-6, CHAR-7" while
 * every suite stayed green.
 *
 * Here the router, the production resolver and `CloudbathUgcVideoWorkflow` are
 * all real, and only Notion is faked. The cast-lock comparison this proves is
 * not reimplemented anywhere in the file -- it runs inside the shared workflow,
 * so if that guard regresses these tests fail.
 */

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";

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

const SCENE_ONE = "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ ในร้านกาแฟ แนวตั้ง";
/** A SECOND scene on the same project and the same cast -- the former blocker. */
const SCENE_TWO = "ใช้ Twong กับ Twong2 ให้ Twong2 หันกลับมามอง Twong 12 วิ แนวตั้ง";

/** A Character Library row: display Name and a SEPARATE generated Character ID. */
function characterPage(params: { name: string; number: number }): NotionPage {
  return {
    id: `page-char-${params.number}`,
    last_edited_time: "2026-08-30T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: params.name }] },
      "Character ID": {
        type: "unique_id",
        unique_id: { prefix: "CHAR", number: params.number },
      },
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

function dedupeStore(): StoryboardDedupeStore {
  const seen = new Map<string, { reply: string }>();
  return { lookup: async (k) => seen.get(k), register: async (k, v) => void seen.set(k, v) };
}

function harness() {
  // The router masks a lifecycle failure behind a generic reply, so the reply
  // alone cannot say WHY a scene failed. Capturing the logged reason makes the
  // regression report the real production message.
  const warnings: Array<{ event: string; reason: unknown }> = [];

  // Twong -> CHAR-6, Twong2 -> CHAR-7. Names and canonical ids are separate on
  // purpose: a path that froze the display name as identity fails loudly.
  const library: Record<string, NotionPage> = {
    Twong: characterPage({ name: "Twong", number: 6 }),
    Twong2: characterPage({ name: "Twong2", number: 7 }),
  };
  const scenePages = new Map<number, NotionPage>();
  let sceneCounter = 0;
  const projectPage = { id: "a".repeat(32) } as unknown as NotionPage;

  const notion = {
    listCharacterNames: async () => Object.keys(library),
    resolveNamedRecord: async ({ name }: { name: string }) => {
      const page = library[name];
      if (!page) {
        // Fail closed exactly like the production client.
        throw new Error("CHARACTER_LIBRARY record not found");
      }
      return page;
    },
    readProjectPage: async () => projectPage,
    createProject: async () => projectPage,
    latestSceneNumber: async () => sceneCounter,
    findSceneByOrder: async ({ sceneNumber }: { sceneNumber: number }) =>
      scenePages.get(sceneNumber),
    createOrReuseScene: async ({ sceneNumber }: { sceneNumber: number }) => {
      sceneCounter = Math.max(sceneCounter, sceneNumber);
      const page = { id: `scene-${sceneNumber}`.padEnd(32, "0") } as unknown as NotionPage;
      scenePages.set(sceneNumber, page);
      return page;
    },
  };

  const projectLocks = mem<UgcProjectCharacterLock>();
  const workflow = new CloudbathUgcVideoWorkflow(
    { capabilities: CAPABILITIES } as NonNullable<WorkspacePolicyConfig["ugc"]>,
    {} as never,
    notion as never,
    mem<PendingUgcVideoScope>(),
    mem<FrozenUgcVideoScope>(),
    mem<ActiveUgcLineSession>(),
    projectLocks,
    mem<UgcProjectInstance>(),
    mem<ActiveUgcProject>(),
    () => Date.UTC(2026, 7, 31),
  );

  // The REAL production resolver over the REAL workflow.
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
      now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    }),
    resolver,
    active: mem<ActiveStoryboardContext>(),
    drafts: mem<StoryboardFinalVideoDraft>(),
    dedupe: dedupeStore(),
    registry: {
      lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }),
    },
    now: () => Date.parse("2026-08-30T10:00:00.000Z"),
    logger: {
      warn: (event, fields) => void warnings.push({ event, reason: fields?.["reason"] }),
    },
  });

  let messageSeq = 0;
  const send = async (content: string) =>
    await router.handleBeforeDispatch(
      {
        content,
        senderId: OWNER,
        senderIsOwner: true,
        isGroup: true,
        messageId: `m-${(messageSeq += 1)}`,
      },
      {
        channelId: "line",
        accountId: ACCOUNT,
        conversationId: GROUP,
      },
    );

  const lockedCodes = async (): Promise<readonly string[]> => {
    const [entry] = await projectLocks.entries();
    return entry?.value.characterLocks.map((lock) => lock.code) ?? [];
  };

  return { send, lockedCodes, projectLocks, warnings };
}

describe("N. the storyboard flow runs on the real shared UGC lifecycle", () => {
  it("takes a second scene on the same project and cast", async () => {
    const h = harness();

    const first = await h.send(SCENE_ONE);
    expect(first?.handled).toBe(true);
    // Canonical identity, not the names the owner typed.
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
    expect(first?.text).toContain("Storyboard v1");

    // The former blocker: this is the call that failed in production. The
    // lifecycle error surfaces in the log, so assert there first -- it names
    // the exact message this regression exists to keep out.
    const second = await h.send(SCENE_TWO);
    expect(h.warnings).toEqual([]);
    expect(second?.handled).toBe(true);
    expect(second?.text).not.toContain("สร้าง Storyboard ไม่สำเร็จ");
    expect(second?.text).toContain("Storyboard v1");

    // One project, one frozen cast, still canonical after the second scene.
    expect((await h.projectLocks.entries()).length).toBe(1);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });

  it("still refuses a cast the project never froze", async () => {
    const h = harness();
    await h.send(SCENE_ONE);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);

    // "Nobody" is not in the Character Library, so the create fails closed
    // before any lifecycle write rather than recasting the project.
    const refused = await h.send("ใช้ Twong กับ Nobody ให้ Twong เดิน 10 วิ แนวตั้ง");
    expect(refused?.text).toContain("ไม่พบตัวละคร");
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});
