import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  FrozenWorkspaceJobScope,
  LineGroupPairingGrant,
  LineGroupPolicyBinding,
  LineGroupWorkspacePolicyId,
  NotionTarget,
  UgcCapabilityAccess,
  UgcCapabilityId,
  WorkspacePolicyConfig,
} from "./types.js";

const POLICY_IDS = new Set<LineGroupWorkspacePolicyId>(["UGC", "KEEP_WATCHING"]);
const PAIRING_COMMAND = /^สร้าง\s+pairing\s+(UGC|KEEP_WATCHING)$/iu;
const PAIRING_CODE = /^PAIR-([A-Z2-9]{8})$/u;
const UNPAIR_COMMAND = /^(?:ยกเลิก\s+pairing|unpair\s+group)$/iu;

const UGC_CAPABILITY_ACCESS: Readonly<Record<UgcCapabilityId, UgcCapabilityAccess>> = {
  PRODUCT_LIBRARY: "READ",
  CHARACTER_LIBRARY: "READ_WRITE",
  UGC_PROJECTS: "READ_WRITE",
  UGC_SHOTS: "READ_WRITE",
  AI_VIDEO_LIBRARY: "READ_WRITE",
  AI_IMAGE_LIBRARY: "READ_WRITE",
};

export type WorkspacePolicyBeforeDispatchEvent = {
  content: string;
  senderId?: string;
  senderIsOwner?: boolean;
  isGroup?: boolean;
};

export type WorkspacePolicyBeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

export type WorkspacePolicyBeforeDispatchResult = { handled: boolean; text?: string };

export function isWorkspacePolicyCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    PAIRING_COMMAND.test(trimmed) ||
    PAIRING_CODE.test(trimmed.toUpperCase()) ||
    UNPAIR_COMMAND.test(trimmed)
  );
}

function normalizedAccountId(accountId: string | undefined): string {
  return accountId?.trim() || "default";
}

function nativeLineGroupId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const prefixed = normalized.match(/^line:group:([A-Za-z0-9_-]+)$/u)?.[1];
  const groupId = prefixed ?? normalized;
  return /^C[A-Za-z0-9_-]+$/u.test(groupId) ? groupId : undefined;
}

function bindingKey(accountId: string, groupId: string): string {
  return crypto.createHash("sha256").update(`${accountId}\0${groupId}`, "utf8").digest("hex");
}

