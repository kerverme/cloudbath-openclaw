import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import type { InboundImageJob, NotionTarget, SafeLogger, UgcCapabilityId } from "./types.js";
import {
  UgcCharacterMediaError,
  UgcCharacterPendingMediaStore,
  type CapturedCharacterMedia,
  type UgcCharacterMediaFailureReason,
} from "./ugc-character-pending-media.js";

const LATEST_IMAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const LINE_IMAGE_ACKNOWLEDGEMENT = "เห็นรูปแล้ว ต้องการให้ช่วยอะไร?";
const CHARACTER_COMMAND =
  /^(?:(?:เก็บ|บันทึก)\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ตัวละคร\s*ชื่อ|ใช้\s*รูปล่าสุด\s*สร้าง\s*ตัวละคร\s*ชื่อ)\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu;
const CHARACTER_UPDATE_COMMAND =
  /^(?:อัปเดต\s*ตัวละคร\s+(.+?)\s+ด้วย\s*รูปล่าสุด|เปลี่ยน\s*รูป\s*ตัวละคร\s+(.+?)\s+เป็น\s*รูปล่าสุด)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu;
const CHARACTER_VIEW_MIGRATION_COMMAND =
  /^(?:สร้าง\s*ลิงก์\s*ถาวร\s*ให้\s*ตัวละคร|create\s+(?:a\s+)?permanent\s+link\s+for\s+character)\s+(CHAR-[1-9]\d*)\s*(?:ครับ|ค่ะ|คะ|หน่อย|please)?[.!。]?$/iu;

export const CLOUDBATH_UGC_LATEST_CHARACTER_IMAGE_NAMESPACE = "ugc-latest-character-image-v2";
export const CLOUDBATH_UGC_CHARACTER_IMAGE_MAX_ENTRIES = 10_000;

export type LatestCharacterImage = Readonly<{
  version: 2;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  durableMediaKey: string;
  contentLength: number;
  sha256: string;
  sourceReceivedAt: string;
  capturedAt: string;
}>;

type CharacterCommand = Readonly<{
  mode: "upsert" | "update";
  name: string;
}>;

type BeforeDispatchEvent = {
  content: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isGroup?: boolean;
};

type BeforeDispatchContext = {
  messageId?: string;
  runId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
};

type R2CharacterClient = {
  ensureObject(params: {
    body: Uint8Array;
    bucketName: string;
    objectKey: string;
    contentType: string;
    contentLength: number;
    sha256: string;
  }): Promise<{ kind: "uploaded" | "existing"; etag?: string }>;
};

export type SavedCharacterAsset = Readonly<{
  name: string;
  characterId: string;
  status: "Active" | "Archived";
  pageId: string;
  viewUrl: string;
}>;

type CharacterNotionClient = {
  saveCharacterAsset(params: {
    target: NotionTarget;
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    nameOrCode: string;
    objectKey: string;
    mode: "upsert" | "update";
    publicAssetBaseUrl: string;
  }): Promise<SavedCharacterAsset>;
  ensureCharacterViewUrl(params: {
    target: NotionTarget;
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    characterId: string;
    publicAssetBaseUrl: string;
  }): Promise<{ objectKey: string; viewUrl: string; pageId: string }>;
};

function nativeGroupId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const groupId = normalized.match(/^line:group:([A-Za-z0-9_-]+)$/u)?.[1] ?? normalized;
  return /^C[A-Za-z0-9_-]+$/u.test(groupId) ? groupId : undefined;
}

function latestImageKey(accountId: string, groupId: string, ownerId: string): string {
  return crypto
    .createHash("sha256")
    .update(`ugc-character-image\0${accountId}\0${groupId}\0${ownerId}`, "utf8")
    .digest("hex");
}

function normalizeCharacterName(value: string): string | undefined {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  return normalized && normalized.length <= 120 ? normalized : undefined;
}

