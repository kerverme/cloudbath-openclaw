import { describe, expect, it } from "vitest";
import {
  activePrevisKey,
  CloudbathPrevisLineRouter,
  type ActivePrevisContext,
  type PrevisDedupeStore,
} from "./previs-line-router.js";
import {
  createPrevisProjectResolver,
  previsDisplayNamesKey,
  type PrevisDisplayNameRecord,
} from "./previs-project-resolver.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisEngine } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import type { AsyncKeyedStore, NotionTarget, UgcCapabilityId } from "./types.js";

/**
 * Exercises the REAL `createPrevisProjectResolver`, not the fake used by the
 * routing tests.
 *
 * The routing suite's fake hands back CHAR-6/CHAR-7 directly, which would hide a
 * production resolver that froze the display name as the canonical code. Here
 * the Character Library fixture carries `Name` and a generated `Character ID`
 * separately, so the canonicalisation is actually proven.
 */
const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const CLAIM: PrevisAccessClaim = {
  accountId: ACCOUNT,
  lineGroupId: GROUP,
  ownerSenderId: OWNER,
};
const CREATE_MESSAGE = "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ แนวตั้ง";
const EDIT_MESSAGE = "วิ 10-14 ให้ Twong หมุนตัวกลับมามอง Twong2";

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

/** A Character Library row: display Name and a separate generated Character ID. */
function characterPage(params: { id: string; name: string; prefix: string; number: number }) {
  return {
    id: params.id,
    last_edited_time: "2026-08-30T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: params.name }] },
      "Character ID": {
        type: "unique_id",
        unique_id: { prefix: params.prefix, number: params.number },
      },
      "Identity Reference R2 Keys": {
        type: "rich_text",
        rich_text: [{ plain_text: `ugc/characters/${params.name}.png` }],
      },
    },
  };
}

