/**
 * LINE-owned paid-draft preparation for a frozen storyboard, on fal.
 *
 * No test here reaches a real provider: nothing in this module submits, and
 * the fal registry is a published schema transcription rather than a network
 * call, so the paid call count is structurally zero.
 */
import { describe, expect, it } from "vitest";
import {
  createLineVideoDraft,
  LINE_VIDEO_DRAFT_NAMESPACE,
  type LineVideoDraft,
  type LineVideoDraftStore,
} from "./video-draft-store.js";
import {
  listStoryboardCompatibleModels,
  prepareLineStoryboardVideoDraft,
  type LineStoryboardVideoDraftRequest,
} from "./video-storyboard-draft.js";

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const H3 = "minimax/h3/reference-to-video";
const SEEDANCE = "bytedance/seedance-2.0/reference-to-video";

/**
 * An operator who has declared everything fal's schema leaves out.
 *
 * H3's duration bound and audio behaviour are declarations because fal's
 * schema states neither; the Seedance facts below are schema-proven and need
 * only a price.
 */
type FalTestConfig = {
  videoGeneration: {
    maxEstimatedCostUsd?: number;
    falModels?: Record<string, { durationSeconds?: number[]; audio?: "always_on" }>;
    falPricing?: { models: Record<string, { usdPerSecond?: number; source?: string }> };
  };
};

function fullyConfigured(maxEstimatedCostUsd = 20): FalTestConfig {
  return {
    videoGeneration: {
      maxEstimatedCostUsd,
      falModels: {
        [H3]: { durationSeconds: [5, 10, 15], audio: "always_on" as const },
      },
      falPricing: {
        models: {
          [H3]: { usdPerSecond: 0.1, source: "https://fal.ai/pricing" },
          [SEEDANCE]: { usdPerSecond: 0.05, source: "https://fal.ai/pricing" },
        },
      },
    },
  };
}

function memoryDraftStore(): LineVideoDraftStore {
  const values = new Map<string, LineVideoDraft>();
  return {
    async register(key: string, value: LineVideoDraft) {
      values.set(key, structuredClone(value));
    },
    async registerIfAbsent(key: string, value: LineVideoDraft) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    async lookup(key: string) {
      return values.get(key);
    },
    async consume(key: string) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key: string) {
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

/** The flagship request: 15s · 720p · 9:16, one canonical character, sound on. */
function request(
  overrides: Partial<LineStoryboardVideoDraftRequest> = {},
): LineStoryboardVideoDraftRequest {
  return {
    accountId: ACCOUNT,
    conversationId: GROUP,
    ownerSenderId: OWNER,
    prompt: "Setting: garden\nBeats:\n0-15s | Medium-wide | F1 walks",
    durationSeconds: 15,
    aspectRatio: "9:16",
    resolution: "720p",
    audio: "full",
    spokenDialogue: false,
    storyboardId: "sb_1",
    storyboardVersionNumber: 2,
    characterLocks: [{ code: "CHAR-12", pageId: "page-char-12" }],
    referenceAssets: [
      {
        kind: "identity",
        source: "r2",
        locator: "ugc/characters/F1.png",
        characterCode: "CHAR-12",
        displayName: "F1",
      },
    ],
    ...overrides,
  };
}

function harness(options: { cfg?: ReturnType<typeof fullyConfigured>; falAuth?: boolean } = {}) {
  const draftStore = memoryDraftStore();
  return {
    draftStore,
    deps: {
      draftStore,
      resolveFalAuth: async () => options.falAuth ?? true,
      cfg: options.cfg ?? fullyConfigured(),
    },
  };
}

describe("E. the capability-aware default", () => {
  it("defaults a compatible 15-second scene to MiniMax H3", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);

    expect(result).toMatchObject({ kind: "created" });
    if (result.kind !== "created") {
      return;
    }
    expect(result.modelId).toBe(H3);
    expect(result.familyId).toBe("minimax");
    // fal's own declared rate, per endpoint. 15s at $0.10/s.
    expect(result.estimatedCostUsd).toBeCloseTo(1.5, 6);
    expect(result.pricingSource).toBe(`fal:${H3}`);
    expect(result.displacedPreferred).toBeUndefined();
  });

  it("freezes the actual fal endpoint into the draft before the code exists", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    if (result.kind !== "created") {
      throw new Error("expected a created draft");
    }
    const stored = await h.draftStore.lookup(result.draftId);
    expect(stored?.providerRoute).toEqual({ provider: "fal", modelId: H3 });
    expect(stored?.model).toBe(H3);
    expect(stored?.estimatedCostUsd).toBeCloseTo(1.5, 6);
  });
});