function pairingKey(accountId: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${accountId}\0${code.toUpperCase()}`, "utf8")
    .digest("hex");
}

function randomPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return `PAIR-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function assertPolicyConfigured(
  config: WorkspacePolicyConfig,
  policyId: LineGroupWorkspacePolicyId,
): void {
  if (policyId === "UGC" && !config.ugc) {
    throw new Error("UGC workspace policy is not configured");
  }
  if (policyId === "KEEP_WATCHING" && !config.keepWatching) {
    throw new Error("KEEP_WATCHING workspace policy is not configured");
  }
}

export class LineGroupWorkspacePolicyRegistry {
  constructor(
    private readonly config: WorkspacePolicyConfig,
    private readonly bindings: PluginStateKeyedStore<LineGroupPolicyBinding>,
    private readonly pairingGrants: PluginStateKeyedStore<LineGroupPairingGrant>,
    private readonly now: () => number = Date.now,
    private readonly createCode: () => string = randomPairingCode,
  ) {}

  async lookup(
    accountId: string | undefined,
    groupId: string,
  ): Promise<LineGroupPolicyBinding | null> {
    return (
      (await this.bindings.lookup(bindingKey(normalizedAccountId(accountId), groupId))) ?? null
    );
  }

  async requirePolicy(
    accountId: string | undefined,
    groupId: string,
    expected: LineGroupWorkspacePolicyId,
  ): Promise<LineGroupPolicyBinding> {
    const binding = await this.lookup(accountId, groupId);
    if (!binding || binding.policyId !== expected) {
      throw new Error("LINE group is not paired with the required workspace policy");
    }
    return binding;
  }

  private async issuePairingCode(params: {
    accountId?: string;
    ownerId: string;
    policyId: LineGroupWorkspacePolicyId;
  }): Promise<{ code: string; expiresAt: string }> {
    assertPolicyConfigured(this.config, params.policyId);
    const accountId = normalizedAccountId(params.accountId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = this.createCode().toUpperCase();
      if (!PAIRING_CODE.test(code)) {
        throw new Error("Pairing code generator returned an invalid code");
      }
      const createdAtMs = this.now();
      const grant: LineGroupPairingGrant = {
        accountId,
        policyId: params.policyId,
        ownerId: params.ownerId,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.config.pairingTtlMs).toISOString(),
      };
      if (
        await this.pairingGrants.registerIfAbsent(pairingKey(accountId, code), grant, {
          ttlMs: this.config.pairingTtlMs,
        })
      ) {
        return { code, expiresAt: grant.expiresAt };
      }
    }
    throw new Error("Unable to allocate a unique pairing code");
  }

  private async redeemPairingCode(params: {
    accountId?: string;
    groupId: string;
    ownerId: string;
    code: string;
  }): Promise<LineGroupPolicyBinding> {
    const accountId = normalizedAccountId(params.accountId);
    const grant = await this.pairingGrants.consume(pairingKey(accountId, params.code));
    if (!grant) {
      throw new Error("Pairing code is invalid, expired, or already used");
    }
    if (
      grant.accountId !== accountId ||
      grant.ownerId !== params.ownerId ||
      !POLICY_IDS.has(grant.policyId) ||
      Date.parse(grant.expiresAt) <= this.now()
    ) {
      throw new Error("Pairing code is invalid, expired, or already used");
    }
    assertPolicyConfigured(this.config, grant.policyId);
    const binding: LineGroupPolicyBinding = {
      accountId,
      groupId: params.groupId,
      policyId: grant.policyId,
      boundByOwnerId: params.ownerId,
      boundAt: new Date(this.now()).toISOString(),
    };
    await this.bindings.register(bindingKey(accountId, params.groupId), binding);
    return binding;
  }

  private async unpair(params: { accountId?: string; groupId: string }): Promise<boolean> {
    return await this.bindings.delete(
      bindingKey(normalizedAccountId(params.accountId), params.groupId),
    );
  }

  async handleBeforeDispatch(
    event: WorkspacePolicyBeforeDispatchEvent,
    context: WorkspacePolicyBeforeDispatchContext,
  ): Promise<WorkspacePolicyBeforeDispatchResult | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const text = event.content.trim();
    const pairingMatch = text.match(PAIRING_COMMAND);
    const codeMatch = text.toUpperCase().match(PAIRING_CODE);
    const isUnpair = UNPAIR_COMMAND.test(text);
    if (pairingMatch || codeMatch || isUnpair) {
      if (event.senderIsOwner !== true || !event.senderId?.trim()) {
        return { handled: true };
      }
    }

    if (pairingMatch) {
      const policyId = pairingMatch[1].toUpperCase() as LineGroupWorkspacePolicyId;
      try {
        const pairing = await this.issuePairingCode({
          accountId: context.accountId,
          ownerId: event.senderId!,
          policyId,
        });
        return {
          handled: true,
          text: `Pairing code for ${policyId}: ${pairing.code}\nExpires in ${Math.ceil(this.config.pairingTtlMs / 60_000)} minutes.`,
        };
      } catch {
        return { handled: true, text: "This workspace policy is not configured." };
      }
    }

    if (codeMatch) {
      const groupId = event.isGroup ? nativeLineGroupId(context.conversationId) : undefined;
      if (!groupId) {
        return { handled: true, text: "Send the pairing code inside a LINE group." };
      }
      try {
        const binding = await this.redeemPairingCode({
          accountId: context.accountId,
          groupId,
          ownerId: event.senderId!,
          code: text.toUpperCase(),
        });
        return { handled: true, text: `LINE group paired with ${binding.policyId}.` };
      } catch {
        return { handled: true, text: "Pairing code is invalid, expired, or already used." };
      }
    }

    if (isUnpair) {
      const groupId = event.isGroup ? nativeLineGroupId(context.conversationId) : undefined;
      if (!groupId) {
        return { handled: true, text: "Run this action inside the paired LINE group." };
      }
      const removed = await this.unpair({ accountId: context.accountId, groupId });
      return {
        handled: true,
        text: removed ? "LINE group unpaired." : "LINE group was not paired.",
      };
    }

    const groupId = event.isGroup ? nativeLineGroupId(context.conversationId) : undefined;
    if (!groupId) {
      return undefined;
    }
    const binding = await this.lookup(context.accountId, groupId);
    if (binding?.policyId === "KEEP_WATCHING") {
      return { handled: true };
    }
    return undefined;
  }
}

export function resolveUgcCapability(params: {
  config: WorkspacePolicyConfig;
  binding: LineGroupPolicyBinding | null;
  capabilityId: UgcCapabilityId;
  requiredAccess: UgcCapabilityAccess;
}): NotionTarget {
  if (params.binding?.policyId !== "UGC" || !params.config.ugc) {
    throw new Error("UGC capability access denied");
  }
  const actualAccess = UGC_CAPABILITY_ACCESS[params.capabilityId];
  if (params.requiredAccess === "READ_WRITE" && actualAccess !== "READ_WRITE") {
    throw new Error("UGC capability is read-only");
  }
  const target = params.config.ugc.capabilities[params.capabilityId];
  if (!target) {
    throw new Error("UGC capability is not configured");
  }
  return target;
}

export function freezeWorkspaceJobScope(input: FrozenWorkspaceJobScope): FrozenWorkspaceJobScope {
  const sourceCapabilityIds = Object.freeze([...input.sourceCapabilityIds]);
  return Object.freeze({ ...input, sourceCapabilityIds });
}

export const UGC_CAPABILITY_PERMISSIONS = UGC_CAPABILITY_ACCESS;
