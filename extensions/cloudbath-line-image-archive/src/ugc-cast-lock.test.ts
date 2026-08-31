import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import type {
  ActiveUgcLineSession,
  ActiveUgcProject,
  FrozenUgcVideoScope,
  NotionTarget,
  PendingUgcVideoScope,
  UgcCapabilityId,
  UgcProjectCharacterLock,
  UgcProjectInstance,
  WorkspacePolicyConfig,
} from "./types.js";
import { CloudbathUgcVideoWorkflow, generatedIdText, type NotionPage } from "./ugc-workflow.js";

/**
 * The shared cast-lock guard, exercised through the REAL
 * `CloudbathUgcVideoWorkflow.resolveProjectScene`.
 *
 * The routing suites stub `resolveProjectScene`, which is exactly why the
 * display-name-versus-canonical-code mismatch survived: nothing drove the real
 * lifecycle twice against one project. These tests do, for both caller styles
 * that exist in production:
 *
 *   canonicalising  previs / storyboard -- names in, CHAR-6 frozen
 *   verbatim        cloudbath_ugc_video_prepare -- the typed code is frozen
 */

const ACCOUNT = "acct-1";
const GROUP = "C-ugc";
const OWNER = "U-owner";

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

const CONFIG: NonNullable<WorkspacePolicyConfig["ugc"]> = { capabilities: CAPABILITIES };

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

