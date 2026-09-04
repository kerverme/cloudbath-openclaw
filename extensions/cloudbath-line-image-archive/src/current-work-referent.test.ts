import { describe, expect, it, vi } from "vitest";
import { conversationContextKey } from "./conversation-context.js";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import {
  expectNothingBillable,
  harness,
  OWNER_SENDER_ID,
  resolver,
  type StoryboardLogFn,
} from "./storyboard-router.test-support.js";
import { activeStoryboardKey } from "./storyboard-store.js";
import { StoryboardVisualService, type StoryboardVisualArtifact } from "./storyboard-visual.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const CLAIM = { accountId: ACCOUNT, lineGroupId: GROUP, ownerSenderId: OWNER_SENDER_ID };

function lock(code: string): UgcCharacterLock {
  return Object.freeze({
    code,
    pageId: `page-${code.toLowerCase()}`,
    identityReferences: Object.freeze([
      { kind: "identity" as const, source: "r2" as const, locator: `ugc/${code}.jpg` },
    ]),
    styleReferences: Object.freeze([]),
    frozenAt: "2026-09-04T00:00:00.000Z",
  });
}

function paidRuntime(): StoryboardPaidDraftRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    prepareStoryboardVideoDraft: async () => {
      runtime.calls += 1;
      return { kind: "rejected" as const, reason: "not_used" };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & { calls: number };
}

function revisionResolver(): ConversationSemanticResolver {
  return {
    resolve: async ({ message }) =>
      message.includes("ทำวิดีโอ")
        ? undefined
        : {
            intent: "revise_active_storyboard",
            referentType: "storyboard",
            confidence: 0.99,
            needsClarification: false,
          },
  };
}

