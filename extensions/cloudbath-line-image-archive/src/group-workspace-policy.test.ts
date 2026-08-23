import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  freezeWorkspaceJobScope,
  LineGroupWorkspacePolicyRegistry,
  resolveUgcCapability,
  UGC_CAPABILITY_PERMISSIONS,
} from "./group-workspace-policy.js";
import type {
  LineGroupPairingGrant,
  LineGroupPolicyBinding,
  UgcCapabilityId,
  WorkspacePolicyConfig,
} from "./types.js";

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number; expiresAt?: number }>();
  return {
    async register(key, value, opts) {
      values.set(key, {
        value,
        createdAt: Date.now(),
        expiresAt: opts?.ttlMs ? Date.now() + opts.ttlMs : undefined,
      });
    },
    async registerIfAbsent(key, value, opts) {
      if (values.has(key)) {
        return false;
      }
      await this.register(key, value, opts);
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const found = values.get(key)?.value;
      values.delete(key);
      return found;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values, ([key, entry]) => ({ key, ...entry }));
    },
    async clear() {
      values.clear();
    },
  };
}

const notionTarget = (suffix: string) => ({
  databaseId: suffix.padStart(32, "a"),
  dataSourceId: suffix.padStart(32, "b"),
});

function policyConfig(): WorkspacePolicyConfig {
  const capabilityIds: UgcCapabilityId[] = [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ];
  return {
    pairingTtlMs: 60_000,
    keepWatching: { notion: notionTarget("1"), r2Prefix: "keep-watching" },
    ugc: {
      capabilities: Object.fromEntries(
        capabilityIds.map((id, index) => [id, notionTarget(String(index + 2))]),
      ) as Record<UgcCapabilityId, ReturnType<typeof notionTarget>>,
    },
  };
}

function registry(params: { now?: () => number; code?: string } = {}) {
  return new LineGroupWorkspacePolicyRegistry(
    policyConfig(),
    memoryStore<LineGroupPolicyBinding>(),
    memoryStore<LineGroupPairingGrant>(),
    params.now,
    params.code ? () => params.code! : undefined,
  );
}

const ownerEvent = (content: string) => ({
  content,
  senderId: "U-owner",
  senderIsOwner: true,
  isGroup: true,
});
const lineContext = (groupId = "C-group") => ({
  channelId: "line",
  accountId: "primary",
  conversationId: groupId,
});

