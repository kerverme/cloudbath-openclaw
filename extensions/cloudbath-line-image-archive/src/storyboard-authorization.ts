/**
 * What a LINE owner is allowed to do in this conversation, in one place.
 *
 * Two different questions were being answered by one check. "Is this the
 * owner talking?" decides whether the storyboard flow may plan a video at all.
 * "Does this conversation have a UGC workspace?" decides whether Character
 * Library identities, Notion projects and frozen casts are reachable. Asking
 * only the second one meant a group with no binding got no storyboard UX at
 * all, and its natural video request fell through to the legacy draft tool.
 *
 * Storyboard-first is the product's default owner video flow, so it is gated on
 * ownership. Project capability is a separate axis: absent it, the flow still
 * plans, revises and renders — it just cannot cast from the Character Library
 * or freeze a project, and says so at the point that actually needs it.
 */

import type { StoryboardAccessClaim } from "./storyboard-types.js";

export type StoryboardGroupBindingLookup = (
  accountId: string,
  groupId: string,
) => Promise<{ policyId: string; boundByOwnerId: string } | null | undefined>;

/**
 * `denied` is a real decision, not an absence: an explicit policy that is not
 * UGC (KEEP_WATCHING) and a UGC space bound to somebody else both mean this
 * owner must not drive a storyboard here.
 */
export type StoryboardAuthorization =
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "owner_scoped"; projectCapable: boolean }>;

/**
 * Whether the UGC project space is available for this owner.
 *
 * Named separately from the routing decision because callers branch on it at
 * the step that needs a project, not at the door.
 */
export async function resolveStoryboardAuthorization(params: {
  claim: StoryboardAccessClaim;
  lookup: StoryboardGroupBindingLookup;
}): Promise<StoryboardAuthorization> {
  const binding = await params.lookup(params.claim.accountId, params.claim.lineGroupId);
  if (!binding) {
    // No workspace policy has been bound here. The owner still gets the
    // storyboard-first flow; only project-backed capability is missing.
    return { kind: "owner_scoped", projectCapable: false };
  }
  if (binding.policyId !== "UGC" || binding.boundByOwnerId !== params.claim.ownerSenderId) {
    return { kind: "denied" };
  }
  return { kind: "owner_scoped", projectCapable: true };
}

/** What to say when a step genuinely needs the project space this group lacks. */
export const STORYBOARD_PROJECT_CAPABILITY_REPLY =
  "ส่วนนี้ต้องใช้ Character Library / โปรเจกต์ของกลุ่มนี้ก่อน\n" +
  "พิมพ์ “เปิดใช้งาน UGC” เพื่อผูกกลุ่มนี้กับ workspace แล้วค่อยทำต่อได้เลย";
