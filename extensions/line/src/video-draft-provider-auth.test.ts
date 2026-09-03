import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
/**
 * Production regression: an owner's LINE video request reached
 * line_video_draft, but the draft failed and the owner saw a message about
 * failed authorization -- reading as if LINE owner permission had been
 * refused. Owner authorization had in fact succeeded; OpenRouter credential
 * resolution had not.
 *
 * These tests reproduce the production-equivalent owner tool context: the tool
 * is built exactly as extensions/line/index.ts builds it, with NO injected
 * resolveApiKey and NO ctx.resolveApiKeyForProvider, so the canonical
 * provider-auth path is the one actually under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Swappable canonical-resolver result; mirrors env/config/profile resolution. */
let providerAuthResult: { apiKey?: string } = { apiKey: "sk-openrouter-test" };
const resolveApiKeyForProviderMock = vi.fn(async (..._args: unknown[]) => providerAuthResult);
const logInfoMock = vi.fn();

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: (...args: unknown[]) => resolveApiKeyForProviderMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("openclaw/plugin-sdk/logging-core", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  logInfo: (...args: unknown[]) => logInfoMock(...args),
}));
vi.mock("./accounts.js", () => ({
  resolveLineAccount: () => ({
    accountId: "acct-1",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config" as const,
    config: {
      videoGeneration: {
        // Seedance 2.5 at 720p runs ~$0.46/second on fal's published token
        // price, so the default $2 ceiling would refuse an ordinary clip.
        maxEstimatedCostUsd: 10,
        falPricing: {
          models: { "bytedance/seedance-2.0/reference-to-video": { usdPerSecond: 0.1 } },
        },
      },
    },
  }),
}));

const { createLineVideoDraftTool } = await import("./video-draft-tool.js");
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock } from "./video-job-store.js";
import type { LineVideoModelPreferenceState } from "./video-model-preference.js";

/** The owner's real production request: "please make me a video of a cat sitting on water, 5s". */
const OWNER_REQUEST_PROMPT = "แมวนั่งอยู่บนน้ำ";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, T>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  };
}

const SEEDANCE_CATALOG = {
  data: [
    {
      id: "bytedance/seedance-2.5",
      name: "ByteDance: Seedance 2.5",
      supported_durations: [4, 6, 8],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_resolutions: ["720p", "1080p"],
      supported_frame_images: ["first_frame"],
      pricing_skus: { "per-video-second": "0.10" },
    },
  ],
};

/**
 * Builds the tool with exactly the argument set extensions/line/index.ts
 * passes for a real owner LINE turn. Note the absence of `resolveApiKey`:
 * production does not inject one, so the canonical resolver runs.
 */
function buildProductionOwnerTool(
  overrides: {
    accountId?: string | undefined;
    sessionId?: string | undefined;
    requesterSenderId?: string | undefined;
    catalogFails?: boolean;
    contextApiKeyResolverAvailable?: boolean;
    hasProviderAuth?: (providerId: string) => boolean;
  } = {},
) {
  const draftStore = createMemoryStore<LineVideoDraft>();
  const requestedUrls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    requestedUrls.push(String(url));
    if (overrides.catalogFails) {
      return new Response("upstream unavailable", { status: 503 });
    }
    return new Response(JSON.stringify(SEEDANCE_CATALOG), { status: 200 });
  }) as unknown as typeof fetch;

  const tool = createLineVideoDraftTool({
    messageChannel: "line",
    senderIsOwner: true,
    requesterSenderId:
      "requesterSenderId" in overrides ? overrides.requesterSenderId : "U-owner-real",
    sessionId: "sessionId" in overrides ? overrides.sessionId : "grp-real",
    accountId: "accountId" in overrides ? overrides.accountId : "acct-1",
    deliveryTo: "line:group:grp-real",
    cfg: {},
    draftStore,
    preferenceStore: createMemoryStore<LineVideoModelPreferenceState>(),
    activeJobLockStore: createMemoryStore<LineVideoActiveJobLock>(),
    ...(overrides.contextApiKeyResolverAvailable !== undefined
      ? { contextApiKeyResolverAvailable: overrides.contextApiKeyResolverAvailable }
      : {}),
    ...(overrides.hasProviderAuth ? { hasProviderAuth: overrides.hasProviderAuth } : {}),
    fetchImpl,
  });

  /** Any request to the paid submit endpoint (`/videos`, not `/videos/models`). */
  const paidVideoPosts = () =>
    requestedUrls.filter((url) => url.includes("/videos") && !url.includes("/videos/models"));

  return { tool, draftStore, requestedUrls, paidVideoPosts };
}

