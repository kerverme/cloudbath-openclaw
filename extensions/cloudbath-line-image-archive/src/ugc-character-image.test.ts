import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnsureR2ObjectParams } from "./r2.js";
import type { InboundImageJob, LineGroupPolicyBinding, SafeLogger } from "./types.js";
import {
  parseUgcCharacterImageCommand,
  parseUgcCharacterViewMigrationCommand,
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
/** JFIF magic plus a body, so the store sniffs a real JPEG rather than a name. */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  Buffer.from("cloudbath-first-frame"),
  Buffer.from([0xff, 0xd9]),
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

  function harness(imageMaxBytes = 10 * 1024 * 1024, now = () => Date.UTC(2026, 7, 26)) {
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
        characterId: "CHAR-5",
        status: "Active" as const,
        pageId: "character-page",
        viewUrl: "https://cloudbath.example/c/CHAR-5/abcdefghijklmnop",
      })),
      ensureCharacterViewUrl: vi.fn(async () => ({
        objectKey: "ugc/characters/twong/v1/main.webp",
        pageId: "twong-page",
        viewUrl: "https://cloudbath.example/c/CHAR-6/ponmlkjihgfedcba",
      })),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies SafeLogger;
    const latestImages = memoryStore<LatestCharacterImage>();
    const onCharacterSaved = vi.fn();
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
      "https://cloudbath.example",
      now,
      undefined,
      onCharacterSaved,
    );
    return { workflow, r2, notion, ensureObjectInputs, latestImages, logger, onCharacterSaved };
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

  it.each([
    "บันทึกตัวละคร Manju พร้อมรูปนี้",
    "เซฟรูปนี้เป็นตัวละคร Manju",
    "เก็บรูปนี้ไว้เป็น Manju",
    "ตัวนี้ชื่อ Manju บันทึกไว้เป็นตัวละคร",
    "เพิ่มตัวละครชื่อ Manju ใช้รูปนี้เป็นภาพอ้างอิง",
    "จำรูปนี้เป็นตัวละครชื่อ Manju",
  ])("parses natural Character-save request %s", (content) => {
    expect(parseUgcCharacterImageCommand(content)).toEqual({ mode: "upsert", name: "Manju" });
  });

  it.each(["สร้างลิงก์ถาวรให้ตัวละคร CHAR-6", "create permanent link for character CHAR-6"])(
    "parses explicit existing-Character migration command %s",
    (content) => {
      expect(parseUgcCharacterViewMigrationCommand(content)).toBe("CHAR-6");
    },
  );

  it("migrates an existing Character by exact generated ID without an image or R2 upload", async () => {
    const { workflow, notion, r2 } = harness();

    const result = await workflow.handleBeforeDispatch(
      {
        content: "สร้างลิงก์ถาวรให้ตัวละคร CHAR-6",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "primary",
        conversationId: "line:group:C-ugc",
      },
    );

    expect(result?.text).toContain("Character ID: CHAR-6");
    expect(result?.text).toContain("View URL: https://cloudbath.example/c/CHAR-6/ponmlkjihgfedcba");
    expect(notion.ensureCharacterViewUrl).toHaveBeenCalledWith({
      target: CAPABILITIES.CHARACTER_LIBRARY,
      capabilities: CAPABILITIES,
      characterId: "CHAR-6",
      publicAssetBaseUrl: "https://cloudbath.example",
    });
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("fails closed when a non-owner requests an existing Character migration", async () => {
    const { workflow, notion, r2 } = harness();

    const result = await workflow.handleBeforeDispatch(
      {
        content: "สร้างลิงก์ถาวรให้ตัวละคร CHAR-6",
        senderId: "U-other",
        senderIsOwner: false,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "primary",
        conversationId: "line:group:C-ugc",
      },
    );

    expect(result).toEqual({ handled: true });
    expect(notion.ensureCharacterViewUrl).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("safely uploads the owner's latest same-group image and returns one stable Cloudbath URL", async () => {
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
    expect(notion.saveCharacterAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: ensureObjectInputs[0]?.objectKey,
        publicAssetBaseUrl: "https://cloudbath.example",
      }),
    );
    expect(result?.text).toContain("Name: Kerver");
    expect(result?.text).toContain("Character ID: CHAR-5");
    expect(result?.text?.match(/View URL:/gu)).toHaveLength(1);
    expect(result?.text).toContain("View URL: https://cloudbath.example/c/CHAR-5/abcdefghijklmnop");
    expect(result?.text).not.toContain("X-Amz-");
    expect(result?.text).not.toContain("cloudflarestorage.com");
    expect(result?.text).not.toContain("Canonical URL:");
    expect(result?.text).not.toContain("unit-test-access");
    expect(result?.text).not.toContain("unit-test-secret");
  });

  it("commits the owner's durable latest image before acknowledging the image turn", async () => {
    const { workflow, latestImages, r2 } = harness();
    const imageTurn = workflow.beginInboundImageTurn(job(), {
      messageId: "message-owner-image",
      runId: "image-run",
      channelId: "line",
      accountId: "primary",
      conversationId: "line:group:C-ugc",
      sessionKey: "agent:main:line:group:C-ugc",
    });
    const acknowledgement = await workflow.handleBeforeDispatch(
      { content: "", senderId: "U-owner", senderIsOwner: true, isGroup: true },
      {
        messageId: "message-owner-image",
        runId: "image-run",
        channelId: "line",
        accountId: "primary",
        conversationId: "line:group:C-ugc",
        sessionKey: "agent:main:line:group:C-ugc",
      },
    );

    await expect(imageTurn).resolves.toBe(true);
    expect(acknowledgement).toEqual({
      handled: true,
      text: "เห็นรูปแล้ว ต้องการให้ช่วยอะไร?",
    });
    expect(latestImages.values.size).toBe(1);

    const save = await workflow.handleBeforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        runId: "save-run",
        channelId: "line",
        accountId: "primary",
        conversationId: "line:group:C-ugc",
        sessionKey: "agent:main:line:group:C-ugc",
      },
    );
    expect(save?.text).toContain("บันทึกตัวละครเรียบร้อย");
    expect(r2.ensureObject).toHaveBeenCalledOnce();
  });

  it("saves a remembered production-shaped image from a natural request", async () => {
    const { workflow, notion, r2, onCharacterSaved } = harness();
    await workflow.rememberImage(job());

    const result = await workflow.handleBeforeDispatch(
      {
        content: "บันทึกตัวละคร Manju พร้อมรูปนี้",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );

    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toContain("Name: Manju");
    expect(result?.text).toContain("Character ID: CHAR-5");
    expect(r2.ensureObject).toHaveBeenCalledOnce();
    expect(notion.saveCharacterAsset).toHaveBeenCalledWith(
      expect.objectContaining({ nameOrCode: "Manju", mode: "upsert" }),
    );
    await expect(notion.saveCharacterAsset.mock.results[0]?.value).resolves.toMatchObject({
      characterId: "CHAR-5",
      pageId: "character-page",
    });
    expect(onCharacterSaved).toHaveBeenCalledOnce();
  });

  it("asks for an image instead of letting a natural mutation reach general chat", async () => {
    const { workflow, notion, r2 } = harness();
    const result = await workflow.handleBeforeDispatch(
      {
        content: "บันทึกตัวละคร Manju พร้อมรูปนี้",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );
    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toContain("กรุณาส่งรูปก่อน");
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("never confirms success when the Character Library write fails", async () => {
    const { workflow, notion, onCharacterSaved } = harness();
    await workflow.rememberImage(job());
    notion.saveCharacterAsset.mockRejectedValueOnce(new Error("Notion unavailable"));
    const result = await workflow.handleBeforeDispatch(
      {
        content: "บันทึกตัวละคร Manju พร้อมรูปนี้",
        senderId: "U-owner",
        senderIsOwner: true,
        isGroup: true,
      },
      { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
    );
    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toContain("บันทึกตัวละครไม่สำเร็จ");
    expect(result?.text).not.toContain("เรียบร้อย");
    expect(onCharacterSaved).not.toHaveBeenCalled();
  });

  it.each(["บันทึกรูปนี้เป็นตัวละคร", "เพิ่มตัวละคร ใช้รูปนี้เป็นภาพอ้างอิง"])(
    "fails closed for an incomplete Character mutation: %s",
    async (content) => {
      const { workflow, notion, r2 } = harness();
      await workflow.rememberImage(job());
      const result = await workflow.handleBeforeDispatch(
        { content, senderId: "U-owner", senderIsOwner: true, isGroup: true },
        { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
      );
      expect(result).toMatchObject({ handled: true });
      expect(result?.text).toContain("ชื่อตัวละคร");
      expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
      expect(r2.ensureObject).not.toHaveBeenCalled();
    },
  );

  it.each(["Manju เป็นตัวละครที่น่ารัก", "ช่วยอธิบายรูปนี้ของ Manju"])(
    "does not treat ordinary discussion as a Character save: %s",
    async (content) => {
      const { workflow, notion, r2 } = harness();
      const result = await workflow.handleBeforeDispatch(
        { content, senderId: "U-owner", senderIsOwner: true, isGroup: true },
        { channelId: "line", accountId: "primary", conversationId: "line:group:C-ugc" },
      );
      expect(result).toBeUndefined();
      expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
      expect(r2.ensureObject).not.toHaveBeenCalled();
    },
  );

  it("acknowledges another participant's image without replacing the owner's latest image", async () => {
    const { workflow, latestImages } = harness();
    await workflow.rememberImage(job());
    const ownerLatest = Array.from(latestImages.values.values())[0];
    const imageTurn = workflow.beginInboundImageTurn(job("C-ugc", "U-other"), {
      messageId: "message-other-image",
      runId: "other-image-run",
      channelId: "line",
      accountId: "primary",
      conversationId: "line:group:C-ugc",
      sessionKey: "agent:main:line:group:C-ugc",
    });
    const acknowledgement = await workflow.handleBeforeDispatch(
      { content: "", senderId: "U-other", senderIsOwner: false, isGroup: true },
      {
        messageId: "message-other-image",
        runId: "other-image-run",
        channelId: "line",
        accountId: "primary",
        conversationId: "line:group:C-ugc",
        sessionKey: "agent:main:line:group:C-ugc",
      },
    );

    await expect(imageTurn).resolves.toBe(true);
    expect(acknowledgement).toEqual({
      handled: true,
      text: "เห็นรูปแล้ว ต้องการให้ช่วยอะไร?",
    });
    expect(Array.from(latestImages.values.values())).toEqual([ownerLatest]);
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

  it("does not let an older event overwrite or delete the active newer image", async () => {
    const { workflow, latestImages } = harness();
    await workflow.rememberImage({ ...job(), receivedAt: "2026-08-26T00:02:00.000Z" });
    const newer = Array.from(latestImages.values.values())[0];
    expect(newer).toBeDefined();
    const newerPath = path.join(
      stateDir,
      UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR,
      ...(newer?.durableMediaKey.split("/") ?? []),
    );
    mediaPath = (
      await saveMediaBuffer(
        Buffer.concat([PNG_BYTES, Buffer.from("-older")]),
        "image/png",
        "inbound",
        10 * 1024 * 1024,
        "older.png",
      )
    ).path;

    await workflow.rememberImage({
      ...job(),
      messageId: "message-older",
      receivedAt: "2026-08-26T00:01:00.000Z",
    });

    expect(Array.from(latestImages.values.values())[0]).toEqual(newer);
    expect((await fsp.stat(newerPath)).isFile()).toBe(true);
  });

  it("removes an unreferenced durable copy when atomic state registration fails", async () => {
    const { workflow, latestImages, logger } = harness();
    latestImages.update = vi.fn(async () => {
      throw new Error("state unavailable");
    });

    await workflow.rememberImage(job());

    const rootDir = path.join(stateDir, UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR);
    expect(latestImages.values.size).toBe(0);
    expect(await fsp.readdir(rootDir)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith("ugc_character_image_rejected", {
      reason: "STATE_REGISTER_FAILED",
    });
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

  it("does not follow a replaced plugin-owned pending-media root", async () => {
    const { workflow, latestImages, logger } = harness();
    await workflow.rememberImage(job());
    const existing = Array.from(latestImages.values.values())[0];
    expect(existing).toBeDefined();
    const rootDir = path.join(stateDir, UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR);
    const displacedDir = path.join(stateDir, "displaced-pending-root");
    const redirectedDir = path.join(stateDir, "redirected-pending-root");
    await fsp.mkdir(redirectedDir, { mode: 0o700 });
    await fsp.rename(rootDir, displacedDir);
    await fsp.symlink(redirectedDir, rootDir, "dir");
    mediaPath = (
      await saveMediaBuffer(
        Buffer.concat([PNG_BYTES, Buffer.from("-replacement")]),
        "image/png",
        "inbound",
        10 * 1024 * 1024,
        "replacement.png",
      )
    ).path;

    await workflow.rememberImage({
      ...job(),
      messageId: "message-2",
      receivedAt: "2026-08-26T00:01:00.000Z",
    });

    expect(Array.from(latestImages.values.values())[0]).toEqual(existing);
    expect(await fsp.readdir(redirectedDir)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith("ugc_character_image_rejected", {
      reason: "DURABLE_COPY_FAILED",
    });
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
  const OWNER_TURN = { senderId: "U-owner", senderIsOwner: true, isGroup: true } as const;
  const UGC_CONTEXT = {
    channelId: "line",
    accountId: "primary",
    conversationId: "line:group:C-ugc",
  } as const;

  it("saves the just-named image when the owner follows up with Character Library", async () => {
    const { workflow, notion, r2, ensureObjectInputs } = harness();
    await workflow.rememberImage(job());

    const naming = await workflow.handleBeforeDispatch(
      { content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN },
      UGC_CONTEXT,
    );
    const followUp = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    // The naming turn still belongs to the archive flow.
    expect(naming).toBeUndefined();
    expect(followUp?.text).toContain("บันทึกตัวละครเรียบร้อย");
    expect(followUp?.text).toContain("Name: Twong99");
    expect(notion.saveCharacterAsset).toHaveBeenCalledOnce();
    expect(notion.saveCharacterAsset).toHaveBeenCalledWith(
      expect.objectContaining({ nameOrCode: "Twong99", mode: "upsert" }),
    );
    expect(r2.ensureObject).toHaveBeenCalledOnce();
    expect(ensureObjectInputs[0]?.objectKey).toMatch(/^ugc\/characters\/twong99\//u);
  });

  it.each([
    "เก็บใน Character Library",
    "เอาเข้า Character Library",
    "เก็บเข้าคลังตัวละคร",
    "เอารูปเมื่อกี้ไปเป็น character",
    "เก็บอันนี้เป็นตัวละคร",
    "ใส่รูปนี้ใน Character Library",
    "ย้ายเข้าคลังตัวละคร",
    "save into Character Library",
    "upload this to the character library",
  ])("resolves the remembered name from mixed Thai/English intent: %s", async (content) => {
    const { workflow, notion } = harness();
    await workflow.rememberImage(job());
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);

    const result = await workflow.handleBeforeDispatch({ content, ...OWNER_TURN }, UGC_CONTEXT);

    expect(result?.text).toContain("Name: Twong99");
    expect(notion.saveCharacterAsset).toHaveBeenCalledWith(
      expect.objectContaining({ nameOrCode: "Twong99" }),
    );
  });

  it.each([
    "เก็บรูปชื่อ Twong99",
    "เก็บรูปนี้ชื่อ Twong99",
    "ตั้งชื่อรูปนี้ว่า Twong99",
    "save this image as Twong99",
  ])("records a name without claiming the turn or writing a Character: %s", async (content) => {
    const { workflow, notion, r2 } = harness();
    await workflow.rememberImage(job());

    const result = await workflow.handleBeforeDispatch({ content, ...OWNER_TURN }, UGC_CONTEXT);

    expect(result).toBeUndefined();
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
    await expect(
      workflow.handleBeforeDispatch(
        { content: "เก็บใน Character Library", ...OWNER_TURN },
        UGC_CONTEXT,
      ),
    ).resolves.toMatchObject({ text: expect.stringContaining("Name: Twong99") });
  });

  it("asks for the Character name instead of reaching general chat when none is remembered", async () => {
    const { workflow, notion, r2 } = harness();
    await workflow.rememberImage(job());

    const result = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toContain("ชื่อตัวละคร");
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("asks again once the remembered name has expired", async () => {
    let clock = Date.UTC(2026, 7, 26);
    const { workflow, notion } = harness(10 * 1024 * 1024, () => clock);
    await workflow.rememberImage(job());
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);
    clock += 16 * 60 * 1_000;

    const result = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    expect(result?.text).toContain("ชื่อตัวละคร");
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
  });

  it.each([
    "วันนี้อากาศดีนะ",
    "Character Library มีกี่ตัวแล้ว",
    "เอารูปนี้มาดูหน่อย",
    "เอาตัวละคร Twong99 ทำวิดีโอ",
  ])("does not turn unrelated conversation into a Character mutation: %s", async (content) => {
    const { workflow, notion, r2 } = harness();
    await workflow.rememberImage(job());
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);

    const result = await workflow.handleBeforeDispatch({ content, ...OWNER_TURN }, UGC_CONTEXT);

    expect(result).toBeUndefined();
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
    expect(r2.ensureObject).not.toHaveBeenCalled();
  });

  it("never reports success for a context-resolved save when Notion fails", async () => {
    const { workflow, notion, onCharacterSaved } = harness();
    await workflow.rememberImage(job());
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);
    notion.saveCharacterAsset.mockRejectedValueOnce(new Error("Notion unavailable"));

    const result = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    expect(result?.text).toContain("บันทึกตัวละครไม่สำเร็จ");
    expect(result?.text).not.toContain("เรียบร้อย");
    expect(result?.text).not.toContain("Twong99");
    expect(onCharacterSaved).not.toHaveBeenCalled();
  });

  it("does not write a second Character when the confirmation is repeated", async () => {
    const { workflow, notion } = harness();
    await workflow.rememberImage(job());
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);
    await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    const repeat = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      UGC_CONTEXT,
    );

    expect(notion.saveCharacterAsset).toHaveBeenCalledOnce();
    expect(repeat?.text).toContain("ชื่อตัวละคร");
  });

  it("does not leak the remembered name to another group or another sender", async () => {
    const { workflow, notion } = harness();
    await workflow.rememberImage(job());
    await workflow.rememberImage(job("C-other"));
    await workflow.handleBeforeDispatch({ content: "เก็บรูปชื่อ Twong99", ...OWNER_TURN }, UGC_CONTEXT);

    const otherGroup = await workflow.handleBeforeDispatch(
      { content: "เก็บใน Character Library", ...OWNER_TURN },
      { ...UGC_CONTEXT, conversationId: "line:group:C-other" },
    );
    const otherSender = await workflow.handleBeforeDispatch(
      {
        content: "เก็บใน Character Library",
        senderId: "U-other",
        senderIsOwner: false,
        isGroup: true,
      },
      UGC_CONTEXT,
    );

    expect(otherGroup?.text).toContain("ชื่อตัวละคร");
    expect(otherGroup?.text).not.toContain("Twong99");
    expect(otherSender).toEqual({ handled: true });
    expect(notion.saveCharacterAsset).not.toHaveBeenCalled();
  });
});

/**
 * The first frame a storyboard freezes is resolved back through this workflow,
 * and its content type comes from the bytes the store already validated.
 *
 * Labelling every image `image/jpeg` was a real defect: a PNG handed to an
 * image provider under a JPEG content type declares a type the file does not
 * have. Nothing here reaches a provider — only the store and the workflow run.
 */
describe("resolving a frozen first frame", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "ugc-source-image-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const CLAIM = { accountId: "primary", lineGroupId: "C-ugc", ownerSenderId: "U-owner" };

  function sourceHarness() {
    const registry = {
      lookup: vi.fn(async (_accountId: string | undefined, groupId: string) => ({
        accountId: "primary",
        groupId,
        policyId: "UGC" as const,
        boundByOwnerId: "U-owner",
        boundAt: "2026-08-26T00:00:00.000Z",
      })),
    };
    const latestImages = memoryStore<LatestCharacterImage>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const workflow = new UgcCharacterImageWorkflow(
      registry as never,
      latestImages as never,
      { ensureObject: vi.fn(async () => ({ kind: "uploaded" as const })) } as never,
      {} as never,
      CAPABILITIES as never,
      stateDir,
      10 * 1024 * 1024,
      {
        endpoint: "https://r2.example",
        bucketName: "bucket",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      logger as never,
      undefined,
      () => Date.UTC(2026, 8, 5),
    );
    return { workflow, latestImages };
  }

  /** Puts one image through the real inbound capture path. */
  async function capture(
    h: ReturnType<typeof sourceHarness>,
    bytes: Buffer,
    contentType: string,
    filename: string,
    receivedAt = "2026-09-05T00:00:00.000Z",
  ): Promise<string> {
    const media = await saveMediaBuffer(bytes, contentType, "inbound", 10 * 1024 * 1024, filename);
    await h.workflow.rememberImage({
      accountId: "primary",
      groupId: "C-ugc",
      lineTarget: "line:group:C-ugc",
      messageId: `m-${receivedAt}`,
      userId: "U-owner",
      mediaPath: media.path,
      mimeType: contentType,
      receivedAt,
    });
    const stored = await h.latestImages.lookup(
      [...(await h.latestImages.entries())][0]?.key ?? "missing",
    );
    return stored!.durableMediaKey;
  }

  it("reports a PNG as image/png", async () => {
    const h = sourceHarness();
    const mediaId = await capture(h, PNG_BYTES, "image/png", "frame.png");

    const resolved = await h.workflow.resolveSelectedSourceImage(CLAIM, mediaId);

    expect(resolved?.mimeType).toBe("image/png");
    expect(resolved?.path).toContain(stateDir);
  });

  it("reports a JPEG as image/jpeg", async () => {
    const h = sourceHarness();
    const mediaId = await capture(h, JPEG_BYTES, "image/jpeg", "frame.jpg");

    const resolved = await h.workflow.resolveSelectedSourceImage(CLAIM, mediaId);

    expect(resolved?.mimeType).toBe("image/jpeg");
  });

  it("refuses a handle that is not this owner's selection", async () => {
    const h = sourceHarness();
    await capture(h, PNG_BYTES, "image/png", "frame.png");

    expect(await h.workflow.resolveSelectedSourceImage(CLAIM, "some-other-handle")).toBeUndefined();
    expect(
      await h.workflow.resolveSelectedSourceImage(
        { ...CLAIM, ownerSenderId: "U-someone-else" },
        "any",
      ),
    ).toBeUndefined();
  });

  it("marks a second recent image as having displaced the first", async () => {
    // Two candidates inside the window. The store keeps one row, so without
    // this flag the newer one would silently become "the" selection.
    const h = sourceHarness();
    await capture(h, PNG_BYTES, "image/png", "frame.png", "2026-09-05T00:00:00.000Z");
    await capture(h, JPEG_BYTES, "image/jpeg", "second.jpg", "2026-09-05T00:05:00.000Z");

    const [{ value }] = await h.latestImages.entries();

    expect(value.displacedRecentAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("does not mark an image that replaced only a long-stale one", async () => {
    const h = sourceHarness();
    await capture(h, PNG_BYTES, "image/png", "frame.png", "2026-09-05T00:00:00.000Z");
    await capture(h, JPEG_BYTES, "image/jpeg", "second.jpg", "2026-09-05T09:00:00.000Z");

    const [{ value }] = await h.latestImages.entries();

    expect(value.displacedRecentAt).toBeUndefined();
  });
});
