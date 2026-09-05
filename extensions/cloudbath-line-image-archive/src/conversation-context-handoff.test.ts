/**
 * Contextual understanding, proved by what the flow ENDS UP DOING.
 *
 * The suite next door proves arbitration reads a turn correctly. This one
 * proves the reading is acted on: a deictic message has to leave a revised
 * storyboard behind, an explicit Character has to reach the Character handler,
 * and a message with nothing to point at has to be asked about rather than
 * guessed. `kind: "pass"` is never accepted as the outcome of a case that is
 * supposed to change something.
 *
 * The semantic resolver is a local double, because a model's judgement is not
 * a deterministic test. What IS under test is everything around it: that it
 * receives real recent dialogue rather than an empty list, that the referent it
 * picks is re-bound from OUR state instead of taken from its answer, that the
 * instruction handed on is the owner's own words, and that the mutation is
 * performed by the existing storyboard code.
 *
 * No provider is reachable: the paid runtime is a local stub with a counter and
 * the planner double answers from a table, both without any network call.
 */
import { describe, expect, it } from "vitest";
import type { ConversationSemanticResolver } from "./conversation-semantic-resolver.js";
import {
  projectRecentTurns,
  type ConversationTranscriptReader,
  type ConversationTurn,
} from "./conversation-transcript.js";
import type { StoryboardPaidDraftRuntime } from "./storyboard-paid-draft-runtime.js";
import { StoryboardLlmPlanner } from "./storyboard-planner.js";
import { harness, OTHER_MEMBER, SESSION_KEY } from "./storyboard-router.test-support.js";

/** Opens a storyboard the deictic messages below can refer back to. */
const NATURAL_REQUEST = "เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ";

function stubPaidRuntime(): StoryboardPaidDraftRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    readActiveVideoJob: async () => undefined,
    prepareStoryboardVideoDraft: async () => {
      runtime.calls += 1;
      return { kind: "rejected" as const, reason: "not_used_here" };
    },
  };
  return runtime as unknown as StoryboardPaidDraftRuntime & { calls: number };
}

/** The paid seam reporting one running job, still without any network call. */
function runtimeWithRunningJob(): StoryboardPaidDraftRuntime & { calls: number } {
  const runtime = stubPaidRuntime();
  return {
    ...runtime,
    readActiveVideoJob: async () => ({
      jobId: "job-1",
      draftId: "9566",
      status: "running" as const,
      stage: "provider_submission" as const,
      submittedAt: 1,
    }),
  } as unknown as StoryboardPaidDraftRuntime & { calls: number };
}

/**
 * Answers the planner's two prompts from a table.
 *
 * The edit it returns is deliberately unrelated to the words in the request, so
 * an assertion that the storyboard changed cannot pass by accident: only the
 * real plan-and-append path produces this text.
 */
function stubPlanner(): StoryboardLlmPlanner & { editRequests: string[] } {
  const editRequests: string[] = [];
  const planner = new StoryboardLlmPlanner(async ({ purpose, messages }) => {
    if (purpose === "cloudbath-storyboard-edit") {
      editRequests.push(messages[0]!.content);
      return { text: JSON.stringify({ fromSeconds: 10, toSeconds: 15, action: "REVISED-ENDING" }) };
    }
    return {
      text: JSON.stringify({
        beats: [
          {
            startSeconds: 1,
            endSeconds: 15,
            kind: "action",
            framing: "Medium",
            action: "Twong walks",
            camera: "Static",
            characterNames: ["Twong"],
          },
        ],
      }),
    };
  });
  return Object.assign(planner, { editRequests });
}

