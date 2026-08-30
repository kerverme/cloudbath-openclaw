import { parsePrevisIntent, type PrevisIntent } from "./previs-intent.js";
import type { CloudbathPrevisService } from "./previs-service.js";
import type { PrevisAccessClaim, PrevisVersion } from "./previs-types.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

/**
 * Deterministic LINE routing for previs create / edit / approve.
 *
 * This runs in `before_dispatch` and returns `{ handled: true }`, so a
 * recognised previs request never reaches the model. That is the fix for the
 * structural routing problem: previously a character-led scene request could be
 * understood semantically and then answered with a generic `[[confirm:...]]`
 * yes/no prompt instead of invoking the deterministic workflow. A generic
 * confirm can no longer stand in for a previs action, because the model is not
 * given the turn at all.
 *
 * Nothing here is paid. Creating or approving a previs performs no provider
 * call, produces no video draft, and never consumes a `VIDEO ####` code.
 */

/** Same shape the sibling character workflow reads; kept local to this plugin. */
export type PrevisDispatchEvent = {
  content: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isGroup?: boolean;
  messageId?: string;
};

export type PrevisDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
};

export const CLOUDBATH_PREVIS_ACTIVE_NAMESPACE = "cloudbath-previs-active-v1";
export const CLOUDBATH_PREVIS_DEDUPE_NAMESPACE = "cloudbath-previs-dedupe-v1";
export const CLOUDBATH_PREVIS_ACTIVE_MAX_ENTRIES = 20_000;
/** A retried webhook arrives within seconds; an hour is far past any retry window. */
const DEDUPE_TTL_MS = 60 * 60 * 1_000;

/** The owner's current previs, scoped to the trusted LINE identity triple. */
export type ActivePrevisContext = Readonly<{
  version: 1;
  previsProjectId: string;
  projectInstanceId: string;
  sceneId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  reviewUrl: string;
  updatedAt: string;
}>;

/**
 * Resolves named characters into a frozen project cast.
 *
 * Injected so the router stays testable without Notion, and so previs reuses
 * the existing UGC project/lock model rather than growing a shadow one.
 */
export type PrevisProjectResolver = Readonly<{
  /** Character Library names, for deterministic name matching. */
  listCharacterNames(claim: PrevisAccessClaim): Promise<readonly string[]>;
  /**
   * Freezes (or reuses) the project cast for these names, in the order given.
   * Cast order fixes the stand-in letters for the life of the project.
   */
  resolveProject(params: {
    claim: PrevisAccessClaim;
    characterNames: readonly string[];
    scenePrompt: string;
  }): Promise<{
    projectInstanceId: string;
    sceneId: string;
    characterLocks: readonly UgcCharacterLock[];
    displayNames: Readonly<Record<string, string>>;
  }>;
  /** The frozen cast for an existing project, for edit-time resolution. */
  readProjectCast(params: { claim: PrevisAccessClaim; projectInstanceId: string }): Promise<{
    characterLocks: readonly UgcCharacterLock[];
    displayNames: Readonly<Record<string, string>>;
  }>;
}>;

export type PrevisLineRouterDeps = Readonly<{
  service: CloudbathPrevisService;
  resolver: PrevisProjectResolver;
  active: AsyncKeyedStore<ActivePrevisContext>;
  /** Guards against duplicate webhook delivery of the same inbound message. */
  dedupe: PrevisDedupeStore;
  registry: {
    lookup(
      accountId: string | undefined,
      groupId: string,
    ): Promise<{ policyId: string; boundByOwnerId: string } | null | undefined>;
  };
  now: () => number;
  logger?: { warn: (event: string, fields?: Record<string, unknown>) => void };
}>;

/**
 * Narrow dedupe-store contract. Separate from `AsyncKeyedStore` because these
 * entries expire: a replay window is short-lived, unlike previs history.
 */
export type PrevisDedupeStore = Readonly<{
  lookup(key: string): Promise<{ reply: string } | undefined>;
  register(key: string, value: { reply: string }, opts?: { ttlMs?: number }): Promise<void>;
}>;

export function activePrevisKey(claim: PrevisAccessClaim): string {
  return `previs-active:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}`;
}

/** Native LINE group id, or undefined for anything that is not a group. */
function nativeGroupId(conversationId: string | undefined): string | undefined {
  const value = conversationId?.trim();
  if (!value) {
    return undefined;
  }
  const native = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  return /^[CR][0-9a-f]{32}$|^C[0-9A-Za-z]{5,}$/u.test(native) ? native : undefined;
}

const REPLY = {
  noActive: "ยังไม่มี Previs ที่กำลังทำอยู่ กรุณาสร้างฉากก่อน",
  engineDown: "สร้าง Previs ไม่สำเร็จ กรุณาลองอีกครั้ง",
  emptyAction: "กรุณาระบุสิ่งที่ต้องการให้ตัวละครทำในช่วงเวลานั้น",
} as const;

