import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD } from "./video-cost-guard.js";
import {
  createLineVideoDraft,
  LINE_VIDEO_DRAFT_NAMESPACE,
  type LineVideoDraft,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import type { OpenRouterVideoModel } from "./video-model-catalog.js";
import { DEFAULT_LINE_VIDEO_MODEL } from "./video-model-preference.js";
import {
  LINE_STORYBOARD_VIDEO_MODEL_ID,
  prepareLineStoryboardVideoDraft,
  type LineStoryboardVideoDraftRequest,
} from "./video-storyboard-draft.js";

/**
 * LINE-owned paid-draft preparation for a storyboard.
 *
 * No test here reaches a real provider: the catalog is a fixture and nothing in
 * this module submits, so the paid call count is structurally zero.
 */

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";

/**
 * A Seedance-shaped catalog row.
 *
 * Priced per video second so the arithmetic in these tests is legible; the
 * production guard also handles token- and flat-priced shapes.
 */
function seedanceRow(overrides: Partial<OpenRouterVideoModel> = {}): OpenRouterVideoModel {
  return {
    id: DEFAULT_LINE_VIDEO_MODEL,
    name: "Seedance 2.5",
    supportedDurationSeconds: [4, 5, 10, 15, 20, 30],
    supportedAspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    supportedResolutions: ["480p", "720p"],
    supportedSizes: ["854x480", "480x854", "1280x720", "720x1280"],
    supportsFrameImages: true,
    supportsAudio: true,
    pricingSkus: { "per-video-second": "0.2312" },
    ...overrides,
  };
}

function memoryDraftStore(): LineVideoDraftStore {
  const values = new Map<string, LineVideoDraft>();
  return {
    async register(key, value) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
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
      return Array.from(values, ([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      values.clear();
    },
  } as LineVideoDraftStore;
}

/** The flagship storyboard request: 15s · 720p · 9:16 with two canonical characters. */
function request(
  overrides: Partial<LineStoryboardVideoDraftRequest> = {},
): LineStoryboardVideoDraftRequest {
  return {
    accountId: ACCOUNT,
    conversationId: GROUP,
    ownerSenderId: OWNER,
    prompt: "Setting: cafe\nBeats:\n0-7s | Medium-wide | CHAR-6 walks past CHAR-7",
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: true,
    storyboardId: "sb_1",
    storyboardVersionNumber: 2,
    characterLocks: [
      { code: "CHAR-6", pageId: "page-char-6" },
      { code: "CHAR-7", pageId: "page-char-7" },
    ],
    referenceAssets: [
      { kind: "identity", source: "r2", locator: "ugc/characters/Twong.png" },
      { kind: "identity", source: "r2", locator: "ugc/characters/Twong2.png" },
    ],
    ...overrides,
  };
}

function harness(
  options: {
    models?: OpenRouterVideoModel[];
    maxEstimatedCostUsd?: number;
    apiKey?: string | undefined;
    loadModels?: () => Promise<OpenRouterVideoModel[]>;
    randomDraftCode?: () => number;
  } = {},
) {
  const draftStore = memoryDraftStore();
  const loadModels = options.loadModels ?? (async () => options.models ?? [seedanceRow()]);
  const deps = {
    draftStore,
    resolveApiKey: async () => ("apiKey" in options ? options.apiKey : "sk-test-key"),
    cfg:
      options.maxEstimatedCostUsd === undefined
        ? {}
        : { videoGeneration: { maxEstimatedCostUsd: options.maxEstimatedCostUsd } },
    loadModels,
    ...(options.randomDraftCode ? { randomDraftCode: options.randomDraftCode } : {}),
  };
  return { draftStore, deps };
}

describe("A. สร้างวิดีโอ allocates a LINE-owned paid draft", () => {
  it("binds seedance 2.5 from the live catalog and quotes it, submitting nothing", async () => {
    const h = harness({ maxEstimatedCostUsd: 5 });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") {
      return;
    }
    expect(result.modelId).toBe("bytedance/seedance-2.5");
    expect(result.draftId).toMatch(/^\d{4}$/u);
    // 15s at $0.2312/s, the live catalog's own number -- not a constant here.
    expect(result.estimatedCostUsd).toBeCloseTo(3.468, 3);
    expect(result.maxAllowedUsd).toBe(5);
    expect(result.durationSeconds).toBe(15);
    expect(result.resolution).toBe("720p");
    expect(result.aspectRatio).toBe("9:16");
    expect(result.outputSize).toBe("720x1280");

    // The draft is pending in LINE's own store, scoped to this owner.
    const stored = await h.draftStore.lookup(result.draftId);
    expect(stored?.model).toBe("bytedance/seedance-2.5");
    expect(stored?.ownerSenderId).toBe(OWNER);
    expect(stored?.status).toBe("pending");
    expect(stored?.estimatedCostUsd).toBeCloseTo(3.468, 3);
  });

  it("binds the same slug the conversation preference defaults to", () => {
    // One model id, not two literals that can drift apart.
    expect(LINE_STORYBOARD_VIDEO_MODEL_ID).toBe(DEFAULT_LINE_VIDEO_MODEL);
    expect(LINE_STORYBOARD_VIDEO_MODEL_ID).toBe("bytedance/seedance-2.5");
  });

  it("scopes the draft to the LINE conversation key, not a rebuilt one", async () => {
    const h = harness({ maxEstimatedCostUsd: 5 });
    const created = await prepareLineStoryboardVideoDraft(
      request({ conversationId: `line:group:${GROUP}` }),
      h.deps,
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") {
      return;
    }
    // Same normalized key whether the caller passed the native or prefixed id.
    const stored = await h.draftStore.lookup(created.draftId);
    expect(stored?.conversationKey).toBe(`${ACCOUNT}|${GROUP}`);
  });
});

describe("B. the draft lives in LINE's own store", () => {
  it("uses the shipped LINE draft namespace and no second one", () => {
    // The storyboard plugin has no allocator at all; this is the only 4-digit
    // code space, and it is this plugin's.
    expect(LINE_VIDEO_DRAFT_NAMESPACE).toBe("video-draft-v1");
  });
});

describe("C. the allocator avoids an existing pending code", () => {
  it("never reuses a code the LINE flow already holds", async () => {
    const h = harness({ maxEstimatedCostUsd: 5, randomDraftCode: codes([4821, 4821, 4822]) });
    // An unrelated LINE paid draft already owns 4821.
    await createLineVideoDraft({
      store: h.draftStore,
      accountId: ACCOUNT,
      conversationKey: `${ACCOUNT}|other`,
      ownerSenderId: "U-someone-else",
      model: "bytedance/seedance-2.5",
      prompt: "an unrelated pending job",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "480p",
      audio: false,
      estimatedCostUsd: 0.5,
      randomDraftCode: () => 4821,
    });

    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") {
      return;
    }
    expect(result.draftId).toBe("4822");
    // The unrelated draft is untouched: still its own prompt and owner.
    const other = await h.draftStore.lookup("4821");
    expect(other?.ownerSenderId).toBe("U-someone-else");
    expect(other?.prompt).toBe("an unrelated pending job");
  });
});

/** Deterministic code sequence for allocator tests. */
function codes(sequence: readonly number[]): () => number {
  let index = 0;
  return () => sequence[Math.min(index++, sequence.length - 1)]!;
}

describe("G/H. the cost guard decides, and it fails closed", () => {
  it("refuses the flagship job under the global $2 default", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);

    expect(result).toMatchObject({ kind: "rejected", reason: "over_limit" });
    if (result.kind !== "rejected" || result.reason !== "over_limit") {
      return;
    }
    expect(result.maxAllowedUsd).toBe(DEFAULT_VIDEO_MAX_ESTIMATED_COST_USD);
    expect(result.maxAllowedUsd).toBe(2);
    expect(result.estimatedCostUsd).toBeGreaterThan(2);
    // Fail closed means no code was minted at all.
    expect(await h.draftStore.entries()).toEqual([]);
  });

  it("refuses a 30s job even under the $5 account override", async () => {
    const h = harness({ maxEstimatedCostUsd: 5 });
    const result = await prepareLineStoryboardVideoDraft(request({ durationSeconds: 30 }), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "over_limit" });
    expect(await h.draftStore.entries()).toEqual([]);
  });

  it("refuses a model whose price it cannot read, rather than assuming free", async () => {
    const h = harness({
      maxEstimatedCostUsd: 5,
      models: [seedanceRow({ pricingSkus: { "some-future-shape": "0.5" } })],
    });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "unknown_cost" });
    expect(await h.draftStore.entries()).toEqual([]);
  });
});

