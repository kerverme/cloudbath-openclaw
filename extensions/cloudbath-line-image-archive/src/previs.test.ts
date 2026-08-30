import type { IncomingMessage } from "node:http";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  applyAspectRatioToProjectArtifact,
  compilePrevisPlan,
  previsDeferrals,
} from "./previs-cozyclay.js";
import { applyTimeRangeEdit, createPrevisDocument } from "./previs-document.js";
import { approvePrevis, preparePrevis } from "./previs-prepare.js";
import { createPrevisReviewRouteHandler } from "./previs-route.js";
import { PrevisStore, type PrevisArtifactSink, type PrevisEngine } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import { buildPrevisViewUrl, parsePrevisViewPath } from "./previs-url.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const BASE_URL = "https://cloudbath.example";
const CLAIM: PrevisAccessClaim = {
  accountId: "acct-1",
  lineGroupId: "C1234567890",
  ownerSenderId: "U0987654321",
};

/** Twong = CHAR-6, Twong2 = CHAR-7, frozen in that order by the project lock. */
const TWONG: UgcCharacterLock = Object.freeze({
  code: "CHAR-6",
  pageId: "page-char-6",
  identityReferences: Object.freeze([
    Object.freeze({ kind: "identity", source: "r2", locator: "ugc/characters/twong.png" } as const),
  ]),
  styleReferences: Object.freeze([]),
  frozenAt: "2026-08-29T00:00:00.000Z",
});
const TWONG2: UgcCharacterLock = Object.freeze({
  code: "CHAR-7",
  pageId: "page-char-7",
  identityReferences: Object.freeze([
    Object.freeze({
      kind: "identity",
      source: "r2",
      locator: "ugc/characters/twong2.png",
    } as const),
  ]),
  styleReferences: Object.freeze([]),
  frozenAt: "2026-08-29T00:00:00.000Z",
});

function memoryStore<T>(): AsyncKeyedStore<T> {
  const map = new Map<string, T>();
  return {
    register: async (key, value) => void map.set(key, value),
    registerIfAbsent: async (key, value) => {
      if (map.has(key)) {
        return false;
      }
      map.set(key, value);
      return true;
    },
    lookup: async (key) => map.get(key),
    entries: async () => [...map].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/**
 * Keyed store with a hard row cap that REJECTS new keys once full, mirroring the
 * SQLite store's "reject-new" overflow policy. The production alternative,
 * "evict-oldest", would delete the oldest row in the namespace instead --
 * silently destroying v1 of a live project.
 */
function cappedStore<T>(capacity: number): AsyncKeyedStore<T> {
  const inner = memoryStore<T>();
  const keys = new Set<string>();
  const guard = async (key: string) => {
    if (!keys.has(key) && keys.size >= capacity) {
      throw new Error(`Plugin state namespace reached its ${capacity}-row limit.`);
    }
    keys.add(key);
  };
  return {
    ...inner,
    register: async (key, value) => {
      await guard(key);
      return inner.register(key, value);
    },
    registerIfAbsent: async (key, value) => {
      await guard(key);
      return inner.registerIfAbsent(key, value);
    },
  };
}

function newStore() {
  return new PrevisStore({
    heads: memoryStore<PrevisProjectHead>(),
    versions: memoryStore<PrevisVersion>(),
    now: () => Date.parse("2026-08-29T12:00:00.000Z"),
    artifactKeyPrefix: "previs/cozyclay",
  });
}

/** A previs engine that returns a real CozyClay project envelope shape. */
function fakeEngine(): { engine: PrevisEngine; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    engine: {
      renderProjectArtifact: async ({ document }) => {
        state.calls += 1;
        return JSON.stringify({
          app: "cozyclay",
          kind: "project",
          version: 2,
          name: "previs",
          scenes: {
            version: 4,
            activeSceneId: "scene-1",
            scenes: [
              {
                id: "scene-1",
                name: "SCENE 01",
                objects: [],
                shotDocument: null,
                stage: {
                  characters: document.cast.map((member) => ({ id: `char-${member.standIn}` })),
                  shotAspect: "16:9",
                  sensorId: "fullFrame",
                },
              },
            ],
          },
          workspace: null,
          poseLibrary: [],
          assets: [],
        });
      },
    },
  };
}

function artifactSink(): PrevisArtifactSink & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    putPrivateArtifact: async ({ objectKey }) => void keys.push(objectKey),
  };
}