/** Twong -> CHAR-6, Twong2 -> CHAR-7, Other -> CHAR-99. */
function freshLibrary(): Record<string, NotionPage> {
  return {
    Twong: characterPage({ name: "Twong", number: 6 }),
    Twong2: characterPage({ name: "Twong2", number: 7 }),
    Other: characterPage({ name: "Other", number: 99 }),
  };
}

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values, ([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

function harness() {
  const projectLocks = memoryStore<UgcProjectCharacterLock>();
  const library = freshLibrary();
  const notionCalls = { resolveNamedRecord: 0 };
  const projectPage = { id: "a".repeat(32) } as unknown as NotionPage;
  const notion = {
    resolveNamedRecord: async ({ name }: { name: string }) => {
      notionCalls.resolveNamedRecord += 1;
      const page = library[name];
      if (!page) {
        // Fail closed exactly like the production client: unknown and
        // ambiguous rows both throw rather than resolving to something.
        throw new Error("CHARACTER_LIBRARY record not found");
      }
      return page;
    },
    readProjectPage: async () => projectPage,
    createProject: async () => projectPage,
    latestSceneNumber: async () => 0,
    findSceneByOrder: async () => ({ id: "b".repeat(32) }) as unknown as NotionPage,
    createOrReuseScene: async () => ({ id: "c".repeat(32) }) as unknown as NotionPage,
  };
  const workflow = new CloudbathUgcVideoWorkflow(
    CONFIG,
    {} as never,
    notion as never,
    memoryStore<PendingUgcVideoScope>(),
    memoryStore<FrozenUgcVideoScope>(),
    memoryStore<ActiveUgcLineSession>(),
    projectLocks,
    memoryStore<UgcProjectInstance>(),
    memoryStore<ActiveUgcProject>(),
    () => Date.UTC(2026, 7, 31),
  );

  /** Mirrors `createPrevisProjectResolver`: names in, canonical codes frozen. */
  const canonicalising = async (characterNames: readonly string[], sceneNumber?: number) =>
    await workflow.resolveProjectScene({
      accountId: ACCOUNT,
      groupId: GROUP,
      ownerSenderId: OWNER,
      characterNames,
      resolveCharacterPages: async () => {
        const pages: Array<{ code: string; page: NotionPage }> = [];
        for (const name of characterNames) {
          const page = await notion.resolveNamedRecord({ name });
          const code = generatedIdText(page.properties?.["Character ID"]).trim();
          if (!code) {
            throw new Error(`Character "${name}" has no generated Character ID`);
          }
          pages.push({ code, page });
        }
        return pages;
      },
      prompt: "a scene",
      ...(sceneNumber === undefined ? {} : { sceneNumber }),
    });

  /** Mirrors `cloudbath_ugc_video_prepare`: the typed code is frozen verbatim. */
  const verbatim = async (characterNames: readonly string[], sceneNumber?: number) =>
    await workflow.resolveProjectScene({
      accountId: ACCOUNT,
      groupId: GROUP,
      ownerSenderId: OWNER,
      characterNames,
      resolveCharacterPages: async () => {
        const pages: Array<{ code: string; page: NotionPage }> = [];
        for (const code of characterNames) {
          pages.push({ code, page: await notion.resolveNamedRecord({ name: code }) });
        }
        return pages;
      },
      prompt: "a scene",
      ...(sceneNumber === undefined ? {} : { sceneNumber }),
    });

  const lockedCodes = async (): Promise<readonly string[]> => {
    const [entry] = await projectLocks.entries();
    return entry?.value.characterLocks.map((lock) => lock.code) ?? [];
  };

  return { canonicalising, verbatim, lockedCodes, notionCalls, projectLocks, library };
}

describe("A. the first scene freezes the cast canonically", () => {
  it("stores canonical Character IDs, never the display names", async () => {
    const h = harness();
    const first = await h.canonicalising(["Twong", "Twong2"]);

    expect(first.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
    for (const lock of first.characterLocks) {
      expect(lock.code).toMatch(/^CHAR-\d+$/u);
      expect(["Twong", "Twong2"]).not.toContain(lock.code);
    }
  });
});

describe("B. a second scene in the same project passes", () => {
  it("compares canonical IDs, not the display names the owner typed", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    // The critical regression: this threw "already locked to CHAR-6, CHAR-7"
    // because "twong" was compared against "char-6".
    const second = await h.canonicalising(["Twong", "Twong2"], 2);
    expect(second.sceneNumber).toBe(2);
    expect(second.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    // The lock is reused, never rewritten back to display names.
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});

describe("C. cast order stays normalised", () => {
  it("accepts the same cast named in a different order", async () => {
    // Existing semantics sort both sides before comparing; this pins that so a
    // later change cannot silently make cast order significant.
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    const reversed = await h.canonicalising(["Twong2", "Twong"], 2);
    expect(reversed.sceneNumber).toBe(2);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});

describe("D. a different cast still fails closed", () => {
  it("rejects a scene naming a character outside the frozen lock", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    await expect(h.canonicalising(["Twong", "Other"], 2)).rejects.toThrow(
      /already locked to CHAR-6, CHAR-7/u,
    );
    // The lock is untouched by the rejected request.
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });

  it("rejects a subset of the frozen cast", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    await expect(h.canonicalising(["Twong"], 2)).rejects.toThrow(/already locked/u);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});

describe("E. an unresolvable character fails closed", () => {
  it("never falls back to comparing the raw display name", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    // "Nobody" has no Character Library row: resolution throws, and the guard
    // must not quietly compare the string "Nobody" against the lock instead.
    await expect(h.canonicalising(["Twong", "Nobody"], 2)).rejects.toThrow(
      /CHARACTER_LIBRARY record not found/u,
    );
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});

describe("E2. an id-less Character row fails closed", () => {
  it("refuses to compare pages that carry no id", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    // Two id-less rows would compare equal to each other and to any other
    // id-less lock, so the guard must reject rather than pass.
    h.library.Twong = {
      ...(h.library.Twong as unknown as Record<string, unknown>),
      id: undefined,
    } as unknown as NotionPage;

    await expect(h.canonicalising(["Twong", "Twong2"], 2)).rejects.toThrow(
      // Named by canonical code, the identity the guard actually works in.
      /Character "CHAR-6" has no Character Library page id/u,
    );
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });
});

describe("E3. a corrupt frozen lock fails closed", () => {
  it("names the culprit instead of throwing inside the comparator", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    // Corrupt the stored lock's page id, as a partially written row would be.
    for (const { key, value } of await h.projectLocks.entries()) {
      await h.projectLocks.register(key, {
        ...value,
        characterLocks: value.characterLocks.map((lock, index) => {
          if (index !== 0) {
            return lock;
          }
          const corrupt = structuredClone(lock) as { pageId?: string };
          delete corrupt.pageId;
          return corrupt as typeof lock;
        }),
      });
    }

    await expect(h.canonicalising(["Twong", "Twong2"], 2)).rejects.toThrow(
      /Character "CHAR-6" has no Character Library page id/u,
    );
  });
});

describe("F. cloudbath_ugc_video_prepare is unaffected", () => {
  it("keeps working when the caller freezes the typed code verbatim", async () => {
    const h = harness();
    const first = await h.verbatim(["Twong", "Twong2"], 1);
    expect(first.characterLocks.map((lock) => lock.code)).toEqual(["Twong", "Twong2"]);

    const second = await h.verbatim(["Twong", "Twong2"], 2);
    expect(second.sceneNumber).toBe(2);
    expect(await h.lockedCodes()).toEqual(["Twong", "Twong2"]);
  });

  it("still rejects a different cast for a verbatim caller", async () => {
    const h = harness();
    await h.verbatim(["Twong", "Twong2"], 1);
    await expect(h.verbatim(["Twong", "Other"], 2)).rejects.toThrow(/already locked/u);
  });
});

describe("H. a project takes many scenes without a false mismatch", () => {
  it("runs five consecutive scenes on one frozen canonical cast", async () => {
    const h = harness();
    for (let sceneNumber = 1; sceneNumber <= 5; sceneNumber += 1) {
      const resolved = await h.canonicalising(["Twong", "Twong2"], sceneNumber);
      expect(resolved.sceneNumber, `scene ${sceneNumber}`).toBe(sceneNumber);
      expect(resolved.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    }
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });

  it("keeps the frozen references even after the library row changes", async () => {
    const h = harness();
    const first = await h.canonicalising(["Twong", "Twong2"], 1);
    expect(first.characterLocks[0]!.identityReferences[0]!.locator).toBe(
      "ugc/characters/Twong.png",
    );

    // Repoint the library row. Only identity is re-resolved on a continuation,
    // so the frozen reference must NOT follow the edit.
    h.library.Twong = {
      ...(h.library.Twong as unknown as { properties: Record<string, unknown> }),
      id: "page-char-6",
      properties: {
        ...(h.library.Twong as unknown as { properties: Record<string, unknown> }).properties,
        "Identity Reference R2 Keys": {
          type: "rich_text",
          rich_text: [{ plain_text: "ugc/characters/REPOINTED.png" }],
        },
      },
    } as unknown as NotionPage;

    const second = await h.canonicalising(["Twong", "Twong2"], 2);
    expect(second.characterLocks[0]!.identityReferences[0]!.locator).toBe(
      "ugc/characters/Twong.png",
    );
    expect(second.characterLocks).toEqual(first.characterLocks);
  });
});

describe("G. either caller can continue a project the other started", () => {
  it("lets previs continue a project cloudbath_ugc_video_prepare created", async () => {
    // The two callers freeze different `code` schemes on purpose, so identity
    // has to be the Character page they both resolve to.
    const h = harness();
    const first = await h.verbatim(["Twong", "Twong2"], 1);
    expect(first.characterLocks.map((lock) => lock.code)).toEqual(["Twong", "Twong2"]);

    const second = await h.canonicalising(["Twong", "Twong2"], 2);
    expect(second.sceneNumber).toBe(2);
    // The lock is reused as frozen; continuing never rewrites its codes.
    expect(await h.lockedCodes()).toEqual(["Twong", "Twong2"]);
  });

  it("lets cloudbath_ugc_video_prepare continue a project previs created", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    const second = await h.verbatim(["Twong", "Twong2"], 2);
    expect(second.sceneNumber).toBe(2);
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);
  });

  it("still rejects a different cast across callers", async () => {
    const h = harness();
    await h.verbatim(["Twong", "Twong2"], 1);
    await expect(h.canonicalising(["Twong", "Other"], 2)).rejects.toThrow(/already locked/u);
  });
});

describe("J. the resolve cost per continuation is bounded", () => {
  it("resolves each named character exactly once per scene", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    const afterFirst = h.notionCalls.resolveNamedRecord;
    expect(afterFirst).toBe(2);

    // A continuation re-resolves identity (and only identity): two names, two
    // lookups. This is the change's new cost, pinned so it cannot creep.
    await h.canonicalising(["Twong", "Twong2"], 2);
    expect(h.notionCalls.resolveNamedRecord - afterFirst).toBe(2);
  });
});

describe("I. a continuation whose lock is missing rebuilds it", () => {
  it("re-freezes the named cast instead of storing an empty lock", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);

    // Simulate an evicted lock row: the instance and active pointer survive.
    for (const { key } of await h.projectLocks.entries()) {
      await h.projectLocks.delete(key);
    }

    const second = await h.canonicalising(["Twong", "Twong2"], 2);
    expect(second.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    // Not a zero-character lock, which would poison the project.
    expect(await h.lockedCodes()).toEqual(["CHAR-6", "CHAR-7"]);

    const third = await h.canonicalising(["Twong", "Twong2"], 3);
    expect(third.sceneNumber).toBe(3);
  });
});

describe("K. a lost lock cannot silently re-cast the project", () => {
  it("rejects a rebuild that names a cast the instance never froze", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    for (const { key } of await h.projectLocks.entries()) {
      await h.projectLocks.delete(key);
    }

    // The lock is gone but the INSTANCE still carries the frozen page ids.
    await expect(h.canonicalising(["Twong", "Other"], 2)).rejects.toThrow(
      /already locked to a different cast/u,
    );
    expect(await h.lockedCodes()).toEqual([]);
  });

  it("refuses a cast-less continuation instead of dropping the identity", async () => {
    const h = harness();
    await h.canonicalising(["Twong", "Twong2"], 1);
    for (const { key } of await h.projectLocks.entries()) {
      await h.projectLocks.delete(key);
    }

    // References can only be rebuilt from names. Preparing this scene anyway
    // would carry no identity references at all, so it fails closed and no
    // empty lock is written.
    await expect(h.canonicalising([], 2)).rejects.toThrow(/cast needs naming again/u);
    expect((await h.projectLocks.entries()).length).toBe(0);

    // Naming the cast again rebuilds the lock and the project continues.
    const rebuilt = await h.canonicalising(["Twong", "Twong2"], 3);
    expect(rebuilt.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
  });
});
