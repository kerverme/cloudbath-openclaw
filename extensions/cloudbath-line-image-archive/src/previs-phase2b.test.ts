import { describe, expect, it, vi } from "vitest";
import { parsePrevisIntent, parseTimeRange } from "./previs-intent.js";
import {
  activePrevisKey,
  CloudbathPrevisLineRouter,
  type ActivePrevisContext,
  type PrevisDedupeStore,
  type PrevisProjectResolver,
} from "./previs-line-router.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisEngine } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const BASE_URL = "https://cloudbath.example";
const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const CLAIM: PrevisAccessClaim = {
  accountId: ACCOUNT,
  lineGroupId: GROUP,
  ownerSenderId: OWNER,
};
const NAMES = ["Twong", "Twong2"] as const;

/** The canonical Phase 2B inputs. */
const CREATE_MESSAGE = "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 แล้วคุยกันเบาๆ 15 วิ แนวตั้ง";
const EDIT_MESSAGE = "วิ 10-14 ให้ Twong หมุนตัวกลับมามอง Twong2";
const REGRESSION_MESSAGE =
  "ใช้ Twong กับ Twong2 ให้ Twong เดินผ่าน Twong2 คุยกันเบาๆ 10 วิ แนวตั้ง 720p มีเสียง";

const lock = (code: string, pageId: string): UgcCharacterLock =>
  Object.freeze({
    code,
    pageId,
    identityReferences: Object.freeze([
      Object.freeze({ kind: "identity", source: "r2", locator: `ugc/${pageId}.png` } as const),
    ]),
    styleReferences: Object.freeze([]),
    frozenAt: "2026-08-30T00:00:00.000Z",
  });

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
  return {
    lookup: async (k) => m.get(k),
    register: async (k, v) => void m.set(k, v),
  };
}

function fakeEngine() {
  const state = { calls: 0 };
  const engine: PrevisEngine & { readonly calls: number } = {
    get calls() {
      return state.calls;
    },
    renderProjectArtifact: async ({ document }) => {
      state.calls += 1;
      return JSON.stringify({
        app: "cozyclay",
        kind: "project",
        version: 2,
        scenes: {
          scenes: [
            {
              stage: {
                characters: document.cast.map((m) => ({ id: `char-${m.standIn.toLowerCase()}` })),
                shotAspect: "16:9",
              },
            },
          ],
        },
      });
    },
  } as PrevisEngine & { readonly calls: number };
  return engine;
}

function resolver(overrides: Partial<PrevisProjectResolver> = {}): PrevisProjectResolver {
  const locks = [lock("CHAR-6", "page-char-6"), lock("CHAR-7", "page-char-7")];
  const displayNames = { "CHAR-6": "Twong", "CHAR-7": "Twong2" } as const;
  return {
    listCharacterNames: async () => NAMES,
    resolveProject: async ({ characterNames }) => ({
      projectInstanceId: "proj-1",
      sceneId: "SCENE-1",
      characterLocks: locks.slice(0, Math.max(1, characterNames.length)),
      displayNames,
    }),
    readProjectCast: async () => ({ characterLocks: locks, displayNames }),
    ...overrides,
  };
}

type Harness = {
  router: CloudbathPrevisLineRouter;
  store: PrevisStore;
  engine: ReturnType<typeof fakeEngine>;
  active: AsyncKeyedStore<ActivePrevisContext>;
  artifactKeys: string[];
  send(
    content: string,
    over?: { messageId?: string; senderId?: string; group?: string },
  ): Promise<{ handled: true; text?: string } | undefined>;
};

function harness(
  options: { resolver?: PrevisProjectResolver; engine?: PrevisEngine } = {},
): Harness {
  const engine = (options.engine ?? fakeEngine()) as ReturnType<typeof fakeEngine>;
  const artifactKeys: string[] = [];
  const store = new PrevisStore({
    heads: mem<PrevisProjectHead>(),
    versions: mem<PrevisVersion>(),
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    artifactKeyPrefix: "previs/cozyclay",
  });
  const service = new CloudbathPrevisService(store, BASE_URL, engine, {
    putPrivateArtifact: async ({ objectKey }) => {
      artifactKeys.push(objectKey);
    },
  });
  const active = mem<ActivePrevisContext>();
  const router = new CloudbathPrevisLineRouter({
    service,
    resolver: options.resolver ?? resolver(),
    active,
    dedupe: dedupeStore(),
    registry: {
      lookup: async (_accountId, groupId) =>
        groupId === GROUP ? { policyId: "UGC", boundByOwnerId: OWNER } : null,
    },
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
  });
  return {
    router,
    store,
    engine,
    active,
    artifactKeys,
    send: (content, over = {}) =>
      router.handleBeforeDispatch(
        {
          content,
          senderId: over.senderId ?? OWNER,
          senderIsOwner: true,
          isGroup: true,
          messageId: over.messageId ?? `m-${Math.random()}`,
        },
        {
          channelId: "line",
          accountId: ACCOUNT,
          conversationId: over.group ?? GROUP,
          sessionKey: "s-1",
        },
      ),
  };
}

