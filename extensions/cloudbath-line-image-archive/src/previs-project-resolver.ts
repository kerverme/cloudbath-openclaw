import crypto from "node:crypto";
import type { PrevisProjectResolver } from "./previs-line-router.js";
import type {
  NotionTarget,
  UgcCapabilityId,
  UgcCharacterLock,
  UgcProjectCharacterLock,
  AsyncKeyedStore,
  UgcReferenceAsset,
} from "./types.js";
import { freezeCharacterLock } from "./ugc-character-lock.js";
import type { UgcNotionWorkflowClient } from "./ugc-workflow.js";

/**
 * Production resolver: named characters -> a frozen project cast.
 *
 * Deliberately reuses the existing UGC identity model — the same
 * `freezeCharacterLock`, the same project-lock store — rather than growing a
 * parallel previs project system. Once a project's cast is frozen, later scenes
 * and edits read that lock; the Character Library is never re-queried to swap
 * references underneath an in-flight project.
 */
export type PrevisProjectResolverDeps = Readonly<{
  notion: Pick<UgcNotionWorkflowClient, "listCharacterNames" | "resolveNamedRecord">;
  capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  /** Shared with the UGC workflow so one project has exactly one frozen cast. */
  projectLocks: AsyncKeyedStore<UgcProjectCharacterLock>;
  /** Reads a character page's reference assets, as the UGC workflow does. */
  readReferences: (
    page: { id?: string; last_edited_time?: string },
    names: readonly string[],
    kind: UgcReferenceAsset["kind"],
  ) => UgcReferenceAsset[];
  now: () => number;
}>;

/** Keyed the same way the UGC workflow keys its project locks. */
export function previsProjectLockKey(projectInstanceId: string): string {
  return `ugc-project-lock:${projectInstanceId}`;
}

export function createPrevisProjectResolver(
  deps: PrevisProjectResolverDeps,
): PrevisProjectResolver {
  const displayNamesFor = (locks: readonly UgcCharacterLock[], names: readonly string[]) =>
    Object.freeze(
      Object.fromEntries(locks.map((lock, index) => [lock.code, names[index] ?? lock.code])),
    );

  return {
    listCharacterNames: async () =>
      await deps.notion.listCharacterNames({ capabilities: deps.capabilities }),

    resolveProject: async ({ claim, characterNames }) => {
      if (characterNames.length === 0) {
        throw new Error("Previs requires at least one character");
      }
      const frozenAt = new Date(deps.now()).toISOString();
      const locks: UgcCharacterLock[] = [];
      for (const name of characterNames) {
        // resolveNamedRecord throws on both "not found" and "ambiguous", so a
        // duplicate library entry fails closed rather than picking one.
        const page = await deps.notion.resolveNamedRecord({
          capabilityId: "CHARACTER_LIBRARY",
          target: deps.capabilities.CHARACTER_LIBRARY,
          capabilities: deps.capabilities,
          name,
        });
        locks.push(
          freezeCharacterLock({
            code: name,
            page,
            readReferences: deps.readReferences,
            frozenAt,
          }),
        );
      }
      // Product is intentionally absent: a character-only previs is valid and
      // must not require a Product Library record.
      const projectInstanceId = crypto.randomUUID();
      const sceneId = "SCENE-1";
      await deps.projectLocks.register(previsProjectLockKey(projectInstanceId), {
        version: 1,
        projectInstanceId,
        projectPageId: "",
        projectRecordId: "",
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        characterLocks: Object.freeze(locks),
        frozenAt,
      });
      return {
        projectInstanceId,
        sceneId,
        characterLocks: Object.freeze(locks),
        displayNames: displayNamesFor(locks, characterNames),
      };
    },

    readProjectCast: async ({ claim, projectInstanceId }) => {
      const stored = await deps.projectLocks.lookup(previsProjectLockKey(projectInstanceId));
      // Fail closed on the full trusted triple: a project belongs to one owner
      // in one group, and an edit must never reach another owner's cast.
      if (
        !stored ||
        stored.accountId !== claim.accountId ||
        stored.lineGroupId !== claim.lineGroupId ||
        stored.ownerSenderId !== claim.ownerSenderId
      ) {
        throw new Error("Previs project cast is not accessible to this owner");
      }
      return {
        characterLocks: stored.characterLocks,
        displayNames: displayNamesFor(
          stored.characterLocks,
          stored.characterLocks.map((lock) => lock.code),
        ),
      };
    },
  };
}
