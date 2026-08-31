import { describe, expect, it, vi } from "vitest";
import type {
  StoryboardPaidDraftRequest,
  StoryboardPaidDraftResult,
  StoryboardPaidDraftRuntime,
} from "./storyboard-paid-draft-runtime.js";
import {
  CREATE_MESSAGE,
  expectNothingBillable,
  harness,
} from "./storyboard-router.test-support.js";

/**
 * The storyboard side of the LINE-owned paid handoff.
 *
 * The runtime here stands in for the LINE plugin, which is the only side that
 * may allocate a code. What these tests pin is what the storyboard flow SENDS
 * and how it treats what comes back — never a second allocator, and never a
 * code invented on this side.
 */

/** Records every handoff and returns a LINE-shaped allocation. */
function paidRuntime(
  reply: (request: StoryboardPaidDraftRequest) => StoryboardPaidDraftResult = () => ({
    kind: "created",
    draftId: "4821",
    modelId: "bytedance/seedance-2.5",
    modelName: "Seedance 2.5",
    durationSeconds: 15,
    resolution: "720p",
    aspectRatio: "9:16",
    audio: true,
    estimatedCostUsd: 3.468,
    maxAllowedUsd: 5,
    pricingSource: "openrouter:bytedance/seedance-2.5",
  }),
): StoryboardPaidDraftRuntime & { requests: StoryboardPaidDraftRequest[] } {
  const requests: StoryboardPaidDraftRequest[] = [];
  return {
    requests,
    prepareStoryboardVideoDraft: async (request) => {
      requests.push(request);
      return reply(request);
    },
  };
}

describe("A. สร้างวิดีโอ hands off and shows the LINE-allocated code", () => {
  it("prints the code LINE returned and never mints one itself", async () => {
    const runtime = paidRuntime();
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });

    expect(result.source).toBe("storyboard");
    expect(result.text).toContain("ยืนยัน VIDEO 4821");
    expect(result.text).toContain("Seedance 2.5");
    expect(result.text).toContain("~$3.47");

    const [draft] = (await h.drafts.entries()).map((entry) => entry.value);
    expect(draft?.confirmation).toEqual({ kind: "ready", code: "4821" });
    expect(draft?.model).toEqual({
      kind: "provider-bound",
      providerModelId: "bytedance/seedance-2.5",
      displayName: "Seedance 2.5",
    });
    expect(draft?.estimatedCost).toEqual({
      kind: "available",
      amountUsd: 3.468,
      source: "openrouter:bytedance/seedance-2.5",
    });
    // The storyboard's OWN draft id is not a 4-digit code: this side has no
    // allocator, so it cannot occupy the LINE code space.
    expect(draft?.draftId).not.toMatch(/^\d{4}$/u);
  });

  it("sends canonical identity, the frozen references and the conversation", async () => {
    const runtime = paidRuntime();
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });

    const [request] = runtime.requests;
    expect(request?.characterLocks.map((lock) => lock.code)).toEqual(["CHAR-6", "CHAR-7"]);
    expect(request?.characterLocks.map((lock) => lock.pageId)).toEqual([
      "page-char-6",
      "page-char-7",
    ]);
    // Identity references travel with the request, in frozen cast order.
    expect(request?.referenceAssets.map((asset) => asset.locator)).toEqual([
      "ugc/page-char-6.png",
      "ugc/page-char-7.png",
    ]);
    for (const asset of request?.referenceAssets ?? []) {
      expect(asset.kind).toBe("identity");
    }
    // Raw LINE identity, so the LINE side derives its own draft key.
    expect(request?.conversationId).toBe("C1234567890abcdef");
    expect(request?.durationSeconds).toBe(15);
    expect(request?.aspectRatio).toBe("9:16");
    expect(request?.resolution).toBe("720p");
    // A display name must never stand in for canonical identity.
    expect(JSON.stringify(request?.characterLocks)).not.toMatch(/Twong/u);
  });

  it("carries the beats and camera intent into the provider prompt", async () => {
    const runtime = paidRuntime();
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });

    const prompt = runtime.requests[0]?.prompt ?? "";
    expect(prompt).toContain("CHAR-6");
    expect(prompt).toContain("camera:");
    expect(prompt).toMatch(/0-\d+s \|/u);
    expect(prompt).toContain("ร้านกาแฟ");
  });
});

