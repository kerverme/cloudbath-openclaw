/**
 * Deterministic LINE routing for the storyboard-first video flow.
 *
 * This runs in `before_dispatch` AHEAD of the previs router and returns
 * `{ handled: true }`, so a natural video request becomes a storyboard instead
 * of a previs — and cannot be answered by the model with a generic
 * confirmation. Explicit legacy previs requests are never claimed here, and an
 * edit or "สร้างวิดีโอ" is only claimed when this owner actually has an active
 * storyboard, so previs behaviour is unchanged when there is none.
 *
 * Nothing in this router is paid. Creating, editing, or preparing a Final Video
 * Draft performs no provider call and consumes no `VIDEO ####` code.
 */

import type { PrevisProjectResolver } from "./previs-line-router.js";
import { compileStoryboardDocument } from "./storyboard-compiler.js";
import { formatFinalVideoDraftForLine, formatStoryboardForLine } from "./storyboard-format.js";
import { parseStoryboardIntent, type StoryboardIntent } from "./storyboard-intent.js";
import {
  STORYBOARD_DEFAULT_ASPECT_RATIO,
  STORYBOARD_DEFAULT_DURATION_SECONDS,
  STORYBOARD_DEFAULT_RESOLUTION,
} from "./storyboard-request.js";
import { activeStoryboardKey, StoryboardStore } from "./storyboard-store.js";
import {
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_RESOLUTIONS,
  type ActiveStoryboardContext,
  type StoryboardAccessClaim,
  type StoryboardAspectRatio,
  type StoryboardCastMember,
  type StoryboardFinalVideoDraft,
  type StoryboardResolution,
  type StoryboardVersion,
} from "./storyboard-types.js";
import {
  prepareStoryboardFinalVideoDraft,
  type PrepareFinalVideoDraftParams,
} from "./storyboard-video-plan.js";
import type { AsyncKeyedStore, UgcCharacterLock } from "./types.js";

/** A retried webhook arrives within seconds; an hour is far past any retry window. */
const DEDUPE_TTL_MS = 60 * 60 * 1_000;

export type StoryboardDispatchEvent = {
  content: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isGroup?: boolean;
  messageId?: string;
};

export type StoryboardDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
};

/**
 * The SAME production resolver previs uses.
 *
 * Reused rather than reimplemented so canonical Character ids, the frozen cast
 * lock and the real UGC project/scene lifecycle stay identical across both
 * flows; a second lookup would be a second source of identity truth.
 */
export type StoryboardProjectResolver = PrevisProjectResolver;

export type StoryboardDedupeStore = Readonly<{
  lookup(key: string): Promise<{ reply: string } | undefined>;
  register(key: string, value: { reply: string }, opts?: { ttlMs?: number }): Promise<void>;
}>;

export type StoryboardLineRouterDeps = Readonly<{
  store: StoryboardStore;
  resolver: StoryboardProjectResolver;
  active: AsyncKeyedStore<ActiveStoryboardContext>;
  drafts: AsyncKeyedStore<StoryboardFinalVideoDraft>;
  dedupe: StoryboardDedupeStore;
  registry: {
    lookup(
      accountId: string | undefined,
      groupId: string,
    ): Promise<{ policyId: string; boundByOwnerId: string } | null | undefined>;
  };
  now: () => number;
  randomId?: PrepareFinalVideoDraftParams["randomId"];
  logger?: { warn: (event: string, fields?: Record<string, unknown>) => void };
}>;

const REPLY = {
  engineDown: "สร้าง Storyboard ไม่สำเร็จ กรุณาลองอีกครั้ง",
  emptyAction: "กรุณาระบุสิ่งที่ต้องการให้เกิดขึ้นในช่วงเวลานั้น",
  conflict: "มีการแก้ Storyboard พร้อมกัน กรุณาลองอีกครั้ง",
  missingVersion: "ไม่พบ Storyboard ล่าสุด กรุณาสร้างใหม่",
} as const;

function unknownCharacterReply(name: string): string {
  return `ไม่พบตัวละคร "${name}" ใน Character Library`;
}