export function parseUgcCharacterImageCommand(content: string): CharacterCommand | null {
  const normalized = content.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const create = normalized.match(CHARACTER_COMMAND);
  const update = normalized.match(CHARACTER_UPDATE_COMMAND);
  const name = normalizeCharacterName(create?.[1] ?? update?.[1] ?? update?.[2] ?? "");
  if (!name) {
    return null;
  }
  return { mode: create ? "upsert" : "update", name };
}

export function parseUgcCharacterViewMigrationCommand(content: string): string | null {
  const normalized = content.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized.match(CHARACTER_VIEW_MIGRATION_COMMAND)?.[1]?.toUpperCase() ?? null;
}

function slugName(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (slug) {
    return slug;
  }
  return `character-${crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

function contentTypeForExtension(extension: string): string {
  const types: Readonly<Record<string, string>> = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
  };
  const contentType = types[extension];
  if (!contentType) {
    throw new Error("Latest LINE image has an unsupported image format");
  }
  return contentType;
}

function characterObjectKey(name: string, sha256: string, extension: string): string {
  return `ugc/characters/${slugName(name)}/sha256/${sha256.slice(0, 2)}/${sha256}${extension}`;
}

export class UgcCharacterImageWorkflow {
  private readonly pendingMedia: UgcCharacterPendingMediaStore;
  private readonly pendingInboundImageTurns = new Map<string, Promise<boolean>>();

  constructor(
    private readonly registry: LineGroupWorkspacePolicyRegistry,
    private readonly latestImages: PluginStateKeyedStore<LatestCharacterImage>,
    private readonly r2: R2CharacterClient,
    private readonly notion: CharacterNotionClient,
    private readonly capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>,
    private readonly stateDir: string,
    private readonly imageMaxBytes: number,
    private readonly r2Config: Readonly<{
      endpoint: string;
      bucketName: string;
      accessKeyId: string;
      secretAccessKey: string;
    }>,
    private readonly logger: SafeLogger,
    private readonly publicAssetBaseUrl?: string,
    private readonly now: () => number = Date.now,
    pendingMedia?: UgcCharacterPendingMediaStore,
  ) {
    this.pendingMedia =
      pendingMedia ?? new UgcCharacterPendingMediaStore(this.stateDir, this.imageMaxBytes);
  }

  private async activeDurableMediaKeys(): Promise<Set<string>> {
    const entries = await this.latestImages.entries();
    return new Set(entries.map((entry) => entry.value.durableMediaKey));
  }

  private reasonFor(error: unknown): UgcCharacterMediaFailureReason | "STATE_REGISTER_FAILED" {
    return error instanceof UgcCharacterMediaError ? error.reason : "STATE_REGISTER_FAILED";
  }

  private inboundImageTurnKey(context: BeforeDispatchContext): string | undefined {
    const scope = [context.channelId, context.accountId, context.conversationId]
      .map((value) => value?.trim() ?? "")
      .join("\u0000");
    const messageId = context.messageId?.trim();
    if (messageId) {
      return `message:${scope}:${messageId}`;
    }
    const runId = context.runId?.trim();
    if (runId) {
      return `run:${scope}:${runId}`;
    }
    const sessionKey = context.sessionKey?.trim();
    return sessionKey ? `session:${sessionKey}` : undefined;
  }

  beginInboundImageTurn(job: InboundImageJob, context: BeforeDispatchContext): Promise<boolean> {
    const task = this.rememberImage(job);
    const turnKey = this.inboundImageTurnKey(context);
    if (turnKey) {
      // Register before the first await so before_dispatch can join the exact
      // media capture even though message_received itself is fire-and-forget.
      this.pendingInboundImageTurns.set(turnKey, task);
    }
    return task;
  }

  private async consumeInboundImageTurn(
    context: BeforeDispatchContext,
  ): Promise<boolean | undefined> {
    const turnKey = this.inboundImageTurnKey(context);
    const pending = turnKey ? this.pendingInboundImageTurns.get(turnKey) : undefined;
    if (!turnKey || !pending) {
      return undefined;
    }
    this.pendingInboundImageTurns.delete(turnKey);
    return await pending;
  }

  async cleanupExpiredPendingImages(): Promise<void> {
    try {
      const activeKeys = await this.activeDurableMediaKeys();
      await this.pendingMedia.sweepExpired(activeKeys, this.now() - LATEST_IMAGE_TTL_MS);
    } catch {
      this.logger.warn("ugc_character_image_cleanup_failed", {
        reason: "STATE_REGISTER_FAILED",
      });
    }
  }

  async rememberImage(job: InboundImageJob): Promise<boolean> {
    const binding = await this.registry.lookup(job.accountId, job.groupId);
    if (binding?.policyId !== "UGC") {
      return false;
    }
    if (!job.userId?.trim() || binding.boundByOwnerId !== job.userId.trim()) {
      return true;
    }
    const scopeKey = latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId);
    let captured: CapturedCharacterMedia;
    try {
      captured = await this.pendingMedia.capture(job.mediaPath, scopeKey);
    } catch (error) {
      this.logger.warn("ugc_character_image_rejected", { reason: this.reasonFor(error) });
      return true;
    }
    let previous: LatestCharacterImage | undefined;
    let accepted = false;
    const next: LatestCharacterImage = {
      version: 2,
      accountId: binding.accountId,
      lineGroupId: binding.groupId,
      ownerSenderId: binding.boundByOwnerId,
      durableMediaKey: captured.durableMediaKey,
      contentLength: captured.contentLength,
      sha256: captured.sha256,
      sourceReceivedAt: job.receivedAt,
      capturedAt: new Date(this.now()).toISOString(),
    };
    try {
      if (!this.latestImages.update) {
        throw new Error("Atomic plugin state update is unavailable");
      }
      await this.latestImages.update(
        scopeKey,
        (current) => {
          previous = current;
          if (current && Date.parse(current.sourceReceivedAt) > Date.parse(next.sourceReceivedAt)) {
            return undefined;
          }
          accepted = true;
          return next;
        },
        { ttlMs: LATEST_IMAGE_TTL_MS },
      );
    } catch (error) {
      const activeKeys = await this.activeDurableMediaKeys().catch(() => new Set<string>());
      if (!activeKeys.has(captured.durableMediaKey)) {
        await this.pendingMedia.delete(captured.durableMediaKey).catch(() => undefined);
      }
      this.logger.warn("ugc_character_image_rejected", { reason: this.reasonFor(error) });
      return true;
    }
    if (!accepted) {
      const activeKeys = await this.activeDurableMediaKeys().catch(() => new Set<string>());
      if (!activeKeys.has(captured.durableMediaKey)) {
        await this.pendingMedia.delete(captured.durableMediaKey).catch(() => undefined);
      }
      return true;
    }
    this.logger.info("ugc_character_image_remembered");
    try {
      if (previous && previous.durableMediaKey !== captured.durableMediaKey) {
        const activeKeys = await this.activeDurableMediaKeys();
        if (!activeKeys.has(previous.durableMediaKey)) {
          await this.pendingMedia.delete(previous.durableMediaKey);
        }
      }
    } catch {
      this.logger.warn("ugc_character_image_cleanup_failed", {
        reason: "STATE_REGISTER_FAILED",
      });
    }
    return true;
  }

  async handleBeforeDispatch(
    event: BeforeDispatchEvent,
    context: BeforeDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    if ((await this.consumeInboundImageTurn(context)) === true) {
      return { handled: true, text: LINE_IMAGE_ACKNOWLEDGEMENT };
    }
    const command = parseUgcCharacterImageCommand(event.content);
    const migrationCharacterId = parseUgcCharacterViewMigrationCommand(event.content);
    if (!command && !migrationCharacterId) {
      return undefined;
    }
    const groupId = event.isGroup ? nativeGroupId(context.conversationId) : undefined;
    const senderId = event.senderId?.trim();
    const binding = groupId ? await this.registry.lookup(context.accountId, groupId) : null;
    if (
      !groupId ||
      !senderId ||
      event.senderIsOwner !== true ||
      binding?.policyId !== "UGC" ||
      binding.boundByOwnerId !== senderId
    ) {
      return { handled: true };
    }
    if (migrationCharacterId) {
      if (!this.publicAssetBaseUrl) {
        return { handled: true, text: "ยังไม่สามารถสร้างลิงก์ตัวละครได้: ระบบลิงก์ยังไม่พร้อม" };
      }
      try {
        const migrated = await this.notion.ensureCharacterViewUrl({
          target: this.capabilities.CHARACTER_LIBRARY,
          capabilities: this.capabilities,
          characterId: migrationCharacterId,
          publicAssetBaseUrl: this.publicAssetBaseUrl,
        });
        this.logger.info("ugc_character_view_url_ensured");
        return {
          handled: true,
          text: [
            "สร้างลิงก์ถาวรให้ตัวละครเรียบร้อย:",
            `Character ID: ${migrationCharacterId}`,
            `View URL: ${migrated.viewUrl}`,
          ].join("\n"),
        };
      } catch {
        this.logger.warn("ugc_character_view_url_failed", { reason: "MIGRATION_FAILED" });
        return { handled: true, text: "สร้างลิงก์ตัวละครไม่สำเร็จ กรุณาตรวจสอบ Character ID" };
      }
    }
    if (!command) {
      return undefined;
    }
    if (
      !this.r2Config.endpoint ||
      !this.r2Config.bucketName ||
      !this.r2Config.accessKeyId ||
      !this.r2Config.secretAccessKey ||
      !this.publicAssetBaseUrl
    ) {
      return { handled: true, text: "ยังไม่สามารถบันทึกตัวละครได้: ระบบจัดเก็บรูปยังไม่พร้อม" };
    }
    const latest = await this.latestImages.lookup(
      latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId),
    );
    if (
      !latest ||
      latest.accountId !== binding.accountId ||
      latest.lineGroupId !== binding.groupId ||
      latest.ownerSenderId !== binding.boundByOwnerId
    ) {
      return { handled: true, text: "ไม่พบรูปล่าสุดจากเจ้าของในกลุ่มนี้ กรุณาส่งรูปก่อน" };
    }
    try {
      const media = await this.pendingMedia.read({
        durableMediaKey: latest.durableMediaKey,
        scopeKey: latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId),
        expectedSize: latest.contentLength,
        expectedSha256: latest.sha256,
      });
      const contentType = contentTypeForExtension(media.extension);
      const objectKey = characterObjectKey(command.name, media.sha256, media.extension);
      await this.r2.ensureObject({
        body: media.bytes,
        bucketName: this.r2Config.bucketName,
        objectKey,
        contentType,
        contentLength: media.contentLength,
        sha256: media.sha256,
      });
      const saved = await this.notion.saveCharacterAsset({
        target: this.capabilities.CHARACTER_LIBRARY,
        capabilities: this.capabilities,
        nameOrCode: command.name,
        objectKey,
        mode: command.mode,
        publicAssetBaseUrl: this.publicAssetBaseUrl,
      });
      this.logger.info("ugc_character_saved", { mode: command.mode });
      return {
        handled: true,
        text: [
          "บันทึกตัวละครเรียบร้อย:",
          `Name: ${saved.name}`,
          `Character ID: ${saved.characterId}`,
          `View URL: ${saved.viewUrl}`,
          `Status: ${saved.status}`,
        ].join("\n"),
      };
    } catch (error) {
      this.logger.warn("ugc_character_save_failed", {
        mode: command.mode,
        reason: error instanceof UgcCharacterMediaError ? error.reason : "SAVE_FAILED",
      });
      return {
        handled: true,
        text:
          command.mode === "update"
            ? "อัปเดตตัวละครไม่สำเร็จ กรุณาตรวจสอบชื่อและรูปล่าสุด"
            : "บันทึกตัวละครไม่สำเร็จ กรุณาตรวจสอบรูปล่าสุดและ Character Library",
      };
    }
  }
}
