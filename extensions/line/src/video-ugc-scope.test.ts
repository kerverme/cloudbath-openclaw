import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCloudbathLineVideoWorkspaceRuntime,
  installCloudbathLineVideoWorkspaceRuntime,
} from "../../cloudbath-line-image-archive/src/line-video-workspace-runtime.js";
import { ugcDraftScopeKey } from "../../cloudbath-line-image-archive/src/ugc-workflow.js";
import {
  materializeLineVideoUgcReferences,
  orderLineVideoUgcReferences,
  resolveCloudbathUgcCapabilities,
  validateLineVideoUgcScope,
  type LineGroupPolicyBinding,
  type LineVideoUgcScope,
} from "./video-ugc-scope.js";
import { tryGetLineVideoWorkspaceRuntime } from "./video-workspace-runtime.js";

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

const runtimeOwner = Symbol("line-video-workspace-test-owner");

const SCOPE: LineVideoUgcScope = {
  version: 1,
  policyId: "UGC",
  accountId: "primary",
  lineGroupId: "C-ugc",
  ownerSenderId: "U-owner",
  productPageId: "product-page",
  characterPageId: "character-page",
  characterLocks: [
    {
      code: "F1",
      pageId: "character-page",
      identityReferences: [
        { kind: "identity", source: "r2", locator: "workspace/ugc/identity.png" },
      ],
      styleReferences: [],
      frozenAt: "2026-08-23T00:00:00.000Z",
    },
  ],
  projectInstanceId: "project-instance",
  projectPageId: "project-page",
  projectRecordId: "project-record",
  scene: {
    sceneNumber: 1,
    characterPageIds: ["character-page"],
    characterCodes: ["F1"],
    prompt: "review the product",
  },
  scenePageId: "shot-1",
  shotPageIds: ["shot-1"],
  referenceAssets: [
    { kind: "style", source: "https", locator: "https://assets.example/style.png" },
    { kind: "identity", source: "r2", locator: "workspace/ugc/identity.png" },
  ],
  frozenPrompt: "review the product",
  capabilities: TARGETS,
  r2Prefix: "outbound/line-video",
  createdAt: "2026-08-23T00:00:00.000Z",
};

function memoryStore<T>(entries: Map<string, T>) {
  return {
    async register(key: string, value: T) {
      entries.set(key, value);
    },
    async registerIfAbsent(key: string, value: T) {
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, value);
      return true;
    },
    async lookup(key: string) {
      return entries.get(key);
    },
    async consume(key: string) {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      entries.clear();
    },
  };
}

afterEach(() => {
  clearCloudbathLineVideoWorkspaceRuntime(runtimeOwner);
});

describe("LINE Cloudbath UGC scope", () => {
  it("resolves all six configured capabilities and rejects frozen target retargeting", async () => {
    expect(resolveCloudbathUgcCapabilities(CONFIG)).toEqual(TARGETS);
    const binding: LineGroupPolicyBinding = {
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "UGC",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-23T00:00:00.000Z",
    };
    expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        binding,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).toBe(true);
    expect(
      validateLineVideoUgcScope({
        scope: {
          ...SCOPE,
          capabilities: {
            ...TARGETS,
            AI_VIDEO_LIBRARY: { databaseId: "9".repeat(32), dataSourceId: "8".repeat(32) },
          },
        },
        cfg: CONFIG,
        binding,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).toBe(false);
  });

  it("fails cross-policy and transferred-owner validation closed", async () => {
    const keepWatching: LineGroupPolicyBinding = {
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "KEEP_WATCHING",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-23T00:00:00.000Z",
    };
    expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        binding: keepWatching,
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-owner",
        frozenPrompt: "review the product",
      }),
    ).toBe(false);
    expect(
      validateLineVideoUgcScope({
        scope: SCOPE,
        cfg: CONFIG,
        binding: {
          accountId: "primary",
          groupId: "C-ugc",
          policyId: "UGC",
          boundByOwnerId: "U-owner",
          boundAt: "2026-08-23T00:00:00.000Z",
        },
        accountId: "primary",
        groupId: "C-ugc",
        ownerSenderId: "U-other",
        frozenPrompt: "review the product",
      }),
    ).toBe(false);
  });

  it("shares only Cloudbath-owned bindings and frozen scopes through the runtime bridge", async () => {
    const binding: LineGroupPolicyBinding = {
      accountId: "primary",
      groupId: "C-ugc",
      policyId: "UGC",
      boundByOwnerId: "U-owner",
      boundAt: "2026-08-23T00:00:00.000Z",
    };
    const bindingEntries = new Map([["binding-key", binding]]);
    const scopeEntries = new Map([[ugcDraftScopeKey("draft-1"), SCOPE]]);
    installCloudbathLineVideoWorkspaceRuntime(runtimeOwner, {
      lookupBinding: async () => bindingEntries.get("binding-key"),
      ugcScopeStore: memoryStore(scopeEntries),
    });

    const runtime = tryGetLineVideoWorkspaceRuntime();
    await expect(runtime?.lookupBinding("primary", "C-ugc")).resolves.toEqual(binding);
    await expect(runtime?.lookupUgcDraftScope("draft-1")).resolves.toEqual(SCOPE);
    await expect(runtime?.consumeUgcDraftScope("draft-1")).resolves.toEqual(SCOPE);
    await expect(runtime?.lookupUgcDraftScope("draft-1")).resolves.toBeUndefined();
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
    expect(assets[0]).toMatchObject({ role: "reference_image", mimeType: "image/png" });
  });

  it.each([
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
    [
      "WebP",
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      "image/webp",
    ],
  ])("preserves %s MIME metadata on identity references", async (_label, bytes, mimeType) => {
    const assets = await materializeLineVideoUgcReferences(SCOPE, {
      env: {
        R2_ACCOUNT_ID: "account",
        R2_ACCESS_KEY_ID: "test-access",
        R2_SECRET_ACCESS_KEY: "test-secret",
        R2_BUCKET_NAME: "existing-bucket",
      },
      s3Client: {
        send: vi.fn(async () => ({
          ContentLength: bytes.byteLength,
          Body: { transformToByteArray: async () => bytes },
        })),
      },
      guardedFetch: vi.fn(async () => ({
        response: new Response(bytes, { status: 200 }),
        release: vi.fn(async () => {}),
      })) as never,
    });

    expect(assets[0]).toMatchObject({ role: "reference_image", mimeType });
  });

  it("preserves the frozen Character reference order", () => {
    const twong = {
      kind: "identity" as const,
      source: "r2" as const,
      locator: "characters/CHAR-6/twong.png",
    };
    const manju = {
      kind: "identity" as const,
      source: "r2" as const,
      locator: "characters/CHAR-8/manju.png",
    };
    const scope: LineVideoUgcScope = {
      ...SCOPE,
      characterLocks: [
        {
          ...SCOPE.characterLocks[0]!,
          code: "CHAR-6",
          pageId: "twong",
          identityReferences: [twong],
        },
        {
          ...SCOPE.characterLocks[0]!,
          code: "CHAR-8",
          pageId: "manju",
          identityReferences: [manju],
        },
      ],
      referenceAssets: [manju, twong],
    };

    expect(orderLineVideoUgcReferences(scope)).toEqual([twong, manju]);
  });
});
