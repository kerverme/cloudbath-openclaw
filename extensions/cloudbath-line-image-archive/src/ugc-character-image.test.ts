import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnsureR2ObjectParams } from "./r2.js";
import type { InboundImageJob, LineGroupPolicyBinding, SafeLogger } from "./types.js";
import {
  buildCanonicalR2AssetUrl,
  parseUgcCharacterImageCommand,
  type LatestCharacterImage,
  UgcCharacterImageWorkflow,
} from "./ugc-character-image.js";
import { UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR } from "./ugc-character-pending-media.js";

function memoryStore<T>(): PluginStateKeyedStore<T> & { values: Map<string, T> } {
  const values = new Map<string, T>();
  return {
    values,
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    register: async (key, value) => {
      values.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update: async (key, updateValue) => {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    delete: async (key) => values.delete(key),
    entries: async () =>
      Array.from(values, ([key, value]) => ({ key, value, createdAt: Date.now() })),
    clear: async () => values.clear(),
  };
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("cloudbath-character"),
]);
const CAPABILITIES = {
  PRODUCT_LIBRARY: { databaseId: "1".repeat(32), dataSourceId: "2".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "3".repeat(32), dataSourceId: "4".repeat(32) },
  UGC_PROJECTS: { databaseId: "5".repeat(32), dataSourceId: "6".repeat(32) },
  UGC_SHOTS: { databaseId: "7".repeat(32), dataSourceId: "8".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "9".repeat(32), dataSourceId: "a".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "b".repeat(32), dataSourceId: "c".repeat(32) },
} as const;

describe("UGC latest-image character workflow", () => {
  let stateDir: string;
  let mediaPath: string;

  beforeEach(async () => {
    stateDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "ugc-character-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    mediaPath = (
      await saveMediaBuffer(PNG_BYTES, "image/png", "inbound", 10 * 1024 * 1024, "latest.png")
    ).path;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  function harness(imageMaxBytes = 10 * 1024 * 1024) {
    const binding = (groupId: string): LineGroupPolicyBinding => ({
      accountId: "primary",
      groupId,
      policyId: "UGC",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-26T00:00:00.000Z",
    });
    const registry = {
      lookup: vi.fn(async (_accountId: string | undefined, groupId: string) => binding(groupId)),
    };
    const ensureObjectInputs: EnsureR2ObjectParams[] = [];
    const r2 = {
      ensureObject: vi.fn(async (input: EnsureR2ObjectParams) => {
        ensureObjectInputs.push(input);
        return { kind: "uploaded" as const };
      }),
    };
    const notion = {
      saveCharacterAsset: vi.fn(async (input: { nameOrCode: string }) => ({
        name: input.nameOrCode,
        characterId: "CHAR-KERVER",
        status: "Active" as const,
        pageId: "character-page",
      })),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies SafeLogger;
    const latestImages = memoryStore<LatestCharacterImage>();
    const workflow = new UgcCharacterImageWorkflow(
      registry as never,
      latestImages,
      r2,
      notion,
      CAPABILITIES,
      stateDir,
      imageMaxBytes,
      {
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucketName: "cloudbath",
        accessKeyId: "unit-test-access",
        secretAccessKey: "unit-test-secret",
      },
      logger,
      () => Date.UTC(2026, 7, 26),
    );
    return { workflow, r2, notion, ensureObjectInputs, latestImages, logger };
  }

  function job(groupId = "C-ugc", userId = "U-owner"): InboundImageJob {
    return {
      accountId: "primary",
      groupId,
      lineTarget: `line:group:${groupId}`,
      messageId: "message-1",
      userId,
      mediaPath,
      mimeType: "image/png",
      receivedAt: "2026-08-26T00:00:00.000Z",
    };
  }

  it.each([
    ["เก็บรูปนี้เป็นตัวละครชื่อ Kerver", "upsert"],
    ["บันทึกรูปล่าสุดเป็นตัวละครชื่อ Kerver", "upsert"],
    ["ใช้รูปล่าสุดสร้างตัวละครชื่อ Kerver", "upsert"],
    ["เก็บรูปนี้เป็นตัวละครชื่อ Kerver ครับ!", "upsert"],
    ["อัปเดตตัวละคร Kerver ด้วยรูปล่าสุด", "update"],
    ["เปลี่ยนรูปตัวละคร Kerver เป็นรูปล่าสุด", "update"],
  ] as const)("parses %s", (content, mode) => {
    expect(parseUgcCharacterImageCommand(content)).toEqual({ mode, name: "Kerver" });
  });

  it("safely uploads the owner's latest same-group image and returns one canonical URL", async () => {
    const { workflow, r2, notion, ensureObjectInputs } = harness();
    await workflow.rememberImage(job());

    const result = await workflow.handleBeforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );

    expect(r2.ensureObject).toHaveBeenCalledOnce();
    expect(ensureObjectInputs[0]).toMatchObject({
      bucketName: "cloudbath",
      contentType: "image/png",
      contentLength: PNG_BYTES.byteLength,
    });
    expect(ensureObjectInputs[0]?.objectKey).toMatch(
      /^ugc\/characters\/kerver\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/u,
    );
    expect(notion.saveCharacterAsset).toHaveBeenCalledOnce();
    expect(result?.text).toContain("Name: Kerver");
    expect(result?.text).toContain("Character ID: CHAR-KERVER");
    expect(result?.text?.match(/Canonical URL:/gu)).toHaveLength(1);
  });

  it("fails closed for non-owner commands without touching R2 or Notion", async () => {
    const { workflow, r2, notion } = harness();
    await workflow.rememberImage(job());
    const result = await workflow.handleBeforeDispatch(
      {
        content: "บันทึกรูปล่าสุดเป็นตัวละครชื่อ Kerver",
        senderId: "U-other",
        senderIsOwner: false,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );
    expect(result).toEqual({ handled: true });
    expect(r2.ensureObject).not.toHaveBeenCalled();
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
  });

  it("does not register an image uploaded by another owner", async () => {
    const { workflow, latestImages } = harness();
    await workflow.rememberImage(job("C-ugc", "U-other"));
    expect(latestImages.values.size).toBe(0);
  });

  it("does not intercept the same words on another channel", async () => {
    const { workflow, r2, notion } = harness();
    const result = await workflow.handleBeforeDispatch(
      {
        content: "บันทึกรูปล่าสุดเป็นตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "telegram", accountId: "primary", conversationId: "C-ugc" },
    );
    expect(result).toBeUndefined();
    expect(r2.ensureObject).not.toHaveBeenCalled();
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
  });

  it("cannot pick up the latest image from another LINE group", async () => {
    const { workflow, r2 } = harness();
    await workflow.rememberImage(job("C-first"));
    const result = await workflow.handleBeforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-second" },
    );
    expect(result?.text).toContain("ไม่พบรูปล่าสุด");
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("still saves from the durable copy after the transient inbound file disappears", async () => {
    const { workflow, r2 } = harness();
    await workflow.rememberImage(job());
    await fsp.unlink(mediaPath);
    const result = await workflow.handleBeforeDispatch(
      {
        content: "ใช้รูปล่าสุดสร้างตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );
    expect(result?.text).toContain("บันทึกตัวละครเรียบร้อย");
    expect(r2.ensureObject).toHaveBeenCalledOnce();
  });

  it("rehashes the durable copy immediately before upload and rejects tampering", async () => {
    const { workflow, r2, latestImages, logger } = harness();
    await workflow.rememberImage(job());
    const latest = Array.from(latestImages.values.values())[0];
    expect(latest).toBeDefined();
    const durablePath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(latest?.durableMediaKey.split("/") ?? []),
    );
    await fsp.writeFile(durablePath, Buffer.alloc(PNG_BYTES.byteLength, 0x42));
    const result = await workflow.handleBeforeDispatch(
      {
        content: "ใช้รูปล่าสุดสร้างตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );
    expect(result?.text).toContain("บันทึกตัวละครไม่สำเร็จ");
    expect(r2.ensureObject).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("ugc_character_save_failed", {
      mode: "upsert",
      reason: "HASH_MISMATCH",
    });
  });

  it("atomically replaces the latest image and removes only its superseded durable copy", async () => {
    const { workflow, latestImages } = harness();
    await workflow.rememberImage(job());
    const first = Array.from(latestImages.values.values())[0];
    expect(first).toBeDefined();
    const firstPath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(first?.durableMediaKey.split("/") ?? []),
    );
    const newerBytes = Buffer.concat([PNG_BYTES, Buffer.from("-newer")]);
    mediaPath = (
      await saveMediaBuffer(newerBytes, "image/png", "inbound", 10 * 1024 * 1024, "newer.png")
    ).path;
    const newerJob = { ...job(), messageId: "message-2", receivedAt: "2026-08-26T00:01:00.000Z" };
    await workflow.rememberImage(newerJob);
    const current = Array.from(latestImages.values.values())[0];
    expect(current?.sha256).not.toBe(first?.sha256);
    expect(await fsp.stat(firstPath).catch(() => undefined)).toBeUndefined();
    const currentPath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(current?.durableMediaKey.split("/") ?? []),
    );
    expect((await fsp.stat(currentPath)).isFile()).toBe(true);
  });

  it("logs a sanitized managed-media reason without paths or LINE identifiers", async () => {
    const { workflow, latestImages, logger } = harness();
    await fsp.unlink(mediaPath);
    await workflow.rememberImage(job());
    expect(latestImages.values.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("ugc_character_image_rejected", {
      reason: "MANAGED_MEDIA_UNAVAILABLE",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(mediaPath);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("U-owner");
  });

  it("reports a sanitized size-limit reason", async () => {
    const { workflow, latestImages, logger } = harness(PNG_BYTES.byteLength - 1);
    await workflow.rememberImage(job());
    expect(latestImages.values.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("ugc_character_image_rejected", {
      reason: "MEDIA_TOO_LARGE",
    });
  });

  it("honors the configured image limit above the media-store default", async () => {
    const largeImage = Buffer.concat([PNG_BYTES, Buffer.alloc(6 * 1024 * 1024, 0x61)]);
    mediaPath = (
      await saveMediaBuffer(largeImage, "image/png", "inbound", 10 * 1024 * 1024, "large.png")
    ).path;
    const { workflow, latestImages } = harness(10 * 1024 * 1024);
    await workflow.rememberImage(job());
    expect(Array.from(latestImages.values.values())[0]?.contentLength).toBe(largeImage.byteLength);
  });

  it("does not follow a replaced durable scope directory symlink", async () => {
    const { workflow, r2, latestImages } = harness();
    await workflow.rememberImage(job());
    const latest = Array.from(latestImages.values.values())[0];
    expect(latest).toBeDefined();
    const [scopeKey, filename] = latest?.durableMediaKey.split("/") ?? [];
    const rootDir = path.join(stateDir, UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR);
    const scopeDir = path.join(rootDir, scopeKey ?? "");
    const displacedDir = path.join(stateDir, "displaced-durable-media");
    await fsp.rename(scopeDir, displacedDir);
    await fsp.symlink(displacedDir, scopeDir, "dir");
    expect(await fsp.stat(path.join(displacedDir, filename ?? ""))).toBeDefined();

    const result = await workflow.handleBeforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );

    expect(result?.text).toContain("บันทึกตัวละครไม่สำเร็จ");
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("cleans expired unreferenced media without deleting another active scope", async () => {
    const { workflow, latestImages } = harness();
    await workflow.rememberImage(job("C-expired"));
    const expiredEntry = Array.from(latestImages.values.entries())[0];
    expect(expiredEntry).toBeDefined();
    const expiredPath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(expiredEntry?.[1].durableMediaKey.split("/") ?? []),
    );
    await latestImages.delete(expiredEntry?.[0] ?? "");
    await fsp.utimes(expiredPath, new Date(0), new Date(0));

    await workflow.rememberImage(job("C-active"));
    const active = Array.from(latestImages.values.values())[0];
    expect(active).toBeDefined();
    const activePath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(active?.durableMediaKey.split("/") ?? []),
    );

    await workflow.cleanupExpiredPendingImages();

    expect(await fsp.stat(expiredPath).catch(() => undefined)).toBeUndefined();
    expect((await fsp.stat(activePath)).isFile()).toBe(true);
  });
});

describe("canonical private R2 asset URL", () => {
  it("is stable, HTTPS, queryless, and encodes key segments once", () => {
    expect(
      buildCanonicalR2AssetUrl({
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucketName: "cloudbath",
        objectKey: "ugc/characters/แม่ กำปอง/main.png",
      }),
    ).toBe(
      "https://account.r2.cloudflarestorage.com/cloudbath/ugc/characters/%E0%B9%81%E0%B8%A1%E0%B9%88%20%E0%B8%81%E0%B8%B3%E0%B8%9B%E0%B8%AD%E0%B8%87/main.png",
    );
  });
});