/** A transcript double with the same projection production uses. */
function transcriptFor(
  rows: Readonly<Record<string, readonly Readonly<{ role: string; text: string }>[]>>,
): ConversationTranscriptReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    readRecentTurns: async ({ sessionKey, limit, senderScope }) => {
      asked.push(sessionKey);
      return projectRecentTurns(
        // Transcript roles, not this module's own: production feeds `user` /
        // `assistant` straight off the session store, and a double that spoke
        // the projected vocabulary would hide a mapping bug here.
        (rows[sessionKey] ?? []).map((turn) => ({
          role: turn.role === "owner" ? "user" : turn.role,
          message: { content: [{ type: "text", text: turn.text }] },
        })),
        limit,
        senderScope,
      );
    },
  };
}

/** Records what the semantic step was handed, and answers with a fixed verdict. */
function semanticStub(
  verdict: Parameters<ConversationSemanticResolver["resolve"]> extends never
    ? never
    : Awaited<ReturnType<ConversationSemanticResolver["resolve"]>>,
): ConversationSemanticResolver & { seen: { recentTurns: readonly ConversationTurn[] }[] } {
  const seen: { recentTurns: readonly ConversationTurn[] }[] = [];
  return {
    seen,
    resolve: async (input) => {
      seen.push({ recentTurns: input.recentTurns });
      return verdict;
    },
  };
}

const REVISE = {
  intent: "revise_active_storyboard" as const,
  referentType: "storyboard" as const,
  confidence: 0.9,
  needsClarification: false,
};

const HISTORY = [
  { role: "owner", text: NATURAL_REQUEST },
  { role: "assistant", text: "ต้องการความยาวเท่าไร?" },
  { role: "owner", text: "15" },
] as const;

/** Walks a fresh request to a live storyboard the deixis can point at. */
async function withActiveStoryboard(
  options: {
    semanticResolver?: ConversationSemanticResolver;
    transcript?: ConversationTranscriptReader;
  } = {},
) {
  const paid = stubPaidRuntime();
  const planner = stubPlanner();
  const h = harness({
    paidDraftRuntime: paid,
    planner,
    ...(options.semanticResolver ? { semanticResolver: options.semanticResolver } : {}),
    ...(options.transcript ? { transcript: options.transcript } : {}),
  });
  await h.dispatch(NATURAL_REQUEST);
  await h.dispatch("15");
  await h.dispatch("ไม่มี");
  expect((await h.latest()).versionNumber).toBe(1);
  return { h, paid, planner };
}

describe("A: a deictic request that carries a change", () => {
  it("revises the active storyboard, keeping its project and cast", async () => {
    const transcript = transcriptFor({ [SESSION_KEY]: HISTORY });
    const semantic = semanticStub(REVISE);
    const { h, paid, planner } = await withActiveStoryboard({
      semanticResolver: semantic,
      transcript,
    });
    const before = await h.latest();

    const revised = await h.dispatch("เอาแบบเมื่อกี้ แต่เปลี่ยนเป็นกลางคืน");

    // A real new version, not a "we did not answer wrongly".
    expect(revised.conversation?.kind).toBe("route");
    const after = await h.latest();
    expect(after.versionNumber).toBe(before.versionNumber + 1);
    expect(after.storyboardId).toBe(before.storyboardId);
    expect(after.project?.projectInstanceId).toBe(before.project?.projectInstanceId);
    expect(after.document.cast.map((member) => member.characterId)).toEqual(
      before.document.cast.map((member) => member.characterId),
    );
    // "เปลี่ยนเป็นกลางคืน" is a document-level change, so the route hands it to
    // the SAME environment revision the plainly-worded path uses rather than
    // re-planning beats around it. That is what the owner asked for.
    expect(after.document.environment).toBe("กลางคืน");
    expect(planner.editRequests).toEqual([]);
    expect(paid.calls).toBe(0);
  });
});

