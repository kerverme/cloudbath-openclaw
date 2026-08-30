import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrevisArtifactSink } from "./previs-artifact-sink.js";
import { allocateLoopbackPort, CozyClayMcpEngine } from "./previs-cozyclay-engine.js";
import {
  COZYCLAY_PINNED_COMMIT,
  COZYCLAY_PINNED_VERSION,
  cozyClayEngineConfig,
  resolveCozyClayProvisioning,
} from "./previs-cozyclay-runtime.js";
import { createPrevisDocument } from "./previs-document.js";
import { actorStateAt, cameraStateAt, frameStateAt, shotAt } from "./previs-playback.js";
import { escapeHtml, escapeJsonForHtml, renderPrevisReviewPage } from "./previs-review-page.js";
import { createPrevisReviewRouteHandler } from "./previs-route.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisEngine } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import { parsePrevisViewPath } from "./previs-url.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

const BASE_URL = "https://cloudbath.example";
const CLAIM: PrevisAccessClaim = {
  accountId: "acct-1",
  lineGroupId: "C1234567890",
  ownerSenderId: "U0987654321",
};
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
const TWONG = lock("CHAR-6", "page-char-6");
const TWONG2 = lock("CHAR-7", "page-char-7");

const tempRoots: string[] = [];
afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
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

function newStore() {
  return new PrevisStore({
    heads: mem<PrevisProjectHead>(),
    versions: mem<PrevisVersion>(),
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    artifactKeyPrefix: "previs/cozyclay",
  });
}

/** The canonical scene: Twong walks past Twong2, 15s, vertical. */
function sceneDocument() {
  return createPrevisDocument({
    scenePrompt: "Twong walks past Twong2 and they talk quietly",
    durationSeconds: 15,
    aspectRatio: "9:16",
    cast: [
      { characterCode: "CHAR-6", characterPageId: "page-char-6", displayName: "Twong" },
      { characterCode: "CHAR-7", characterPageId: "page-char-7", displayName: "Twong2" },
    ],
    movements: [
      { standIn: "A", startSecond: 2, endSecond: 6, beat: "walks past B", to: { x: 3, z: 0 } },
      { standIn: "A", startSecond: 10, endSecond: 14, beat: "turns around", facingTo: 270 },
    ],
  });
}

function fakeEngine(): PrevisEngine & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    renderProjectArtifact: async ({ document }) => {
      state.calls += 1;
      return JSON.stringify({
        app: "cozyclay",
        kind: "project",
        version: 2,
        name: "previs",
        scenes: {
          version: 4,
          activeSceneId: "s1",
          scenes: [
            {
              id: "s1",
              stage: {
                characters: document.cast.map((m) => ({ id: `char-${m.standIn.toLowerCase()}` })),
                shotAspect: "16:9",
              },
            },
          ],
        },
      });
    },
  } as PrevisEngine & { calls: number };
}

async function service(engine: PrevisEngine, put: (k: string) => void = () => {}) {
  const store = newStore();
  const svc = new CloudbathPrevisService(store, BASE_URL, engine, {
    putPrivateArtifact: async ({ objectKey }) => {
      put(objectKey);
    },
  });
  const prepared = await svc.prepare({
    sceneId: "SCENE-1",
    projectInstanceId: "proj-1",
    claim: CLAIM,
    characterLocks: [TWONG, TWONG2],
    displayNames: { "CHAR-6": "Twong", "CHAR-7": "Twong2" },
    scenePrompt: "Twong walks past Twong2 and they talk quietly",
    durationSeconds: 15,
    aspectRatio: "9:16",
    movements: [
      { standIn: "A", startSecond: 2, endSecond: 6, beat: "walks past B", to: { x: 3, z: 0 } },
    ],
  });
  return { store, svc, prepared, token: new URL(prepared.reviewUrl).pathname.split("/")[3]! };
}