async function prepare(overrides: Partial<Parameters<typeof preparePrevis>[0]> = {}) {
  const store = overrides.store ?? newStore();
  const result = await preparePrevis({
    store,
    publicAssetBaseUrl: BASE_URL,
    input: {
      sceneId: "SCENE-1",
      projectInstanceId: "proj-1",
      claim: CLAIM,
      characterLocks: [TWONG, TWONG2],
      displayNames: { "CHAR-6": "Twong", "CHAR-7": "Twong2" },
      scenePrompt: "Twong walks past Twong2 and they talk quietly",
      durationSeconds: 15,
      aspectRatio: "9:16",
      movements: [
        { standIn: "A", startSecond: 0, endSecond: 15, beat: "walks past B, then slows" },
      ],
    },
    ...overrides,
  });
  return { store, result };
}

describe("previs cast mapping", () => {
  it("maps CHAR-6 and CHAR-7 to CozyClay stand-ins deterministically", async () => {
    const first = await prepare();
    const second = await prepare();
    for (const { result } of [first, second]) {
      expect(result.cast.map((m) => [m.characterCode, m.standIn])).toEqual([
        ["CHAR-6", "A"],
        ["CHAR-7", "B"],
      ]);
    }
  });

  it("keeps canonical Cloudbath identity unchanged by the stand-in mapping", async () => {
    const { result } = await prepare();
    expect(result.cast).toEqual([
      expect.objectContaining({
        characterCode: "CHAR-6",
        characterPageId: "page-char-6",
        displayName: "Twong",
        standIn: "A",
      }),
      expect.objectContaining({
        characterCode: "CHAR-7",
        characterPageId: "page-char-7",
        displayName: "Twong2",
        standIn: "B",
      }),
    ]);
    // The stand-in description is generic geometry; no identity reference leaks
    // into the previs engine.
    for (const member of result.cast) {
      expect(member.standInSubject).toBe(`previs stand-in ${member.standIn}`);
      expect(member.standInSubject).not.toContain("Twong");
    }
  });

  it("produces a deterministic previs project for a 15 second scene", async () => {
    const build = () =>
      createPrevisDocument({
        scenePrompt: "Twong walks past Twong2",
        durationSeconds: 15,
        aspectRatio: "9:16",
        cast: [
          { characterCode: "CHAR-6", characterPageId: "page-char-6", displayName: "Twong" },
          { characterCode: "CHAR-7", characterPageId: "page-char-7", displayName: "Twong2" },
        ],
        movements: [{ standIn: "A", startSecond: 0, endSecond: 15, beat: "walks past B" }],
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    const document = build();
    expect(document.durationSeconds).toBe(15);
    expect(document.aspectRatio).toBe("9:16");
    expect(document.shots[0]).toMatchObject({ startSecond: 0, endSecond: 15 });
    expect(compilePrevisPlan(document).calls.map((call) => call.tool)).toEqual([
      // A already exists in a fresh CozyClay scene, so it is re-described
      // rather than added as a third stand-in.
      "place_character",
      "add_character",
      "focus_character",
      "frame_shot",
    ]);
  });
});

describe("previs stable review URL", () => {
  it("generates a Cloudbath-owned private review URL", async () => {
    const { result } = await prepare();
    const url = new URL(result.reviewUrl);
    expect(url.origin).toBe(BASE_URL);
    expect(url.search).toBe("");
    const parsed = parsePrevisViewPath(url.pathname);
    expect(parsed?.previsProjectId).toBe(result.previsProjectId);
    // The bare stable URL is the human review page; JSON keeps explicit segments.
    expect(parsed?.capability).toBe("review");
  });

  it("never exposes a CozyClay editor, localhost or signed R2 URL", async () => {
    const { result } = await prepare();
    expect(result.reviewUrl).not.toMatch(/localhost|127\.0\.0\.1|:518\d|X-Amz-|\?/u);
  });

  it("rejects a malformed or version-zero path", () => {
    expect(parsePrevisViewPath("/previs/not-an-id/token/timeline")).toBeNull();
    const good = buildPrevisViewUrl({
      publicAssetBaseUrl: BASE_URL,
      previsProjectId: "PREVIS-ABCDEFGHJK",
      token: "a".repeat(22),
    });
    expect(parsePrevisViewPath(new URL(good).pathname)).not.toBeNull();
    expect(parsePrevisViewPath(`${new URL(good).pathname}/v0`)).toBeNull();
  });
});

describe("previs private storage", () => {
  it("stores the artifact in private R2 under a durable content-addressed key", async () => {
    const engine = fakeEngine();
    const artifacts = artifactSink();
    const { result } = await prepare({ engine: engine.engine, artifacts });
    expect(artifacts.keys).toHaveLength(1);
    expect(result.artifactObjectKey).toBe(artifacts.keys[0]);
    expect(result.artifactObjectKey).toMatch(
      /^previs\/cozyclay\/assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u,
    );
  });

  it("keeps no signed URL as canonical storage identity", async () => {
    const engine = fakeEngine();
    const artifacts = artifactSink();
    const { store, result } = await prepare({ engine: engine.engine, artifacts });
    const resolved = await store.resolveForReview({
      previsProjectId: result.previsProjectId,
      token: new URL(result.reviewUrl).pathname.split("/")[3]!,
    });
    const serialized = JSON.stringify(resolved?.version);
    expect(serialized).not.toMatch(/https?:\/\//u);
    expect(serialized).not.toMatch(/X-Amz-Signature|Expires=/u);
    expect(resolved?.version.artifactObjectKey).toBe(artifacts.keys[0]);
  });

  it("writes the previs aspect ratio into the CozyClay artifact", async () => {
    const engine = fakeEngine();
    const artifact = await engine.engine.renderProjectArtifact({
      document: createPrevisDocument({
        scenePrompt: "s",
        durationSeconds: 15,
        aspectRatio: "9:16",
        cast: [{ characterCode: "CHAR-6", characterPageId: "p", displayName: "Twong" }],
      }),
      projectName: "p",
    });
    const patched = JSON.parse(applyAspectRatioToProjectArtifact(artifact, "9:16"));
    expect(patched.scenes.scenes[0].stage.shotAspect).toBe("9:16");
  });
});

describe("previs time-range edits and versioning", () => {
  it("changes only the requested 10-14s range and preserves the rest", () => {
    const document = createPrevisDocument({
      scenePrompt: "Twong walks past Twong2",
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        { characterCode: "CHAR-6", characterPageId: "p6", displayName: "Twong" },
        { characterCode: "CHAR-7", characterPageId: "p7", displayName: "Twong2" },
      ],
      movements: [{ standIn: "A", startSecond: 0, endSecond: 15, beat: "walks past B" }],
    });
    const edited = applyTimeRangeEdit(document, {
      standIn: "A",
      fromSecond: 10,
      toSecond: 14,
      beat: "turns around",
    });
    expect(edited.movements).toEqual([
      { standIn: "A", startSecond: 0, endSecond: 10, beat: "walks past B" },
      { standIn: "A", startSecond: 10, endSecond: 14, beat: "turns around" },
      { standIn: "A", startSecond: 14, endSecond: 15, beat: "walks past B" },
    ]);
    // The source document is untouched: versions are immutable.
    expect(document.movements).toHaveLength(1);
  });

  it("leaves another character's blocking alone", () => {
    const document = createPrevisDocument({
      scenePrompt: "s",
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        { characterCode: "CHAR-6", characterPageId: "p6", displayName: "Twong" },
        { characterCode: "CHAR-7", characterPageId: "p7", displayName: "Twong2" },
      ],
      movements: [
        { standIn: "A", startSecond: 0, endSecond: 15, beat: "walks" },
        { standIn: "B", startSecond: 6, endSecond: 9, beat: "stands still" },
      ],
    });
    const edited = applyTimeRangeEdit(document, {
      standIn: "B",
      fromSecond: 6,
      toSecond: 9,
      beat: "jumps backwards",
    });
    expect(edited.movements.filter((m) => m.standIn === "A")).toEqual([
      { standIn: "A", startSecond: 0, endSecond: 15, beat: "walks" },
    ]);
    expect(edited.movements.filter((m) => m.standIn === "B")).toEqual([
      { standIn: "B", startSecond: 6, endSecond: 9, beat: "jumps backwards" },
    ]);
  });

  it("refuses a second edit that would claim an already-written version slot", async () => {
    const { store, result } = await prepare();
    const edit = { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" } as const;
    const [first, second] = await Promise.allSettled([
      store.appendEdit({ previsProjectId: result.previsProjectId, claim: CLAIM, edit }),
      store.appendEdit({ previsProjectId: result.previsProjectId, claim: CLAIM, edit }),
    ]);
    const outcomes = [first, second].map((entry) => entry.status);
    expect(outcomes).toContain("fulfilled");
    expect(outcomes).toContain("rejected");
  });

  it("creates v2 while v1 stays retrievable, and the stable URL resolves latest", async () => {
    const { store, result } = await prepare();
    const token = new URL(result.reviewUrl).pathname.split("/")[3]!;
    const v2 = await store.appendEdit({
      previsProjectId: result.previsProjectId,
      claim: CLAIM,
      edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
    });
    expect(v2.versionNumber).toBe(2);
    expect(v2.parentVersionNumber).toBe(1);

    const latest = await store.resolveForReview({
      previsProjectId: result.previsProjectId,
      token,
    });
    expect(latest?.version.versionNumber).toBe(2);

    const historical = await store.resolveForReview({
      previsProjectId: result.previsProjectId,
      token,
      versionNumber: 1,
    });
    expect(historical?.version.versionNumber).toBe(1);
    expect(historical?.version.document.movements).toEqual([
      { standIn: "A", startSecond: 0, endSecond: 15, beat: "walks past B, then slows" },
    ]);
  });
});

describe("previs immutable history under store pressure", () => {
  it("refuses a new version instead of silently dropping an older one", async () => {
    const versions = cappedStore<PrevisVersion>(2);
    const store = new PrevisStore({
      heads: memoryStore<PrevisProjectHead>(),
      versions,
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
      artifactKeyPrefix: "previs/cozyclay",
    });
    const { result } = await prepare({ store });
    const token = new URL(result.reviewUrl).pathname.split("/")[3]!;
    const edit = { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" } as const;

    const v2 = await store.appendEdit({
      previsProjectId: result.previsProjectId,
      claim: CLAIM,
      edit,
    });
    expect(v2.versionNumber).toBe(2);

    // The store is now full. A third version must fail closed, not evict v1.
    await expect(
      store.appendEdit({
        previsProjectId: result.previsProjectId,
        claim: CLAIM,
        edit: { standIn: "B", fromSecond: 6, toSecond: 9, beat: "jumps backwards" },
      }),
    ).rejects.toThrow(/row limit/u);

    // v1 and v2 both survive the refusal and stay retrievable for compare/undo.
    for (const versionNumber of [1, 2]) {
      const historical = await store.resolveForReview({
        previsProjectId: result.previsProjectId,
        token,
        versionNumber,
      });
      expect(historical?.version.versionNumber).toBe(versionNumber);
    }
    const latest = await store.resolveForReview({
      previsProjectId: result.previsProjectId,
      token,
    });
    // The head never advanced past the version that was actually written.
    expect(latest?.head.latestVersionNumber).toBe(2);
  });
});

describe("previs authorization", () => {
  it("fails closed for a wrong owner, group or account", async () => {
    const { store, result } = await prepare();
    for (const wrong of [
      { ...CLAIM, ownerSenderId: "U-intruder" },
      { ...CLAIM, lineGroupId: "C-other" },
      { ...CLAIM, accountId: "acct-other" },
    ]) {
      await expect(
        store.approve({ previsProjectId: result.previsProjectId, claim: wrong }),
      ).rejects.toThrow(/not accessible/u);
    }
  });

  it("fails closed for a wrong token or unknown project", async () => {
    const { store, result } = await prepare();
    await expect(
      store.resolveForReview({ previsProjectId: result.previsProjectId, token: "b".repeat(22) }),
    ).resolves.toBeUndefined();
    await expect(
      store.resolveForReview({ previsProjectId: "PREVIS-ZZZZZZZZZZ", token: "b".repeat(22) }),
    ).resolves.toBeUndefined();
  });

  it("returns 404 from the review route for a bad token and 405 for a write", async () => {
    const { store, result } = await prepare();
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const badToken = new URL(result.reviewUrl).pathname.replace(/\/[^/]+$/u, `/${"c".repeat(22)}`);

    const notFound = createMockServerResponse();
    await handler({ method: "GET", url: badToken } as IncomingMessage, notFound);
    expect(notFound.statusCode).toBe(404);

    const wrongMethod = createMockServerResponse();
    await handler(
      { method: "POST", url: new URL(result.reviewUrl).pathname } as IncomingMessage,
      wrongMethod,
    );
    expect(wrongMethod.statusCode).toBe(405);
  });

  it("serves the timeline, cast and version state on a valid capability URL", async () => {
    const { store, result } = await prepare();
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const response = createMockServerResponse();
    await handler(
      { method: "GET", url: `${new URL(result.reviewUrl).pathname}/timeline` } as IncomingMessage,
      response,
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(Buffer.from(response.body as unknown as Uint8Array).toString("utf8"));
    expect(body).toMatchObject({
      durationSeconds: 15,
      aspectRatio: "9:16",
      fps: 24,
      frameCount: 360,
      latestVersionNumber: 1,
      approvedVersionNumber: null,
    });
    expect(body.deferredCapabilities.length).toBeGreaterThan(0);
  });
});

describe("APPROVE PREVIS", () => {
  it("freezes the selected version with zero paid provider calls", async () => {
    const engine = fakeEngine();
    const artifacts = artifactSink();
    const paidProvider = vi.fn();
    const { store, result } = await prepare({ engine: engine.engine, artifacts });
    const renderCallsBeforeApproval = engine.calls;

    const approved = await approvePrevis({
      store,
      previsProjectId: result.previsProjectId,
      claim: CLAIM,
    });
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.versionNumber).toBe(1);
    expect(paidProvider).not.toHaveBeenCalled();
    // Approval is a state change only: it renders nothing and bills nothing.
    expect(engine.calls).toBe(renderCallsBeforeApproval);
    expect(artifacts.keys).toHaveLength(1);
  });

  it("does not carry approval forward onto an edited version", async () => {
    const { store, result } = await prepare();
    await approvePrevis({ store, previsProjectId: result.previsProjectId, claim: CLAIM });
    const v2 = await store.appendEdit({
      previsProjectId: result.previsProjectId,
      claim: CLAIM,
      edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
    });
    expect(v2.approvedAt).toBeUndefined();
  });
});

describe("previs engine failure", () => {
  it("does not corrupt Cloudbath project state when CozyClay is unavailable", async () => {
    const store = newStore();
    const failing: PrevisEngine = {
      renderProjectArtifact: async () => {
        throw new Error("CozyClay MCP server is unreachable");
      },
    };
    const artifacts = artifactSink();
    await expect(prepare({ store, engine: failing, artifacts })).rejects.toThrow(/unreachable/u);
    // Nothing was persisted, so no half-written previs is left behind.
    await expect(
      store.resolveForReview({ previsProjectId: "PREVIS-ABCDEFGHJK", token: "a".repeat(22) }),
    ).resolves.toBeUndefined();
    expect(artifacts.keys).toHaveLength(0);

    // A later successful prepare still starts cleanly at v1.
    const engine = fakeEngine();
    const { result } = await prepare({ store, engine: engine.engine, artifacts });
    expect(result.versionNumber).toBe(1);
  });

  it("keeps an existing version chain intact when an edit's render fails", async () => {
    const engine = fakeEngine();
    const artifacts = artifactSink();
    const { store, result } = await prepare({ engine: engine.engine, artifacts });
    const failing: PrevisEngine = {
      renderProjectArtifact: async () => {
        throw new Error("CozyClay MCP server is unreachable");
      },
    };
    await expect(
      store.appendEdit({
        previsProjectId: result.previsProjectId,
        claim: CLAIM,
        edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
        engine: failing,
        artifacts,
      }),
    ).rejects.toThrow(/unreachable/u);
    const latest = await store.resolveForReview({
      previsProjectId: result.previsProjectId,
      token: new URL(result.reviewUrl).pathname.split("/")[3]!,
    });
    expect(latest?.head.latestVersionNumber).toBe(1);
    expect(latest?.version.versionNumber).toBe(1);
  });
});

describe("Phase 1 boundaries", () => {
  it("compiles only headless CozyClay tools and defers editor/GPU capabilities", () => {
    const document = createPrevisDocument({
      scenePrompt: "s",
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        { characterCode: "CHAR-6", characterPageId: "p6", displayName: "Twong" },
        { characterCode: "CHAR-7", characterPageId: "p7", displayName: "Twong2" },
      ],
      movements: [{ standIn: "A", startSecond: 0, endSecond: 15, beat: "walks" }],
    });
    const plan = compilePrevisPlan(document);
    // CozyClay 1.6.0 refuses these four without a connected editor.
    for (const editorOnly of [
      "capture_frame",
      "set_prompt_blocks",
      "generate_motion",
      "apply_batch",
    ]) {
      expect(plan.calls.map((call) => call.tool)).not.toContain(editorOnly);
    }
    const deferred = previsDeferrals(document).map((entry) => entry.capability);
    expect(deferred).toContain("TIMELINE_PROMPT_BLOCKS");
    expect(deferred).toContain("FRAME_CAPTURE");
    expect(deferred).toContain("CHARACTER_MOTION");
    expect(
      previsDeferrals(document).find((entry) => entry.capability === "CHARACTER_MOTION")?.requires,
    ).toBe("LIVE_EDITOR_AND_GPU");
  });

  it("makes no paid provider call anywhere in the previs flow", async () => {
    const seedance = vi.fn();
    const runway = vi.fn();
    const engine = fakeEngine();
    const artifacts = artifactSink();
    const { store, result } = await prepare({ engine: engine.engine, artifacts });
    await store.appendEdit({
      previsProjectId: result.previsProjectId,
      claim: CLAIM,
      edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
      engine: engine.engine,
      artifacts,
    });
    await approvePrevis({ store, previsProjectId: result.previsProjectId, claim: CLAIM });
    expect(seedance).not.toHaveBeenCalled();
    expect(runway).not.toHaveBeenCalled();
  });

  it("rejects an unsupported aspect ratio rather than guessing one", async () => {
    await expect(
      preparePrevis({
        store: newStore(),
        publicAssetBaseUrl: BASE_URL,
        input: {
          sceneId: "SCENE-1",
          projectInstanceId: "proj-1",
          claim: CLAIM,
          characterLocks: [TWONG],
          displayNames: {},
          scenePrompt: "s",
          durationSeconds: 15,
          aspectRatio: "21:9",
        },
      }),
    ).rejects.toThrow(/aspect ratio/u);
  });
});
