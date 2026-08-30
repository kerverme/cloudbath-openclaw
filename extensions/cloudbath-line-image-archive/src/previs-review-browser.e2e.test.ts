import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previsDeferrals } from "./previs-cozyclay.js";
import { createPrevisDocument } from "./previs-document.js";
import { createPrevisReviewRouteHandler } from "./previs-route.js";
import { PrevisStore } from "./previs-store.js";
import type { PrevisProjectHead, PrevisVersion } from "./previs-types.js";
import type { AsyncKeyedStore } from "./types.js";

/**
 * Real browser proof for the previs review page.
 *
 * Opt-in on an installed Chromium: `playwright-core` is already a repository
 * dependency, and this environment ships the browser at PLAYWRIGHT_BROWSERS_PATH.
 * Skipped when neither is present rather than silently passing.
 */
const CHROMIUM_CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
];
const executablePath = CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate));

function mem<T>(): AsyncKeyedStore<T> {
  const m = new Map<string, T>();
  return {
    register: async (k, v) => void m.set(k, v),
    registerIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    lookup: async (k) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

describe.runIf(executablePath)("previs review page (real browser)", () => {
  let server: Server;
  let origin = "";
  let reviewPath = "";

  beforeAll(async () => {
    const store = new PrevisStore({
      heads: mem<PrevisProjectHead>(),
      versions: mem<PrevisVersion>(),
      now: () => Date.parse("2026-08-30T12:00:00.000Z"),
      artifactKeyPrefix: "previs/cozyclay",
    });
    const document = createPrevisDocument({
      scenePrompt: "Twong walks past Twong2 and they talk quietly",
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        { characterCode: "CHAR-6", characterPageId: "page-char-6", displayName: "Twong" },
        { characterCode: "CHAR-7", characterPageId: "page-char-7", displayName: "Twong2" },
      ],
      movements: [
        { standIn: "A", startSecond: 2, endSecond: 6, beat: "walks past B", to: { x: 3, z: 0 } },
      ],
    });
    const { head } = await store.createProject({
      document,
      sceneId: "SCENE-1",
      projectInstanceId: "proj-1",
      claim: { accountId: "a", lineGroupId: "g", ownerSenderId: "o" },
      deferrals: previsDeferrals(document),
    });
    reviewPath = `/previs/${head.previsProjectId}/${head.reviewToken}`;
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("loads, plays, and scrubs to second 10 without leaking the token", async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage();
      // Any request to an origin other than our own loopback server would mean
      // the capability token could leave the page.
      const foreign: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith(origin)) {
          foreign.push(request.url());
        }
      });

      const response = await page.goto(`${origin}${reviewPath}`, { waitUntil: "load" });
      expect(response?.status()).toBe(200);

      // The viewport really rendered: a canvas with non-zero pixels.
      await page.waitForSelector("#view");
      const painted = await page.evaluate(() => {
        const canvas = document.getElementById("view") as HTMLCanvasElement;
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! + data[i + 1]! + data[i + 2]! > 40) {
            lit += 1;
          }
        }
        return { width: canvas.width, height: canvas.height, lit };
      });
      expect(painted.width).toBeGreaterThan(0);
      expect(painted.lit).toBeGreaterThan(500);

      expect(await page.textContent("#clock")).toContain("00:00 / 00:15");
      await page.click("#play");
      expect(await page.getAttribute("#play", "data-state")).toBe("playing");
      await page.waitForFunction(
        () =>
          (
            window as never as { cloudbathPrevisPlayer: { state(): { second: number } } }
          ).cloudbathPrevisPlayer.state().second > 0.3,
        undefined,
        { timeout: 5000 },
      );

      // Scrub to second 10 and confirm the page reports exactly that second.
      await page.evaluate(() => {
        (
          window as never as { cloudbathPrevisPlayer: { seek(v: number): void } }
        ).cloudbathPrevisPlayer.seek(10);
      });
      expect(await page.getAttribute("#clock", "data-second")).toBe("10");
      expect(await page.textContent("#clock")).toContain("00:10 / 00:15");
      expect(await page.getAttribute("#play", "data-state")).toBe("paused");

      // Cast names render for the reviewer; stand-in letters stay visible too.
      const cast = await page.textContent(".cast");
      expect(cast).toContain("Twong");
      expect(cast).toContain("Twong2");

      expect(foreign).toEqual([]);
      await browser.close();
    } finally {
      await browser.close().catch(() => undefined);
    }
  }, 120_000);
});
