import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
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
    const inbound = path.join(stateDir, "media", "inbound");
    await fsp.mkdir(inbound, { recursive: true });
    mediaPath = path.join(inbound, "latest.png");
    await fsp.writeFile(mediaPath, PNG_BYTES);
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  function harness() {
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
    const workflow = new UgcCharacterImageWorkflow(
      registry as never,
      memoryStore<LatestCharacterImage>(),
      r2,
      notion,
      CAPABILITIES,
      stateDir,
      10 * 1024 * 1024,
      {
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucketName: "cloudbath",
        accessKeyId: "unit-test-access",
        secretAccessKey: "unit-test-secret",
      },
      logger,
      () => Date.UTC(2026, 7, 26),
    );
    return { workflow, r2, notion, ensureObjectInputs };
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

  it("rehashes immediately before upload and rejects replaced same-sized bytes", async () => {
    const { workflow, r2 } = harness();
    await workflow.rememberImage(job());
    await fsp.writeFile(mediaPath, Buffer.alloc(PNG_BYTES.byteLength, 0x42));
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
