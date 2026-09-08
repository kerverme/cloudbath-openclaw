/**
 * The reported LINE incident: one storyboard, sixteen turns, four owners.
 *
 * A storyboard with complete visuals was on screen. Every chip the owner
 * pressed came back "ปุ่มนี้เป็นของขั้นตอนก่อนหน้า" even though it belonged to
 * the message they were looking at; asking for 15 seconds from a 7-second
 * Final Video Draft fell out of the flow into a generic answer and then into
 * the Character Library; and saying "ใช้ storyboard ไปทำวีดีโอ สิ 15 วิ" put
 * them back at "ยืนยัน Storyboard" with the length dropped.
 *
 * Two faults, both about STATE rather than wording:
 *
 *  1. Every handled turn minted a new question nonce, even when the question it
 *     described had not changed. A chip is bound to that nonce, so the controls
 *     on screen died on the next message. The version the standing controls
 *     belong to was never on the question at all, so churn was the only thing
 *     making a genuinely old chip stale.
 *  2. A length named while a storyboard is bound to the conversation was not
 *     read as a change to it. The general parser demands a replacement marker
 *     ("ขอ 15 วิแทน"), which "15 วิได้ไหม" does not carry, so the turn reached
 *     no handler and the model answered instead.
 *
 * Nothing here can spend anything: the paid runtime is a local stub with a
 * counter and no network call, and the only paid trigger stays the exact typed
 * `ยืนยัน VIDEO ####`, which this side never resolves.
 */
import { describe, expect, it } from "vitest";
import type { StoryboardModelSelectionState } from "./storyboard-confirmation.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness, type StoryboardLogFn } from "./storyboard-router.test-support.js";
import { StoryboardVisualService, type StoryboardVisualArtifact } from "./storyboard-visual.js";
import type { AsyncKeyedStore } from "./types.js";

/** The owner's opening request: a video, with nothing pinned down. */
const ASK_VIDEO = "ช่วยทำวิดีโอให้หน่อย";
/** Text-only: no first frame, no Character Library. */
const PICK_TEXT_ONLY = "1";
const SCENE = "แมวเดินในสวนแล้วกระโดด";

