/**
 * The official end-to-end owner video flow for the LINE channel, asserted
 * against the real stores and the real routers rather than model-authored
 * prose:
 *
 *   natural request
 *     -> the bot asks 15 or 30 seconds, BEFORE building anything
 *     -> storyboard, with NO paid VIDEO code
 *     -> free revision, still no code
 *     -> "ยืนยัน Storyboard" freezes the content
 *     -> capability-aware default model, or a change
 *     -> Final Video Draft naming the actual fal endpoint
 *     -> exact "ยืนยัน VIDEO ####"
 *     -> exactly one mocked fal submission -> R2 -> LINE
 *     -> a replayed confirmation submits nothing
 *
 * fal is the only paid video provider in this flow, and every submission here
 * goes through a mocked `generateVideo`; no paid call is made.
 */
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateVideoMock = vi.fn();
const sendMessageLineMock = vi.fn(async (..._args: unknown[]) => ({}));
const stageLineOutboundVideoMock = vi.fn(async (..._args: unknown[]) => ({
  url: "https://r2.example/archived.mp4?X-Amz-Signature=sig",
  objectKey: "outbound/line-video/sha256/ab/abcd.mp4",
  contentType: "video/mp4",
  contentLength: 10,
  sha256: "abcd",
}));

const ACCOUNT = "acct-1";
const GROUP = "C1234567890abcdef";
const OWNER = "U0987654321";
const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const H3_MODEL = "minimax/h3/reference-to-video";
const SEEDANCE_25 = "bytedance/seedance-2.5/reference-to-video";

const CAPABILITIES = Object.fromEntries(
  [
    "PRODUCT_LIBRARY",
    "CHARACTER_LIBRARY",
    "UGC_PROJECTS",
    "UGC_SHOTS",
    "AI_VIDEO_LIBRARY",
    "AI_IMAGE_LIBRARY",
  ].map((id, index) => [
    id,
    { databaseId: String(index + 1).repeat(32), dataSourceId: String(index + 1).repeat(32) },
  ]),
);

const runtimeConfigMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("openclaw/plugin-sdk/video-generation-runtime", () => ({
  generateVideo: (...args: unknown[]) => generateVideoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => runtimeConfigMock.current,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: () => "/agent-dir",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "fal-key" }),
}));
vi.mock("./send.js", () => ({
  sendMessageLine: (...args: unknown[]) => sendMessageLineMock(...args),
}));
vi.mock("./video-outbound-staging.js", () => ({
  stageLineOutboundVideo: (...args: unknown[]) => stageLineOutboundVideoMock(...args),
  stageLineVideoPreviewImage: async () => ({ url: "https://r2.example/preview.jpg" }),
  signArchivedLineVideoUrl: async (key: string) => `https://r2.example/${key}?sig`,
}));
// fal's endpoint takes reference URLs. Only the R2 publish is replaced; the
// ORDERING comes from the real resolver, because that ordering is what binds
// each reference marker to the right character.
vi.mock("./video-reference-urls.js", async () => {
  const scope =
    await vi.importActual<typeof import("./video-ugc-scope.js")>("./video-ugc-scope.js");
  return {
    resolveLineVideoReferenceUrls: async (
      value: Parameters<typeof scope.orderLineVideoUgcReferences>[0],
    ) =>
      scope.orderLineVideoUgcReferences(value).map((reference, index) => ({
        index,
        url: `https://r2.example/${encodeURIComponent(reference.locator)}?sig`,
        mimeType: "image/png",
      })),
  };
});

const { CloudbathStoryboardLineRouter } =
  await import("../../cloudbath-line-image-archive/src/storyboard-line-router.js");
const { StoryboardStore } =
  await import("../../cloudbath-line-image-archive/src/storyboard-store.js");
const { resolver } =
  await import("../../cloudbath-line-image-archive/src/storyboard-router.test-support.js");