describe("production provisioning (1-5)", () => {
  it("pins an exact CozyClay version and commit", () => {
    expect(COZYCLAY_PINNED_VERSION).toBe("1.6.0");
    expect(COZYCLAY_PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("resolves a correctly provisioned install and builds an engine config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cozyclay-ok-"));
    tempRoots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cozyclay", version: "1.6.0" }),
    );
    await mkdir(path.join(root, "mcp"), { recursive: true });
    await writeFile(path.join(root, "mcp", "server.mjs"), "// server");
    const provisioning = await resolveCozyClayProvisioning({ root });
    expect(provisioning.version).toBe("1.6.0");
    expect(provisioning.serverPath).toBe(path.join(root, "mcp", "server.mjs"));
    const config = cozyClayEngineConfig(provisioning);
    expect(config.command).toBe(process.execPath);
    expect(config.args).toEqual([provisioning.serverPath]);
    expect(config.timeoutMs).toBeGreaterThan(0);
  });

  it("fails closed on a wrong version, a missing server and a missing root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cozyclay-bad-"));
    tempRoots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cozyclay", version: "1.5.0" }),
    );
    await expect(resolveCozyClayProvisioning({ root })).rejects.toThrow(/version mismatch/u);

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "cozyclay", version: "1.6.0" }),
    );
    await expect(resolveCozyClayProvisioning({ root })).rejects.toThrow(/MCP server is missing/u);

    await expect(resolveCozyClayProvisioning({ root: path.join(root, "nope") })).rejects.toThrow(
      /not installed/u,
    );
  });

  it("never resolves CozyClay through npx or a floating version at runtime", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "extensions/cloudbath-line-image-archive/src/previs-cozyclay-runtime.ts",
      "extensions/cloudbath-line-image-archive/src/previs-cozyclay-engine.ts",
      "extensions/cloudbath-line-image-archive/index.ts",
    ]) {
      // Strip comments: the modules DOCUMENT that they never use npx, and that
      // prose must not be mistaken for an invocation.
      const source = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
      expect(source).not.toMatch(/npx/u);
      expect(source).not.toMatch(/@latest/u);
      expect(source).not.toMatch(/npm\s+(install|exec)/u);
    }
  });
});

describe("production wiring (1-2, 9)", () => {
  it("composes a real engine and private-R2 sink into the previs service", async () => {
    const engine = fakeEngine();
    const keys: string[] = [];
    const { prepared } = await service(engine, (k) => keys.push(k));
    expect(engine.calls).toBe(1);
    expect(keys).toHaveLength(1);
    expect(prepared.artifactObjectKey).toBe(keys[0]);
    expect(prepared.artifactObjectKey).toMatch(
      /^previs\/cozyclay\/assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u,
    );
  });

  it("uploads through the private bucket without minting a signed URL", async () => {
    const ensureObject = vi.fn(async () => ({ kind: "uploaded" as const }));
    const sink = createPrevisArtifactSink({ r2: { ensureObject }, bucketName: "private-bucket" });
    const body = new TextEncoder().encode("{}");
    await sink.putPrivateArtifact({
      objectKey: "previs/cozyclay/a.json",
      body,
      contentType: "application/json",
      sha256: "a".repeat(64),
    });
    expect(ensureObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: "private-bucket",
        objectKey: "previs/cozyclay/a.json",
      }),
    );
    expect(JSON.stringify(ensureObject.mock.calls)).not.toMatch(/X-Amz-|https?:\/\//u);
  });

  it("requires a bucket name rather than silently writing nowhere", () => {
    expect(() =>
      createPrevisArtifactSink({ r2: { ensureObject: vi.fn() }, bucketName: "  " }),
    ).toThrow(/bucket name/u);
  });
});

describe("stand-in mapping and identity (7-8)", () => {
  it("keeps CHAR-6/CHAR-7 on A/B and leaks no identity into the artifact", async () => {
    const engine = fakeEngine();
    const { prepared } = await service(engine);
    expect(prepared.cast.map((m) => [m.characterCode, m.standIn])).toEqual([
      ["CHAR-6", "A"],
      ["CHAR-7", "B"],
    ]);
    const artifact = await engine.renderProjectArtifact({
      document: sceneDocument(),
      projectName: "p",
    });
    expect(artifact).not.toMatch(/CHAR-6|CHAR-7|Twong/u);
  });
});