function mem<T>(): AsyncKeyedStore<T> {
  const rows = new Map<string, T>();
  return {
    register: async (key, value) => void rows.set(key, value),
    registerIfAbsent: async (key, value) => (rows.has(key) ? false : (rows.set(key, value), true)),
    lookup: async (key) => rows.get(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

/** Quotes and allocates without a network call, and counts every allocation. */
function paidRuntime(compatible = ["fal/model-a"]) {
  const runtime = {
    prepareCalls: 0,
    requestedModelIds: [] as (string | undefined)[],
    superseded: [] as string[],
    offerDefaultVideoModel: async () => ({
      kind: "offered" as const,
      model: {
        modelId: "fal/model-a",
        displayName: "Model A",
        familyId: "fam",
        familyDisplayName: "Fam",
      },
      estimatedCostUsd: 1,
    }),
    listCompatibleVideoModels: async () =>
      compatible.map((modelId) => ({
        modelId,
        displayName: `Model ${modelId}`,
        familyId: "fam",
        familyDisplayName: "Fam",
      })),
    readActiveVideoJob: async () => undefined,
    supersedeStoryboardDrafts: async ({ storyboardId }: { storyboardId: string }) => {
      runtime.superseded.push(storyboardId);
      return ["4887"];
    },
    prepareStoryboardVideoDraft: async (request: {
      durationSeconds: number;
      requestedModelId?: string;
    }) => {
      runtime.prepareCalls += 1;
      runtime.requestedModelIds.push(request.requestedModelId);
      const modelId = request.requestedModelId ?? "fal/model-a";
      return {
        kind: "created" as const,
        draftId: "4887",
        modelId,
        modelName: `Model ${modelId}`,
        durationSeconds: request.durationSeconds,
        resolution: "1080p",
        aspectRatio: "9:16",
        audio: false,
        estimatedCostUsd: 1,
        maxAllowedUsd: 50,
        pricingSource: `fal:${modelId}`,
      };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & {
    prepareCalls: number;
    requestedModelIds: (string | undefined)[];
    superseded: string[];
  };
}

/** Per-shot visuals with no image provider: bytes come from the stub itself. */
function visuals(): StoryboardVisualService {
  return new StoryboardVisualService({
    artifacts: mem<StoryboardVisualArtifact>(),
    now: () => Date.parse("2026-09-08T00:00:00.000Z"),
    generate: async ({ shotIndex }: { shotIndex: number }) => ({
      bytes: Buffer.from(`shot-${shotIndex}`),
      mimeType: "image/png",
      width: 64,
      height: 64,
      provider: "stub",
      model: "stub",
    }),
    normalize: async ({ bytes }: { bytes: Buffer }) => ({
      bytes,
      mimeType: "image/png" as const,
      width: 64,
      height: 64,
    }),
    persist: async () => {},
  } as never);
}

function planner(): StoryboardLlmPlanner {
  return new StoryboardLlmPlanner(async () => ({
    text: JSON.stringify({
      beats: [
        {
          startSeconds: 1,
          endSeconds: 4,
          kind: "establishing",
          framing: "Wide",
          action: "cat walks",
          camera: "Static",
          characterNames: [],
        },
        {
          startSeconds: 4,
          endSeconds: 7,
          kind: "action",
          framing: "Medium",
          action: "cat jumps",
          camera: "Track",
          characterNames: [],
        },
      ],
    }),
  }));
}

type Chip = Readonly<{ label: string; value: string }>;

/**
 * The reported starting state: a text-only storyboard, visuals complete, with
 * the review controls on screen. Every step is the free path.
 */
async function textOnlyStoryboard() {
  const paid = paidRuntime();
  const logs: Array<{ level: "info" | "warn"; event: string; fields?: Record<string, unknown> }> =
    [];
  const record =
    (level: "info" | "warn"): StoryboardLogFn =>
    (event, fields) =>
      void logs.push({ level, event, ...(fields ? { fields } : {}) });
  const shots = visuals();
  const h = harness({
    binding: null,
    paidDraftRuntime: paid,
    planner: planner(),
    modelSelection: mem<StoryboardModelSelectionState>(),
    visuals: shots,
    publicAssetBaseUrl: "https://assets.example",
    sendVisualImage: async () => {},
    resolveSelectedSourceImage: async () => ({ kind: "none" as const }),
    logger: { info: record("info"), warn: record("warn") },
  });

  const chips = (reply: Awaited<ReturnType<typeof h.dispatch>>): readonly Chip[] =>
    (reply.presentation?.blocks ?? []).flatMap((block) =>
      block.type === "buttons"
        ? block.buttons.flatMap((button) =>
            button.action.type === "callback"
              ? [{ label: button.label, value: button.action.value }]
              : [],
          )
        : [],
    );
  const chip = (reply: Awaited<ReturnType<typeof h.dispatch>>, label: string): string => {
    const found = chips(reply).find((entry) => entry.label === label);
    if (!found) {
      throw new Error(`no chip labelled ${label}`);
    }
    return found.value;
  };

  await h.dispatch(ASK_VIDEO);
  await h.dispatch(PICK_TEXT_ONLY);
  await h.dispatch(SCENE);
  await h.dispatch("7 วิ");
  await h.dispatch("ไม่มี");
  const ready = await h.dispatch("ทำภาพแต่ละช็อต");

  return { h, paid, logs, chips, chip, ready, shots };
}

/** Storyboard confirmed, default model offered, Final Video Draft on screen. */
async function withFinalDraft() {
  const started = await textOnlyStoryboard();
  const offered = await started.h.dispatch("ยืนยัน Storyboard");
  const drafted = await started.h.dispatch(started.chip(offered, "ใช้ Default"));
  return { ...started, offered, drafted };
}

describe("1. a chip and the same answer typed are one action", () => {
  it("reaches the Final Video Draft from the chip that was just rendered", async () => {
    const { h, chip } = await textOnlyStoryboard();

    const offered = await h.dispatch("ยืนยัน Storyboard");
    expect(offered.text).toContain("Default Model");

    // The chip carried by the message on screen, pressed unchanged.
    const drafted = await h.dispatch(chip(offered, "ใช้ Default"));

    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(drafted.text).not.toContain("ขั้นตอนก่อนหน้า");
  });

  it("reaches the same place when the owner types the answer instead", async () => {
    const { h } = await textOnlyStoryboard();

    await h.dispatch("ยืนยัน Storyboard");
    const drafted = await h.dispatch("ใช้ default model");

    // The same action, reaching the same step: a chip may never succeed where
    // the words it stands for are refused, or the other way round.
    expect(drafted.source).toBe("storyboard");
    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).toMatch(/ยืนยัน VIDEO \d{4}/u);
    expect(drafted.text).not.toContain("ขั้นตอนก่อนหน้า");
  });
});

describe("2. staleness follows the step, not the turn", () => {
  it("keeps a chip alive while the step it belongs to is still open", async () => {
    const { h, chips, ready } = await textOnlyStoryboard();

    const before = chips(ready).find((entry) => entry.label === "ทำวิดีโอจาก Storyboard นี้")!;
    // Two more turns on the SAME storyboard version. Under the old behaviour
    // each of these re-minted the nonce and killed the controls on screen.
    await h.dispatch("ทำวิดีโอจาก Storyboard นี้");
    await h.dispatch("ทำวิดีโอจาก Storyboard นี้");

    const pressed = await h.dispatch(before.value);

    expect(pressed.text ?? "").not.toContain("ขั้นตอนก่อนหน้า");
    expect(pressed.conversation).toMatchObject({ kind: "rewrite", source: "button" });
  });

  it("refuses a chip whose step really is behind the owner", async () => {
    const { h, chips, ready } = await textOnlyStoryboard();

    const before = chips(ready).find((entry) => entry.label === "ทำวิดีโอจาก Storyboard นี้")!;
    // A revision appends a version, so these version-bound controls no longer
    // describe the scene on screen.
    await h.dispatch("ขอ 20 วิแทน");
    expect((await h.latest()).versionNumber).toBe(2);

    const pressed = await h.dispatch(before.value);

    expect(pressed.text).toContain("ขั้นตอนก่อนหน้า");
  });
});

describe("3. a new length asked for after the Final Video Draft", () => {
  it("revises the same storyboard and re-quotes it, without a generic answer", async () => {
    const { h, paid, drafted } = await withFinalDraft();
    const before = await h.latest();
    expect(before.document.durationSeconds).toBe(7);
    expect(drafted.text).toContain("Final Video Draft");

    const revised = await h.dispatch("15 วิได้ไหม");

    // Claimed by the storyboard flow: never the model, never a legacy route.
    expect(revised.source).toBe("storyboard");
    expect(revised.handled).toBe(true);

    // Same lineage, new version, actually 15 seconds.
    const after = await h.latest();
    expect(after.storyboardId).toBe(before.storyboardId);
    expect(after.versionNumber).toBe(before.versionNumber + 1);
    expect(after.document.durationSeconds).toBe(15);

    // The old quote is dead and a new one exists for the length that now is.
    expect(paid.superseded).toEqual([before.storyboardId]);
    expect(revised.text).toContain("Final Video Draft");
    expect(revised.text).toContain("15 วิ");
    // Compatibility was re-checked for the new length and the endpoint the
    // owner had settled on was carried forward.
    expect(paid.requestedModelIds.at(-1)).toBe("fal/model-a");
  });

  it("re-offers rather than reusing a model the new length cannot run", async () => {
    const paid = paidRuntime();
    const h = harness({
      binding: null,
      paidDraftRuntime: paid,
      planner: planner(),
      modelSelection: mem<StoryboardModelSelectionState>(),
      visuals: visuals(),
      publicAssetBaseUrl: "https://assets.example",
      sendVisualImage: async () => {},
      resolveSelectedSourceImage: async () => ({ kind: "none" as const }),
    });
    for (const message of [ASK_VIDEO, PICK_TEXT_ONLY, SCENE, "7 วิ", "ไม่มี", "ทำภาพแต่ละช็อต"]) {
      await h.dispatch(message);
    }
    await h.dispatch("ยืนยัน Storyboard");
    await h.dispatch("ใช้ Default");
    // The registry stops offering that endpoint for the longer scene.
    (
      paid as unknown as { listCompatibleVideoModels: () => Promise<unknown[]> }
    ).listCompatibleVideoModels = async () => [];

    await h.dispatch("15 วิได้ไหม");

    // No requested endpoint: the capability-aware default is asked for instead
    // of re-submitting one the new length was never checked against.
    expect(paid.requestedModelIds.at(-1)).toBeUndefined();
  });

  it("keeps the Character Library out of a text-only scene", async () => {
    const { h } = await withFinalDraft();

    const revised = await h.dispatch("15 วิได้ไหม");
    const confirmed = await h.dispatch("ยืนยัน");

    for (const reply of [revised.text ?? "", confirmed.text ?? ""]) {
      expect(reply).not.toContain("Character Library");
      expect(reply).not.toContain("ยังไม่มีตัวละคร");
    }
    expect(revised.source).toBe("storyboard");
  });
});

describe("4. naming the storyboard as the thing to make a video from", () => {
  it("resolves the active storyboard and carries the new length into it", async () => {
    const { h } = await withFinalDraft();
    const before = await h.latest();

    const continued = await h.dispatch("ใช้ storyboard ไปทำวีดีโอ สิ 15 วิ");

    expect(continued.source).toBe("storyboard");
    const after = await h.latest();
    expect(after.storyboardId).toBe(before.storyboardId);
    expect(after.document.durationSeconds).toBe(15);
    // Not a restart: the owner is not sent back to confirm content they had
    // already confirmed, and the length they named is not dropped.
    expect(continued.text ?? "").not.toContain("พร้อมภาพครบแล้ว");
    expect(continued.text).toContain("Final Video Draft");
  });
});

describe("5. a text-only storyboard is video work, not a casting problem", () => {
  it("builds and drafts one with no Character Library and no first frame", async () => {
    const { h, chip } = await textOnlyStoryboard();

    const version = await h.latest();
    expect(version.characterLocks).toEqual([]);
    expect(version.document.sourceImage).toBeUndefined();

    const offered = await h.dispatch("ยืนยัน Storyboard");
    const drafted = await h.dispatch(chip(offered, "ใช้ Default"));

    expect(drafted.text).toContain("Final Video Draft");
    expect(drafted.text).toContain("text-to-video");
    expect(drafted.text ?? "").not.toContain("Character Library");
  });

  it("carries finished shots across a length change, since the shots did not change", async () => {
    const { h, shots } = await withFinalDraft();

    await h.dispatch("15 วิได้ไหม");

    // The images depend on framing, action and cast — never on the seconds — so
    // a re-timed version inherits the shots the owner already approved.
    const after = await h.latest();
    const status = await shots.status({ version: after, claim: h.claim });
    expect(status.kind).toBe("ready");
  });
});

describe("6. nothing above can spend anything", () => {
  it("never starts a video before the exact typed confirmation", async () => {
    const { h, paid } = await withFinalDraft();

    for (const message of [
      "15 วิได้ไหม",
      "ยืนยัน",
      "ตกลง",
      "เอาเลย",
      "ใช้ storyboard ไปทำวีดีโอ สิ 15 วิ",
      "ยืนยัน VIDEO",
    ]) {
      const answered = await h.dispatch(message);
      expect(answered.text ?? "").not.toMatch(/เริ่มสร้างวิดีโอ/u);
    }

    // Every allocation above is a quote. Submitting is not on this side's seam
    // at all: the exact typed `ยืนยัน VIDEO ####` is resolved by the LINE gate.
    expect(paid.prepareCalls).toBeGreaterThan(0);
    expect(Object.keys(paid)).not.toContain("submitCalls");
  });
});

describe("what a claimed route records", () => {
  it("names the state and the action, and whether a chip or typing arrived", async () => {
    const { h, chip, logs } = await textOnlyStoryboard();

    const offered = await h.dispatch("ยืนยัน Storyboard");
    await h.dispatch(chip(offered, "ใช้ Default"));

    const claimed = logs.filter((entry) => entry.event === "storyboard_route_claimed");
    expect(claimed.at(-1)?.fields).toMatchObject({
      resolvedAction: "answer_model_selection",
      inputSource: "button",
      modelSelectionStep: "default",
      modelSelectionFrozenVersion: 1,
      replyTextPresent: true,
    });
    const postback = logs.find((entry) => entry.event === "conversation_postback_resolved");
    expect(postback?.fields).toMatchObject({
      inputSource: "button",
      resolved: true,
      tokenNonceMatched: true,
      questionId: "model_default",
    });
    // The owner's own words are their content: measured, never echoed.
    expect(JSON.stringify(logs)).not.toContain(SCENE);
  });
});