const { ugcDraftScopeKey } = await import("../../cloudbath-line-image-archive/src/ugc-workflow.js");
const { createLineVideoConfirmationGate } = await import("./video-confirmation.js");
const { prepareLineStoryboardVideoDraft } = await import("./video-storyboard-draft.js");
const { supersedeLineVideoDraftsForStoryboard } = await import("./video-draft-store.js");
const { buildLineVideoConversationKey } = await import("./video-model-preference.js");
const { listFalStoryboardModels, matchFalStoryboardQuery, offerFalStoryboardDefault } =
  await import("./fal-storyboard-seam.js");
import type { FalStoryboardConfig } from "./fal-storyboard-seam.js";
import type { LineVideoDraft } from "./video-draft-store.js";
import type { LineVideoActiveJobLock, LineVideoJob } from "./video-job-store.js";

/** The owner's natural request; the cast is resolved from the Character Library. */
const NATURAL_REQUEST = "เอา Twong เดินในสวน เจอน้ำ แล้วเตะขวดน้ำออกไปนอกโลก";
const DURATION_QUESTION = "ต้องการความยาวเท่าไร?\n1. 15 วินาที\n2. 30 วินาที";
/** The director's second slot: speech is asked about separately from sound. */
const DIALOGUE_QUESTION = "มีเสียงพูดในคลิปไหม? (มี / ไม่มี)";
const DIALOGUE_TEXT_QUESTION = "ให้พูดว่าอะไร?";

/**
 * One fal configuration, shared by allocation and the confirmation gate.
 *
 * Deliberately declares NO rates: H3 and Seedance 2.5 both carry fal's own
 * published price for their exact endpoint, so this is the shape a real
 * operator ships with, and the quotes below are the ones production computes.
 *
 * Typed as the fal seam's own config PLUS `maxEstimatedCostUsd`, which is a
 * separate LINE-owned budget field production merges into the same
 * `videoGeneration` object (see types.ts's `LineVideoGenerationConfig`).
 * Declaring the wider type here, not just this concrete value, is what keeps
 * it assignable everywhere production passes it: a value with zero property
 * overlap with a fully-optional target type fails TypeScript's weak-type
 * check even though every field is optional.
 */
function falVideoGeneration(): FalStoryboardConfig["videoGeneration"] & {
  maxEstimatedCostUsd?: number;
} {
  return { maxEstimatedCostUsd: 50 };
}

