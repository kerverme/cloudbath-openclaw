import { describe, expect, it } from "vitest";
import { buildStoryboardDraftScope } from "../../cloudbath-line-image-archive/src/storyboard-draft-scope.js";
import {
  validateLineVideoUgcScope,
  type LineGroupPolicyBinding,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";

/**
 * The cross-plugin scope contract, asserted against the validator that spends.
 *
 * The confirmation gate refuses a UGC-bound group's draft unless it finds a
 * scope it accepts, so a storyboard draft whose scope this validator rejects is
 * a code that can never be confirmed. Building the scope on one side and
 * checking it with the other side's real validator is the only way to catch
 * that before production does.
 *
 * (This test imports across the plugin boundary deliberately and follows the
 * existing precedent in video-ugc-scope.test.ts; it is a test, not runtime.)
 */

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";

const CAPABILITIES = Object.fromEntries(
  [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ].map((id, index) => [
    id,
    { databaseId: String(index + 1).repeat(32), dataSourceId: String(index + 1).repeat(32) },
  ]),
) as never;

/** The real config path the gate reads capabilities from. */
const CFG = {
  plugins: {
    entries: {
      "cloudbath-line-image-archive": {
        config: { groupWorkspacePolicies: { ugc: { capabilities: CAPABILITIES } } },
      },
    },
  },
} as never;

const CLAIM = { accountId: ACCOUNT, lineGroupId: GROUP, ownerSenderId: OWNER };
const BINDING: LineGroupPolicyBinding = {
  policyId: "UGC",
  accountId: ACCOUNT,
  groupId: GROUP,
  boundByOwnerId: OWNER,
  boundAt: "2026-08-30T00:00:00.000Z",
};

function lock(code: string, pageId: string) {
  return Object.freeze({
    code,
    pageId,
    identityReferences: Object.freeze([
      Object.freeze({ kind: "identity", source: "r2", locator: `ugc/${pageId}.png` } as const),
    ]),
    styleReferences: Object.freeze([]),
    frozenAt: "2026-08-30T00:00:00.000Z",
  });
}

/** A draft shaped exactly as the storyboard router hands one to the scope builder. */
function draft(overrides: Record<string, unknown> = {}, project: Record<string, unknown> = {}) {
  const characterLocks = [lock("CHAR-6", "page-char-6"), lock("CHAR-7", "page-char-7")];
  return {
    version: 1,
    draftId: "sb-draft-1",
    storyboardId: "sb_1",
    storyboardVersionNumber: 2,
    project: {
      projectInstanceId: "proj-instance-1",
      projectPageId: "page-project-1",
      sceneId: "SCENE-3",
      scenePageId: "page-scene-3",
      ...project,
    },
    accountId: ACCOUNT,
    lineGroupId: GROUP,
    ownerSenderId: OWNER,
    characterLocks,
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "720p",
    model: { kind: "provider-bound", providerModelId: "m", displayName: "Seedance 2.5" },
    estimatedCost: { kind: "available", amountUsd: 3.468, source: "openrouter:m" },
    plan: {
      version: 1,
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "720p",
      environment: "ร้านกาแฟ",
      characters: characterLocks.map((entry) => ({
        characterId: entry.code,
        characterPageId: entry.pageId,
        displayName: entry.code === "CHAR-6" ? "Twong" : "Twong2",
        identityReferences: entry.identityReferences.map((reference) => reference.locator),
      })),
      beats: [
        {
          beatId: "BEAT-1",
          startSeconds: 0,
          endSeconds: 15,
          framing: "Medium-wide tracking shot",
          action: "เดินผ่าน",
          camera: "Track with the subject",
          characterIds: ["CHAR-6", "CHAR-7"],
        },
      ],
    },
    confirmation: { kind: "ready", code: "4821" },
    createdAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  } as never;
}

describe("a storyboard draft's scope satisfies the paid gate's own validator", () => {
  it("is accepted, with the frozen prompt the gate will compare", () => {
    const scope = buildStoryboardDraftScope({
      draft: draft(),
      claim: CLAIM,
      capabilities: CAPABILITIES,
      createdAt: "2026-08-30T10:00:00.000Z",
    });
    expect(scope).toBeDefined();

    const accepted = validateLineVideoUgcScope({
      scope: scope as unknown as LineVideoUgcScope,
      cfg: CFG,
      binding: BINDING,
      accountId: ACCOUNT,
      groupId: GROUP,
      ownerSenderId: OWNER,
      // The gate passes the DRAFT's prompt here; the storyboard freezes the
      // same compiled string into the paid draft.
      frozenPrompt: scope!.frozenPrompt,
    });
    expect(accepted).toBe(true);
  });

  it("keeps canonical identity positional with the frozen cast", () => {
    const scope = buildStoryboardDraftScope({
      draft: draft(),
      claim: CLAIM,
      capabilities: CAPABILITIES,
      createdAt: "2026-08-30T10:00:00.000Z",
    });
    expect(scope?.scene.characterCodes).toEqual(["CHAR-6", "CHAR-7"]);
    expect(scope?.scene.characterPageIds).toEqual(["page-char-6", "page-char-7"]);
    expect(scope?.scene.sceneNumber).toBe(3);
    // Identity references travel with the scope, one per character.
    expect(scope?.referenceAssets.map((asset) => asset.locator)).toEqual([
      "ugc/page-char-6.png",
      "ugc/page-char-7.png",
    ]);
    // A display name may appear in the PROMPT, which is what a video model
    // reads, but never in an identity field.
    expect(JSON.stringify(scope?.scene.characterCodes)).not.toMatch(/Twong/u);
    expect(JSON.stringify(scope?.scene.characterPageIds)).not.toMatch(/Twong/u);
    expect(JSON.stringify(scope?.characterLocks.map((entry) => entry.code))).not.toMatch(/Twong/u);
  });

  it("is refused by the gate when the owner, group or account differ", () => {
    const scope = buildStoryboardDraftScope({
      draft: draft(),
      claim: CLAIM,
      capabilities: CAPABILITIES,
      createdAt: "2026-08-30T10:00:00.000Z",
    }) as unknown as LineVideoUgcScope;
    const base: Parameters<typeof validateLineVideoUgcScope>[0] = {
      scope,
      cfg: CFG,
      binding: BINDING,
      accountId: ACCOUNT,
      groupId: GROUP,
      ownerSenderId: OWNER,
      frozenPrompt: scope.frozenPrompt,
    };
    expect(validateLineVideoUgcScope({ ...base, ownerSenderId: "U-intruder" })).toBe(false);
    expect(validateLineVideoUgcScope({ ...base, groupId: "C-other" })).toBe(false);
    expect(validateLineVideoUgcScope({ ...base, accountId: "acct-other" })).toBe(false);
    // A prompt that drifted from the one the owner confirmed must not spend.
    expect(validateLineVideoUgcScope({ ...base, frozenPrompt: "something else" })).toBe(false);
  });

  it("declines to build a scope for a scene it cannot number", () => {
    expect(
      buildStoryboardDraftScope({
        draft: draft({}, { sceneId: "SCENE-UNKNOWN" }),
        claim: CLAIM,
        capabilities: CAPABILITIES,
        createdAt: "2026-08-30T10:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});