function unknownCharacterReply(name: string): string {
  return `ไม่พบตัวละคร "${name}" ใน Character Library`;
}

function rangeTooLongReply(from: number, to: number, duration: number): string {
  return `ช่วงเวลา ${from}-${to} วิ เกินความยาวฉาก ${duration} วิ`;
}

function createdReply(params: {
  version: number;
  displayNames: readonly string[];
  durationSeconds: number;
  aspectRatio: string;
  reviewUrl: string;
}): string {
  return [
    `สร้าง Previs v${params.version} แล้ว`,
    `${params.displayNames.join(" + ")} · ${params.durationSeconds} วิ · ${params.aspectRatio}`,
    `ดู 3D: ${params.reviewUrl}`,
  ].join("\n");
}

function editedReply(params: {
  version: number;
  fromSecond: number;
  toSecond: number;
  reviewUrl: string;
}): string {
  return [
    `อัปเดต Previs เป็น v${params.version} แล้ว`,
    `แก้ช่วง ${params.fromSecond}-${params.toSecond} วิ`,
    `ดู 3D: ${params.reviewUrl}`,
  ].join("\n");
}

function approvedReply(params: { version: number; reviewUrl: string }): string {
  return [
    `อนุมัติ Previs v${params.version} แล้ว`,
    "ยังไม่มีการสร้าง Final Video หรือคิดค่าใช้จ่าย",
    `ดู 3D: ${params.reviewUrl}`,
  ].join("\n");
}

export class CloudbathPrevisLineRouter {
  constructor(private readonly deps: PrevisLineRouterDeps) {}

  /**
   * Handles a previs intent, or returns undefined to leave the turn alone.
   *
   * Returning `{ handled: true, text }` ends the turn before the model runs.
   */
  async handleBeforeDispatch(
    event: PrevisDispatchEvent,
    context: PrevisDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const claim = this.trustedClaim(event, context);
    if (!claim) {
      return undefined;
    }
    const binding = await this.deps.registry.lookup(claim.accountId, claim.lineGroupId);
    // Mutations are authorised by the trusted LINE ownership context, never by
    // the browser capability token. A non-owner participant is simply not ours.
    if (binding?.policyId !== "UGC" || binding.boundByOwnerId !== claim.ownerSenderId) {
      return undefined;
    }

    const knownCharacterNames = await this.deps.resolver
      .listCharacterNames(claim)
      .catch(() => [] as readonly string[]);
    const intent = parsePrevisIntent({ content: event.content ?? "", knownCharacterNames });
    if (!intent) {
      return undefined;
    }

    // A retried webhook must not create a second version. Replaying the first
    // reply is both idempotent and what the owner already saw.
    const dedupeKey = this.dedupeKey(event, context, claim);
    if (dedupeKey) {
      const seen = await this.deps.dedupe.lookup(dedupeKey);
      if (seen) {
        return { handled: true, text: seen.reply };
      }
    }

    const text = await this.execute(intent, claim);
    if (dedupeKey) {
      await this.deps.dedupe.register(dedupeKey, { reply: text }, { ttlMs: DEDUPE_TTL_MS });
    }
    return { handled: true, text };
  }

  private trustedClaim(
    event: PrevisDispatchEvent,
    context: PrevisDispatchContext,
  ): PrevisAccessClaim | undefined {
    const lineGroupId = nativeGroupId(context.conversationId);
    const accountId = context.accountId?.trim();
    const ownerSenderId = event.senderId?.trim();
    if (!lineGroupId || !accountId || !ownerSenderId || event.senderIsOwner !== true) {
      return undefined;
    }
    return { accountId, lineGroupId, ownerSenderId };
  }

  /** Stable per-inbound-message key, scoped to the owner so it cannot collide. */
  private dedupeKey(
    event: PrevisDispatchEvent,
    context: PrevisDispatchContext,
    claim: PrevisAccessClaim,
  ): string | undefined {
    const id = event.messageId?.trim() || context.messageId?.trim();
    return id
      ? `previs-dedupe:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}:${id}`
      : undefined;
  }

  private async execute(intent: PrevisIntent, claim: PrevisAccessClaim): Promise<string> {
    if (intent.kind === "create") {
      return await this.create(intent, claim);
    }
    if (intent.kind === "edit") {
      return await this.edit(intent, claim);
    }
    return await this.approve(claim);
  }

