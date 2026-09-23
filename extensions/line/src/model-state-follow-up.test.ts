/**
 * A follow-up to a model-state answer resolves against the model it named.
 *
 * Production: after a deterministic answer about a model, "เปลี่ยนให้หน่อย"
 * named no model, fell through to the referent resolver and DeepSeek, and a
 * later "ทำไมเปลี่ยนเองไม่ได้ใช้ผ่าน openrouter" was answered with an invented
 * need for a separate OpenAI API key. These cases drive the real handler,
 * the real switch path and a real session store through whole conversations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinePendingModelSelection } from "./model-catalog-tool.js";
import {
  classifyLineModelFollowUp,
  LINE_MODEL_REFERENCE_RETENTION_MS,
  LINE_MODEL_REFERENCE_TTL_MS,
  type LineModelReference,
} from "./model-reference.js";
import { createLineModelStateRouter } from "./model-state-router.js";
import { createLineModelSwitchIntentRouter } from "./model-switch-router.js";

const AGENT_ID = "main";
const OWNER = "U-owner";
const SESSION_KEY = "agent:main:line:group:c-follow-up";
const OTHER_SESSION_KEY = "agent:main:line:group:c-typed-switch";
const DEEPSEEK_FLASH = "deepseek/deepseek-v4-flash-0731";
const LUNA = "openai/gpt-5.6-luna";

const CATALOG = [
  { id: LUNA, name: "OpenAI: GPT-5.6 Luna" },
  { id: "openai/gpt-5.6-sol", name: "OpenAI: GPT-5.6 Sol" },
  { id: DEEPSEEK_FLASH, name: "DeepSeek: DeepSeek V4 Flash" },
];
const CONFIG = {
  agents: { defaults: { model: { primary: `openrouter/${DEEPSEEK_FLASH}` } } },
} as OpenClawConfig;

let clock = 0;
let tempDir: string;
let previousStateDir: string | undefined;
let keyRequests: string[] = [];

function memoryStore<T>(defaultTtlMs: number): PluginStateKeyedStore<T> {
  const values = new Map<string, { value: T; expiresAt: number }>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt <= clock) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async register(key, value, options) {
      values.set(key, { value, expiresAt: clock + (options?.ttlMs ?? defaultTtlMs) });
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
        return entry ? [{ key, value: entry.value, createdAt: 0 }] : [];
      });
    },
    async clear() {
      values.clear();
    },
  };
}

const deps = () => ({
  pendingStore: memoryStore<LinePendingModelSelection>(10 * 60 * 1000),
  resolveApiKey: async (providerId: string) => {
    keyRequests.push(providerId);
    return "test-openrouter-key";
  },
  fetchImpl: async () => new Response(JSON.stringify({ data: CATALOG }), { status: 200 }),
  now: () => clock,
});

function conversation() {
  const router = createLineModelStateRouter({
    ...deps(),
    referenceStore: memoryStore<LineModelReference>(LINE_MODEL_REFERENCE_RETENTION_MS),
    readConfig: () => CONFIG,
  });
  return async (text: string, senderIsOwner = true) =>
    await router(
      { content: text, body: text, channel: "line", senderId: OWNER, senderIsOwner },
      { sessionKey: SESSION_KEY, agentId: AGENT_ID },
    );
}

async function seedSession(sessionKey: string): Promise<void> {
  await upsertSessionEntry({
    agentId: AGENT_ID,
    sessionKey,
    entry: {
      sessionId: `sess-${sessionKey}`,
      providerOverride: "openrouter",
      modelOverride: DEEPSEEK_FLASH,
      modelOverrideSource: "user",
      updatedAt: 1,
    } as SessionEntry,
  });
}

function readEntry(sessionKey = SESSION_KEY): SessionEntry | undefined {
  clearSessionStoreCacheForTest();
  return getSessionEntry({ agentId: AGENT_ID, sessionKey, readConsistency: "latest" });
}

function modelFields(entry: SessionEntry | undefined) {
  return {
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    modelOverrideSource: entry?.modelOverrideSource,
    liveModelSwitchPending: entry?.liveModelSwitchPending,
  };
}

const UNCHANGED = {
  providerOverride: "openrouter",
  modelOverride: DEEPSEEK_FLASH,
  modelOverrideSource: "user",
  liveModelSwitchPending: undefined,
};
const SWITCHED_TO_LUNA = {
  providerOverride: "openrouter",
  modelOverride: LUNA,
  modelOverrideSource: "user",
  liveModelSwitchPending: true,
};

beforeEach(async () => {
  clock = Date.parse("2026-09-23T09:00:00.000Z");
  keyRequests = [];
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-follow-up-")));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDir;
  clearSessionStoreCacheForTest();
  await seedSession(SESSION_KEY);
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

describe("a follow-up switches to the exact model the answer established", () => {
  it.each(["เปลี่ยนให้หน่อย", "ใช้ตัวนี้", "เอาตัวนี้", "ทำไมเปลี่ยนเองไม่ได้ใช้ผ่าน openrouter"])(
    "มี GPT-5.6 Luna ไหม -> %s",
    async (followUp) => {
      const say = conversation();
      expect((await say("มี GPT-5.6 Luna ไหม"))?.text).toMatch(/^มี OpenAI: GPT-5\.6 Luna/u);

      const result = await say(followUp);

      expect(result).toEqual({ handled: true, text: "เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว" });
      expect(modelFields(readEntry())).toEqual(SWITCHED_TO_LUNA);
    },
  );

  it("does the same for an English conversation", async () => {
    const say = conversation();
    await say("Is GPT-5.6 Luna available?");

    const result = await say("switch to it");

    expect(result?.text).toBe("Switched to OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna).");
    expect(modelFields(readEntry())).toEqual(SWITCHED_TO_LUNA);
  });

  it("asks for nothing but the OpenRouter key: an OpenAI-developed model needs no OpenAI key", async () => {
    const say = conversation();
    await say("มี GPT-5.6 Luna ไหม");

    const result = await say("ทำไมเปลี่ยนเองไม่ได้ใช้ผ่าน openrouter");

    expect(new Set(keyRequests)).toEqual(new Set(["openrouter"]));
    expect(result?.text).not.toMatch(/api key|คีย์|openai key/iu);
    expect(readEntry()?.providerOverride).toBe("openrouter");
  });
});

describe("a suggestion is never switched to without an explicit confirmation", () => {
  it("offers the similar model instead of switching to it", async () => {
    const say = conversation();
    expect((await say("มี GPT-6 Luna ไหม"))?.text).toMatch(/^ไม่มี "GPT-6 Luna"/u);

    const result = await say("เปลี่ยนให้หน่อย");

    expect(result?.text).toBe(
      'ไม่มี "GPT-6 Luna" ในแคตตาล็อก OpenRouter ของบัญชีนี้ แต่มี OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)\nต้องการเปลี่ยนเป็น OpenAI: GPT-5.6 Luna ไหมครับ?',
    );
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });

  it.each(["ใช่ เอาตัวนั้น", "ใช่", "เปลี่ยนให้หน่อย", "yes, use it"])(
    "switches to exactly the offered model on %s",
    async (confirmation) => {
      const say = conversation();
      await say("มี GPT-6 Luna ไหม");
      await say("เปลี่ยนให้หน่อย");

      const result = await say(confirmation);

      expect(result?.handled).toBe(true);
      expect(modelFields(readEntry())).toEqual(SWITCHED_TO_LUNA);
    },
  );

  it("drops the offer when the owner declines", async () => {
    const say = conversation();
    await say("มี GPT-6 Luna ไหม");
    await say("เปลี่ยนให้หน่อย");

    expect(await say("ไม่เอา")).toEqual({ handled: true, text: "โอเคครับ ไม่เปลี่ยนโมเดล" });
    // Nothing is left to switch to: a later bare follow-up is not about a model.
    expect(await say("เปลี่ยนให้หน่อย")).toBeUndefined();
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });
});

describe("no model to act on: ask which, never guess and never hand off", () => {
  it("asks after the reference has expired", async () => {
    const say = conversation();
    await say("มี GPT-5.6 Luna ไหม");
    clock += LINE_MODEL_REFERENCE_TTL_MS + 1;

    expect(await say("เปลี่ยนให้หน่อย")).toEqual({
      handled: true,
      text: "ต้องการเปลี่ยนเป็นโมเดลไหนครับ?",
    });
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });

  it("asks when the answer named several models", async () => {
    const say = conversation();
    await say("มีโมเดล OpenAI อะไรบ้าง");

    expect((await say("เปลี่ยนให้หน่อย"))?.text).toBe(
      'ต้องการเปลี่ยนเป็นโมเดลไหนครับ?\n• OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)\n• OpenAI: GPT-5.6 Sol (openai/gpt-5.6-sol)\nพิมพ์ "เปลี่ยนเป็น <ชื่อรุ่น>" ได้เลย',
    );
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });
});

describe("only follow-ups are claimed", () => {
  it("leaves another request alone and lets it end the model conversation", async () => {
    const say = conversation();
    await say("มี GPT-5.6 Luna ไหม");

    expect(await say("เปลี่ยนเพลงให้หน่อย")).toBeUndefined();
    // The song request moved the conversation on; the model is no longer "it".
    expect(await say("เปลี่ยนให้หน่อย")).toBeUndefined();
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });

  it("claims nothing without an earlier model answer", async () => {
    const say = conversation();

    expect(await say("เปลี่ยนให้หน่อย")).toBeUndefined();
    expect(keyRequests).toEqual([]);
  });

  it("ignores a non-owner's follow-up", async () => {
    const say = conversation();
    await say("มี GPT-5.6 Luna ไหม");

    expect(await say("เปลี่ยนให้หน่อย", false)).toBeUndefined();
    expect(modelFields(readEntry())).toEqual(UNCHANGED);
  });

  it.each([
    ["เปลี่ยนให้หน่อย", "switch"],
    ["ใช้ตัวนี้", "switch"],
    ["เอาตัวนี้", "switch"],
    ["เปลี่ยนเป็นตัวนี้", "switch"],
    ["เอาอันนี้เลย", "switch"],
    ["ทำไมเปลี่ยนเองไม่ได้ใช้ผ่าน openrouter", "switch"],
    ["switch to it", "switch"],
    ["use this one", "switch"],
    ["use that one", "switch"],
    ["switch to this", "switch"],
    ["yes, use it", "switch"],
    ["ใช่อันนี้", "affirm"],
    ["ใช่", "affirm"],
    ["ไม่เอา", "decline"],
    ["ไม่ใช่", "decline"],
    ["ไม่ต้องเปลี่ยน", "decline"],
    ["เปลี่ยนเพลงให้หน่อย", undefined],
    ["ใช่ไหม", undefined],
    ["ผู้ใช้", undefined],
    ["เอาไว้ก่อน", undefined],
    ["change the song", undefined],
    ["เปลี่ยนเป็น GPT-5.6 Sol", undefined],
  ])("classifies %s as %s", (text, expected) => {
    expect(classifyLineModelFollowUp(text)).toBe(expected);
  });
});

describe("the follow-up switch is the typed switch", () => {
  it("writes exactly what the switch router writes for the same model", async () => {
    await seedSession(OTHER_SESSION_KEY);
    const say = conversation();
    await say("มี GPT-5.6 Luna ไหม");
    await say("เปลี่ยนให้หน่อย");

    const typed = await createLineModelSwitchIntentRouter(deps())(
      {
        content: `เปลี่ยนเป็น ${LUNA}`,
        body: `เปลี่ยนเป็น ${LUNA}`,
        channel: "line",
        senderId: OWNER,
        senderIsOwner: true,
      },
      { sessionKey: OTHER_SESSION_KEY, agentId: AGENT_ID },
    );

    expect(typed?.text).toBe("เปลี่ยนเป็น OpenAI: GPT-5.6 Luna แล้ว");
    expect(modelFields(readEntry())).toEqual(modelFields(readEntry(OTHER_SESSION_KEY)));
    expect(modelFields(readEntry())).toEqual(SWITCHED_TO_LUNA);
  });
});