function visualStore(): AsyncKeyedStore<StoryboardVisualArtifact> {
  const values = new Map<string, StoryboardVisualArtifact>();
  return {
    lookup: async (key) => values.get(key),
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) =>
      values.has(key) ? false : (values.set(key, value), true),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

async function setupTwoWorks(logger?: { info?: StoryboardLogFn; warn: StoryboardLogFn }) {
  const paid = paidRuntime();
  let projectSequence = 0;
  const characterLocks = {
    Twong: lock("CHAR-6"),
    Monk: lock("CHAR-20"),
    Wizard: lock("CHAR-21"),
  } as const;
  const projectResolver = resolver({
    listCharacterNames: async () => ["Twong", "Monk", "Wizard"],
    resolveProject: async ({ characterNames }) => {
      projectSequence += 1;
      const selected = characterNames.map(
        (name) => characterLocks[name as keyof typeof characterLocks],
      );
      return {
        projectInstanceId: `project-${projectSequence}`,
        projectPageId: `project-page-${projectSequence}`,
        sceneId: "SCENE-1",
        scenePageId: `scene-page-${projectSequence}`,
        characterLocks: selected,
        displayNames: Object.fromEntries(
          selected.map((entry, index) => [entry.code, characterNames[index]!]),
        ),
      };
    },
  });
  const h = harness({
    resolver: projectResolver,
    paidDraftRuntime: paid,
    semanticResolver: revisionResolver(),
    ...(logger ? { logger } : {}),
  });

  await h.dispatch("ใช้ Twong ทำวิดีโอเดินในสวน 8 วิ แนวตั้ง ไม่มีเสียง");
  const workA = await h.latest();
  await h.dispatch("ใช้ Monk กับ Wizard ทำวิดีโอเดินในวัด 8 วิ แนวตั้ง ไม่มีเสียง");
  const workB = await h.latest();
  expect(workB.storyboardId).not.toBe(workA.storyboardId);

  const artifacts = visualStore();
  const visuals = new StoryboardVisualService({
    artifacts,
    now: () => 1,
    randomId: () => "b".repeat(36),
    generate: async () => ({
      bytes: Buffer.from("mock-image"),
      mimeType: "image/jpeg",
      width: 720,
      height: 1280,
      provider: "mock",
      model: "mock",
    }),
    normalize: async ({ bytes, maxWidth }) => ({
      bytes,
      mimeType: "image/jpeg",
      width: maxWidth === 240 ? 135 : 720,
      height: maxWidth === 240 ? 240 : 1280,
    }),
    persist: async () => undefined,
  });
  expect(await visuals.generate({ version: workB, claim: CLAIM })).toMatchObject({ kind: "ready" });
  return { h, paid, workA, workB };
}

describe("carried current-work referent", () => {
  it.each(["เอา 15 วิ", "สามารถทำเป็น 15 วิได้ไหม", "เปลี่ยนความยาวเป็น 15 วินาที"])(
    "revises visual work B, never the stale generic active pointer: %s",
    async (phrase) => {
      const { h, paid, workA, workB } = await setupTwoWorks();
      // Reproduce the incident: conversation context says B, legacy active pointer drifts to A.
      await h.active.register(activeStoryboardKey(CLAIM), {
        version: 1,
        storyboardId: workA.storyboardId,
        projectInstanceId: workA.projectInstanceId,
        ...CLAIM,
        updatedAt: "2026-09-04T00:00:00.000Z",
      });

      const result = await h.dispatch(phrase);
      expect(result.conversation).toMatchObject({
        kind: "route",
        route: {
          kind: "revise_active_storyboard",
          referent: {
            storyboardId: workB.storyboardId,
            storyboardVersionNumber: 1,
            projectInstanceId: workB.projectInstanceId,
          },
        },
      });
      const revisedB = await h.store.readLatest({ storyboardId: workB.storyboardId, claim: CLAIM });
      const unchangedA = await h.store.readLatest({
        storyboardId: workA.storyboardId,
        claim: CLAIM,
      });
      expect(revisedB).toMatchObject({ versionNumber: 2, document: { durationSeconds: 15 } });
      expect(unchangedA).toMatchObject({ versionNumber: 1, document: { durationSeconds: 8 } });
      expect(result.text).toContain("Storyboard v2");
      expect(result.text).toContain("Monk");
      expect(paid.calls).toBe(0);
      await expectNothingBillable(h);
    },
  );

  it("fails closed when recent work B cannot be proven instead of mutating A", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { h, paid, workA } = await setupTwoWorks(logger);
    const context = await h.conversationContext.lookup(conversationContextKey(CLAIM));
    await h.conversationContext.register(conversationContextKey(CLAIM), {
      ...context!,
      activeStoryboardId: "sb-missing",
    });
    await h.active.register(activeStoryboardKey(CLAIM), {
      version: 1,
      storyboardId: workA.storyboardId,
      projectInstanceId: workA.projectInstanceId,
      ...CLAIM,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });

    const result = await h.dispatch("เอา 15 วิ");
    expect(result.conversation?.kind).toBe("clarify");
    expect(result.text).toContain("หมายถึงงานไหน");
    expect(
      await h.store.readLatest({ storyboardId: workA.storyboardId, claim: CLAIM }),
    ).toMatchObject({
      versionNumber: 1,
      document: { durationSeconds: 8 },
    });
    expect(paid.calls).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "contextual_revision_referent_unprovable",
      expect.objectContaining({ referentProven: false }),
    );
    await expectNothingBillable(h);
  });

  it("keeps progress and successive natural revisions on newest work B", async () => {
    const { h, paid, workA, workB } = await setupTwoWorks();
    await h.active.register(activeStoryboardKey(CLAIM), {
      version: 1,
      storyboardId: workA.storyboardId,
      projectInstanceId: workA.projectInstanceId,
      ...CLAIM,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });

    const status = await h.dispatch("เสร็จยัง");
    expect(status.text).toContain("Storyboard v1");
    const environment = await h.dispatch("เอาแบบเมื่อกี้แต่เปลี่ยนเป็นกลางคืน");
    expect(environment.text).toContain("Monk");
    const duration = await h.dispatch("เอา 15 วิ");
    expect(duration.text).toContain("Monk");

    const latestB = await h.store.readLatest({ storyboardId: workB.storyboardId, claim: CLAIM });
    const latestA = await h.store.readLatest({ storyboardId: workA.storyboardId, claim: CLAIM });
    expect(latestB).toMatchObject({
      versionNumber: 3,
      document: { environment: "กลางคืน", durationSeconds: 15 },
    });
    expect(latestA).toMatchObject({ versionNumber: 1, document: { durationSeconds: 8 } });
    expect(paid.calls).toBe(0);
    await expectNothingBillable(h);
  });
});