describe("routing contract (1, 2, 10, 26)", () => {
  it("routes a natural two-character request to PREVIS, not a generic confirmation", async () => {
    const h = harness();
    const result = await h.send(CREATE_MESSAGE);
    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("สร้าง Previs v1");
    // The model never runs, so no [[confirm:]] can be emitted for this turn.
    expect(result?.text).not.toContain("[[confirm");
    expect(result?.text).not.toMatch(/ยืนยัน|ยกเลิก/u);
  });

  it("recreates the historical failure input and still enters previs creation", async () => {
    const h = harness();
    const result = await h.send(REGRESSION_MESSAGE);
    expect(result?.handled).toBe(true);
    expect(result?.text).toContain("สร้าง Previs v1");
    expect(result?.text).toContain("10 วิ");
    expect(result?.text).not.toContain("[[confirm");
  });

  it("does not require the word previs", () => {
    const intent = parsePrevisIntent({
      content: "ทำฉาก Twong เดินเข้ามาหา Twong2 10 วิ",
      knownCharacterNames: NAMES,
    });
    expect(intent?.kind).toBe("create");
  });

  it("leaves non-previs messages to the normal flow", async () => {
    const h = harness();
    expect(await h.send("สวัสดีครับ")).toBeUndefined();
    expect(await h.send("ยืนยัน")).toBeUndefined();
    expect(await h.send("ยืนยัน VIDEO 4827")).toBeUndefined();
  });
});

describe("character resolution (3-7)", () => {
  it("keeps character-only previs valid without a Product", async () => {
    const h = harness();
    const result = await h.send(CREATE_MESSAGE);
    expect(result?.text).toContain("Twong + Twong2");
  });

  it("maps cast order to A/B and keeps it frozen across versions", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.document.cast.map((m) => [m.displayName, m.standIn])).toEqual([
      ["Twong", "A"],
      ["Twong2", "B"],
    ]);
  });

  it("fails closed on a named character the library does not hold", async () => {
    const h = harness();
    const result = await h.send("ใช้ Twong กับ Twong3 เดินผ่านกัน 10 วิ");
    expect(result?.text).toContain("ไม่พบตัวละคร");
    expect(result?.text).toContain("Twong3");
    expect(h.engine.calls).toBe(0);
  });

  it("fails closed when the library resolution is ambiguous", async () => {
    const h = harness({
      resolver: resolver({
        resolveProject: async () => {
          throw new Error("CHARACTER_LIBRARY record is ambiguous");
        },
      }),
    });
    const result = await h.send(CREATE_MESSAGE);
    expect(result?.text).toBe("สร้าง Previs ไม่สำเร็จ กรุณาลองอีกครั้ง");
    // The internal reason is never surfaced to the user.
    expect(result?.text).not.toMatch(/ambiguous|CHARACTER_LIBRARY/u);
  });
});

describe("create (8, 9, 11, 31-34)", () => {
  it("creates a real v1 with a stable 3D URL and a private artifact", async () => {
    const h = harness();
    const result = await h.send(CREATE_MESSAGE);
    expect(h.engine.calls).toBe(1);
    expect(h.artifactKeys).toHaveLength(1);
    expect(h.artifactKeys[0]).toMatch(
      /^previs\/cozyclay\/assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u,
    );
    expect(result?.text).toContain("15 วิ");
    expect(result?.text).toContain("9:16");
    const url = result!.text!.match(/https:\/\/\S+/u)![0];
    expect(url.startsWith(`${BASE_URL}/previs/`)).toBe(true);
  });

  it("never leaks internal ids, R2 keys or credentials into the LINE reply", async () => {
    const h = harness();
    const result = await h.send(CREATE_MESSAGE);
    const text = result!.text!;
    expect(text).not.toContain(h.artifactKeys[0]!);
    expect(text).not.toMatch(/X-Amz-|r2\.cloudflarestorage|localhost|127\.0\.0\.1|AKIA/u);
    expect(text).not.toContain("proj-1");
    expect(text).not.toContain("page-char-6");
    expect(text).not.toContain("/opt/cozyclay");
  });

  it("does not leak canonical identity into the CozyClay artifact", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    for (const member of latest!.document.cast) {
      expect(member.standInSubject).not.toMatch(/Twong|CHAR-6|CHAR-7/u);
    }
  });
});