function rangeOutsideReply(from: number, to: number, duration: number): string {
  return `ช่วงเวลา ${from}-${to} วิ อยู่นอกความยาว Storyboard ${duration} วิ`;
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

function toAspectRatio(value: string | undefined): StoryboardAspectRatio {
  return (
    STORYBOARD_ASPECT_RATIOS.find((candidate) => candidate === value) ??
    STORYBOARD_DEFAULT_ASPECT_RATIO
  );
}

function toResolution(value: string | undefined): StoryboardResolution {
  return (
    STORYBOARD_RESOLUTIONS.find((candidate) => candidate === value) ?? STORYBOARD_DEFAULT_RESOLUTION
  );
}

/**
 * Frozen locks -> storyboard cast, in lock order.
 *
 * `characterId` is always the lock's canonical code. The display name is only
 * looked up for presentation and falls back to the code, so a missing name can
 * never promote a display string into the canonical identity.
 */
function buildCast(
  characterLocks: readonly UgcCharacterLock[],
  displayNames: Readonly<Record<string, string>>,
): readonly StoryboardCastMember[] {
  return Object.freeze(
    characterLocks.map((lock) =>
      Object.freeze({
        characterId: lock.code,
        characterPageId: lock.pageId,
        displayName: displayNames[lock.code] ?? lock.code,
      }),
    ),
  );
}

export class CloudbathStoryboardLineRouter {
  /**
   * Executions in flight, keyed by dedupe key.
   *
   * The durable dedupe record is only written AFTER execution, so two
   * simultaneous deliveries of the same inbound message both missed it and each
   * created a storyboard -- minting a second real Notion project and scene.
   * Duplicates now await the first execution and receive its reply.
   */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: StoryboardLineRouterDeps) {}

  /**
   * Handles a storyboard intent, or returns undefined to leave the turn alone.
   *
   * Returning undefined is what keeps previs and the paid confirmation gate
   * reachable, so every non-storyboard branch must return it untouched.
   */
  async handleBeforeDispatch(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<{ handled: true; text?: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const claim = this.trustedClaim(event, context);
    if (!claim) {
      return undefined;
    }
    const binding = await this.deps.registry.lookup(claim.accountId, claim.lineGroupId);
    if (binding?.policyId !== "UGC" || binding.boundByOwnerId !== claim.ownerSenderId) {
      return undefined;
    }

    const knownCharacterNames = await this.deps.resolver
      .listCharacterNames(claim)
      .catch(() => [] as readonly string[]);
    const intent = parseStoryboardIntent({ content: event.content ?? "", knownCharacterNames });
    if (!intent) {
      return undefined;
    }
    // An edit or a draft request without an active storyboard is not ours: it
    // must fall through so the existing previs routing keeps working.
    const active = await this.readActive(claim);
    if (intent.kind !== "create" && !active) {
      return undefined;
    }
    // With a storyboard already active, only an EXPLICIT casting instruction
    // starts a second one. Otherwise a follow-up tweak ("เอาแบบ 16:9 นะ Twong")
    // would mint another Notion project and scene and move the active pointer
    // off the storyboard the owner is iterating on.
    if (intent.kind === "create" && active && !intent.explicitCasting) {
      return undefined;
    }

    const dedupeKey = this.dedupeKey(event, context, claim);
    if (!dedupeKey) {
      return { handled: true, text: await this.execute(intent, claim, active) };
    }
    const seen = await this.deps.dedupe.lookup(dedupeKey);
    if (seen) {
      return { handled: true, text: seen.reply };
    }
    const running = this.inFlight.get(dedupeKey);
    if (running) {
      return { handled: true, text: await running };
    }
    const pending = this.execute(intent, claim, active).then(async (text) => {
      await this.deps.dedupe.register(dedupeKey, { reply: text }, { ttlMs: DEDUPE_TTL_MS });
      return text;
    });
    this.inFlight.set(dedupeKey, pending);
    try {
      return { handled: true, text: await pending };
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  private async execute(
    intent: StoryboardIntent,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext | undefined,
  ): Promise<string> {
    if (intent.kind === "create") {
      return await this.create(intent, claim);
    }
    if (intent.kind === "edit") {
      return await this.edit(intent, claim, active!);
    }
    return await this.prepareDraft(claim, active!);
  }

  private async create(
    intent: Extract<StoryboardIntent, { kind: "create" }>,
    claim: StoryboardAccessClaim,
  ): Promise<string> {
    // A named-but-unknown character fails closed: dropping it silently would
    // recast the scene without the owner realising.
    if (intent.unknownNames[0]) {
      return unknownCharacterReply(intent.unknownNames[0]);
    }
    try {
      const resolved = await this.deps.resolver.resolveProject({
        claim,
        characterNames: intent.characterNames,
        scenePrompt: intent.scenePrompt,
      });
      const document = compileStoryboardDocument({
        scenePrompt: intent.scenePrompt,
        cast: buildCast(resolved.characterLocks, resolved.displayNames),
        durationSeconds: intent.durationSeconds ?? STORYBOARD_DEFAULT_DURATION_SECONDS,
        aspectRatio: toAspectRatio(intent.aspectRatio),
        resolution: toResolution(intent.resolution),
        environment: intent.environment,
      });
      const created = await this.deps.store.createStoryboard({
        document,
        claim,
        projectInstanceId: resolved.projectInstanceId,
        projectPageId: resolved.projectPageId,
        sceneId: resolved.sceneId,
        scenePageId: resolved.scenePageId,
        characterLocks: resolved.characterLocks,
      });
      await this.deps.active.register(activeStoryboardKey(claim), {
        version: 1,
        storyboardId: created.head.storyboardId,
        projectInstanceId: resolved.projectInstanceId,
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        updatedAt: new Date(this.deps.now()).toISOString(),
      });
      return formatStoryboardForLine({
        versionNumber: created.version.versionNumber,
        document: created.version.document,
      });
    } catch (error) {
      return this.failure("storyboard_create_failed", error);
    }
  }

  private async edit(
    intent: Extract<StoryboardIntent, { kind: "edit" }>,
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
  ): Promise<string> {
    // Unknown-name fail-closed applies to CREATE, where the cast is being
    // chosen. An edit instruction is free-form, so a Latin word after "ให้"
    // ("ให้ zoom in") is direction, not a missing character.
    if (!intent.action.trim()) {
      return REPLY.emptyAction;
    }
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    const duration = latest.document.durationSeconds;
    if (
      !Number.isFinite(intent.fromSeconds) ||
      !Number.isFinite(intent.toSeconds) ||
      intent.fromSeconds < 0 ||
      intent.toSeconds <= intent.fromSeconds ||
      intent.toSeconds > duration
    ) {
      // Never silently clamp: the owner must know the range was not applied.
      return rangeOutsideReply(intent.fromSeconds, intent.toSeconds, duration);
    }
    try {
      const version = await this.deps.store.appendEdit({
        storyboardId: active.storyboardId,
        claim,
        edit: {
          fromSeconds: intent.fromSeconds,
          toSeconds: intent.toSeconds,
          action: intent.action,
          ...this.editCharacterIds(latest, intent.characterNames),
        },
      });
      // Keep the pointer alive while the owner is actively iterating; only an
      // ABANDONED storyboard should age out.
      await this.touchActive(active);
      return formatStoryboardForLine({
        versionNumber: version.versionNumber,
        document: version.document,
      });
    } catch (error) {
      // A concurrent edit already claimed this version slot; the owner retries
      // rather than having their edit silently overwrite the other one.
      if (error instanceof Error && error.message.includes("concurrently")) {
        return REPLY.conflict;
      }
      return this.failure("storyboard_edit_failed", error);
    }
  }

  /**
   * Spread-ready cast override for an edit, omitted when nothing resolves.
   *
   * An empty array is NOT nullish, so returning `characterIds: []` would defeat
   * the edit's `?? anchor ?? cast` fallback and leave the rewritten beat with
   * no cast at all.
   */
  private editCharacterIds(
    version: StoryboardVersion,
    names: readonly string[],
  ): { characterIds?: readonly string[] } {
    const ids = version.document.cast
      .filter((member) => names.includes(member.displayName))
      .map((member) => member.characterId);
    return ids.length > 0 ? { characterIds: ids } : {};
  }

  private async prepareDraft(
    claim: StoryboardAccessClaim,
    active: ActiveStoryboardContext,
  ): Promise<string> {
    const latest = await this.deps.store
      .readLatest({ storyboardId: active.storyboardId, claim })
      .catch(() => undefined);
    if (!latest) {
      return REPLY.missingVersion;
    }
    try {
      const draft = await prepareStoryboardFinalVideoDraft({
        version: latest,
        drafts: this.deps.drafts,
        now: this.deps.now,
        ...(this.deps.randomId ? { randomId: this.deps.randomId } : {}),
      });
      await this.touchActive(active);
      return formatFinalVideoDraftForLine(draft);
    } catch (error) {
      return this.failure("storyboard_draft_failed", error);
    }
  }

  private trustedClaim(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): StoryboardAccessClaim | undefined {
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
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
    claim: StoryboardAccessClaim,
  ): string | undefined {
    const id = event.messageId?.trim() || context.messageId?.trim();
    return id
      ? `storyboard-dedupe:${claim.accountId}:${claim.lineGroupId}:${claim.ownerSenderId}:${id}`
      : undefined;
  }

  /** Re-registers the active pointer so its TTL tracks last use, not creation. */
  private async touchActive(active: ActiveStoryboardContext): Promise<void> {
    await this.deps.active.register(
      activeStoryboardKey({
        accountId: active.accountId,
        lineGroupId: active.lineGroupId,
        ownerSenderId: active.ownerSenderId,
      }),
      { ...active, updatedAt: new Date(this.deps.now()).toISOString() },
    );
  }

  /** Owner-scoped read: another owner or group never resolves this context. */
  private async readActive(
    claim: StoryboardAccessClaim,
  ): Promise<ActiveStoryboardContext | undefined> {
    const active = await this.deps.active.lookup(activeStoryboardKey(claim));
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
