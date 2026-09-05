import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { LineGroupWorkspacePolicyRegistry } from "./group-workspace-policy.js";
import type {
  InboundImageJob,
  LineGroupPolicyBinding,
  NotionTarget,
  SafeLogger,
  UgcCapabilityId,
} from "./types.js";
import {
  UgcCharacterMediaError,
  UgcCharacterPendingMediaStore,
  type CapturedCharacterMedia,
  type UgcCharacterMediaFailureReason,
} from "./ugc-character-pending-media.js";

const LATEST_IMAGE_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * Two images this close together are both plausibly "the one I want".
 *
 * Matches the storyboard flow's own selection window: inside it either could be
 * the one the owner means, so the flow asks rather than choosing.
 */
const SOURCE_IMAGE_AMBIGUITY_WINDOW_MS = 30 * 60 * 1_000;
/**
 * How long a name given to the latest image stays usable for a bare follow-up.
 *
 * Short on purpose: the follow-up is meant to be the next thing the owner
 * says, and an expired name asks rather than writing the wrong Character.
 */
const LATEST_IMAGE_NAME_TTL_MS = 15 * 60 * 1_000;
const LINE_IMAGE_ACKNOWLEDGEMENT = "เห็นรูปแล้ว ต้องการให้ช่วยอะไร?";
const CHARACTER_COMMANDS = [
  /^(?:(?:เก็บ|บันทึก)\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ตัวละคร\s*ชื่อ|ใช้\s*รูปล่าสุด\s*สร้าง\s*ตัวละคร\s*ชื่อ)\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^บันทึก\s*ตัวละคร\s+(.+?)\s+พร้อม\s*(?:รูปนี้|รูปล่าสุด)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^เซฟ\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ตัวละคร(?:\s*ชื่อ)?\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^เก็บ\s*(?:รูปนี้|รูปล่าสุด)\s*ไว้\s*เป็น\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^ตัวนี้\s*ชื่อ\s+(.+?)\s+บันทึก\s*ไว้\s*เป็น\s*ตัวละคร\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^เพิ่ม\s*ตัวละคร\s*ชื่อ\s+(.+?)\s+ใช้\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ภาพอ้างอิง\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^จ(?:ำ|ํา)\s*(?:รูปนี้|รูปล่าสุด)\s*เป็น\s*ตัวละคร\s*ชื่อ\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
] as const;
const CHARACTER_UPDATE_COMMAND =
  /^(?:อัปเดต\s*ตัวละคร\s+(.+?)\s+ด้วย\s*รูปล่าสุด|เปลี่ยน\s*รูป\s*ตัวละคร\s+(.+?)\s+เป็น\s*รูปล่าสุด)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu;
const CHARACTER_VIEW_MIGRATION_COMMAND =
  /^(?:สร้าง\s*ลิงก์\s*ถาวร\s*ให้\s*ตัวละคร|create\s+(?:a\s+)?permanent\s+link\s+for\s+character)\s+(CHAR-[1-9]\d*)\s*(?:ครับ|ค่ะ|คะ|หน่อย|please)?[.!。]?$/iu;

/**
 * Names the owner gives the LATEST image without asking for a Character.
 *
 * "เก็บรูปชื่อ Twong99" is not a Character mutation and stays owned by the
 * archive flow, so this only captures the name for a follow-up such as
 * "เก็บใน Character Library". Each pattern requires the name marker
 * (ชื่อ/ว่า/as) directly after the image noun, which is what keeps
 * "เก็บรูปนี้เป็นตัวละครชื่อ X" out: that one is a full Character command.
 */
const LATEST_IMAGE_NAMING_COMMANDS = [
  /^(?:เก็บ|บันทึก|เซฟ)\s*(?:รูป|ภาพ)\s*(?:นี้|ล่าสุด|เมื่อกี้)?\s*(?:ชื่อ|ว่า)\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^ตั้ง\s*ชื่อ\s*(?:รูป|ภาพ)\s*(?:นี้|ล่าสุด|เมื่อกี้)?\s*(?:ว่า|เป็น|ชื่อ)\s+(.+?)\s*(?:ครับ|ค่ะ|คะ|หน่อย)?[.!。]?$/iu,
  /^(?:save|name)\s+(?:this\s+|the\s+|latest\s+)*(?:image|photo|picture)\s+(?:as|to)?\s*(.+?)\s*(?:please)?[.!。]?$/iu,
] as const;