describe("N. the confirmed job is the latest storyboard version", () => {
  it("hands off v2 after an edit, never the stale v1", async () => {
    const runtime = paidRuntime();
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    await h.dispatch("วิ 10-14 ให้ Twong หันกลับมามอง Twong2", { messageId: "m2" });
    expect((await h.latest()).versionNumber).toBe(2);

    await h.dispatch("สร้างวิดีโอ", { messageId: "m3" });
    const [request] = runtime.requests;
    expect(request?.storyboardVersionNumber).toBe(2);
    // The v2 edit text must be in the submitted prompt; v1 did not have it.
    expect(request?.prompt).toContain("หันกลับ");
  });
});

describe("G/H. a refused quote leaves the draft unbillable", () => {
  it("shows no code when LINE refuses on budget, and stays a usable draft", async () => {
    const runtime = paidRuntime(() => ({
      kind: "rejected",
      reason: "over_limit",
      estimatedCostUsd: 3.468,
      maxAllowedUsd: 2,
    }));
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });

    expect(result.text).not.toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(result.text).toContain("Final Video Draft");
    const [draft] = (await h.drafts.entries()).map((entry) => entry.value);
    expect(draft?.confirmation).toEqual({ kind: "deferred" });
    await expectNothingBillable(h);
  });

  it("stays deferred for every refusal reason, including a thrown seam", async () => {
    const reasons = [
      { kind: "rejected", reason: "model_unavailable" },
      { kind: "rejected", reason: "unsupported_duration" },
      { kind: "rejected", reason: "unknown_cost" },
      { kind: "rejected", reason: "catalog_unavailable" },
    ] as const;
    for (const reply of reasons) {
      const h = harness({ paidDraftRuntime: paidRuntime(() => reply) });
      await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
      const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });
      expect(result.text, reply.reason).not.toMatch(/ยืนยัน VIDEO/u);
      await expectNothingBillable(h);
    }

    const throwing: StoryboardPaidDraftRuntime = {
      prepareStoryboardVideoDraft: async () => {
        throw new Error("LINE runtime exploded");
      },
    };
    const h = harness({ paidDraftRuntime: throwing });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });
    // The storyboard still reaches the owner; it is simply not billable.
    expect(result.text).toContain("Final Video Draft");
    expect(result.text).not.toMatch(/ยืนยัน VIDEO/u);
    await expectNothingBillable(h);
  });

  it("stays deferred when the LINE plugin is not installed at all", async () => {
    const h = harness({ paidDraftRuntime: null });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
    const result = await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });
    expect(result.text).not.toMatch(/ยืนยัน VIDEO/u);
    await expectNothingBillable(h);
  });
});

describe("D. a generic agreement never reaches the paid handoff", () => {
  it("hands off for สร้างวิดีโอ only", async () => {
    const runtime = paidRuntime();
    const h = harness({ paidDraftRuntime: runtime });
    await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });

    for (const message of ["ยืนยัน", "โอเค", "ทำเลย", "เอาเลย", "สร้างเลย", "yes", "confirm", "go"]) {
      const result = await h.dispatch(message, { messageId: `g-${message}` });
      expect(result.source, message).toBe("model");
    }
    // Not one of them reached the allocator.
    expect(runtime.requests).toEqual([]);
    expect(await h.drafts.entries()).toEqual([]);
  });
});

describe("the storyboard side owns no part of the paid pipeline", () => {
  it("never generates a 4-digit code and never calls a provider", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = "extensions/cloudbath-line-image-archive/src";
    const files = (await readdir(dir)).filter(
      (name) => name.startsWith("storyboard") && name.endsWith(".ts") && !name.includes(".test"),
    );
    for (const name of files) {
      const source = await readFile(`${dir}/${name}`, "utf8");
      // A 4-digit allocator on this side would be a second code space.
      expect(source, name).not.toMatch(/randomInt\s*\(|1000|9999/u);
      expect(source, name).not.toMatch(/generateVideo|openrouter|bytedance\//iu);
    }
  });

  it("performs no network call during a full create-and-draft turn", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const h = harness({ paidDraftRuntime: paidRuntime() });
      await h.dispatch(CREATE_MESSAGE, { messageId: "m1" });
      await h.dispatch("สร้างวิดีโอ", { messageId: "m2" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
