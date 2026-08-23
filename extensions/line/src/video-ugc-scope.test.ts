import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  lineGroupPolicyBindingKey,
  materializeLineVideoUgcReferences,
  resolveCloudbathUgcCapabilities,
  validateLineVideoUgcScope,
  type LineGroupPolicyBinding,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";

const TARGETS = {
  PRODUCT_LIBRARY: { databaseId: "1".repeat(32), dataSourceId: "a".repeat(32) },
  CHARACTER_LIBRARY: { databaseId: "2".repeat(32), dataSourceId: "b".repeat(32) },
  UGC_PROJECTS: { databaseId: "3".repeat(32), dataSourceId: "c".repeat(32) },
  UGC_SHOTS: { databaseId: "4".repeat(32), dataSourceId: "d".repeat(32) },
  AI_VIDEO_LIBRARY: { databaseId: "5".repeat(32), dataSourceId: "e".repeat(32) },
  AI_IMAGE_LIBRARY: { databaseId: "6".repeat(32), dataSourceId: "f".repeat(32) },
} as const;

const CONFIG = {
  plugins: {
    entries: {
      "cloudbath-line-image-archive": {
        config: { groupWorkspacePolicies: { ugc: { capabilities: TARGETS } } },
      },
    },
  },
};

const SCOPE: LineVideoUgcScope = {
  version: 1,
  policyId: "UGC",
  accountId: "primary",
  lineGroupId: "C-ugc",
  ownerSenderId: "U-owner",
  productPageId: "product-page",
  characterPageId: "character-page",
  projectPageId: "project-page",
  shotPageIds: ["shot-1", "shot-2"],
  referenceAssets: [
    { kind: "style", source: "https", locator: "https://assets.example/style.png" },
    { kind: "identity", source: "r2", locator: "workspace/ugc/identity.png" },
  ],
  frozenPrompt: "review the product",
  capabilities: TARGETS,
  r2Prefix: "outbound/line-video",
  createdAt: "2026-08-23T00:00:00.000Z",
};

function bindingStore(
  binding: LineGroupPolicyBinding,
): PluginStateKeyedStore<LineGroupPolicyBinding> {
  const key = lineGroupPolicyBindingKey(binding.accountId, binding.groupId);
  return {
    async register() {},
    async registerIfAbsent() {
      return false;
    },
    async lookup(wanted) {
      return wanted === key ? binding : undefined;
    },
    async consume() {
      return undefined;
    },
    async delete() {
      return false;
    },
    async entries() {
      return [];
    },
    async clear() {},
  };
}

describe("LINE Cloudbath UGC scope", () => {
  it("resolves all six configured capabilities and rejects frozen target retargeting", async () => {
    expect(resolveCloudbathUgcCapabilities(CONFIG)).toEqual(TARGETS);
    const store = bindingStore({
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "UGC",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-23T00:00:00.000Z",
    });
    await expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        bindingStore: store,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).resolves.toBe(true);
    await expect(
      validateLineVideoUgcScope({
        scope: {
          ...SCOPE,
          capabilities: {
            ...TARGETS,
            AI_VIDEO_LIBRARY: { databaseId: "9".repeat(32), dataSourceId: "8".repeat(32) },
          },
        },
        cfg: CONFIG,
        bindingStore: store,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).resolves.toBe(false);
  });

  it("fails cross-policy and transferred-owner validation closed", async () => {
    const keepWatching = bindingStore({
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "KEEP_WATCHING",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-23T00:00:00.000Z",
    });
    await expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        bindingStore: keepWatching,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).resolves.toBe(false);
    await expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        bindingStore: bindingStore({
          accountId: "primary",
          groupId: "C-ugc",
          policyId: "UGC",
          boundByOwnerId: "U-owner",
          boundAt: "2026-08-23T00:00:00.000Z",
        }),
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-other",
        frozenPrompt: "review the product",
      }),
    ).resolves.toBe(false);
  });

  it("materializes identity references before style references without a paid provider call", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const callOrder: string[] = [];
    const s3Client = {
      send: vi.fn(async () => {
        callOrder.push("identity");
        return {
          ContentLength: png.byteLength,
          Body: { transformToByteArray: async () => png },
        };
      }),
    };
    const guardedFetch = vi.fn(async () => {
      callOrder.push("style");
      return {
        response: new Response(png, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
        }),
        release: vi.fn(async () => {}),
      };
    });
    const assets = await materializeLineVideoUgcReferences(SCOPE, {
      env: {
        R2_ACCOUNT_ID: "account",
        R2_ACCESS_KEY_ID: "test-access",
        R2_SECRET_ACCESS_KEY: "test-secret",
        R2_BUCKET_NAME: "existing-bucket",
      },
      s3Client,
      guardedFetch: guardedFetch as never,
    });
    expect(assets).toHaveLength(2);
    expect(callOrder).toEqual(["identity", "style"]);
  });
});
