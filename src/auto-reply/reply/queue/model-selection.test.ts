// Tests committed explicit model selections reaching every queued run of a session.
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { refreshQueuedFollowupModelSelection } from "./model-selection.js";
import { clearFollowupQueue, getExistingFollowupQueue, getFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

const SESSION_KEY = "agent:main:line:group:c0ffee";
const OTHER_SESSION_KEY = "agent:main:line:group:cbeef";
const CFG = {} as OpenClawConfig;
const LUNA = { provider: "openrouter", model: "openai/gpt-6-luna" };

afterEach(() => {
  clearFollowupQueue(SESSION_KEY);
  clearFollowupQueue(OTHER_SESSION_KEY);
});

function makeRun(sessionKey = SESSION_KEY): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: CFG,
    provider: "openrouter",
    model: "qwen/qwen3.8-27b",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

function queuedTurn(prompt: string, sessionKey = SESSION_KEY): FollowupRun {
  return { prompt, enqueuedAt: Date.now(), run: makeRun(sessionKey) };
}

function savedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    providerOverride: LUNA.provider,
    modelOverride: LUNA.model,
    modelOverrideSource: "user",
    ...overrides,
  };
}

/** A queue holding turns in every place the drain can execute them from. */
function populateQueue(sessionKey = SESSION_KEY) {
  const queue = getFollowupQueue(sessionKey, { mode: "collect" });
  queue.lastRun = makeRun(sessionKey);
  queue.items.push(queuedTurn("first", sessionKey), queuedTurn("second", sessionKey));
  queue.summarySources.push(queuedTurn("summarized", sessionKey));
  queue.summaryElisions.push({
    contextKey: "context",
    count: 1,
    sources: [queuedTurn("elided", sessionKey)],
    sourceRefs: new WeakMap(),
  });
  return queue;
}

function allRuns(queue: ReturnType<typeof populateQueue>) {
  return [
    queue.lastRun,
    ...queue.items.map((item) => item.run),
    ...queue.summarySources.map((item) => item.run),
    ...queue.summaryElisions.flatMap((entry) => entry.sources.map((item) => item.run)),
  ];
}

describe("refreshQueuedFollowupModelSelection", () => {
  it("retargets every queued turn, the last run and collapsed summaries", () => {
    const queue = populateQueue();

    refreshQueuedFollowupModelSelection({
      cfg: CFG,
      sessionKey: SESSION_KEY,
      selection: LUNA,
      entry: savedEntry(),
      agentId: "main",
    });

    const runs = allRuns(queue);
    expect(runs).toHaveLength(5);
    for (const run of runs) {
      expect(run).toMatchObject({
        ...LUNA,
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      });
    }
    expect(queue.items.map((item) => item.prompt)).toEqual(["first", "second"]);
  });

  it("carries the saved auth profile and thinking level", () => {
    const queue = populateQueue();

    refreshQueuedFollowupModelSelection({
      cfg: CFG,
      sessionKey: SESSION_KEY,
      selection: LUNA,
      entry: savedEntry({
        authProfileOverride: "openrouter:work",
        authProfileOverrideSource: "user",
        thinkingLevel: "low",
      }),
      agentId: "main",
    });

    for (const run of allRuns(queue)) {
      expect(run).toMatchObject({
        authProfileId: "openrouter:work",
        authProfileIdSource: "user",
        thinkLevel: "low",
      });
    }
  });

  it("clears an auth profile the save removed", () => {
    const queue = populateQueue();
    queue.items[0]!.run.authProfileId = "openrouter:stale";
    queue.items[0]!.run.authProfileIdSource = "user";

    refreshQueuedFollowupModelSelection({
      cfg: CFG,
      sessionKey: SESSION_KEY,
      selection: LUNA,
      entry: savedEntry(),
    });

    expect(queue.items[0]!.run.authProfileId).toBeUndefined();
    expect(queue.items[0]!.run.authProfileIdSource).toBeUndefined();
  });

  it("leaves other sessions' queues untouched", () => {
    populateQueue();
    const other = populateQueue(OTHER_SESSION_KEY);

    refreshQueuedFollowupModelSelection({
      cfg: CFG,
      sessionKey: SESSION_KEY,
      selection: LUNA,
      entry: savedEntry(),
    });

    for (const run of allRuns(other)) {
      expect(run).toEqual(makeRun(OTHER_SESSION_KEY));
    }
  });

  it("is a no-op that creates no queue when nothing is queued", () => {
    refreshQueuedFollowupModelSelection({
      cfg: CFG,
      sessionKey: SESSION_KEY,
      selection: LUNA,
      entry: savedEntry(),
    });

    expect(getExistingFollowupQueue(SESSION_KEY)).toBeUndefined();
  });
});