function mem<T>(): PluginStateKeyedStore<T> {
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
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

function notionLibraryStub() {
  return {
    validate: async () => {},
    createProcessing: async () => ({ pageId: "notion-page-1" }),
    markCompleted: async () => {},
    markFailed: async () => {},
    markUgcProcessing: async () => {},
    markUgcCompleted: async () => {},
    markUgcFailed: async () => {},
  };
}

/**
 * @param options.supersedeFails simulates the proactive retirement write
 * failing when the scene changes — the state the fail-closed confirmation gate
 * exists for. Everything else in the flow stays real.
 * @param options.storyboardVersionUnreadable simulates the storyboard service
 * being unable to answer, which must refuse rather than assume "unchanged".
 */
function buildFlow(options?: { supersedeFails?: boolean; storyboardVersionUnreadable?: boolean }) {
  const draftStore = mem<LineVideoDraft>();
  const jobStore = mem<LineVideoJob>();
  const activeJobLockStore = mem<LineVideoActiveJobLock>();
  const draftScopes = mem<Record<string, unknown>>();
  const background: Array<() => Promise<void>> = [];

  runtimeConfigMock.current = {
    plugins: {
      entries: {
        "cloudbath-line-image-archive": {
          config: { groupWorkspacePolicies: { ugc: { capabilities: CAPABILITIES } } },
        },
      },
    },
  };

  // Bound once and reused as a variable, not a fresh literal, at each call
  // site: `falVideoGeneration()` carries `maxEstimatedCostUsd` for the LINE
  // cost guard below, which is real production shape (one merged
  // `videoGeneration` config object) rather than something the narrower fal-
  // only types declare.
  const falCfg = { videoGeneration: falVideoGeneration() };

  // The REAL LINE-owned paid runtime and the REAL fal registry seams, injected
  // rather than installed into the process-global slot so suites do not leak.
  const paidDraftRuntime = {
    offerDefaultVideoModel: async (_accountId: string, requirements: never) =>
      offerFalStoryboardDefault(falCfg, requirements),
    listCompatibleVideoModels: async (_accountId: string, requirements: never) =>
      listFalStoryboardModels(falCfg, requirements),
    matchVideoModelQuery: async (_accountId: string, requirements: never, text: string) =>
      matchFalStoryboardQuery(falCfg, requirements, text),
    prepareStoryboardVideoDraft: async (request: never) =>
      await prepareLineStoryboardVideoDraft(request, {
        draftStore: draftStore as never,
        resolveFalAuth: async () => true,
        cfg: falCfg,
        now: () => NOW,
      }),
    // The real LINE-owned retirement, reached the way the storyboard reaches
    // it. `supersedeFails` makes the store write throw instead of stubbing the
    // whole call away, so the failure is the one production would have.
    supersedeStoryboardDrafts: async (request: {
      accountId: string;
      conversationId: string;
      ownerSenderId: string;
      storyboardId: string;
    }) => {
      if (options?.supersedeFails) {
        throw new Error("draft store unavailable");
      }
      return await supersedeLineVideoDraftsForStoryboard({
        store: draftStore as never,
        accountId: request.accountId,
        conversationKey:
          buildLineVideoConversationKey({
            accountId: request.accountId,
            conversationId: request.conversationId,
          }) ?? "",
        ownerSenderId: request.ownerSenderId,
        storyboardId: request.storyboardId,
        now: () => NOW,
      });
    },
  };

  const storyboardRouter = new CloudbathStoryboardLineRouter({
    store: new StoryboardStore({ heads: mem(), versions: mem(), now: () => NOW }),
    resolver: resolver(),
    active: mem(),
    drafts: mem(),
    dedupe: mem(),
    director: mem(),
    modelSelection: mem(),
    registry: { lookup: async () => ({ policyId: "UGC", boundByOwnerId: OWNER }) },
    now: () => NOW,
    draftScopes: draftScopes as never,
    ugcCapabilities: CAPABILITIES as never,
    paidDraftRuntime: paidDraftRuntime as never,
  } as never);

  const gate = createLineVideoConfirmationGate({
    draftStore: draftStore as never,
    jobStore: jobStore as never,
    activeJobLockStore: activeJobLockStore as never,
    resolveFalAuth: async () => true,
    workspaceRuntime: {
      lookupBinding: async () => ({
        accountId: ACCOUNT,
        groupId: GROUP,
        policyId: "UGC" as const,
        boundByOwnerId: OWNER,
        boundAt: "2026-08-30T00:00:00.000Z",
      }),
      lookupUgcDraftScope: async (draftId: string) =>
        await draftScopes.lookup(ugcDraftScopeKey(draftId)),
      consumeUgcDraftScope: async (draftId: string) =>
        await draftScopes.consume(ugcDraftScopeKey(draftId)),
      // The real Cloudbath-side read, over the real seam: the gate proves a
      // code's frozen version against the storyboard's own version chain.
      readStoryboardVersionNumber: async (request: {
        accountId: string;
        conversationId: string;
        ownerSenderId: string;
        storyboardId: string;
      }) => {
        if (options?.storyboardVersionUnreadable) {
          throw new Error("storyboard store unavailable");
        }
        return await storyboardRouter.readStoryboardVersionNumber(request);
      },
    } as never,
    createNotionLibrary: () => notionLibraryStub() as never,
    scheduleBackgroundWork: (run) => void background.push(run),
    resolveAccount: (() => ({
      accountId: ACCOUNT,
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config" as const,
      config: { videoGeneration: falVideoGeneration() },
    })) as never,
    now: () => NOW,
  });

  let message = 0;
  const say = async (content: string, sender = OWNER) =>
    await storyboardRouter.handleBeforeDispatch(
      {
        content,
        senderId: sender,
        senderIsOwner: sender === OWNER,
        isGroup: true,
        messageId: `m${(message += 1)}`,
      },
      { channelId: "line", accountId: ACCOUNT, conversationId: GROUP },
    );

  const confirm = async (code: string, sender = OWNER) =>
    await gate(
      {
        content: "",
        channel: "line",
        body: `ยืนยัน VIDEO ${code}`,
        senderId: sender,
        senderIsOwner: sender === OWNER,
      } as never,
      { accountId: ACCOUNT, conversationId: GROUP } as never,
    );

  return { say, confirm, draftStore, jobStore, background };
}

/**
 * Answers the director's two questions and returns the storyboard reply.
 *
 * `speech` decides the SOUND requirement, which is a capability input rather
 * than flavour: fal's H3 endpoints always produce audio, so a silent scene
 * must not resolve to one.
 */
async function answerDirector(
  flow: ReturnType<typeof buildFlow>,
  durationAnswer: string,
  speech?: string,
): Promise<string> {
  const opened = await flow.say(NATURAL_REQUEST);
  expect(opened?.text).toBe(DURATION_QUESTION);
  expect((await flow.say(durationAnswer))?.text).toBe(DIALOGUE_QUESTION);
  if (speech === undefined) {
    return (await flow.say("ไม่มี"))?.text ?? "";
  }
  expect((await flow.say("มี"))?.text).toBe(DIALOGUE_TEXT_QUESTION);
  return (await flow.say(speech))?.text ?? "";
}

/** Drives the flow to a Final Video Draft and returns its VIDEO code. */
async function driveToDraft(
  flow: ReturnType<typeof buildFlow>,
  durationAnswer: string,
  speech: string | undefined = "สวัสดีครับ",
): Promise<{ code: string; draftText: string }> {
  const storyboard = await answerDirector(flow, durationAnswer, speech);
  expect(storyboard).toContain("Storyboard v1");
  expect(storyboard).not.toMatch(/ยืนยัน VIDEO/u);

  const confirmed = await flow.say("ยืนยัน Storyboard");
  expect(confirmed?.text).toContain("ใช้ Default Model หรือเปลี่ยน Model?");

  const drafted = await flow.say("ใช้ Default");
  const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
  expect(code).toMatch(/^\d{4}$/u);
  return { code: code!, draftText: drafted?.text ?? "" };
}

beforeEach(() => {
  generateVideoMock.mockReset().mockResolvedValue({
    videos: [{ url: "https://v3.fal.media/out.mp4", mimeType: "video/mp4" }],
    provider: "fal",
    model: SEEDANCE_25,
    attempts: [],
    ignoredOverrides: [],
    metadata: { requestId: "fal-req-1" },
  });
  sendMessageLineMock.mockReset().mockResolvedValue({});
  stageLineOutboundVideoMock.mockClear();
});

describe("A-D. the owner conversation before any money", () => {
  it("asks 15 or 30 seconds before building anything", async () => {
    const flow = buildFlow();

    const opened = await flow.say(NATURAL_REQUEST);

    expect(opened?.text).toBe(DURATION_QUESTION);
    // Nothing was drafted, quoted or billed by asking a question.
    expect(await flow.draftStore.entries()).toEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("B: the duration answer produces a storyboard with NO VIDEO code", async () => {
    const flow = buildFlow();

    const storyboard = await answerDirector(flow, "1");

    expect(storyboard).toContain("Storyboard v1");
    expect(storyboard).toContain("ยืนยัน Storyboard หรือบอกจุดที่ต้องการแก้");
    expect(storyboard).not.toMatch(/ยืนยัน VIDEO/u);
    expect(await flow.draftStore.entries()).toEqual([]);
  });

  it("C: a revision makes a new version and still mints no code", async () => {
    const flow = buildFlow();
    await answerDirector(flow, "1");

    const revised = await flow.say("เปลี่ยนเป็นกลางคืน");

    expect(revised?.text).toContain("Storyboard v2");
    expect(revised?.text).not.toMatch(/ยืนยัน VIDEO/u);
    expect(await flow.draftStore.entries()).toEqual([]);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("D: confirming the storyboard begins model selection, not a paid draft", async () => {
    const flow = buildFlow();
    await answerDirector(flow, "1");

    const confirmed = await flow.say("ยืนยัน Storyboard");

    expect(confirmed?.text).toContain("Default Model:");
    expect(confirmed?.text).toContain("ใช้ Default Model หรือเปลี่ยน Model?");
    expect(await flow.draftStore.entries()).toEqual([]);
  });
});

describe("E-J. model selection and the Final Video Draft", () => {
  it("M: a 15-second scene defaults to H3 at 2K, quoted from fal's own price", async () => {
    const flow = buildFlow();
    const { draftText, code } = await driveToDraft(flow, "1");

    expect(draftText).toContain("Final Video Draft");
    // The ACTUAL fal endpoint that will receive the paid request.
    expect(draftText).toContain("fal.ai");
    expect(draftText).toContain(H3_MODEL);
    // The endpoint's documented default size, and its published rate:
    // 15s x $0.13 at 2K, one Character reference inside the free five.
    expect(draftText).toContain("2K");
    expect(draftText).toContain("~$1.95");
    const stored = await flow.draftStore.lookup(code);
    expect(stored).toMatchObject({
      providerRoute: { provider: "fal", modelId: H3_MODEL },
      resolution: "2K",
      durationSeconds: 15,
    });
    expect(stored?.estimatedCostUsd).toBeCloseTo(1.95, 6);
  });

  it("N: a 30-second scene defaults to Seedance 2.5 and explains why, not 'none'", async () => {
    const flow = buildFlow();
    // With sound wanted, H3 clears every requirement except the length, so the
    // displacement this asserts is about duration and nothing else.
    await answerDirector(flow, "2", "สวัสดีครับ");

    const confirmed = await flow.say("ยืนยัน Storyboard");

    // H3 tops out at 15s, so it is not offered; the replacement is explained.
    expect(confirmed?.text).toContain(
      "งานนี้ยาว 30 วินาที MiniMax H3 Reference-to-Video รองรับสูงสุด 15 วินาที",
    );
    expect(confirmed?.text).toContain("Default สำหรับงานนี้จึงเป็น Seedance 2.5 Reference-to-Video");
    const drafted = await flow.say("ใช้ Default");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{4}$/u);
    expect(await flow.draftStore.lookup(code!)).toMatchObject({
      providerRoute: { provider: "fal", modelId: SEEDANCE_25 },
      durationSeconds: 30,
    });
  });

  it("O: a silent scene never defaults to an endpoint that always makes sound", async () => {
    const flow = buildFlow();
    // fal publishes no proven "generate_audio: false" for H3, so an owner who
    // asked for no sound must not be handed one. Seedance 2.5 can turn it off.
    await answerDirector(flow, "1");

    const confirmed = await flow.say("ยืนยัน Storyboard");

    expect(confirmed?.text).toContain("งานนี้ต้องไม่มีเสียง");
    expect(confirmed?.text).toContain("Default Model: Seedance 2.5 Reference-to-Video");
  });

  it("G/H/I: change model -> family -> a named Seedance version", async () => {
    const flow = buildFlow();
    await answerDirector(flow, "1");
    await flow.say("ยืนยัน Storyboard");

    const families = await flow.say("เปลี่ยนโมเดล");
    expect(families?.text).toContain("เลือกค่าย / Model Family:");
    expect(families?.text).toContain("ByteDance / Seedance");

    const versions = await flow.say("seedance");
    expect(versions?.text).toContain("Seedance 2.5 Reference-to-Video");

    const drafted = await flow.say("seedance 2.5");
    const code = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{4}$/u);
    // The exact frozen paid model, never aliased onto 2.0.
    expect(await flow.draftStore.lookup(code!)).toMatchObject({
      providerRoute: { provider: "fal", modelId: SEEDANCE_25 },
    });
  });
});

describe("K-N. the paid confirmation", () => {
  it("L/N: the exact phrase submits once to fal, then archives and delivers", async () => {
    const flow = buildFlow();
    const { code } = await driveToDraft(flow, "1");

    const started = await flow.confirm(code);
    expect(started?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    await flow.background[0]?.();

    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    const submitted = generateVideoMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted.modelOverride).toBe(`fal/${H3_MODEL}`);
    expect(submitted.autoProviderFallback).toBe(false);
    // N: reference ordering matches the markers compiled into the prompt.
    const urls = (submitted.inputImages as ReadonlyArray<{ url?: string }> | undefined)?.map(
      (asset) => asset.url,
    );
    expect(urls?.length).toBeGreaterThan(0);
    expect(String(submitted.prompt)).toContain("Image 1 = ");

    // Archived in R2, delivered from the R2 URL, never fal's transient one.
    expect(stageLineOutboundVideoMock).toHaveBeenCalledWith("https://v3.fal.media/out.mp4");
    expect(JSON.stringify(sendMessageLineMock.mock.calls)).not.toContain("v3.fal.media");
    const [job] = await flow.jobStore.entries();
    expect(job?.value).toMatchObject({
      status: "completed",
      provider: "fal",
      r2ObjectKey: "outbound/line-video/sha256/ab/abcd.mp4",
      providerRequestId: "fal-req-1",
    });
  });

  it("M: a replayed confirmation submits nothing more", async () => {
    const flow = buildFlow();
    const { code } = await driveToDraft(flow, "1");
    await flow.confirm(code);

    const replay = await flow.confirm(code);

    expect(replay).toEqual({ handled: true, text: "ไม่พบ video draft นี้ หรือถูกใช้ไปแล้ว" });
    expect(flow.background).toHaveLength(1);
  });

  it("U: no OpenRouter video generation happens anywhere in this flow", async () => {
    const flow = buildFlow();
    const { code } = await driveToDraft(flow, "1");
    await flow.confirm(code);
    await flow.background[0]?.();

    for (const call of generateVideoMock.mock.calls) {
      expect(String((call[0] as { modelOverride?: string }).modelOverride)).toMatch(/^fal\//u);
    }
  });
});

describe("unauthorized LINE video operations fail closed", () => {
  it("refuses a confirmation from someone other than the code's owner", async () => {
    const flow = buildFlow();
    const { code } = await driveToDraft(flow, "1");

    const refused = await flow.confirm(code, "U-someone-else");

    expect(refused?.text).not.toContain("เริ่มสร้างวิดีโอแล้ว");
    // The code survives for its real owner, and nothing was billed.
    expect(await flow.draftStore.lookup(code)).toMatchObject({ status: "pending" });
    expect(flow.background).toHaveLength(0);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("does not claim a non-owner's storyboard request at all", async () => {
    const flow = buildFlow();

    const ignored = await flow.say(NATURAL_REQUEST, "U-someone-else");

    expect(ignored).toBeUndefined();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });
});

/**
 * The incident this guards against: the owner revises a scene AFTER a paid
 * code exists, and the proactive retirement of that code fails.
 *
 * The retirement is a write, and writes fail. What must never depend on it is
 * whether the old code can still submit — so these drive the real routers and
 * the real confirmation gate, with the retirement write throwing, and assert
 * that the code for the superseded version reaches no provider at all.
 */
describe("a revised scene retires its code even when the retirement write fails", () => {
  it("refuses the old code, submits nothing, and keeps the revised storyboard", async () => {
    const flow = buildFlow({ supersedeFails: true });
    const { code } = await driveToDraft(flow, "1");
    expect(await flow.draftStore.lookup(code)).toMatchObject({
      durationSeconds: 15,
      storyboardVersionNumber: 1,
    });

    // The scene changes. The retirement throws, so the old code is left
    // exactly as it was: pending, unexpired, owner-bound, and confirmable.
    const revised = await flow.say("เอาเป็น 30 วิ");
    expect(revised?.text).toContain("Storyboard v2");
    expect(revised?.text).toContain("30");
    expect(await flow.draftStore.lookup(code)).toMatchObject({ status: "pending" });

    const refused = await flow.confirm(code);

    // The one thing that matters: no paid request, by any route.
    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(flow.background).toHaveLength(0);
    expect(await flow.jobStore.entries()).toEqual([]);
    // A specific answer the owner can act on, not a silent drop or a retry.
    expect(refused?.handled).toBe(true);
    expect(refused?.text).toContain("storyboard นี้ถูกแก้ไขแล้ว");
    expect(refused?.text).toContain("เวอร์ชัน 2");
    expect(refused?.text).toContain("สร้างวิดีโอ");
    // Refusing is not consuming: nothing was spent to reject a stale code.
    expect(await flow.draftStore.lookup(code)).toMatchObject({ status: "pending" });
  });

  it("still refuses when the storyboard's current version cannot be read", async () => {
    const flow = buildFlow({ supersedeFails: true, storyboardVersionUnreadable: true });
    const { code } = await driveToDraft(flow, "1");

    const refused = await flow.confirm(code);

    expect(generateVideoMock).not.toHaveBeenCalled();
    expect(flow.background).toHaveLength(0);
    expect(refused?.text).toContain("ตรวจสอบเวอร์ชันล่าสุดของ storyboard ไม่ได้");
    expect(await flow.draftStore.lookup(code)).toMatchObject({ status: "pending" });
  });

  it("the revised scene still reaches a new code, and only that code can submit", async () => {
    const flow = buildFlow();
    const { code: oldCode } = await driveToDraft(flow, "1");

    // The retirement works here, so the owner is told the old code is dead.
    const revised = await flow.say("เอาเป็น 30 วิ");
    expect(revised?.text).toContain("Storyboard v2");
    expect(await flow.draftStore.lookup(oldCode)).toMatchObject({ status: "superseded" });

    // Re-confirming re-derives a compatible model for the NEW length and
    // quotes it: 30 seconds is past H3's ceiling, so the price changes with it.
    const confirmed = await flow.say("ยืนยัน Storyboard");
    expect(confirmed?.text).toContain("ใช้ Default Model หรือเปลี่ยน Model?");
    const drafted = await flow.say("ใช้ Default");
    const newCode = /ยืนยัน VIDEO (\d{4})/u.exec(drafted?.text ?? "")?.[1];
    expect(newCode).toMatch(/^\d{4}$/u);
    expect(newCode).not.toBe(oldCode);
    expect(await flow.draftStore.lookup(newCode!)).toMatchObject({
      providerRoute: { provider: "fal", modelId: SEEDANCE_25 },
      durationSeconds: 30,
      storyboardVersionNumber: 2,
    });

    // The old code stays dead, and the new one is the only thing that submits.
    const stale = await flow.confirm(oldCode);
    expect(stale?.text).toContain("draft นี้ถูกแทนที่แล้ว");
    expect(generateVideoMock).not.toHaveBeenCalled();

    const started = await flow.confirm(newCode!);
    expect(started?.text).toContain("เริ่มสร้างวิดีโอแล้ว");
    await flow.background[0]?.();
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
  });
});