describe("persistent LINE group workspace policy registry", () => {
  it("allows only the verified owner to issue and redeem a one-time pairing code", async () => {
    const subject = registry({ code: "PAIR-ABCD2345" });
    const issued = await subject.handleBeforeDispatch(
      ownerEvent("สร้าง pairing KEEP_WATCHING"),
      lineContext(),
    );
    expect(issued?.text).toContain("PAIR-ABCD2345");

    const nonOwner = await subject.handleBeforeDispatch(
      { ...ownerEvent("PAIR-ABCD2345"), senderId: "U-other", senderIsOwner: false },
      lineContext(),
    );
    expect(nonOwner).toEqual({ handled: true });
    expect(await subject.lookup("primary", "C-group")).toBeNull();

    const paired = await subject.handleBeforeDispatch(ownerEvent("PAIR-ABCD2345"), lineContext());
    expect(paired?.text).toContain("KEEP_WATCHING");
    expect(await subject.lookup("primary", "C-group")).toMatchObject({
      groupId: "C-group",
      policyId: "KEEP_WATCHING",
      boundByOwnerId: "U-owner",
    });

    const replayed = await subject.handleBeforeDispatch(ownerEvent("PAIR-ABCD2345"), lineContext());
    expect(replayed?.text).toContain("invalid, expired, or already used");
  });

  it("rejects expired pairing grants and never binds the native group", async () => {
    let now = 1_000;
    const subject = registry({ now: () => now, code: "PAIR-BCDE3456" });
    await subject.handleBeforeDispatch(ownerEvent("สร้าง pairing UGC"), lineContext());
    now += 60_001;
    const result = await subject.handleBeforeDispatch(ownerEvent("PAIR-BCDE3456"), lineContext());
    expect(result?.text).toContain("invalid, expired, or already used");
    expect(await subject.lookup("primary", "C-group")).toBeNull();
  });

  it("requires fresh owner authentication to change or unpair a persistent binding", async () => {
    const codes = ["PAIR-CDEF4567", "PAIR-DEFG5678"];
    const subject = new LineGroupWorkspacePolicyRegistry(
      policyConfig(),
      memoryStore<LineGroupPolicyBinding>(),
      memoryStore<LineGroupPairingGrant>(),
      Date.now,
      () => codes.shift()!,
    );
    await subject.handleBeforeDispatch(ownerEvent("สร้าง pairing KEEP_WATCHING"), lineContext());
    await subject.handleBeforeDispatch(ownerEvent("PAIR-CDEF4567"), lineContext());
    await subject.handleBeforeDispatch(ownerEvent("สร้าง pairing UGC"), lineContext());
    await subject.handleBeforeDispatch(ownerEvent("PAIR-DEFG5678"), lineContext());
    expect((await subject.lookup("primary", "C-group"))?.policyId).toBe("UGC");

    const denied = await subject.handleBeforeDispatch(
      { ...ownerEvent("unpair group"), senderIsOwner: false },
      lineContext(),
    );
    expect(denied).toEqual({ handled: true });
    expect(await subject.lookup("primary", "C-group")).not.toBeNull();

    await subject.handleBeforeDispatch(ownerEvent("unpair group"), lineContext());
    expect(await subject.lookup("primary", "C-group")).toBeNull();
  });

  it("restores a native LINE group policy after the registry is recreated", async () => {
    const bindings = memoryStore<LineGroupPolicyBinding>();
    const grants = memoryStore<LineGroupPairingGrant>();
    const first = new LineGroupWorkspacePolicyRegistry(
      policyConfig(),
      bindings,
      grants,
      Date.now,
      () => "PAIR-FGHJ7892",
    );
    await first.handleBeforeDispatch(ownerEvent("สร้าง pairing UGC"), lineContext());
    await first.handleBeforeDispatch(ownerEvent("PAIR-FGHJ7892"), lineContext());

    const afterRestart = new LineGroupWorkspacePolicyRegistry(policyConfig(), bindings, grants);
    expect(await afterRestart.lookup("primary", "C-group")).toMatchObject({
      groupId: "C-group",
      policyId: "UGC",
    });
  });

  it("silences ordinary KEEP_WATCHING group traffic but leaves unknown and UGC chat unclaimed", async () => {
    const subject = registry({ code: "PAIR-EFGH6789" });
    expect(
      await subject.handleBeforeDispatch(ownerEvent("ordinary text"), lineContext("C-unknown")),
    ).toBeUndefined();
    await subject.handleBeforeDispatch(ownerEvent("สร้าง pairing KEEP_WATCHING"), lineContext());
    await subject.handleBeforeDispatch(ownerEvent("PAIR-EFGH6789"), lineContext());
    expect(await subject.handleBeforeDispatch(ownerEvent("ordinary text"), lineContext())).toEqual({
      handled: true,
    });
  });
});

describe("UGC capability and frozen job scope boundaries", () => {
  it("enforces fixed capability permissions and prevents cross-policy access", () => {
    expect(UGC_CAPABILITY_PERMISSIONS.PRODUCT_LIBRARY).toBe("READ");
    expect(UGC_CAPABILITY_PERMISSIONS.UGC_PROJECTS).toBe("READ_WRITE");
    const binding: LineGroupPolicyBinding = {
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "UGC",
      boundByOwnerId: "U-owner",
      boundAt: new Date().toISOString(),
    };
    expect(
      resolveUgcCapability({
        config: policyConfig(),
        binding,
        capabilityId: "PRODUCT_LIBRARY",
        requiredAccess: "READ",
      }),
    ).toEqual(policyConfig().ugc!.capabilities.PRODUCT_LIBRARY);
    expect(() =>
      resolveUgcCapability({
        config: policyConfig(),
        binding,
        capabilityId: "PRODUCT_LIBRARY",
        requiredAccess: "READ_WRITE",
      }),
    ).toThrow("read-only");
    expect(() =>
      resolveUgcCapability({
        config: policyConfig(),
        binding: { ...binding, policyId: "KEEP_WATCHING" },
        capabilityId: "UGC_PROJECTS",
        requiredAccess: "READ",
      }),
    ).toThrow("access denied");
    expect(() =>
      resolveUgcCapability({
        config: policyConfig(),
        binding: null,
        capabilityId: "UGC_PROJECTS",
        requiredAccess: "READ",
      }),
    ).toThrow("access denied");
  });

  it("freezes policy-derived scope so model output cannot retarget a job", () => {
    const scope = freezeWorkspaceJobScope({
      lineGroupId: "C-group",
      policyId: "UGC",
      jobType: "UGC_WORKFLOW",
      sourceCapabilityIds: ["PRODUCT_LIBRARY"],
      targetDatabaseId: "a".repeat(32),
      targetDataSourceId: "b".repeat(32),
      r2Prefix: "ugc/jobs",
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.sourceCapabilityIds)).toBe(true);
    expect(() => {
      (scope as { targetDatabaseId: string }).targetDatabaseId = "attacker";
    }).toThrow();
    expect(scope.targetDatabaseId).toBe("a".repeat(32));
  });
});