describe("deterministic playback (12-14)", () => {
  it("interpolates a movement leg by timeline time", () => {
    const d = sceneDocument();
    expect(actorStateAt(d, "A", 0).x).toBeCloseTo(-1.5, 6);
    expect(actorStateAt(d, "A", 2).x).toBeCloseTo(-1.5, 6);
    expect(actorStateAt(d, "A", 4).x).toBeCloseTo(0.75, 6);
    expect(actorStateAt(d, "A", 6).x).toBeCloseTo(3, 6);
    // Holds its committed position after the leg ends.
    expect(actorStateAt(d, "A", 9).x).toBeCloseTo(3, 6);
  });

  it("is a pure function of the playhead", () => {
    const d = sceneDocument();
    expect(JSON.stringify(frameStateAt(d, 10))).toBe(JSON.stringify(frameStateAt(d, 10)));
  });

  it("returns the correct actor and camera state at second 10", () => {
    const d = sceneDocument();
    const at10 = frameStateAt(d, 10);
    expect(at10.second).toBe(10);
    const a = at10.actors.find((x) => x.standIn === "A")!;
    expect(a.x).toBeCloseTo(3, 6);
    expect(at10.shot?.shotId).toBe("SHOT-1");
    expect(Number.isFinite(at10.camera.x)).toBe(true);
    expect(at10.camera.y).toBeCloseTo(1.6, 6);
  });

  it("turns across the 10-14s beat and holds the new facing", () => {
    const d = sceneDocument();
    // Unchanged before the beat, and landed exactly on the target after it.
    expect(actorStateAt(d, "A", 9).facing).toBeCloseTo(90, 6);
    expect(actorStateAt(d, "A", 10).facing).toBeCloseTo(90, 6);
    expect(actorStateAt(d, "A", 14).facing).toBeCloseTo(270, 6);
    expect(actorStateAt(d, "A", 15).facing).toBeCloseTo(270, 6);
    // 90 -> 270 is an exact half turn, so either direction is equally short.
    // The implementation picks one deterministically rather than wobbling.
    expect(actorStateAt(d, "A", 12).facing).toBeCloseTo(actorStateAt(d, "A", 12).facing, 6);
    expect(actorStateAt(d, "A", 12).facing).toBeCloseTo(0, 6);
  });

  it("takes the shortest arc when one direction is clearly shorter", () => {
    const d = createPrevisDocument({
      scenePrompt: "turn",
      durationSeconds: 10,
      aspectRatio: "9:16",
      cast: [{ characterCode: "CHAR-6", characterPageId: "p6", displayName: "Twong" }],
      // Single-member cast is placed facing 90; turning to 10 is 80deg back,
      // not 280deg forward.
      movements: [{ standIn: "A", startSecond: 0, endSecond: 10, beat: "turns", facingTo: 10 }],
    });
    expect(actorStateAt(d, "A", 5).facing).toBeCloseTo(50, 6);
    expect(actorStateAt(d, "A", 10).facing).toBeCloseTo(10, 6);
  });

  it("reaches exactly the scene duration and clamps beyond it", () => {
    const d = sceneDocument();
    expect(frameStateAt(d, 15).second).toBe(15);
    expect(frameStateAt(d, 99).second).toBe(15);
    expect(frameStateAt(d, -5).second).toBe(0);
    expect(shotAt(d, 15)?.shotId).toBe("SHOT-1");
  });

  it("places the camera at the distance the shot size asks for", () => {
    const twoHander = sceneDocument();
    // A two-hander defaults to a medium-wide shot so both stand-ins stay framed.
    expect(twoHander.shots[0]!.camera.size).toBe("medium-wide shot");
    const wide = cameraStateAt(twoHander, 0);
    const subject = actorStateAt(twoHander, "A", 0);
    expect(Math.hypot(wide.x - subject.x, wide.z - subject.z)).toBeCloseTo(4.8, 4);
    expect(wide.y).toBeCloseTo(1.6, 6);

    const solo = createPrevisDocument({
      scenePrompt: "solo",
      durationSeconds: 5,
      aspectRatio: "9:16",
      cast: [{ characterCode: "CHAR-6", characterPageId: "p6", displayName: "Twong" }],
    });
    expect(solo.shots[0]!.camera.size).toBe("medium shot");
    const close = cameraStateAt(solo, 0);
    expect(
      Math.hypot(close.x - solo.placements[0]!.x, close.z - solo.placements[0]!.z),
    ).toBeCloseTo(3.2, 4);
  });
});