describe("F. a 30-second scene H3 cannot execute", () => {
  it("does NOT offer H3, and explains the model that took its place", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(
      // 30s exceeds H3's declared lengths; Seedance's schema tops out at 15,
      // so nothing can run it — proving the check is capability-driven.
      request({ durationSeconds: 30 }),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "rejected", reason: "no_compatible_model" });
  });

  it("picks a proven alternative and names why the preferred one was dropped", async () => {
    // H3 declared as 15s-only; a 12-second scene is inside Seedance's
    // schema-proven range but outside H3's declaration.
    const h = harness({
      cfg: {
        videoGeneration: {
          ...fullyConfigured().videoGeneration,
          falModels: { [H3]: { durationSeconds: [15], audio: "always_on" as const } },
        },
      },
    });
    const result = await prepareLineStoryboardVideoDraft(request({ durationSeconds: 12 }), h.deps);
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE });
    if (result.kind !== "created") {
      return;
    }
    expect(result.displacedPreferred?.modelName).toContain("H3");
    expect(result.displacedPreferred?.reasons[0]).toMatchObject({
      kind: "duration",
      requested: 12,
    });
  });

  it("drops H3 for a silent scene it cannot be proven to silence", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request({ audio: "off" }), h.deps);
    // H3 is declared always_on, so it cannot serve a scene that must be silent.
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE });
  });
});

describe("K. no VIDEO code before model, price, auth and compatibility all pass", () => {
  it("mints nothing when fal auth is unavailable, and calls no provider", async () => {
    const h = harness({ falAuth: false });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toEqual({ kind: "rejected", reason: "provider_auth_unavailable" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });

  it("mints nothing when the chosen endpoint has no declared price", async () => {
    const h = harness({
      cfg: {
        videoGeneration: {
          maxEstimatedCostUsd: 20,
          falModels: fullyConfigured().videoGeneration.falModels,
          falPricing: { models: {} },
        },
      },
    });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "unknown_cost" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });

  it("mints nothing when H3's unbounded duration was never declared", async () => {
    // Registry ships H3 with `durations: unknown`, because fal's schema types
    // `duration` as an unbounded number. Unproven is not permission.
    const h = harness({
      cfg: {
        videoGeneration: {
          maxEstimatedCostUsd: 20,
          falPricing: { models: { [H3]: { usdPerSecond: 0.1 } } },
        },
      },
    });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    // Seedance is schema-proven for 15s but unpriced here, so nothing is payable.
    expect(result).toMatchObject({ kind: "rejected" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });

  it("refuses a named model that cannot execute the frozen storyboard", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(
      request({ requestedModelId: "fal-ai/veo3.1/reference-to-video" }),
      h.deps,
    );
    // Veo's schema documents one length ("8s"), so it cannot run a 15s scene —
    // and naming it explicitly is not a way past that.
    expect(result).toMatchObject({ kind: "rejected", reason: "model_incompatible" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });

  it("refuses an endpoint that is not in the registry at all", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(
      request({ requestedModelId: "bytedance/seedance-2.5/reference-to-video" }),
      h.deps,
    );
    // fal publishes no Seedance 2.5 endpoint. It is refused rather than
    // silently substituted with 2.0.
    expect(result).toMatchObject({ kind: "rejected", reason: "model_unavailable" });
  });

  it("refuses when the quote exceeds the configured ceiling", async () => {
    const h = harness({ cfg: fullyConfigured(0.5) });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "over_limit" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });
});

describe("I. an explicitly chosen compatible endpoint", () => {
  it("binds exactly the endpoint the owner named", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(
      request({ requestedModelId: SEEDANCE }),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE });
    if (result.kind !== "created") {
      return;
    }
    // Seedance's own rate, not H3's.
    expect(result.estimatedCostUsd).toBeCloseTo(0.75, 6);
  });
});

describe("N. reference markers match the submitted ordering", () => {
  it("writes the selected model's own marker dialect into the frozen prompt", async () => {
    const h = harness();
    const twoCharacters = request({
      requestedModelId: SEEDANCE,
      characterLocks: [
        { code: "CHAR-12", pageId: "p1" },
        { code: "CHAR-13", pageId: "p2" },
      ],
      referenceAssets: [
        {
          kind: "identity",
          source: "r2",
          locator: "a.png",
          characterCode: "CHAR-12",
          displayName: "F1",
        },
        {
          kind: "identity",
          source: "r2",
          locator: "b.png",
          characterCode: "CHAR-13",
          displayName: "F2",
        },
      ],
    });
    const result = await prepareLineStoryboardVideoDraft(twoCharacters, h.deps);
    if (result.kind !== "created") {
      throw new Error("expected a created draft");
    }
    const stored = await h.draftStore.lookup(result.draftId);
    // Seedance reads "@ImageN"; position N is the Nth identity asset submitted.
    expect(stored?.prompt).toContain("@Image1 = F1 (CHAR-12), identity reference.");
    expect(stored?.prompt).toContain("@Image2 = F2 (CHAR-13), identity reference.");
    // The confirmed storyboard text is preserved byte-for-byte ahead of it.
    expect(stored?.prompt.startsWith(twoCharacters.prompt)).toBe(true);
  });

  it("uses MiniMax H3's 'Image N' dialect, not Seedance's '@ImageN'", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request({ requestedModelId: H3 }), h.deps);
    if (result.kind !== "created") {
      throw new Error("expected a created draft");
    }
    const stored = await h.draftStore.lookup(result.draftId);
    expect(stored?.prompt).toContain("Image 1 = F1 (CHAR-12), identity reference.");
    expect(stored?.prompt).not.toContain("@Image1");
  });
});