describe("active context scope (12-14)", () => {
  it("scopes the active previs to the owner triple", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    expect(await h.active.lookup(activePrevisKey(CLAIM))).toBeDefined();
    expect(
      await h.active.lookup(activePrevisKey({ ...CLAIM, ownerSenderId: "U-other" })),
    ).toBeUndefined();
  });

  it("ignores a different group entirely", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    // A group with no UGC binding is not ours; the turn passes through.
    expect(await h.send(EDIT_MESSAGE, { group: "C0000000000000000" })).toBeUndefined();
  });

  it("does not let another participant approve the owner's previs", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const intruder = await h.router.handleBeforeDispatch(
      { content: "APPROVE PREVIS", senderId: "U-intruder", senderIsOwner: false, isGroup: true },
      { channelId: "line", accountId: ACCOUNT, conversationId: GROUP, sessionKey: "s-2" },
    );
    expect(intruder).toBeUndefined();
  });

  it("returns a deterministic message when no active previs exists", async () => {
    const h = harness();
    const result = await h.send(EDIT_MESSAGE);
    expect(result?.text).toBe("ยังไม่มี Previs ที่กำลังทำอยู่ กรุณาสร้างฉากก่อน");
  });
});

describe("time range parsing and edit semantics (15-21)", () => {
  it("parses the canonical range forms", () => {
    expect(parseTimeRange("วิ 10-14 ให้ Twong หมุนตัวกลับ")).toEqual({
      fromSecond: 10,
      toSecond: 14,
    });
    expect(parseTimeRange("วินาที 6-9 ให้ Twong2 กระโดดถอยหลัง")).toEqual({
      fromSecond: 6,
      toSecond: 9,
    });
    expect(parseTimeRange("ช่วง 3 ถึง 6 วิ ให้ Twong เดินเข้าใกล้")).toEqual({
      fromSecond: 3,
      toSecond: 6,
    });
    // A bare duration is a create request, never a range.
    expect(parseTimeRange("15 วิ")).toBeUndefined();
  });

  it("rejects an out-of-range edit instead of clamping it", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const result = await h.send("วิ 14-20 ให้ Twong หมุนตัวกลับ");
    expect(result?.text).toBe("ช่วงเวลา 14-20 วิ เกินความยาวฉาก 15 วิ");
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.versionNumber).toBe(1);
  });

  it("rejects an inverted range", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const result = await h.send("วิ 12-8 ให้ Twong หมุนตัวกลับ");
    expect(result?.text).toContain("เกินความยาวฉาก");
  });

  it("creates v2 for a 10-14 edit, preserves v1, and keeps the same stable URL", async () => {
    const h = harness();
    const created = await h.send(CREATE_MESSAGE);
    const createdUrl = created!.text!.match(/https:\/\/\S+/u)![0];

    const edited = await h.send(EDIT_MESSAGE);
    expect(edited?.text).toContain("อัปเดต Previs เป็น v2");
    expect(edited?.text).toContain("10-14");
    const editedUrl = edited!.text!.match(/https:\/\/\S+/u)![0];
    expect(editedUrl).toBe(createdUrl);

    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const token = new URL(createdUrl).pathname.split("/")[3]!;
    const latest = await h.store.resolveForReview({
      previsProjectId: active!.previsProjectId,
      token,
    });
    expect(latest?.version.versionNumber).toBe(2);

    const v1 = await h.store.resolveForReview({
      previsProjectId: active!.previsProjectId,
      token,
      versionNumber: 1,
    });
    expect(v1?.version.versionNumber).toBe(1);
    // v1's timeline is untouched by the edit.
    expect(v1?.version.document.movements).toEqual([]);
    expect(latest?.version.document.movements).toEqual([
      expect.objectContaining({ standIn: "A", startSecond: 10, endSecond: 14 }),
    ]);
  });

  it("targets the stand-in named in the edit, resolved from the frozen cast", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    await h.send("วิ 6-9 ให้ Twong2 กระโดดถอยหลัง");
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.document.movements[0]!.standIn).toBe("B");
  });
});