beforeEach(() => {
  providerAuthResult = { apiKey: "sk-openrouter-test" };
  resolveApiKeyForProviderMock.mockClear();
  logInfoMock.mockClear();
});

describe("LINE video draft: canonical OpenRouter credential resolution", () => {
  it("1: the production owner context resolves credentials and creates a draft", async () => {
    const { tool, draftStore, paidVideoPosts } = buildProductionOwnerTool();
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-1", {
      prompt: OWNER_REQUEST_PROMPT,
      durationSeconds: 5,
    });
    const details = (result as { details?: { resolution?: string } }).details;
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect(details?.resolution).toBe("draft_created");
    expect(text).toContain("🎬 Video draft");
    expect(text).toContain("Seedance 2.5 Reference-to-Video");
    expect(text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect((await draftStore.entries()).length).toBe(1);
    expect(paidVideoPosts()).toStrictEqual([]);
  });

  it("2: credentials are resolved for openrouter through the canonical resolver", async () => {
    const { tool } = buildProductionOwnerTool();
    await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalled();
    expect(resolveApiKeyForProviderMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
    });
  });

  // The regression itself: production supplies no ctx.resolveApiKeyForProvider
  // (it is omitted whenever no authProfileStore is present, and resolves only
  // saved auth profiles even when it is). The draft must still succeed.
  it("3: succeeds even though the context API-key resolver is absent", async () => {
    const { tool } = buildProductionOwnerTool({
      contextApiKeyResolverAvailable: false,
      hasProviderAuth: () => false,
    });

    const result = await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
  });
});

describe("LINE video draft: deterministic failure messaging", () => {
  it("4: missing provider credentials give provider_auth_unavailable naming fal", async () => {
    providerAuthResult = {};
    const { tool, draftStore } = buildProductionOwnerTool();

    const result = await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    const details = (result as { details?: Record<string, unknown> }).details;
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect(details?.resolution).toBe("provider_auth_unavailable");
    // Naming the provider is what stops the model reading this as a LINE
    // owner-permission failure.
    expect(details?.provider).toBe("openrouter");
    expect(text).toContain("❌ ยังสร้าง Video Draft ไม่ได้");
    expect(text).toContain("fal.ai");
    expect((await draftStore.entries()).length).toBe(0);
  });

  it("5: the failure text never claims an authorization/permission problem", async () => {
    providerAuthResult = {};
    const { tool } = buildProductionOwnerTool();
    const result = await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    // The exact production wording that misled the owner.
    expect(text).not.toContain("ยืนยันสิทธิ์");
    expect(text).not.toContain("สิทธิ์");
  });

  it("6: missing runtime context gives the deterministic context failure", async () => {
    const { tool } = buildProductionOwnerTool({ accountId: undefined });

    const result = await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";

    expect((result as { details?: { resolution?: string } }).details?.resolution).toBe(
      "context_unavailable",
    );
    expect(text).toContain("LINE runtime context ไม่ครบ");
  });

  it("8: logs one attempt record and exactly one resolution", async () => {
    const { tool } = buildProductionOwnerTool({
      contextApiKeyResolverAvailable: false,
      hasProviderAuth: () => false,
    });
    await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });

    const lines = logInfoMock.mock.calls.map((call) => String(call[0]));
    const attempts = lines.filter((line) => line.includes("event=video_draft_attempt"));
    const results = lines.filter((line) => line.includes("event=video_draft_result"));

    expect(attempts.length).toBe(1);
    expect(results.length).toBe(1);
    expect(attempts[0]).toContain("channel=line");
    expect(attempts[0]).toContain("senderIsOwner=true");
    expect(attempts[0]).toContain("deliveryTo=true");
    expect(attempts[0]).toContain("contextApiKeyResolver=false");
    expect(attempts[0]).toContain("hasAuthForProvider=false");
    expect(results[0]).toContain("resolution=draft_created");
  });

  it("9: diagnostics hash identifiers and never emit secrets or raw ids", async () => {
    const { tool } = buildProductionOwnerTool();
    await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });

    const joined = logInfoMock.mock.calls.map((call) => String(call[0])).join("\n");

    expect(joined).not.toContain("sk-openrouter-test");
    expect(joined).not.toContain("U-owner-real");
    expect(joined).not.toContain("grp-real");
    expect(joined).not.toContain("token");
    // Correlation is still possible via stable hashes.
    expect(joined).toMatch(/accountId=sha256:[0-9a-f]{12}/u);
    expect(joined).toMatch(/requesterSenderId=sha256:[0-9a-f]{12}/u);
  });

  it("10: a provider-auth failure is logged as exactly that resolution", async () => {
    providerAuthResult = {};
    const { tool } = buildProductionOwnerTool();
    await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });

    const results = logInfoMock.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("event=video_draft_result"));

    expect(results.length).toBe(1);
    expect(results[0]).toContain("resolution=provider_auth_unavailable");
  });
});