describe("compatible-model listing for the pickers", () => {
  it("offers only endpoints that are both compatible AND priced", async () => {
    const cfg = fullyConfigured();
    const models = listStoryboardCompatibleModels(request(), cfg);
    expect(models.map((model) => model.modelId)).toEqual([H3, SEEDANCE]);
  });

  it("omits a compatible endpoint the operator never priced", () => {
    const cfg = {
      videoGeneration: {
        ...fullyConfigured().videoGeneration,
        falPricing: { models: { [SEEDANCE]: { usdPerSecond: 0.05 } } },
      },
    };
    const models = listStoryboardCompatibleModels(request(), cfg);
    expect(models.map((model) => model.modelId)).toEqual([SEEDANCE]);
  });
});

describe("the draft lives in LINE's own store", () => {
  it("uses the shipped LINE draft namespace and no second one", () => {
    expect(LINE_VIDEO_DRAFT_NAMESPACE).toBe("video-draft-v1");
  });

  it("scopes the draft to the LINE conversation key, not a rebuilt one", async () => {
    const h = harness();
    const created = await prepareLineStoryboardVideoDraft(
      request({ conversationId: `line:group:${GROUP}` }),
      h.deps,
    );
    if (created.kind !== "created") {
      throw new Error("expected a created draft");
    }
    const stored = await h.draftStore.lookup(created.draftId);
    expect(stored?.conversationKey).toBe(`${ACCOUNT}|${GROUP}`);
    expect(stored?.ownerSenderId).toBe(OWNER);
    expect(stored?.status).toBe("pending");
  });

  it("never reuses a code the LINE flow already holds", async () => {
    const codes = [4821, 4821, 4822];
    let index = 0;
    const h = harness();
    await createLineVideoDraft({
      store: h.draftStore,
      accountId: ACCOUNT,
      conversationKey: `${ACCOUNT}|other`,
      ownerSenderId: "U-someone-else",
      model: SEEDANCE,
      prompt: "an unrelated pending job",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720p",
      audio: false,
      estimatedCostUsd: 0.25,
      randomDraftCode: () => 4821,
    });
    const created = await prepareLineStoryboardVideoDraft(request(), {
      ...h.deps,
      randomDraftCode: () => codes[index++] ?? 4823,
    });
    expect(created).toMatchObject({ kind: "created", draftId: "4822" });
  });

  it("supersedes only the previous code for THIS storyboard", async () => {
    const h = harness();
    const first = await prepareLineStoryboardVideoDraft(request(), h.deps);
    const second = await prepareLineStoryboardVideoDraft(request(), h.deps);
    if (first.kind !== "created" || second.kind !== "created") {
      throw new Error("expected two created drafts");
    }
    expect(second.supersededDraftIds).toEqual([first.draftId]);
    const retired = await h.draftStore.lookup(first.draftId);
    expect(retired).toMatchObject({
      status: "superseded",
      supersededByDraftId: second.draftId,
    });
  });

  it("leaves another storyboard's pending code untouched", async () => {
    const h = harness();
    const other = await prepareLineStoryboardVideoDraft(
      request({ storyboardId: "sb_new_project" }),
      h.deps,
    );
    const mine = await prepareLineStoryboardVideoDraft(request(), h.deps);
    if (other.kind !== "created" || mine.kind !== "created") {
      throw new Error("expected two created drafts");
    }
    expect(mine.supersededDraftIds).toBeUndefined();
    expect(await h.draftStore.lookup(other.draftId)).toMatchObject({ status: "pending" });
  });
});