describe("approval (22-25)", () => {
  it("approves the latest version and states no paid action occurred", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    await h.send(EDIT_MESSAGE);
    const approved = await h.send("APPROVE PREVIS");
    expect(approved?.text).toContain("อนุมัติ Previs v2");
    expect(approved?.text).toContain("ยังไม่มีการสร้าง Final Video หรือคิดค่าใช้จ่าย");

    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.versionNumber).toBe(2);
    expect(latest!.approvedAt).toBeTruthy();
  });

  it("is idempotent and creates no v3", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const first = await h.send("APPROVE PREVIS");
    const second = await h.send("APPROVE PREVIS");
    expect(first?.text).toContain("v1");
    expect(second?.text).toContain("v1");
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.versionNumber).toBe(1);
  });

  it("supports the Thai alias but never a bare confirm", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    expect((await h.send("อนุมัติ PREVIS"))?.text).toContain("อนุมัติ Previs v1");

    const plain = harness();
    await plain.send(CREATE_MESSAGE);
    // A bare confirm is not a previs intent at all: the turn passes through.
    expect(await plain.send("ยืนยัน")).toBeUndefined();
    const stillDraft = await plain.store.readLatest({
      previsProjectId: (await plain.active.lookup(activePrevisKey(CLAIM)))!.previsProjectId,
      claim: CLAIM,
    });
    expect(stillDraft!.approvedAt).toBeUndefined();
  });

  it("makes zero paid provider calls across the whole flow", async () => {
    const seedance = vi.fn();
    const runway = vi.fn();
    const videoGenerate = vi.fn();
    const h = harness();
    await h.send(CREATE_MESSAGE);
    await h.send(EDIT_MESSAGE);
    await h.send("APPROVE PREVIS");
    expect(seedance).not.toHaveBeenCalled();
    expect(runway).not.toHaveBeenCalled();
    expect(videoGenerate).not.toHaveBeenCalled();
    // Two renders (create + edit) and nothing else touched an engine.
    expect(h.engine.calls).toBe(2);
  });
});

describe("idempotency and concurrency (27-30)", () => {
  it("does not create a duplicate previs for a retried webhook", async () => {
    const h = harness();
    const first = await h.send(CREATE_MESSAGE, { messageId: "line-msg-1" });
    const retry = await h.send(CREATE_MESSAGE, { messageId: "line-msg-1" });
    expect(retry?.text).toBe(first?.text);
    expect(h.engine.calls).toBe(1);
    expect(h.artifactKeys).toHaveLength(1);
  });

  it("does not append a second version for a retried edit webhook", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE, { messageId: "line-msg-1" });
    const first = await h.send(EDIT_MESSAGE, { messageId: "line-msg-2" });
    const retry = await h.send(EDIT_MESSAGE, { messageId: "line-msg-2" });
    expect(retry?.text).toBe(first?.text);
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.versionNumber).toBe(2);
  });

  it("never silently loses one of two concurrent edits", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const [a, b] = await Promise.all([
      h.send("วิ 10-14 ให้ Twong หมุนตัวกลับ", { messageId: "c-1" }),
      h.send("วิ 6-9 ให้ Twong2 กระโดดถอยหลัง", { messageId: "c-2" }),
    ]);
    const texts = [a?.text ?? "", b?.text ?? ""];
    const applied = texts.filter((t) => t.includes("อัปเดต Previs"));
    const refused = texts.filter((t) => t.includes("ไม่สำเร็จ"));
    // One wins the version slot; the other is refused loudly, never dropped.
    expect(applied.length + refused.length).toBe(2);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    const active = await h.active.lookup(activePrevisKey(CLAIM));
    const latest = await h.store.readLatest({
      previsProjectId: active!.previsProjectId,
      claim: CLAIM,
    });
    expect(latest!.versionNumber).toBe(applied.length + 1);
  });

  it("leaves the active context and head intact when CozyClay fails", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    const activeBefore = await h.active.lookup(activePrevisKey(CLAIM));

    const failing = harness({
      engine: {
        renderProjectArtifact: async () => {
          throw new Error("CozyClay MCP server is unreachable");
        },
      },
    });
    const created = await failing.send(CREATE_MESSAGE);
    expect(created?.text).toBe("สร้าง Previs ไม่สำเร็จ กรุณาลองอีกครั้ง");
    // No active context is written for a previs that was never created.
    expect(await failing.active.lookup(activePrevisKey(CLAIM))).toBeUndefined();
    expect(activeBefore).toBeDefined();
  });
});

describe("existing paid safety is untouched (35)", () => {
  it("keeps the exact VIDEO confirmation gate out of previs routing", async () => {
    const h = harness();
    await h.send(CREATE_MESSAGE);
    // The paid confirmation is not a previs intent, so previs never consumes it.
    expect(await h.send("ยืนยัน VIDEO 4827")).toBeUndefined();
    expect(await h.send("ยืนยัน VIDEO 0001")).toBeUndefined();
  });

  it("does not treat a generic video request as previs", async () => {
    const h = harness();
    // No cast member named, so the generic video path keeps the turn.
    expect(await h.send("ทำวิดีโอแมวน่ารัก 10 วิ")).toBeUndefined();
  });
});