describe("LINE video draft: root-cause pin", () => {
  /**
   * The exact wiring extensions/line/index.ts used before this fix. In
   * production ctx.resolveApiKeyForProvider is either absent (no
   * authProfileStore) or resolves only saved auth profiles, so on a deployment
   * whose OpenRouter credentials live in env/config this yielded undefined and
   * the draft failed as an auth error -- while the same credentials resolved
   * fine for the switch routers. Kept as a test-local reproduction so the
   * broken shape cannot quietly return to production code.
   */
  it("13: the previous ctx-based wiring fails where the canonical path succeeds", async () => {
    const contextWithoutAuthProfileStore: {
      resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
    } = {};
    const oldWiring = () =>
      contextWithoutAuthProfileStore.resolveApiKeyForProvider?.("openrouter") ??
      Promise.resolve(undefined);

    await expect(oldWiring()).resolves.toBeUndefined();

    const brokenTool = createLineVideoDraftTool({
      messageChannel: "line",
      senderIsOwner: true,
      requesterSenderId: "U-owner-real",
      sessionId: "grp-real",
      accountId: "acct-1",
      deliveryTo: "line:group:grp-real",
      cfg: {},
      draftStore: createMemoryStore<LineVideoDraft>(),
      preferenceStore: createMemoryStore<LineVideoModelPreferenceState>(),
      activeJobLockStore: createMemoryStore<LineVideoActiveJobLock>(),
      resolveApiKey: oldWiring,
    });
    const brokenResult = await brokenTool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    expect((brokenResult as { details?: { resolution?: string } }).details?.resolution).toBe(
      "provider_auth_unavailable",
    );

    // Same credentials, canonical resolution: succeeds.
    const { tool } = buildProductionOwnerTool();
    const fixedResult = await tool!.execute("call-1", { prompt: OWNER_REQUEST_PROMPT });
    expect((fixedResult as { details?: { resolution?: string } }).details?.resolution).toBe(
      "draft_created",
    );
  });

  it("14: index.ts no longer injects a ctx-based resolveApiKey for the draft tool", async () => {
    const fs = await import("node:fs");
    const indexSource = fs.readFileSync(new URL("../index.ts", import.meta.url).pathname, "utf-8");
    const registration = indexSource.slice(
      indexSource.indexOf("createLineVideoDraftTool({"),
      indexSource.indexOf("names: [LINE_VIDEO_DRAFT_TOOL_NAME]"),
    );

    expect(registration).not.toContain("resolveApiKey:");
    // Context auth fields may still be read, but only as diagnostics.
    expect(registration).toContain("contextApiKeyResolverAvailable");
  });
});

describe("LINE video draft: owner authorization is unchanged", () => {
  it("11: a non-owner never gets the tool, even with valid credentials", () => {
    expect(createLineVideoDraftTool({ messageChannel: "line", senderIsOwner: false })).toBeNull();
  });

  it("12: a non-LINE channel never gets the tool", () => {
    expect(
      createLineVideoDraftTool({ messageChannel: "telegram", senderIsOwner: true }),
    ).toBeNull();
  });
});