/**
 * Mutation verbs that may pair with EITHER target class below.
 *
 * Thai and English are matched independently of the target's language: the
 * production bug was "เก็บใน Character Library", a Thai verb against an
 * English target, which the old same-language-only pairing rejected.
 */
const MUTATION_VERB =
  /(?:เก็บ|บันทึก|เซฟ|เพิ่ม|จ(?:ำ|ํา)|สร้าง|ลงทะเบียน|ใส่)|\b(?:save|add|create|register|remember|store|upload|put)\b/iu;
/**
 * Verbs too common to pair with a bare image noun.
 *
 * "เอา" carries a save request in "เอาเข้า Character Library" but is also
 * everyday Thai for "want"/"take", so it only counts against an explicit
 * Character target -- otherwise "เอารูปนี้มาดูหน่อย" would read as a save.
 */
const WEAK_MUTATION_VERB = /(?:เอา|ย้าย)/u;
/** Explicit Character targets, including the English Character Library. */
const CHARACTER_TARGET = /(?:ตัวละคร|คลังตัวละคร)|\bcharacters?\b/iu;
/** Image references that only count for a strong verb. */
const IMAGE_TARGET = /(?:รูปนี้|รูปล่าสุด|รูปเมื่อกี้|ภาพอ้างอิง)/u;
/**
 * Video artefacts owned by the storyboard router, which runs AFTER this one.
 *
 * Without this the widened verb set claims "เอาตัวละคร Twong ทำวิดีโอ" as a
 * Character save and the storyboard flow never sees the turn.
 */
const VIDEO_ARTEFACT = /(?:วิดีโอ|วีดีโอ|วิดิโอ|คลิป|ฉาก)|\b(?:videos?|scenes?|shots?|storyboards?)\b/iu;

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
  /**
   * Name the owner gave THIS image in a recent turn ("เก็บรูปชื่อ Twong99").
   *
   * Kept on the latest-image record rather than in a second store so a new
   * image replaces the name with it; `namedAt` expires the name on its own
   * short TTL while the image keeps the longer one.
   */
  pendingCharacterName?: string;
  pendingCharacterNamedAt?: string;
  /**
   * When the image this one REPLACED arrived, if that one was itself recent.
   *
   * The store keeps one row per owner, so without this a second image would
   * silently become "the" selection and the first would vanish — a most-recent-
   * wins rule by omission. Recorded so the storyboard flow can tell that two
   * candidates existed and ask which, instead of choosing.
   */
  displacedRecentAt?: string;
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
  const normalized = normalizeCommandText(content);
  const create = CHARACTER_COMMANDS.map((pattern) => normalized.match(pattern)).find(Boolean);
  const update = normalized.match(CHARACTER_UPDATE_COMMAND);
  const name = normalizeCharacterName(create?.[1] ?? update?.[1] ?? update?.[2] ?? "");
  if (!name) {
    return null;
  }
  return { mode: create ? "upsert" : "update", name };
}