describe("B: 'แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น'", () => {
  it("actually produces a revised storyboard", async () => {
    const semantic = semanticStub(REVISE);
    const { h, paid } = await withActiveStoryboard({
      semanticResolver: semantic,
      transcript: transcriptFor({ [SESSION_KEY]: HISTORY }),
    });

    const revised = await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(revised.text).toContain("Storyboard v2");
    expect((await h.latest()).versionNumber).toBe(2);
    expect(paid.calls).toBe(0);
  });

  it("hands the semantic step the actual recent dialogue, not an empty list", async () => {
    const semantic = semanticStub(REVISE);
    const transcript = transcriptFor({ [SESSION_KEY]: HISTORY });
    const { h } = await withActiveStoryboard({ semanticResolver: semantic, transcript });

    await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(semantic.seen).toHaveLength(1);
    const turns = semantic.seen[0]!.recentTurns;
    expect(turns.length).toBeGreaterThan(0);
    // Both sides are present and it is real dialogue, not [].
    expect(turns.map((turn) => turn.role)).toContain("assistant");
    expect(turns.map((turn) => turn.text)).toContain(NATURAL_REQUEST);
    // Newest last, and the turn being resolved is not repeated into its own
    // history — it reaches the resolver as `message`.
    expect(turns.at(-1)!.text).toBe("ไม่มี");
    expect(turns.map((turn) => turn.text)).not.toContain("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");
  });
});

describe("C: the same deictic message in a fresh conversation", () => {
  it("asks instead of carrying something over", async () => {
    const semantic = semanticStub(REVISE);
    const paid = stubPaidRuntime();
    const h = harness({
      paidDraftRuntime: paid,
      planner: stubPlanner(),
      semanticResolver: semantic,
      transcript: transcriptFor({}),
    });

    const asked = await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(asked.conversation?.kind).toBe("clarify");
    expect(asked.text).toContain("หมายถึงงานไหน");
    // Nothing to bind, so the model was never even consulted.
    expect(semantic.seen).toHaveLength(0);
    expect(paid.calls).toBe(0);
  });
});

describe("D: a referent the model itself cannot settle", () => {
  it("asks rather than picking one", async () => {
    const semantic = semanticStub({
      intent: "revise_active_storyboard",
      referentType: "storyboard",
      confidence: 0.9,
      needsClarification: true,
    });
    const { h } = await withActiveStoryboard({
      semanticResolver: semantic,
      transcript: transcriptFor({ [SESSION_KEY]: HISTORY }),
    });
    const before = await h.latest();

    const asked = await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(asked.conversation?.kind).toBe("clarify");
    expect((await h.latest()).versionNumber).toBe(before.versionNumber);
  });
});

describe("E: history belonging to a different LINE conversation", () => {
  it("is never read, because the read is scoped by this turn's session", async () => {
    const semantic = semanticStub(REVISE);
    const transcript = transcriptFor({
      "line:group:CsomeoneElse": [{ role: "owner", text: "ความลับของกลุ่มอื่น" }],
    });
    const { h } = await withActiveStoryboard({ semanticResolver: semantic, transcript });

    await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    expect(transcript.asked).toEqual([SESSION_KEY]);
    // The other group's history is not merely filtered out — it was never
    // asked for. What remains is this owner's own recorded turns.
    expect(JSON.stringify(semantic.seen)).not.toContain("ความลับ");
    expect(semantic.seen[0]!.recentTurns.every((turn) => turn.role === "owner")).toBe(true);
  });
});

describe("F: a Character named outright while a video is running", () => {
  it("reaches the Character handler rather than the video status path", async () => {
    const reached: string[] = [];
    const withJob = runtimeWithRunningJob();
    const h = harness({
      paidDraftRuntime: withJob,
      characterHandler: async (content) => {
        reached.push(content);
        return { handled: true as const, text: "CHAR-6 บันทึกแล้ว" };
      },
    });

    const asked = await h.dispatch("Twong บันทึกเสร็จยัง");

    // The end state, not just "did not answer as video".
    expect(asked.source).toBe("character");
    expect(asked.text).toBe("CHAR-6 บันทึกแล้ว");
    expect(reached).toEqual(["Twong บันทึกเสร็จยัง"]);
  });
});