describe("P. provider capability comes from the live catalog", () => {
  it("fails closed when the catalog does not list the model", async () => {
    const h = harness({ maxEstimatedCostUsd: 5, models: [seedanceRow({ id: "other/model" })] });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toMatchObject({
      kind: "rejected",
      reason: "model_unavailable",
      model: "bytedance/seedance-2.5",
    });
    expect(await h.draftStore.entries()).toEqual([]);
  });

  it("fails closed on an unsupported duration, resolution or aspect", async () => {
    const cases: ReadonlyArray<readonly [Partial<OpenRouterVideoModel>, string]> = [
      [{ supportedDurationSeconds: [4, 5, 10] }, "unsupported_duration"],
      [{ supportedResolutions: ["480p"] }, "unsupported_resolution"],
      [{ supportedAspectRatios: ["16:9"] }, "unsupported_aspect_ratio"],
    ];
    for (const [override, reason] of cases) {
      const h = harness({ maxEstimatedCostUsd: 5, models: [seedanceRow(override)] });
      const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
      expect(result, reason).toMatchObject({ kind: "rejected", reason });
      expect(await h.draftStore.entries(), reason).toEqual([]);
    }
  });

  it("fails closed when the catalog cannot be read or auth is missing", async () => {
    const noAuth = harness({ apiKey: undefined });
    expect(await prepareLineStoryboardVideoDraft(request(), noAuth.deps)).toMatchObject({
      kind: "rejected",
      reason: "provider_auth_unavailable",
    });

    const broken = harness({
      maxEstimatedCostUsd: 5,
      loadModels: async () => {
        throw new Error("catalog down");
      },
    });
    expect(await prepareLineStoryboardVideoDraft(request(), broken.deps)).toMatchObject({
      kind: "rejected",
      reason: "catalog_unavailable",
    });
    expect(await broken.draftStore.entries()).toEqual([]);
  });

  it("fails closed on a conversation id it cannot scope", async () => {
    const h = harness({ maxEstimatedCostUsd: 5 });
    const result = await prepareLineStoryboardVideoDraft(
      request({ conversationId: "   " }),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "rejected", reason: "invalid_conversation" });
    expect(await h.draftStore.entries()).toEqual([]);
  });
});