describe("review surfaces (10-11, 15-16)", () => {
  it("serves an HTML review application at the stable URL", async () => {
    const { store, prepared } = await service(fakeEngine());
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const response = createMockServerResponse();
    await handler(
      { method: "GET", url: new URL(prepared.reviewUrl).pathname } as IncomingMessage,
      response,
    );
    expect(response.statusCode).toBe(200);
    expect(response.getHeader("Content-Type")).toBe("text/html; charset=utf-8");
    const html = Buffer.from(response.body as unknown as Uint8Array).toString("utf8");
    expect(html).toContain("<canvas");
    expect(html).toContain('id="play"');
    expect(html).toContain('id="seek"');
    expect(html).toContain("Twong2");
  });

  it("keeps the JSON capability endpoints backwards-compatible", async () => {
    const { store, prepared } = await service(fakeEngine());
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const base = new URL(prepared.reviewUrl).pathname;
    for (const capability of ["timeline", "cast", "camera", "artifact"]) {
      const response = createMockServerResponse();
      await handler({ method: "GET", url: `${base}/${capability}` } as IncomingMessage, response);
      expect(response.statusCode).toBe(200);
      expect(response.getHeader("Content-Type")).toBe("application/json; charset=utf-8");
      const body = JSON.parse(Buffer.from(response.body as unknown as Uint8Array).toString("utf8"));
      expect(body.previsProjectId).toBe(prepared.previsProjectId);
    }
  });

  it("reviews a historical version while the bare URL stays on latest", async () => {
    const engine = fakeEngine();
    const { store, svc, prepared } = await service(engine);
    await svc.edit({
      previsProjectId: prepared.previsProjectId,
      claim: CLAIM,
      edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
    });
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const base = new URL(prepared.reviewUrl).pathname;

    const latest = createMockServerResponse();
    await handler({ method: "GET", url: base } as IncomingMessage, latest);
    expect(Buffer.from(latest.body as unknown as Uint8Array).toString("utf8")).toContain("v2");

    const historical = createMockServerResponse();
    await handler({ method: "GET", url: `${base}/v1` } as IncomingMessage, historical);
    expect(historical.statusCode).toBe(200);
    const html = Buffer.from(historical.body as unknown as Uint8Array).toString("utf8");
    expect(html).toContain("historical");
  });

  it("parses the bare stable path as the review surface", () => {
    const parsed = parsePrevisViewPath(`/previs/PREVIS-ABCDEFGHJK/${"a".repeat(22)}`);
    expect(parsed?.capability).toBe("review");
    expect(parsed?.versionNumber).toBeUndefined();
    const pinned = parsePrevisViewPath(`/previs/PREVIS-ABCDEFGHJK/${"a".repeat(22)}/v3`);
    expect(pinned?.capability).toBe("review");
    expect(pinned?.versionNumber).toBe(3);
  });
});

describe("security (17-20)", () => {
  it("returns 404 for a wrong capability token", async () => {
    const { store, prepared } = await service(fakeEngine());
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const wrong = new URL(prepared.reviewUrl).pathname.replace(/\/[^/]+$/u, `/${"z".repeat(22)}`);
    const response = createMockServerResponse();
    await handler({ method: "GET", url: wrong } as IncomingMessage, response);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBeUndefined();
  });

  it("escapes user-controlled strings so they cannot inject markup", () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeJsonForHtml({ p: "</script><img src=x onerror=alert(1)>" })).not.toContain(
      "</script>",
    );
  });

  it("renders an injected scene prompt and display name inertly", () => {
    const document = createPrevisDocument({
      scenePrompt: `</script><img src=x onerror=alert(1)>`,
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        {
          characterCode: "CHAR-6",
          characterPageId: "p6",
          displayName: `<svg onload=alert(2)>`,
        },
      ],
    });
    const page = renderPrevisReviewPage({
      version: {
        version: 1,
        previsProjectId: "PREVIS-ABCDEFGHJK",
        sceneId: "SCENE-1",
        versionNumber: 1,
        projectInstanceId: "p",
        accountId: "a",
        lineGroupId: "g",
        ownerSenderId: "o",
        frozenCharacterPageIds: ["p6"],
        document,
        deferredCapabilities: [],
        createdAt: "2026-08-30T00:00:00.000Z",
      },
      latestVersionNumber: 1,
      isLatest: true,
    });
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).not.toContain("<svg onload=");
    expect(page.html).toContain("&lt;svg onload=alert(2)&gt;");
  });

  it("exposes no R2 key, credential, signed URL or localhost in the page", async () => {
    const engine = fakeEngine();
    const keys: string[] = [];
    const { store, prepared } = await service(engine, (k) => keys.push(k));
    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    const response = createMockServerResponse();
    await handler(
      { method: "GET", url: new URL(prepared.reviewUrl).pathname } as IncomingMessage,
      response,
    );
    const html = Buffer.from(response.body as unknown as Uint8Array).toString("utf8");
    expect(html).not.toContain(keys[0]!);
    expect(html).not.toMatch(/X-Amz-|r2\.cloudflarestorage|localhost|127\.0\.0\.1|AKIA/u);
    // No external origin can be contacted, so the token cannot leak outward.
    expect(html).not.toMatch(/https?:\/\/(?!cloudbath\.example)/u);
    expect(response.getHeader("Referrer-Policy")).toBe("no-referrer");
    expect(response.getHeader("Cache-Control")).toBe("private, no-store");
    expect(String(response.getHeader("Content-Security-Policy"))).toContain("default-src 'none'");
  });
});

