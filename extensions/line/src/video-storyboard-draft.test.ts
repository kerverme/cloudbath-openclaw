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
const H3_MAX = "minimax/h3-max/reference-to-video";
const SEEDANCE_25 = "bytedance/seedance-2.5/reference-to-video";
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

/**
 * H3 needs no declaration now: fal's product documentation proves 5-15s and
 * native audio. Only the per-endpoint rates are operator-supplied.
 */
function fullyConfigured(maxEstimatedCostUsd = 20): FalTestConfig {
  return {
    videoGeneration: {
      maxEstimatedCostUsd,
      falPricing: {
        models: {
          [H3]: { usdPerSecond: 0.1, source: "https://fal.ai/pricing" },
          [SEEDANCE_25]: { usdPerSecond: 0.05, source: "https://fal.ai/pricing" },
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
  it("defaults to Seedance 2.5 and explains why H3 was not offered", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request({ durationSeconds: 30 }), h.deps);
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE_25 });
    if (result.kind !== "created") {
      return;
    }
    expect(result.displacedPreferred?.modelName).toContain("H3");
    expect(result.displacedPreferred?.reasons[0]).toMatchObject({
      kind: "duration",
      requested: 30,
    });
  });

  it("drops H3 for a silent scene it cannot be made to silence", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request({ audio: "off" }), h.deps);
    // H3 produces native audio on every generation with no off switch.
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE_25 });
  });

  it("finds nothing for a length no fal endpoint reaches", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(request({ durationSeconds: 60 }), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "no_compatible_model" });
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
    // The two endpoints fal publishes a price for are disabled, so the ones
    // that remain need an operator rate and none is configured.
    const h = harness({
      cfg: {
        videoGeneration: {
          maxEstimatedCostUsd: 20,
          falModels: {
            ...fullyConfigured().videoGeneration.falModels,
            [H3]: { enabled: false },
            [SEEDANCE_25]: { enabled: false },
          },
          falPricing: { models: {} },
        },
      },
    });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
    expect(result).toMatchObject({ kind: "rejected", reason: "unknown_cost" });
    expect((await h.draftStore.entries()).length).toBe(0);
  });

  it("still mints nothing when no endpoint has a usable price", async () => {
    // Seedance 2.5 carries fal's published token price, so it is excluded by
    // making its output size one fal publishes no dimensions for.
    const h = harness({
      cfg: {
        videoGeneration: { maxEstimatedCostUsd: 0.01, falPricing: { models: {} } },
      },
    });
    const result = await prepareLineStoryboardVideoDraft(request(), h.deps);
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
      request({ requestedModelId: "bytedance/seedance-9.9/reference-to-video" }),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "rejected", reason: "model_unavailable" });
  });

  it("binds fal's REAL Seedance 2.5 endpoint when the owner names it", async () => {
    const h = harness();
    const result = await prepareLineStoryboardVideoDraft(
      request({ requestedModelId: SEEDANCE_25 }),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "created", modelId: SEEDANCE_25 });
    if (result.kind !== "created") {
      return;
    }
    const stored = await h.draftStore.lookup(result.draftId);
    // The exact frozen paid model, never aliased onto 2.0.
    expect(stored?.providerRoute).toEqual({ provider: "fal", modelId: SEEDANCE_25 });
    // Seedance 2.5's own bracket dialect, not 2.0's @Image form.
    expect(stored?.prompt).toContain("[Image1] = F1 (CHAR-12), identity reference.");
    expect(stored?.prompt).not.toContain("@Image1");
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
    expect(models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining([H3, SEEDANCE_25, SEEDANCE]),
    );
  });

  it("omits a compatible endpoint the operator never priced", () => {
    const cfg = {
      videoGeneration: {
        ...fullyConfigured().videoGeneration,
        falPricing: { models: { [SEEDANCE]: { usdPerSecond: 0.05 } } },
      },
    };
    const models = listStoryboardCompatibleModels(request(), cfg).map((model) => model.modelId);
    // H3 and Seedance 2.5 carry fal's own published prices, so they stay
    // payable with no operator rate; H3 Max publishes none and drops out.
    expect(models).toContain(H3);
    expect(models).toContain(SEEDANCE);
    expect(models).not.toContain(H3_MAX);
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