describe("Q. audio is granted by the catalog, never by the request", () => {
  it("keeps audio when the catalog reports support", async () => {
    const h = harness({ maxEstimatedCostUsd: 5 });
    const result = await prepareLineStoryboardVideoDraft(request({ audio: true }), h.deps);
    expect(result).toMatchObject({ kind: "created", audio: true });
  });

  it("drops audio the catalog does not report, instead of inventing support", async () => {
    for (const override of [{ supportsAudio: false }, {}] as const) {
      const row = seedanceRow(override);
      if (!("supportsAudio" in override)) {
        delete (row as { supportsAudio?: boolean }).supportsAudio;
      }
      const h = harness({ maxEstimatedCostUsd: 5, models: [row] });
      const result = await prepareLineStoryboardVideoDraft(request({ audio: true }), h.deps);
      expect(result).toMatchObject({ kind: "created", audio: false });
      if (result.kind !== "created") {
        return;
      }
      const stored = await h.draftStore.lookup(result.draftId);
      expect(stored?.audio).toBe(false);
    }
  });
});

describe("no test in this file can spend money", () => {
  it("never performs a network call", async () => {
    const fetchSpy = vi.fn();
    const h = harness({ maxEstimatedCostUsd: 5 });
    await prepareLineStoryboardVideoDraft(request(), { ...h.deps, fetchImpl: fetchSpy as never });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