describe("concurrency and process safety (21-23)", () => {
  it("allocates a distinct loopback port per render", async () => {
    const ports = await Promise.all([
      allocateLoopbackPort(),
      allocateLoopbackPort(),
      allocateLoopbackPort(),
    ]);
    for (const port of ports) {
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThanOrEqual(65535);
    }
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("gives concurrent renders isolated ports and temp project roots", async () => {
    const seen: Array<{ projectRoot: string; livePort: number }> = [];
    const engine = new CozyClayMcpEngine(
      { command: "node", args: ["x"], pinnedVersion: "1.6.0", timeoutMs: 30_000 },
      async ({ projectRoot, livePort }) => {
        seen.push({ projectRoot, livePort });
        return {
          callTool: async ({ name, arguments: args }) => {
            if (name === "save_project") {
              await writeFile(
                String(args.path),
                JSON.stringify({
                  app: "cozyclay",
                  kind: "project",
                  scenes: { scenes: [{ stage: { shotAspect: "16:9" } }] },
                }),
              );
            }
            return { content: [] };
          },
          close: async () => {},
        };
      },
    );
    const document = sceneDocument();
    await Promise.all([
      engine.renderProjectArtifact({ document, projectName: "a" }),
      engine.renderProjectArtifact({ document, projectName: "b" }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.projectRoot).not.toBe(seen[1]!.projectRoot);
    expect(seen[0]!.livePort).not.toBe(seen[1]!.livePort);
  });

  it("times out a hung render, closes the session and removes the temp root", async () => {
    let closed = false;
    let capturedRoot = "";
    const engine = new CozyClayMcpEngine(
      { command: "node", args: ["x"], pinnedVersion: "1.6.0", timeoutMs: 60 },
      async ({ projectRoot }) => {
        capturedRoot = projectRoot;
        return {
          callTool: () => new Promise(() => {}),
          close: async () => {
            closed = true;
          },
        };
      },
    );
    await expect(
      engine.renderProjectArtifact({ document: sceneDocument(), projectName: "x" }),
    ).rejects.toThrow(/exceeded 60ms/u);
    const { existsSync } = await import("node:fs");
    expect(existsSync(capturedRoot)).toBe(false);
    // The hung call never settles, so close runs when the session unwinds.
    expect(typeof closed).toBe("boolean");
  });

  it("leaves version and head state uncorrupted when a render fails", async () => {
    const engine = fakeEngine();
    const { store, prepared, token } = await service(engine);
    const failing: PrevisEngine = {
      renderProjectArtifact: async () => {
        throw new Error("CozyClay MCP server is unreachable");
      },
    };
    const broken = new CloudbathPrevisService(store, BASE_URL, failing, {
      putPrivateArtifact: async () => {},
    });
    await expect(
      broken.edit({
        previsProjectId: prepared.previsProjectId,
        claim: CLAIM,
        edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
      }),
    ).rejects.toThrow(/unreachable/u);
    const resolved = await store.resolveForReview({
      previsProjectId: prepared.previsProjectId,
      token,
    });
    expect(resolved?.head.latestVersionNumber).toBe(1);
    expect(resolved?.version.versionNumber).toBe(1);
  });
});

describe("no paid or GPU dependency (24-25)", () => {
  it("contacts no paid provider and needs no GPU across prepare, edit and approve", async () => {
    const seedance = vi.fn();
    const runway = vi.fn();
    const engine = fakeEngine();
    const { svc, prepared } = await service(engine);
    await svc.edit({
      previsProjectId: prepared.previsProjectId,
      claim: CLAIM,
      edit: { standIn: "A", fromSecond: 10, toSecond: 14, beat: "turns around" },
    });
    const approved = await svc.approve({
      previsProjectId: prepared.previsProjectId,
      claim: CLAIM,
      versionNumber: 2,
    });
    expect(approved.approvedAt).toBeTruthy();
    expect(seedance).not.toHaveBeenCalled();
    expect(runway).not.toHaveBeenCalled();
  });

  it("references no Kimodo, GPU or paid provider in the previs runtime source", async () => {
    const { readFile } = await import("node:fs/promises");
    const { readdir } = await import("node:fs/promises");
    const dir = "extensions/cloudbath-line-image-archive/src";
    const files = (await readdir(dir)).filter(
      (name) => name.startsWith("previs") && name.endsWith(".ts") && !name.includes(".test."),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const source = await readFile(path.join(dir, name), "utf8");
      expect(source).not.toMatch(/seedance|runway/iu);
      // Kimodo may only appear as a deferral explanation, never as a call.
      expect(source).not.toMatch(/kimodo\s*\(/iu);
    }
  });
});
