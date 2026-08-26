import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import { readSafeMediaFile } from "./pipeline.js";
import { detectCanonicalImageExtensionFromBytes } from "./r2.js";
import type { InboundImageJob, NotionTarget, SafeLogger, UgcCapabilityId } from "./types.js";

const LATEST_IMAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const CHARACTER_COMMAND =
  /^(?:(?:เก็บ|บันทึก)\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ตัวละคร\s*ชื่อ|ใช้\s*รูปล่าสุด\s*สร้าง\s*ตัวละคร\s*ชื่อ)\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu;
const CHARACTER_UPDATE_COMMAND =
  /^(?:อัปเดต\s*ตัวละคร\s+(.+?)\s+ด้วย\s*รูปล่าสุด|เปลี่ยน\s*รูป\s*ตัวละคร\s+(.+?)\s+เป็น\s*รูปล่าสุด)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu;

export const CLOUDBATH_UGC_LATEST_CHARACTER_IMAGE_NAMESPACE = "ugc-latest-character-image-v1";
export const CLOUDBATH_UGC_CHARACTER_IMAGE_MAX_ENTRIES = 10_000;

export type LatestCharacterImage = Readonly<{
  version: 1;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  job: InboundImageJob;
  contentLength: number;
  sha256: string;
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
  channelId?: string;
  accountId?: string;
  conversationId?: string;
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
}>;

type CharacterNotionClient = {
  saveCharacterAsset(params: {
    target: NotionTarget;
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
    nameOrCode: string;
    objectKey: string;
    mode: "upsert" | "update";
  }): Promise<SavedCharacterAsset>;
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

export function buildCanonicalR2AssetUrl(params: {
  endpoint: string;
  bucketName: string;
  objectKey: string;
}): string {
  const url = new URL(params.endpoint);
  if (url.protocol !== "https:" || !params.bucketName.trim()) {
    throw new Error("UGC character R2 configuration is unavailable");
  }
  const encodedPath = [
    ...url.pathname.split("/").filter(Boolean),
    params.bucketName,
    ...params.objectKey.split("/"),
  ]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `/${encodedPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class UgcCharacterImageWorkflow {
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
    private readonly now: () => number = Date.now,
  ) {}

  async rememberImage(job: InboundImageJob): Promise<void> {
    const binding = await this.registry.lookup(job.accountId, job.groupId);
    if (
      binding?.policyId !== "UGC" ||
      !job.userId?.trim() ||
      binding.boundByOwnerId !== job.userId.trim()
    ) {
      return;
    }
    try {
      const media = await readSafeMediaFile({
        filePath: job.mediaPath,
        stateDir: this.stateDir,
        maxBytes: this.imageMaxBytes,
      });
      await this.latestImages.register(
        latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId),
        {
          version: 1,
          accountId: binding.accountId,
          lineGroupId: binding.groupId,
          ownerSenderId: binding.boundByOwnerId,
          job,
          contentLength: media.size,
          sha256: media.sha256,
          capturedAt: new Date(this.now()).toISOString(),
        },
        { ttlMs: LATEST_IMAGE_TTL_MS },
      );
      this.logger.info("ugc_character_image_remembered", { messageId: job.messageId });
    } catch {
      this.logger.warn("ugc_character_image_rejected");
    }
  }

  async handleBeforeDispatch(
    event: BeforeDispatchEvent,
    context: BeforeDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const command = parseUgcCharacterImageCommand(event.content);
    if (!command) {
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
    if (
      !this.r2Config.endpoint ||
      !this.r2Config.bucketName ||
      !this.r2Config.accessKeyId ||
      !this.r2Config.secretAccessKey
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
      const media = await readSafeMediaFile({
        filePath: latest.job.mediaPath,
        stateDir: this.stateDir,
        maxBytes: this.imageMaxBytes,
        expectedSize: latest.contentLength,
        expectedSha256: latest.sha256,
      });
      const extension = detectCanonicalImageExtensionFromBytes(media.bytes);
      const contentType = contentTypeForExtension(extension);
      const objectKey = characterObjectKey(command.name, media.sha256, extension);
      await this.r2.ensureObject({
        body: media.bytes,
        bucketName: this.r2Config.bucketName,
        objectKey,
        contentType,
        contentLength: media.size,
        sha256: media.sha256,
      });
      const canonicalUrl = buildCanonicalR2AssetUrl({
        endpoint: this.r2Config.endpoint,
        bucketName: this.r2Config.bucketName,
        objectKey,
      });
      const saved = await this.notion.saveCharacterAsset({
        target: this.capabilities.CHARACTER_LIBRARY,
        capabilities: this.capabilities,
        nameOrCode: command.name,
        objectKey,
        mode: command.mode,
      });
      this.logger.info("ugc_character_saved", { mode: command.mode });
      return {
        handled: true,
        text: [
          "บันทึกตัวละครเรียบร้อย:",
          `Name: ${saved.name}`,
          `Character ID: ${saved.characterId}`,
          `Canonical URL: ${canonicalUrl}`,
          `Status: ${saved.status}`,
        ].join("\n"),
      };
    } catch {
      this.logger.warn("ugc_character_save_failed", { mode: command.mode });
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
