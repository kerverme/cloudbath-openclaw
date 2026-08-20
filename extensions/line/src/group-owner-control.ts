import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
// LINE plugin module implements the owner-only per-group/room silent-mode toggle.
//
// The canonical LINE/OpenClaw owner can send the exact text "7272" in a group
// or room to toggle that specific conversation between ACTIVE (default) and
// SILENT. While SILENT, all inbound traffic for that group/room is suppressed
// before any expensive or side-effecting work (media download, history,
// agent/tool invocation) — see bot-handlers.ts's call sites. State persists in
// the plugin's SQLite-backed keyed store (never an in-memory Map), scoped by
// LINE accountId + exact conversation identity, so one group/room's silence
// never affects another.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveLineAddresses } from "./bot-message-context.js";
import { getLineRuntime } from "./runtime.js";
import type { ResolvedLineAccount } from "./types.js";

/** Exact trimmed text the canonical owner sends to toggle a group/room's silent mode. */
export const LINE_GROUP_SILENT_TOGGLE_COMMAND = "7272";
export const LINE_GROUP_SILENT_MODE_NAMESPACE = "group-silent-mode-v1";
export const LINE_GROUP_SILENT_MODE_MAX_ENTRIES = 20_000;

export type LineGroupSilentModeState = {
  silent: true;
  toggledAt: number;
};

export type LineGroupSilentModeStore = PluginStateKeyedStore<LineGroupSilentModeState>;

/**
 * Per-conversation state key: LINE accountId + exact group/room identity, so
 * "Group A silent" never leaks into "Group B" or a different account. A
 * missing entry means ACTIVE (the default); only a stored `silent: true`
 * entry means SILENT — toggling back to ACTIVE deletes the entry rather than
 * writing an explicit "active" record, so absence and "explicitly active"
 * are the same state by construction.
 */
export function buildLineGroupSilentModeStateKey(params: {
  accountId: string;
  groupId?: string;
  roomId?: string;
}): string | null {
  const scopeId = params.groupId
    ? `group:${params.groupId}`
    : params.roomId
      ? `room:${params.roomId}`
      : null;
  return scopeId ? `${params.accountId}|${scopeId}` : null;
}

/**
 * Resolves whether `senderId` is the canonical LINE/OpenClaw owner, reusing
 * the exact same `resolveCommandAuthorization` decision already used for
 * privileged LINE model-switch control (extensions/line/src/model-switch-router.ts)
 * instead of a second owner/admin identity system. Only the fields that
 * decision actually reads are populated; every MsgContext field is optional.
 */
export async function resolveLineCanonicalOwner(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  senderId?: string;
  groupId?: string;
  roomId?: string;
}): Promise<boolean> {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const { fromAddress, toAddress } = resolveLineAddresses({
    isGroup: true,
    groupId: params.groupId,
    roomId: params.roomId,
    userId: senderId,
    peerId: params.groupId ?? params.roomId ?? senderId,
  });
  const ctx: MsgContext = {
    Provider: "line",
    Surface: "line",
    AccountId: params.account.accountId,
    SenderId: senderId,
    From: fromAddress,
    To: toAddress,
    ChatType: "group",
  };
  const authorization = resolveCommandAuthorization({
    ctx,
    cfg: params.cfg,
    commandAuthorized: false,
  });
  return authorization.senderIsOwner;
}

export type LineGroupSilentGateOutcome =
  | { kind: "toggle-consumed"; silent: boolean }
  | { kind: "silent-suppressed" }
  | { kind: "pass" };

export type LineGroupSilentGate = (params: {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
  senderId?: string;
  /** The message's literal text, only for text messages; omit for postbacks/other types. */
  rawText?: string;
  isTextMessage: boolean;
}) => Promise<LineGroupSilentGateOutcome>;

async function toggleLineGroupSilentState(
  store: LineGroupSilentModeStore,
  key: string,
): Promise<boolean> {
  const current = await store.lookup(key);
  if (current?.silent === true) {
    await store.delete(key);
    return false;
  }
  await store.register(key, { silent: true, toggledAt: Date.now() });
  return true;
}

function openLiveLineGroupSilentModeStore(): LineGroupSilentModeStore {
  return getLineRuntime().state.openKeyedStore<LineGroupSilentModeState>({
    namespace: LINE_GROUP_SILENT_MODE_NAMESPACE,
    maxEntries: LINE_GROUP_SILENT_MODE_MAX_ENTRIES,
  });
}

/**
 * Builds the deterministic before-ingress gate consumed by bot-handlers.ts.
 * DM traffic is never touched (`isGroup: false` always resolves to "pass"
 * without a store lookup) — 7272 control is group/room-only. `getStore` and
 * `resolveOwner` default to the live SQLite-backed store (opened lazily and
 * cached, since the plugin runtime is only initialized after registration)
 * and the live canonical-owner decision; tests inject fakes instead of
 * reaching into module internals, matching the model-switch-router pattern.
 */
export function createLineGroupSilentGate(deps?: {
  getStore?: () => LineGroupSilentModeStore;
  resolveOwner?: typeof resolveLineCanonicalOwner;
}): LineGroupSilentGate {
  const resolveOwner = deps?.resolveOwner ?? resolveLineCanonicalOwner;
  let cachedStore: LineGroupSilentModeStore | undefined;
  const getStore = deps?.getStore ?? (() => (cachedStore ??= openLiveLineGroupSilentModeStore()));

  return async (params) => {
    if (!params.isGroup) {
      return { kind: "pass" };
    }
    const key = buildLineGroupSilentModeStateKey({
      accountId: params.account.accountId,
      groupId: params.groupId,
      roomId: params.roomId,
    });
    if (!key) {
      return { kind: "pass" };
    }
    const store = getStore();

    const isToggleCommand =
      params.isTextMessage && params.rawText?.trim() === LINE_GROUP_SILENT_TOGGLE_COMMAND;
    if (isToggleCommand) {
      const isOwner = await resolveOwner({
        cfg: params.cfg,
        account: params.account,
        senderId: params.senderId,
        groupId: params.groupId,
        roomId: params.roomId,
      });
      if (isOwner) {
        const silent = await toggleLineGroupSilentState(store, key);
        return { kind: "toggle-consumed", silent };
      }
      // A non-owner's exact "7272" never toggles state — it falls through to
      // the ordinary silent-state check below like any other message.
    }

    const current = await store.lookup(key);
    return current?.silent === true ? { kind: "silent-suppressed" } : { kind: "pass" };
  };
}