describe("G: the same question with no Character named", () => {
  it("answers about the running video", async () => {
    const withJob = runtimeWithRunningJob();
    const h = harness({
      paidDraftRuntime: withJob,
      characterHandler: async () => undefined,
    });

    const asked = await h.dispatch("เสร็จยัง");

    expect(asked.source).toBe("conversation");
    expect(asked.text).toContain("VIDEO 9566");
  });
});

describe("H: buttons stay deterministic", () => {
  it("resolves a chip without consulting the model at all", async () => {
    const semantic = semanticStub(REVISE);
    const paid = stubPaidRuntime();
    const h = harness({
      paidDraftRuntime: paid,
      planner: stubPlanner(),
      semanticResolver: semantic,
      transcript: transcriptFor({ [SESSION_KEY]: HISTORY }),
    });
    const opened = await h.dispatch(NATURAL_REQUEST);
    const block = opened.presentation?.blocks[0];
    const chip = block?.type === "buttons" ? block.buttons[0]!.action : undefined;

    const pressed = await h.dispatch(chip?.type === "callback" ? chip.value : "");

    expect(pressed.conversation).toEqual({ kind: "rewrite", canonicalText: "15 วิ" });
    expect(semantic.seen).toHaveLength(0);
  });
});

describe("I: the paid trigger", () => {
  it("is not reachable through any semantic route", async () => {
    // The model asks for new work; the route may only carry the owner's own
    // words and a cast from resolved state, so a paid phrase cannot ride along.
    const semantic = semanticStub({
      intent: "new_request",
      referentType: "storyboard",
      requestedAction: "ยืนยัน VIDEO 9566",
      confidence: 0.99,
      needsClarification: false,
    });
    const { h, paid } = await withActiveStoryboard({
      semanticResolver: semantic,
      transcript: transcriptFor({ [SESSION_KEY]: HISTORY }),
    });

    const answered = await h.dispatch("เอาแบบเดิมอีกอันนึง");

    expect(answered.text ?? "").not.toMatch(/ยืนยัน VIDEO/u);
    expect(paid.calls).toBe(0);
  });
});

describe("a Character whose name sits inside another", () => {
  it("does not match the shorter name when the longer one was written", async () => {
    const paid = stubPaidRuntime();
    const withJob = {
      ...paid,
      readActiveVideoJob: async () => ({
        jobId: "job-1",
        draftId: "9566",
        status: "running" as const,
        submittedAt: 1,
      }),
    } as unknown as StoryboardPaidDraftRuntime & { calls: number };
    const seen: string[][] = [];
    const semantic: ConversationSemanticResolver = {
      resolve: async (input) => {
        seen.push(input.entities.map((entity) => entity.id));
        return undefined;
      },
    };
    const h = harness({
      paidDraftRuntime: withJob,
      semanticResolver: semantic,
      // "F9" would be a substring of "F99"; "Twong" of "Twong2".
      resolverNames: ["F9", "F99", "Twong", "Twong2"],
    });

    // A progress question naming F99 must resolve to F99 alone, so it declines
    // rather than answering about the running video.
    const asked = await h.dispatch("F99 เสร็จยัง");

    expect(asked.conversation).toEqual({ kind: "pass" });
    expect(asked.text ?? "").not.toContain("VIDEO 9566");
  });

  it("still matches a name written on its own", async () => {
    const h = harness({
      paidDraftRuntime: runtimeWithRunningJob(),
      resolverNames: ["F9", "F99"],
    });

    // F9 IS named, so the turn is about F9 and not about the running video.
    const asked = await h.dispatch("F9 เสร็จยัง");

    expect(asked.conversation).toEqual({ kind: "pass" });
    expect(asked.text ?? "").not.toContain("VIDEO 9566");
  });

  it("does not read a name out of a longer run of letters or digits", async () => {
    const h = harness({
      paidDraftRuntime: runtimeWithRunningJob(),
      resolverNames: ["F9"],
    });

    // "F91" is not F9, so nothing is named and the question is about the video.
    const asked = await h.dispatch("F91 เสร็จยัง");

    expect(asked.source).toBe("conversation");
    expect(asked.text).toContain("VIDEO 9566");
  });
});