function mem<T>(): AsyncKeyedStore<T> {
  const m = new Map<string, T>();
  return {
    register: async (k, v) => void m.set(k, v),
    registerIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    lookup: async (k) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function dedupeStore(): PrevisDedupeStore {
  const m = new Map<string, { reply: string }>();
  return { lookup: async (k) => m.get(k), register: async (k, v) => void m.set(k, v) };
}

/**
 * A stand-in for the shared UGC lifecycle that records what it was asked to do.
 *
 * It deliberately does NOT invent codes: it freezes exactly the pages the
 * resolver hands it, so the canonical code under test is the resolver's.
 */
function fakeWorkflow(
  options: { existingLocks?: readonly { code: string; pageId: string }[] } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  let locks = options.existingLocks?.map((l) => ({
    code: l.code,
    pageId: l.pageId,
    identityReferences: [{ kind: "identity" as const, source: "r2" as const, locator: "x" }],
    styleReferences: [],
    frozenAt: "2026-08-30T00:00:00.000Z",
  }));
  let sceneNumber = 0;
  return {
    calls,
    get locks() {
      return locks;
    },
    resolveProjectScene: async (params: {
      characterNames: readonly string[];
      resolveCharacterPages: () => Promise<Array<{ code: string; page: unknown }>>;
      prompt: string;
      productName?: string;
    }) => {
      calls.push({ prompt: params.prompt, productName: params.productName });
      if (!locks) {
        const pages = await params.resolveCharacterPages();
        locks = pages.map((entry) => ({
          code: entry.code,
          pageId: (entry.page as { id: string }).id,
          identityReferences: [{ kind: "identity" as const, source: "r2" as const, locator: "x" }],
          styleReferences: [],
          frozenAt: "2026-08-30T00:00:00.000Z",
        }));
      }
      sceneNumber += 1;
      return {
        instance: {
          version: 1 as const,
          projectInstanceId: "instance-real-1",
          // A REAL Notion page id, not an empty placeholder.
          projectPageId: "a".repeat(32),
          accountId: ACCOUNT,
          lineGroupId: GROUP,
          ownerSenderId: OWNER,
          productReferences: [],
          characterPageIds: locks.map((l) => l.pageId),
          createdAt: "2026-08-30T00:00:00.000Z",
        },
        projectPage: { id: "a".repeat(32) },
        projectRecordId: "instance-real-1",
        characterLocks: locks,
        sceneNumber,
        scenePage: { id: "b".repeat(32) },
        previousScene: undefined,
        nowIso: "2026-08-30T00:00:00.000Z",
      };
    },
    readProjectCastLocks: async () => locks ?? [],
  };
}

function productionResolver(workflow: ReturnType<typeof fakeWorkflow>) {
  const pages: Record<string, ReturnType<typeof characterPage>> = {
    Twong: characterPage({ id: "page-6", name: "Twong", prefix: "CHAR", number: 6 }),
    Twong2: characterPage({ id: "page-7", name: "Twong2", prefix: "CHAR", number: 7 }),
    // A row with no generated Character ID, used for the fail-closed case.
    Nameless: {
      id: "page-9",
      last_edited_time: "2026-08-30T00:00:00.000Z",
      properties: { Name: { type: "title", title: [{ plain_text: "Nameless" }] } },
    } as ReturnType<typeof characterPage>,
  };
  const displayNames = mem<PrevisDisplayNameRecord>();
  return {
    displayNames,
    resolver: createPrevisProjectResolver({
      workflow: workflow as never,
      notion: {
        listCharacterNames: async () => ["Twong", "Twong2", "Nameless"],
        resolveNamedRecord: async ({ name }: { name: string }) => {
          const page = pages[name];
          if (!page) {
            throw new Error("CHARACTER_LIBRARY record not found");
          }
          return page as never;
        },
      } as never,
      capabilities: CAPABILITIES,
      displayNames,
    }),
  };
}

function harness(workflow = fakeWorkflow()) {
  const { resolver, displayNames } = productionResolver(workflow);
  const store = new PrevisStore({
    heads: mem<PrevisProjectHead>(),
    versions: mem<PrevisVersion>(),
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    artifactKeyPrefix: "previs/cozyclay",
  });
  const engine: PrevisEngine = {
    renderProjectArtifact: async ({ document }) =>
      JSON.stringify({
        app: "cozyclay",
        kind: "project",
        version: 2,
        scenes: {
          scenes: [
            {
              stage: {
                characters: document.cast.map((m) => ({ id: `char-${m.standIn}` })),
                shotAspect: "16:9",
              },
            },
          ],
        },
      }),
  };
  const service = new CloudbathPrevisService(store, "https://cloudbath.example", engine, {
    putPrivateArtifact: async () => {},
  });
  const active = mem<ActivePrevisContext>();
  const router = new CloudbathPrevisLineRouter({
    service,
    resolver,
    active,
    dedupe: dedupeStore(),
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
  });
  return {
    router,
    store,
    active,
    displayNames,
    workflow,
    resolver,
    send: (content: string, messageId = `m-${Math.random()}`) =>
      router.handleBeforeDispatch(
        { content, senderId: OWNER, senderIsOwner: true, isGroup: true, messageId },
        { channelId: "line", accountId: ACCOUNT, conversationId: GROUP, sessionKey: "s-1" },
      ),
  };
}

describe("production resolver: canonical identity", () => {
  it("freezes the generated Character ID, not the display name", async () => {
    const { resolver } = productionResolver(fakeWorkflow());
    const resolved = await resolver.resolveProject({
      claim: CLAIM,
      characterNames: ["Twong", "Twong2"],
      scenePrompt: CREATE_MESSAGE,
    });
    expect(resolved.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(resolved.displayNames["CHAR-6"]).toBe("Twong");
    expect(resolved.displayNames["CHAR-7"]).toBe("Twong2");
    // The display name is never the canonical identity.
    expect(resolved.characterLocks.map((lock) => lock.code)).not.toContain("Twong");
  });

  it("fails closed when a character row has no generated Character ID", async () => {
    const { resolver } = productionResolver(fakeWorkflow());
    await expect(
      resolver.resolveProject({
        claim: CLAIM,
        characterNames: ["Nameless"],
        scenePrompt: "ทำฉาก Nameless 10 วิ",
      }),
    ).rejects.toThrow(/no generated Character ID/u);
  });

  it("attaches to a real UGC project and scene, not a shadow identity", async () => {
    const { resolver } = productionResolver(fakeWorkflow());
    const resolved = await resolver.resolveProject({
      claim: CLAIM,
      characterNames: ["Twong", "Twong2"],
      scenePrompt: CREATE_MESSAGE,
    });
    // A real Notion page id, never an empty placeholder.
    expect(resolved.projectPageId).toMatch(/^[0-9a-f]{32}$/u);
    expect(resolved.scenePageId).toMatch(/^[0-9a-f]{32}$/u);
    expect(resolved.projectInstanceId).toBe("instance-real-1");
    // Scene identity comes from the real scene order, not a hard-coded label.
    expect(resolved.sceneId).toBe("SCENE-1");
  });

  it("does not require a Product for a character-only previs", async () => {
    const workflow = fakeWorkflow();
    const { resolver } = productionResolver(workflow);
    await resolver.resolveProject({
      claim: CLAIM,
      characterNames: ["Twong"],
      scenePrompt: "ทำฉาก Twong 10 วิ",
    });
    expect(workflow.calls[0]!.productName).toBeUndefined();
  });

  it("recovers display names for a continued project from the durable record", async () => {
    const workflow = fakeWorkflow();
    const { resolver, displayNames } = productionResolver(workflow);
    await resolver.resolveProject({
      claim: CLAIM,
      characterNames: ["Twong", "Twong2"],
      scenePrompt: CREATE_MESSAGE,
    });
    const stored = await displayNames.lookup(previsDisplayNamesKey("instance-real-1"));
    expect(stored?.names).toMatchObject({ "CHAR-6": "Twong", "CHAR-7": "Twong2" });

    const cast = await resolver.readProjectCast({
      claim: CLAIM,
      projectInstanceId: "instance-real-1",
    });
    expect(cast.characterLocks.map((l) => l.code)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(cast.displayNames["CHAR-6"]).toBe("Twong");
  });

  it("refuses a cast read for a different owner", async () => {
    const { resolver } = productionResolver(fakeWorkflow());
    await resolver.resolveProject({
      claim: CLAIM,
      characterNames: ["Twong"],
      scenePrompt: "ทำฉาก Twong 10 วิ",
    });
    await expect(
      resolver.readProjectCast({
        claim: { ...CLAIM, ownerSenderId: "U-other" },
        projectInstanceId: "instance-real-1",
      }),
    ).rejects.toThrow(/not accessible/u);
  });
});

describe("production resolver: create -> edit -> approve keeps canonical codes", () => {
  it("holds CHAR-6/CHAR-7 and Twong/A across the whole LINE flow", async () => {
    const h = harness();

    const created = await h.send(CREATE_MESSAGE, "m-create");
    expect(created?.text).toContain("สร้าง Previs v1");
    // LINE shows the display names, never the codes.
    expect(created?.text).toContain("Twong + Twong2");
    expect(created?.text).not.toContain("CHAR-6");

    const context = await h.active.lookup(activePrevisKey(CLAIM));
    expect(context?.projectPageId).toMatch(/^[0-9a-f]{32}$/u);
    expect(context?.scenePageId).toMatch(/^[0-9a-f]{32}$/u);
    expect(context?.sceneId).toBe("SCENE-1");

    const v1 = await h.store.readLatest({
      previsProjectId: context!.previsProjectId,
      claim: CLAIM,
    });
    // Identity, display and stand-in stay three separate things.
    expect(v1!.document.cast.map((m) => [m.characterCode, m.displayName, m.standIn])).toEqual([
      ["CHAR-6", "Twong", "A"],
      ["CHAR-7", "Twong2", "B"],
    ]);
    expect(v1!.frozenCharacterPageIds).toEqual(["page-6", "page-7"]);
    // The CozyClay artifact still receives generic stand-ins only.
    for (const member of v1!.document.cast) {
      expect(member.standInSubject).not.toMatch(/Twong|CHAR-6|CHAR-7/u);
    }

    const edited = await h.send(EDIT_MESSAGE, "m-edit");
    expect(edited?.text).toContain("อัปเดต Previs เป็น v2");
    const v2 = await h.store.readLatest({
      previsProjectId: context!.previsProjectId,
      claim: CLAIM,
    });
    // "Twong" resolved to the frozen CHAR-6 lock, which is stand-in A.
    expect(v2!.document.movements[0]!.standIn).toBe("A");
    expect(v2!.document.cast.map((m) => m.characterCode)).toEqual(["CHAR-6", "CHAR-7"]);

    const approved = await h.send("APPROVE PREVIS", "m-approve");
    expect(approved?.text).toContain("อนุมัติ Previs v2");
    const finalVersion = await h.store.readLatest({
      previsProjectId: context!.previsProjectId,
      claim: CLAIM,
    });
    expect(finalVersion!.approvedAt).toBeTruthy();
    // The approved version still carries the real linkage the next phase needs.
    expect(finalVersion!.document.cast.map((m) => m.characterCode)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(finalVersion!.projectInstanceId).toBe("instance-real-1");
  });

  it("does not create a second project for a retried create webhook", async () => {
    const h = harness();
    const first = await h.send(CREATE_MESSAGE, "line-msg-1");
    const retry = await h.send(CREATE_MESSAGE, "line-msg-1");
    expect(retry?.text).toBe(first?.text);
    // The shared lifecycle was entered exactly once.
    expect(h.workflow.calls).toHaveLength(1);
  });
});
