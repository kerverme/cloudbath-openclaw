/**
 * One canonical model selection per LINE session.
 *
 * Production: the owner asked LINE to switch to DeepSeek, picked "1", and the
 * bot confirmed "เปลี่ยนเป็น DeepSeek: DeepSeek Flash Latest แล้ว" — yet later
 * turns still reported Qwen as the session's selected model. These cases drive
 * the real picker against a real session store so the persisted row, not a
 * stubbed applier, is what gets asserted: after a switch the session's
 * provider/model override IS the chosen model and nothing of the previous
 * model is left behind for a later turn to resurrect.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLineSessionModelApplier,
  LINE_MODEL_SELECTION_TTL_MS,
  type LinePendingModelSelection,
} from "./model-catalog-tool.js";
import { createLineModelSwitchIntentRouter } from "./model-switch-router.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:line:U6b";
const SECRET = "test-secret-never-log";
const QWEN = "qwen/qwen3.8-27b";
const DEEPSEEK_FLASH = "deepseek/deepseek-v4-flash-0731";
const DEEPSEEK_CHAT = "deepseek/deepseek-v4-chat";
const LUNA = "openai/gpt-5.6-luna";

type CatalogFixture = { id: string; name: string };

/** Names are ordered so the catalog's own sort puts Flash Latest at choice 1. */
const DEEPSEEK_CATALOG: CatalogFixture[] = [
  { id: DEEPSEEK_FLASH, name: "DeepSeek Flash Latest" },
  { id: DEEPSEEK_CHAT, name: "DeepSeek V4 Chat" },
];
const FULL_CATALOG: CatalogFixture[] = [...DEEPSEEK_CATALOG, { id: LUNA, name: "GPT-5.6 Luna" }];

function createMemoryPendingStore(now: () => number) {
  const values = new Map<string, { value: LinePendingModelSelection; expiresAt: number }>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async register(key, value, options) {
      values.set(key, {
        value,
        expiresAt: now() + (options?.ttlMs ?? LINE_MODEL_SELECTION_TTL_MS),
      });
    },
    async registerIfAbsent(key, value, options) {
      if (read(key)) {
        return false;
      }
      await this.register(key, value, options);
      return true;
    },
    async lookup(key) {
      return read(key)?.value;
    },
    async consume(key) {
      const value = read(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.keys()].flatMap((key) => {
        const entry = read(key);
        return entry ? [{ key, ...entry, createdAt: 0 }] : [];
      });
    },
    async clear() {
      values.clear();
    },
  } satisfies PluginStateKeyedStore<LinePendingModelSelection>;
}

let tempDir: string;
let previousStateDir: string | undefined;
let clock = Date.parse("2026-09-21T09:00:00.000Z");

const now = () => clock;

/** The real router, wired to the real session-store applier. */
function createRouter(catalog: CatalogFixture[] = FULL_CATALOG) {
  return createLineModelSwitchIntentRouter({
    pendingStore: createMemoryPendingStore(now),
    resolveApiKey: async () => SECRET,
    buildSessionModelApplier: createLineSessionModelApplier,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: catalog }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    now,
  });
}

function ownerEvent(body: string) {
  return {
    content: body,
    body,
    channel: "line",
    senderId: "U6b",
    senderIsOwner: true,
    sessionKey: SESSION_KEY,
  };
}

const CTX = { sessionKey: SESSION_KEY, agentId: AGENT_ID };

async function seedSelectedModel(model: string): Promise<void> {
  await upsertSessionEntry({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    entry: {
      sessionId: "sess-1",
      providerOverride: "openrouter",
      modelOverride: model,
      modelOverrideSource: "user",
      modelProvider: "openrouter",
      model,
      updatedAt: now(),
    } as SessionEntry,
  });
}

/** The session's canonical selection, read back from the store. */
function readEntry(): SessionEntry | undefined {
  clearSessionStoreCacheForTest();
  return getSessionEntry({ agentId: AGENT_ID, sessionKey: SESSION_KEY, readConsistency: "latest" });
}

beforeEach(() => {
  clock = Date.parse("2026-09-21T09:00:00.000Z");
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-model-")));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDir;
  clearSessionStoreCacheForTest();
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  clearSessionStoreCacheForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("a completed LINE switch leaves exactly one selected model", () => {
  it("replays the production turn: Qwen, ask for DeepSeek, answer 1", async () => {
    await seedSelectedModel(QWEN);
    const router = createRouter();

    const listing = await router(ownerEvent("เปลี่ยนโมเดลเป็น deepseek หน่อย"), CTX);
    expect(listing?.text).toContain("1. DeepSeek Flash Latest");

    const chosen = await router(ownerEvent("1"), CTX);
    expect(chosen?.text).toBe("เปลี่ยนเป็น DeepSeek Flash Latest แล้ว");

    const entry = readEntry();
    expect(entry).toMatchObject({
      providerOverride: "openrouter",
      modelOverride: DEEPSEEK_FLASH,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    // The confirmation and the session row must not disagree, and no trace of
    // the previous model may remain for a later turn to resolve back to.
    expect(JSON.stringify(entry)).not.toContain("qwen");
  });

  it.each([
    ["Luna to DeepSeek", LUNA, "switch to deepseek-v4-flash-0731", DEEPSEEK_FLASH],
    ["DeepSeek to Luna", DEEPSEEK_FLASH, "switch to gpt-5.6-luna", LUNA],
  ])("carries %s through to the session row", async (_label, seeded, request, expected) => {
    await seedSelectedModel(seeded);

    const result = await createRouter()(ownerEvent(request), CTX);

    expect(result?.handled).toBe(true);
    expect(readEntry()).toMatchObject({ providerOverride: "openrouter", modelOverride: expected });
    expect(JSON.stringify(readEntry())).not.toContain(seeded);
  });

  it("survives a cold read of the store", async () => {
    await seedSelectedModel(QWEN);
    const router = createRouter();
    await router(ownerEvent("เปลี่ยนโมเดลเป็น deepseek หน่อย"), CTX);
    await router(ownerEvent("1"), CTX);

    // Same assertion, but from a store cache that knows nothing about this run.
    clearSessionStoreCacheForTest();

    expect(readEntry()?.modelOverride).toBe(DEEPSEEK_FLASH);
  });
});

describe("a stale numbered choice cannot select a model", () => {
  it("binds the number to the newest listing, not the one it replaced", async () => {
    await seedSelectedModel(QWEN);
    const router = createRouter();

    await router(ownerEvent("เปลี่ยนโมเดลเป็น deepseek หน่อย"), CTX);
    // A second request replaces the first listing before any number is sent.
    const second = await router(ownerEvent("เปลี่ยนโมเดลเป็น gpt หน่อย"), CTX);
    expect(second?.handled).toBe(true);

    await router(ownerEvent("1"), CTX);

    // "1" must resolve against the GPT listing; the DeepSeek listing it
    // replaced can no longer supply a candidate for it.
    expect(readEntry()?.modelOverride).not.toBe(DEEPSEEK_FLASH);
  });

  it("leaves the session untouched once the listing has expired", async () => {
    await seedSelectedModel(QWEN);
    const router = createRouter();
    await router(ownerEvent("เปลี่ยนโมเดลเป็น deepseek หน่อย"), CTX);

    clock += LINE_MODEL_SELECTION_TTL_MS + 1;
    const result = await router(ownerEvent("1"), CTX);

    // No pending listing: the bare number is ordinary chat, and the session's
    // selected model is exactly what it was.
    expect(result).toBeUndefined();
    expect(readEntry()?.modelOverride).toBe(QWEN);
  });
});