describe("one LINE group, two senders, one session key", () => {
  /**
   * The leak this guards against. A group routes on the group id, so U1 and U2
   * share a session key, and the canonical transcript's user messages carry no
   * author. Presenting U2's words to the resolver as the owner's would put
   * another member in charge of U1's work.
   */
  it("never presents another member's message as an owner turn", async () => {
    const semantic = semanticStub(REVISE);
    // The transcript holds the WHOLE group, exactly as production would: both
    // members' user turns and the assistant's reply, on one session key.
    const transcript = transcriptFor({
      [SESSION_KEY]: [
        { role: "user", text: NATURAL_REQUEST },
        { role: "user", text: "ไม่เอาอันนั้น ใช้ตัวเดิม" },
        { role: "assistant", text: "ต้องการความยาวเท่าไร?" },
      ],
    });
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(),
      planner: stubPlanner(),
      semanticResolver: semantic,
      transcript,
    });

    // U1 (the bound owner) speaks, then U2 (another member), then U1 again.
    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("ไม่เอาอันนั้น ใช้ตัวเดิม", { senderId: OTHER_MEMBER });
    await h.dispatch("15");
    await h.dispatch("ไม่มี");
    semantic.seen.length = 0;

    await h.dispatch("แบบเมื่อกี้");

    expect(semantic.seen).toHaveLength(1);
    const turns = semantic.seen[0]!.recentTurns;
    // U1's own words are there, and the assistant's.
    expect(turns.map((turn) => turn.text)).toContain(NATURAL_REQUEST);
    expect(turns.map((turn) => turn.role)).toContain("assistant");
    // U2's message is absent entirely — not merely present under another role.
    expect(turns.map((turn) => turn.text)).not.toContain("ไม่เอาอันนั้น ใช้ตัวเดิม");
    expect(JSON.stringify(turns)).not.toContain("ไม่เอาอันนั้น");
    for (const turn of turns) {
      expect(["owner", "assistant"]).toContain(turn.role);
    }
  });

  it("does not record a non-owner turn into the owner's own history at all", async () => {
    const h = harness({ paidDraftRuntime: stubPaidRuntime(), planner: stubPlanner() });

    await h.dispatch(NATURAL_REQUEST);
    await h.dispatch("ความลับของสมาชิกอีกคน", { senderId: OTHER_MEMBER });

    const [entry] = await h.conversationContext.entries();
    const recorded = (entry?.value.recentOwnerTurns ?? []).map((turn) => turn.text);
    expect(recorded).toContain(NATURAL_REQUEST);
    expect(recorded).not.toContain("ความลับของสมาชิกอีกคน");
  });

  it("takes user turns from the transcript when the session has one sender", async () => {
    const semantic = semanticStub(REVISE);
    const transcript = transcriptFor({
      [SESSION_KEY]: [{ role: "user", text: "ในแชทส่วนตัว" }],
    });
    const h = harness({
      paidDraftRuntime: stubPaidRuntime(),
      planner: stubPlanner(),
      semanticResolver: semantic,
      transcript,
      directChat: true,
    });
    await h.dispatch("เอา Twong ทำวิดีโอ เดินอยู่ในสวน แล้วเตะขวดน้ำ");
    await h.dispatch("15");
    await h.dispatch("ไม่มี");
    semantic.seen.length = 0;

    await h.dispatch("แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น");

    // A direct chat IS the sender, so a persisted user turn is attributable.
    expect(semantic.seen[0]!.recentTurns.map((turn) => turn.text)).toContain("ในแชทส่วนตัว");
  });
});