function normalizeCommandText(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * Loose "put this image into the Character Library" intent, in either language.
 *
 * A strong verb counts against a Character OR an image target; a weak verb
 * needs an explicit Character target. Anything naming a video artefact is
 * declined so the storyboard router downstream still gets its turn.
 */
function hasCharacterMutationIntent(content: string): boolean {
  const normalized = normalizeCommandText(content);
  if (VIDEO_ARTEFACT.test(normalized)) {
    return false;
  }
  const characterTarget = CHARACTER_TARGET.test(normalized);
  if (MUTATION_VERB.test(normalized)) {
    return characterTarget || IMAGE_TARGET.test(normalized);
  }
  return characterTarget && WEAK_MUTATION_VERB.test(normalized);
}

/**
 * Reads a name the owner gave the latest image, without claiming the turn.
 */
export function parseLatestImageNamingCommand(content: string): string | null {
  const normalized = normalizeCommandText(content);
  const matched = LATEST_IMAGE_NAMING_COMMANDS.map((pattern) => normalized.match(pattern)).find(
    Boolean,
  );
  return normalizeCharacterName(matched?.[1] ?? "") ?? null;
}

export function parseUgcCharacterViewMigrationCommand(content: string): string | null {
  const normalized = normalizeCommandText(content);
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
    /** Notified after a successful save so name caches can drop stale lists. */
    private readonly onCharacterSaved?: () => void,
    /**
     * Whether this sender already has storyboard work open in this conversation.
     *
     * The narrowing for an UNBOUND conversation, where nothing proves who the
     * owner is: `message_received` carries no `senderIsOwner` and there is no
     * owner registry outside a UGC binding, so identity cannot be established
     * here without inventing it. Need can, though — this state only exists
     * because a dispatch turn already proved `senderIsOwner`, so capturing only
     * for senders who have it keeps the stored set to images that some
     * storyboard could actually use.
     */
    private readonly hasStoryboardWorkInProgress?: (
      claim: Readonly<{ accountId: string; lineGroupId: string; ownerSenderId: string }>,
    ) => Promise<boolean>,
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

  /**
   * Remembers the image its SENDER just put in this conversation.
   *
   * Two questions, deliberately separated. Capture is keyed by the sender we can
   * attribute from the inbound envelope, because that is what makes "the image I
   * sent" provable later — for a bound group that sender is already required to
   * be the bound owner, so the key is unchanged there. Whether this workflow
   * CLAIMS the turn is still the UGC question: an unbound conversation must fall
   * through to archiving exactly as before, so it captures and returns false.
   */
  async rememberImage(job: InboundImageJob): Promise<boolean> {
    const binding = await this.registry.lookup(job.accountId, job.groupId);
    const senderId = job.userId?.trim();
    const accountId = job.accountId?.trim();
    const ugcOwned = binding?.policyId === "UGC";
    if (!senderId || !accountId) {
      return ugcOwned;
    }
    if (ugcOwned && binding.boundByOwnerId !== senderId) {
      return true;
    }
    // Unbound: capture only for a sender with storyboard work already open.
    // Everyone else's images are stored by the archive path as before and never
    // enter this pending-media directory at all.
    if (
      !ugcOwned &&
      !(await this.hasStoryboardWorkInProgress?.({
        accountId,
        lineGroupId: job.groupId,
        ownerSenderId: senderId,
      }).catch(() => false))
    ) {
      return false;
    }
    const scopeKey = latestImageKey(accountId, job.groupId, senderId);
    let captured: CapturedCharacterMedia;
    try {
      captured = await this.pendingMedia.capture(job.mediaPath, scopeKey);
    } catch (error) {
      this.logger.warn("ugc_character_image_rejected", { reason: this.reasonFor(error) });
      return ugcOwned;
    }
    let previous: LatestCharacterImage | undefined;
    let accepted = false;
    const next: LatestCharacterImage = {
      version: 2,
      accountId,
      lineGroupId: job.groupId,
      ownerSenderId: senderId,
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
          // Two candidates inside the selection window mean the owner has to
          // say which; the flag is what lets the storyboard flow ask instead of
          // quietly taking whichever arrived last.
          const displacedRecently =
            current &&
            Date.parse(next.sourceReceivedAt) - Date.parse(current.sourceReceivedAt) <=
              SOURCE_IMAGE_AMBIGUITY_WINDOW_MS;
          return displacedRecently
            ? { ...next, displacedRecentAt: current.sourceReceivedAt }
            : next;
        },
        { ttlMs: LATEST_IMAGE_TTL_MS },
      );
    } catch (error) {
      const activeKeys = await this.activeDurableMediaKeys().catch(() => new Set<string>());
      if (!activeKeys.has(captured.durableMediaKey)) {
        await this.pendingMedia.delete(captured.durableMediaKey).catch(() => undefined);
      }
      this.logger.warn("ugc_character_image_rejected", { reason: this.reasonFor(error) });
      return ugcOwned;
    }
    if (!accepted) {
      const activeKeys = await this.activeDurableMediaKeys().catch(() => new Set<string>());
      if (!activeKeys.has(captured.durableMediaKey)) {
        await this.pendingMedia.delete(captured.durableMediaKey).catch(() => undefined);
      }
      return ugcOwned;
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
    return ugcOwned;
  }

  /**
   * The verified local path of a first frame this owner already selected.
   *
   * Re-reads through the same integrity check every other consumer uses — size
   * and digest must still match the record — so a path only comes back for
   * bytes that are provably the ones the owner sent. The handle is scoped to
   * the trusted triple, so one owner's selection can never resolve another's.
   */
  async resolveSelectedSourceImage(
    claim: Readonly<{ accountId: string; lineGroupId: string; ownerSenderId: string }>,
    mediaId: string,
  ): Promise<Readonly<{ path: string; mimeType: string }> | undefined> {
    const latest = await this.readLatestInboundImage(claim);
    if (!latest || latest.durableMediaKey !== mediaId) {
      return undefined;
    }
    try {
      const media = await this.pendingMedia.read({
        durableMediaKey: latest.durableMediaKey,
        scopeKey: latestImageKey(claim.accountId, claim.lineGroupId, claim.ownerSenderId),
        expectedSize: latest.contentLength,
        expectedSha256: latest.sha256,
      });
      // The type comes from the bytes the store already sniffed and validated,
      // never from a filename and never assumed: relabelling a PNG as JPEG
      // would hand a provider a file whose declared type is a lie. An extension
      // outside the supported set throws, and this fails closed with it.
      return media.filePath
        ? Object.freeze({
            path: media.filePath,
            mimeType: contentTypeForExtension(media.extension),
          })
        : undefined;
    } catch {
      this.logger.warn("storyboard_source_image_unresolvable", { reason: "MEDIA_UNREADABLE" });
      return undefined;
    }
  }

  /**
   * The image this owner explicitly put in this conversation, for the
   * storyboard's first-frame choice.
   *
   * Read-only, and NOT a "most recent image anywhere" lookup: the key is the
   * trusted triple, so it can only ever return something this same owner sent
   * in this same conversation. Freshness is the caller's to judge — the record
   * carries when it arrived, and the storyboard flow refuses a stale one rather
   * than adopting an image the owner may no longer have in mind.
   */
  async readLatestInboundImage(
    claim: Readonly<{ accountId: string; lineGroupId: string; ownerSenderId: string }>,
  ): Promise<LatestCharacterImage | undefined> {
    const record = await this.latestImages.lookup(
      latestImageKey(claim.accountId, claim.lineGroupId, claim.ownerSenderId),
    );
    // Fail closed on every element of the triple: a row written for one owner
    // must never answer another's selection.
    return record &&
      record.accountId === claim.accountId &&
      record.lineGroupId === claim.lineGroupId &&
      record.ownerSenderId === claim.ownerSenderId
      ? record
      : undefined;
  }

  /** Owner-scoped binding for this turn, or null when the flow must not act. */
  private async resolveOwnerBinding(
    event: BeforeDispatchEvent,
    context: BeforeDispatchContext,
  ): Promise<LineGroupPolicyBinding | null> {
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
      return null;
    }
    return binding;
  }

  /**
   * Records the name the owner just gave the latest image.
   *
   * Written onto the existing latest-image record so the name cannot outlive
   * the image it describes, and so no second store can disagree with it.
   */
  private async rememberLatestImageName(
    event: BeforeDispatchEvent,
    context: BeforeDispatchContext,
    name: string,
  ): Promise<void> {
    const binding = await this.resolveOwnerBinding(event, context);
    if (!binding || !this.latestImages.update) {
      return;
    }
    const scopeKey = latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId);
    const namedAt = new Date(this.now()).toISOString();
    try {
      await this.latestImages.update(
        scopeKey,
        (current) =>
          current
            ? { ...current, pendingCharacterName: name, pendingCharacterNamedAt: namedAt }
            : undefined,
        { ttlMs: LATEST_IMAGE_TTL_MS },
      );
      this.logger.info("ugc_character_image_named");
    } catch {
      // A dropped name only costs the owner one extra word on the follow-up.
      this.logger.warn("ugc_character_image_name_failed", { reason: "STATE_REGISTER_FAILED" });
    }
  }

  /** The remembered name, once it is still inside its short TTL. */
  private contextualCharacterName(latest: LatestCharacterImage): string | undefined {
    const namedAt = Date.parse(latest.pendingCharacterNamedAt ?? "");
    if (!latest.pendingCharacterName || !Number.isFinite(namedAt)) {
      return undefined;
    }
    return this.now() - namedAt <= LATEST_IMAGE_NAME_TTL_MS
      ? latest.pendingCharacterName
      : undefined;
  }

  /**
   * Drops the remembered name once it has produced a Character.
   *
   * Without this an accidental second "เก็บใน Character Library" silently
   * rewrites the same Character; the repeat now asks for an explicit name.
   */
  private async clearLatestImageName(scopeKey: string): Promise<void> {
    if (!this.latestImages.update) {
      return;
    }
    try {
      await this.latestImages.update(
        scopeKey,
        (current) => {
          if (!current?.pendingCharacterName) {
            return undefined;
          }
          const { pendingCharacterName: _name, pendingCharacterNamedAt: _at, ...rest } = current;
          return rest;
        },
        { ttlMs: LATEST_IMAGE_TTL_MS },
      );
    } catch {
      this.logger.warn("ugc_character_image_name_failed", { reason: "STATE_REGISTER_FAILED" });
    }
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
    // Naming the latest image is NOT a Character mutation, so the archive flow
    // keeps that turn: this only records the name for a bare follow-up. It
    // outranks loose intent, because "เก็บรูปนี้ชื่อ X" reads as both and is
    // shipped as a naming turn; an explicit Character command still outranks it.
    const namedImage =
      command || migrationCharacterId ? null : parseLatestImageNamingCommand(event.content);
    const mutationIntent = !command && !namedImage && hasCharacterMutationIntent(event.content);
    if (!command && !migrationCharacterId && !mutationIntent) {
      if (namedImage) {
        await this.rememberLatestImageName(event, context, namedImage);
      }
      return undefined;
    }
    const binding = await this.resolveOwnerBinding(event, context);
    if (!binding) {
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
    const scopeKey = latestImageKey(binding.accountId, binding.groupId, binding.boundByOwnerId);
    const latest = await this.latestImages.lookup(scopeKey);
    if (
      !latest ||
      latest.accountId !== binding.accountId ||
      latest.lineGroupId !== binding.groupId ||
      latest.ownerSenderId !== binding.boundByOwnerId
    ) {
      return { handled: true, text: "ไม่พบรูปล่าสุดจากเจ้าของในกลุ่มนี้ กรุณาส่งรูปก่อน" };
    }
    // A bare "เก็บใน Character Library" carries no name, so fall back to the
    // one the owner gave this same image a moment ago. Asking beats guessing.
    const contextualName = command ? undefined : this.contextualCharacterName(latest);
    const resolved: CharacterCommand | null =
      command ?? (contextualName ? { mode: "upsert", name: contextualName } : null);
    if (!resolved) {
      return {
        handled: true,
        text: "กรุณาระบุชื่อตัวละครและขอให้บันทึกรูปนี้เป็นตัวละครให้ชัดเจน",
      };
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
    try {
      const media = await this.pendingMedia.read({
        durableMediaKey: latest.durableMediaKey,
        scopeKey,
        expectedSize: latest.contentLength,
        expectedSha256: latest.sha256,
      });
      const contentType = contentTypeForExtension(media.extension);
      const objectKey = characterObjectKey(resolved.name, media.sha256, media.extension);
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
        nameOrCode: resolved.name,
        objectKey,
        mode: resolved.mode,
        publicAssetBaseUrl: this.publicAssetBaseUrl,
      });
      this.logger.info("ugc_character_saved", { mode: resolved.mode });
      // Only after the real write: a repeat must not silently rewrite it.
      await this.clearLatestImageName(scopeKey);
      this.onCharacterSaved?.();
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
        mode: resolved.mode,
        reason: error instanceof UgcCharacterMediaError ? error.reason : "SAVE_FAILED",
      });
      return {
        handled: true,
        text:
          resolved.mode === "update"
            ? "อัปเดตตัวละครไม่สำเร็จ กรุณาตรวจสอบชื่อและรูปล่าสุด"
            : "บันทึกตัวละครไม่สำเร็จ กรุณาตรวจสอบรูปล่าสุดและ Character Library",
      };
    }
  }
}
