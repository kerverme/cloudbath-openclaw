import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CozyClayMcpEngine } from "./previs-cozyclay-engine.js";
import { cozyClayEngineConfig, resolveCozyClayProvisioning } from "./previs-cozyclay-runtime.js";
import {
  activePrevisKey,
  CloudbathPrevisLineRouter,
  type ActivePrevisContext,
  type PrevisDedupeStore,
  type PrevisProjectResolver,
} from "./previs-line-router.js";
import { createPrevisReviewRouteHandler } from "./previs-route.js";
import { CloudbathPrevisService } from "./previs-service.js";
import { PrevisStore, type PrevisEngine } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

/**
 * End-to-end Phase 2B: a LINE-shaped inbound message drives create -> edit ->
 * approve, and the real browser reviews the result at the stable URL.
 *
 * Two opt-in layers, matching Phase 2A's approach so normal CI needs neither a
 * CozyClay install nor a browser:
 *  - CLOUDBATH_COZYCLAY_ROOT   -> renders through the real pinned CozyClay MCP
 *  - an installed Chromium     -> drives the real review page
 */
const CHROMIUM_CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
];
const executablePath = CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate));
const cozyClayRoot = process.env.CLOUDBATH_COZYCLAY_ROOT;

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

/** Character Library fixture: the frozen cast Phase 2B resolves against. */
function fixtureResolver(): PrevisProjectResolver {
  const locks = [lock("CHAR-6", "page-char-6"), lock("CHAR-7", "page-char-7")];
  const displayNames = { "CHAR-6": "Twong", "CHAR-7": "Twong2" } as const;
  return {
    listCharacterNames: async () => ["Twong", "Twong2"],
    resolveProject: async () => ({
      projectInstanceId: "proj-1",
      sceneId: "SCENE-1",
      characterLocks: locks,
      displayNames,
    }),
    readProjectCast: async () => ({ characterLocks: locks, displayNames }),
  };
}

describe.runIf(executablePath)("LINE previs flow reviewed in a real browser", () => {
  let server: Server;
  let origin = "";
  let artifactKeys: string[] = [];
  let createReply = "";
  let editReply = "";
  let approveReply = "";
  let reviewPath = "";

  beforeAll(async () => {
    artifactKeys = [];
    const store = new PrevisStore({
      heads: mem<PrevisProjectHead>(),
      versions: mem<PrevisVersion>(),
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
      artifactKeyPrefix: "previs/cozyclay",
    });

    // Real CozyClay when provisioned; otherwise a minimal artifact so the
    // browser half still runs. The engine used is reported in the assertions.
    const engine: PrevisEngine = cozyClayRoot
      ? new CozyClayMcpEngine(
          cozyClayEngineConfig(await resolveCozyClayProvisioning({ root: cozyClayRoot })),
        )
      : {
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
      putPrivateArtifact: async ({ objectKey }) => {
        artifactKeys.push(objectKey);
      },
    });
    const active = mem<ActivePrevisContext>();
    const router = new CloudbathPrevisLineRouter({
      service,
      resolver: fixtureResolver(),
      active,
      dedupe: dedupeStore(),
      registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    });
    const send = async (content: string, messageId: string) =>
      (
        await router.handleBeforeDispatch(
          { content, senderId: OWNER, senderIsOwner: true, isGroup: true, messageId },
          {
            channelId: "line",
            accountId: ACCOUNT,
            conversationId: GROUP,
            sessionKey: "s-1",
          },
        )
      )?.text ?? "";

    createReply = await send(CREATE_MESSAGE, "m-create");
    const context = await active.lookup(activePrevisKey(CLAIM));
    reviewPath = new URL(context!.reviewUrl).pathname;

    const handler = createPrevisReviewRouteHandler(() => ({ store }));
    server = createServer((req, res) => {
      void handler(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The browser assertions below read v1 first, then v2, from the SAME path.
    editReply = await send(EDIT_MESSAGE, "m-edit");
    approveReply = await send("APPROVE PREVIS", "m-approve");
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("replies with the stable URL and no internal identifiers", () => {
    expect(createReply).toContain("สร้าง Previs v1");
    expect(createReply).toContain("Twong + Twong2");
    expect(createReply).toContain("15 วิ");
    expect(createReply).toContain("9:16");
    expect(editReply).toContain("อัปเดต Previs เป็น v2");
    expect(approveReply).toContain("อนุมัติ Previs v2");
    expect(approveReply).toContain("ยังไม่มีการสร้าง Final Video");

    // The stable URL never changes across create -> edit -> approve.
    const urls = [createReply, editReply, approveReply].map(
      (reply) => reply.match(/https:\/\/\S+/u)![0],
    );
    expect(new Set(urls).size).toBe(1);
    for (const reply of [createReply, editReply, approveReply]) {
      expect(reply).not.toContain(artifactKeys[0]!);
      expect(reply).not.toMatch(/X-Amz-|r2\.cloudflarestorage|127\.0\.0\.1|proj-1|page-char/u);
    }
  });

  it("produces a durable private artifact per version", () => {
    expect(artifactKeys.length).toBeGreaterThanOrEqual(2);
    for (const key of artifactKeys) {
      expect(key).toMatch(/^previs\/cozyclay\/assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u);
    }
  });

  it("shows v2 at the stable URL and keeps v1 reviewable, in a real browser", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage();
      const foreign: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith(origin)) {
          foreign.push(request.url());
        }
      });

      // Latest: the stable path now resolves v2 after the LINE edit.
      const latest = await page.goto(`${origin}${reviewPath}`, { waitUntil: "load" });
      expect(latest?.status()).toBe(200);
      expect(await page.textContent("h1")).toContain("SCENE-1");
      const latestTags = await page.textContent(".meta");
      expect(latestTags).toContain("v2");
      expect(latestTags).toContain("Approved");

      // Seek to 12s: inside the 10-14 range the LINE edit created.
      await page.evaluate(() => {
        (
          window as never as { cloudbathPrevisPlayer: { seek(v: number): void } }
        ).cloudbathPrevisPlayer.seek(12);
      });
      expect(await page.getAttribute("#clock", "data-second")).toBe("12");
      expect(await page.textContent("#beat")).toContain("Twong");

      // Historical: v1 still renders, and its timeline has no edit beat.
      const historical = await page.goto(`${origin}${reviewPath}/v1`, { waitUntil: "load" });
      expect(historical?.status()).toBe(200);
      const v1Tags = await page.textContent(".meta");
      expect(v1Tags).toContain("v1");
      expect(v1Tags).toContain("historical");
      await page.evaluate(() => {
        (
          window as never as { cloudbathPrevisPlayer: { seek(v: number): void } }
        ).cloudbathPrevisPlayer.seek(12);
      });
      expect(await page.textContent("#beat")).toBe("—");

      expect(foreign).toEqual([]);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }, 180_000);

  it.runIf(cozyClayRoot)("rendered through the real pinned CozyClay engine", () => {
    // Reached only when CLOUDBATH_COZYCLAY_ROOT is set, so a green run here is
    // genuine proof the LINE flow drove real CozyClay renders.
    expect(cozyClayRoot).toBeTruthy();
    expect(artifactKeys.length).toBeGreaterThanOrEqual(2);
  });
});
