import type { PrevisProjectResolver } from "./previs-line-router.js";
import type { AsyncKeyedStore, NotionTarget, UgcCapabilityId } from "./types.js";
import type {
  CloudbathUgcVideoWorkflow,
  NotionPage,
  UgcNotionWorkflowClient,
} from "./ugc-workflow.js";
import { generatedIdText } from "./ugc-workflow.js";

/**
 * Production resolver: named characters -> a real UGC project, scene and frozen
 * cast.
 *
 * There is no separate previs project lifecycle. This delegates to the SAME
 * `resolveProjectScene` that `cloudbath_ugc_video_prepare` uses, so an approved
 * previs already points at a real UGC project and shot — the Final Video Draft
 * phase can follow that linkage without reconciling synthetic ids.
 *
 * Three concepts stay separate throughout:
 *   identity  the frozen lock code, the Character Library's generated id (CHAR-6)
 *   display   what the owner typed and sees in LINE and the browser (Twong)
 *   stand-in  the generic CozyClay letter (A), derived from frozen cast order
 */
export type PrevisProjectResolverDeps = Readonly<{
  workflow: Pick<CloudbathUgcVideoWorkflow, "resolveProjectScene" | "readProjectCastLocks">;
  notion: Pick<UgcNotionWorkflowClient, "listCharacterNames" | "resolveNamedRecord">;
  capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  /**
   * Durable display names per project instance. Canonical identity is the lock
   * code; this is only what the owner calls each character, and it must not be
   * recovered by guessing from the code.
   */
  displayNames: AsyncKeyedStore<PrevisDisplayNameRecord>;
  /** Injectable clock for the Character-name memo; defaults to `Date.now`. */
  now?: () => number;
}>;

export type PrevisDisplayNameRecord = Readonly<{
  version: 1;
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  /** Canonical character code -> the name the owner used. */
  names: Readonly<Record<string, string>>;
}>;

export const CLOUDBATH_PREVIS_DISPLAY_NAMES_NAMESPACE = "cloudbath-previs-display-names-v1";

/** Short enough that a newly added Character shows up within one conversation. */
const CHARACTER_NAMES_TTL_MS = 30_000;

export function previsDisplayNamesKey(projectInstanceId: string): string {
  return `previs-display-names:${projectInstanceId}`;
}

export function createPrevisProjectResolver(
  deps: PrevisProjectResolverDeps,
): PrevisProjectResolver {
  // Single-slot, lifecycle-owned memo. Both the storyboard and previs routers
  // classify EVERY owner message against this list, so an uncached read meant
  // two full Character Library scans per chat turn. The in-flight promise is
  // shared so concurrent classifications collapse into one request, and a
  // failure is never cached.
  let cachedNames: { at: number; names: Promise<readonly string[]> } | undefined;
  const listCharacterNames = (): Promise<readonly string[]> => {
    const now = deps.now?.() ?? Date.now();
    if (cachedNames && now - cachedNames.at < CHARACTER_NAMES_TTL_MS) {
      return cachedNames.names;
    }
    const slot: { at: number; names: Promise<readonly string[]> } = {
      at: now,
      names: deps.notion
        .listCharacterNames({ capabilities: deps.capabilities })
        .catch((error: unknown) => {
          // Clear only THIS slot: a slow failure must not evict a newer
          // successful entry and restore the double scan per turn.
          if (cachedNames === slot) {
            cachedNames = undefined;
          }
          throw error;
        }),
    };
    cachedNames = slot;
    return slot.names;
  };

  return {
    listCharacterNames: async () => await listCharacterNames(),

    resolveProject: async ({ claim, characterNames, scenePrompt }) => {
      if (characterNames.length === 0) {
        throw new Error("Previs requires at least one character");
      }
      // Resolved once here so the canonical code and the display name can be
      // paired; the shared lifecycle then freezes the cast from these pages.
      const displayByCode: Record<string, string> = {};
      const resolveCharacterPages = async () => {
        const pages: Array<{ code: string; page: NotionPage }> = [];
        for (const displayName of characterNames) {
          // Throws on both "not found" and "ambiguous", so a duplicate library
          // row fails closed rather than one being picked.
          const page = await deps.notion.resolveNamedRecord({
            capabilityId: "CHARACTER_LIBRARY",
            target: deps.capabilities.CHARACTER_LIBRARY,
            capabilities: deps.capabilities,
            name: displayName,
          });
          const code = generatedIdText(page.properties?.["Character ID"]).trim();
          // Fail closed: falling back to the display name would make "Twong"
          // the canonical identity and break the handoff to the video pipeline.
          if (!code) {
            throw new Error(
              `Character "${displayName}" has no generated Character ID in the Character Library`,
            );
          }
          displayByCode[code] = displayName;
          pages.push({ code, page });
        }
        return pages;
      };

      const resolved = await deps.workflow.resolveProjectScene({
        accountId: claim.accountId,
        groupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        // Product stays optional: a character-only previs is a first-class shape.
        characterNames,
        resolveCharacterPages,
        prompt: scenePrompt,
      });

      // Previs always names a cast, so the resolve above ran and `displayByCode`
      // covers it. The stored record still merges in first, so a name the owner
      // gave an earlier scene survives eviction of nothing but this turn's map,
      // and a lock with no known display name falls back to its canonical code.
      const stored = await deps.displayNames.lookup(
        previsDisplayNamesKey(resolved.instance.projectInstanceId),
      );
      const names: Record<string, string> = { ...stored?.names, ...displayByCode };
      for (const lock of resolved.characterLocks) {
        names[lock.code] ??= lock.code;
      }
      await deps.displayNames.register(previsDisplayNamesKey(resolved.instance.projectInstanceId), {
        version: 1,
        projectInstanceId: resolved.instance.projectInstanceId,
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
        names: Object.freeze({ ...names }),
      });

      return {
        projectInstanceId: resolved.instance.projectInstanceId,
        projectPageId: resolved.instance.projectPageId,
        // The real UGC shot, by its scene order -- not a hard-coded label.
        sceneId: `SCENE-${resolved.sceneNumber}`,
        scenePageId: resolved.scenePage.id ?? "",
        characterLocks: resolved.characterLocks,
        displayNames: Object.freeze({ ...names }),
      };
    },

    readProjectCast: async ({ claim, projectInstanceId }) => {
      const stored = await deps.displayNames.lookup(previsDisplayNamesKey(projectInstanceId));
      // Fail closed on the full trusted triple: an edit must never reach another
      // owner's cast.
      if (
        !stored ||
        stored.accountId !== claim.accountId ||
        stored.lineGroupId !== claim.lineGroupId ||
        stored.ownerSenderId !== claim.ownerSenderId
      ) {
        throw new Error("Previs project cast is not accessible to this owner");
      }
      const locks = await deps.workflow.readProjectCastLocks({
        projectInstanceId,
        accountId: claim.accountId,
        lineGroupId: claim.lineGroupId,
        ownerSenderId: claim.ownerSenderId,
      });
      return { characterLocks: locks, displayNames: stored.names };
    },
  };
}