  private async create(
    intent: Extract<PrevisIntent, { kind: "create" }>,
    claim: PrevisAccessClaim,
  ): Promise<string> {
    // A named-but-unknown character fails closed: silently dropping it would
    // recast the scene without the owner realising.
    if (intent.unknownNames[0]) {
      return unknownCharacterReply(intent.unknownNames[0]);
    }
    let resolved: Awaited<ReturnType<PrevisProjectResolver["resolveProject"]>>;
    try {
      resolved = await this.deps.resolver.resolveProject({
        claim,
        characterNames: intent.characterNames,
        scenePrompt: intent.scenePrompt,
      });
    } catch (error) {
      return this.failure("previs_project_resolve_failed", error);
    }
    try {
      const prepared = await this.deps.service.prepare({
        sceneId: resolved.sceneId,
        projectInstanceId: resolved.projectInstanceId,
        claim,
        characterLocks: resolved.characterLocks,
        displayNames: resolved.displayNames,
        scenePrompt: intent.scenePrompt,
        durationSeconds: intent.durationSeconds,
        aspectRatio: intent.aspectRatio,
      });
      await this.deps.active.register(activePrevisKey(claim), {
        version: 1,
        previsProjectId: prepared.previsProjectId,
        projectInstanceId: resolved.projectInstanceId,
        sceneId: resolved.sceneId,
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        reviewUrl: prepared.reviewUrl,
        updatedAt: new Date(this.deps.now()).toISOString(),
      });
      return createdReply({
        version: prepared.versionNumber,
        displayNames: prepared.cast.map((member) => member.displayName),
        durationSeconds: prepared.durationSeconds,
        aspectRatio: prepared.aspectRatio,
        reviewUrl: prepared.reviewUrl,
      });
    } catch (error) {
      // A failed render leaves no version and no active context behind.
      return this.failure("previs_create_failed", error);
    }
  }

  private async edit(
    intent: Extract<PrevisIntent, { kind: "edit" }>,
    claim: PrevisAccessClaim,
  ): Promise<string> {
    const active = await this.readActive(claim);
    if (!active) {
      return REPLY.noActive;
    }
    if (intent.unknownNames[0]) {
      return unknownCharacterReply(intent.unknownNames[0]);
    }
    let cast: Awaited<ReturnType<PrevisProjectResolver["readProjectCast"]>>;
    try {
      cast = await this.deps.resolver.readProjectCast({
        claim,
        projectInstanceId: active.projectInstanceId,
      });
    } catch (error) {
      return this.failure("previs_cast_read_failed", error);
    }
    // The stand-in letter comes from the FROZEN lock order, so an edit can never
    // re-map who A and B are.
    const index = intent.characterName
      ? cast.characterLocks.findIndex(
          (lock) => cast.displayNames[lock.code] === intent.characterName,
        )
      : 0;
    if (index < 0) {
      return unknownCharacterReply(intent.characterName!);
    }
    const standIn = String.fromCharCode(65 + index);

    const latest = await this.deps.service.readLatest({
      previsProjectId: active.previsProjectId,
      claim,
    });
    if (!latest) {
      return REPLY.noActive;
    }
    const duration = latest.document.durationSeconds;
    if (
      !Number.isFinite(intent.fromSecond) ||
      !Number.isFinite(intent.toSecond) ||
      intent.fromSecond < 0 ||
      intent.toSecond <= intent.fromSecond ||
      intent.toSecond > duration
    ) {
      // Never silently clamp: the owner must know the range was not applied.
      return rangeTooLongReply(intent.fromSecond, intent.toSecond, duration);
    }
    if (!intent.beat.trim()) {
      return REPLY.emptyAction;
    }
    try {
      const version = await this.deps.service.edit({
        previsProjectId: active.previsProjectId,
        claim,
        edit: {
          standIn,
          fromSecond: intent.fromSecond,
          toSecond: intent.toSecond,
          beat: intent.beat,
        },
      });
      return editedReply({
        version: version.versionNumber,
        fromSecond: intent.fromSecond,
        toSecond: intent.toSecond,
        reviewUrl: active.reviewUrl,
      });
    } catch (error) {
      return this.failure("previs_edit_failed", error);
    }
  }

  private async approve(claim: PrevisAccessClaim): Promise<string> {
    const active = await this.readActive(claim);
    if (!active) {
      return REPLY.noActive;
    }
    try {
      const approved: PrevisVersion = await this.deps.service.approve({
        previsProjectId: active.previsProjectId,
        claim,
      });
      return approvedReply({
        version: approved.versionNumber,
        reviewUrl: active.reviewUrl,
      });
    } catch (error) {
      return this.failure("previs_approve_failed", error);
    }
  }

  /** Owner-scoped read: another owner or group never resolves this context. */
  private async readActive(claim: PrevisAccessClaim): Promise<ActivePrevisContext | undefined> {
    const active = await this.deps.active.lookup(activePrevisKey(claim));
    if (
      !active ||
      active.accountId !== claim.accountId ||
      active.lineGroupId !== claim.lineGroupId ||
      active.ownerSenderId !== claim.ownerSenderId
    ) {
      return undefined;
    }
    return active;
  }

  /** Logs the real cause, replies with a message that leaks no internals. */
  private failure(event: string, error: unknown): string {
    this.deps.logger?.warn(event, {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return REPLY.engineDown;
  }
}
