/**
 * LINE model-state questions are answered from canonical state only.
 *
 * Production: asked "อันนี้ละมีไหม OpenAI: GPT-6 Luna", the agent searched the
 * web and described a model that is not in the account's catalog. These cases
 * drive the real handler against a real session store and a catalog fixture,
 * so what is asserted is the answer the owner reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyLineModelStateQuestion,
  createLineModelControlRouter,
} from "./model-control-router.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:line:group:c-owner-group";
const DEEPSEEK_FLASH = "deepseek/deepseek-v4-flash-0731";
const LUNA = "openai/gpt-5.6-luna";

const CATALOG = [
  { id: LUNA, name: "OpenAI: GPT-5.6 Luna" },
  { id: "openai/gpt-5.6-sol", name: "OpenAI: GPT-5.6 Sol" },
  { id: DEEPSEEK_FLASH, name: "DeepSeek: DeepSeek V4 Flash" },
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
];

const CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openrouter/qwen/qwen3.8-27b" },
      models: { [`openrouter/${LUNA}`]: { alias: "luna" } },
    },
  },
} as OpenClawConfig;

let tempDir: string;
let previousStateDir: string | undefined;
let catalogRequests = 0;

function router(options: { catalogStatus?: number } = {}) {
  return createLineModelControlRouter({
    resolveApiKey: async () => "test-openrouter-key",
    readConfig: () => CONFIG,
    fetchImpl: async () => {
      catalogRequests += 1;
      return options.catalogStatus
        ? new Response("unavailable", { status: options.catalogStatus })
        : new Response(JSON.stringify({ data: CATALOG }), { status: 200 });
    },
  }).early;
}

function ownerTurn(text: string, senderIsOwner = true) {
  return [
    {
      content: text,
      body: text,
      channel: "line",
      senderId: "U-owner",
      senderIsOwner,
      sessionKey: SESSION_KEY,
    },
    { sessionKey: SESSION_KEY, agentId: AGENT_ID },
  ] as const;
}

async function ask(text: string, handle = router()) {
  return await handle(...ownerTurn(text));
}

async function seedSelectedModel(): Promise<void> {
  await upsertSessionEntry({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    entry: {
      sessionId: "sess-1",
      providerOverride: "openrouter",
      modelOverride: DEEPSEEK_FLASH,
      modelOverrideSource: "user",
      modelProvider: "openrouter",
      model: DEEPSEEK_FLASH,
      updatedAt: 1,
    } as SessionEntry,
  });
}

function readEntry(): SessionEntry | undefined {
  clearSessionStoreCacheForTest();
  return getSessionEntry({ agentId: AGENT_ID, sessionKey: SESSION_KEY, readConsistency: "latest" });
}

beforeEach(() => {
  catalogRequests = 0;
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-model-state-")));
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

describe("a model that is not in the catalog is never called available", () => {
  it.each(["มี GPT-6 Luna ไหม", "อันนี้ละมีไหม OpenAI: GPT-6 Luna", "มีโมเดล gpt 6 luna มั้ย"])(
    "%s => NOT AVAILABLE, with GPT-5.6 Luna only as a different model",
    async (text) => {
      const result = await ask(text);

      expect(result?.handled).toBe(true);
      // The owner's own wording is echoed back; it is never rewritten into a model.
      expect(result?.text).toMatch(/^ไม่มี ".*gpt[- ]6 luna" ในแคตตาล็อก OpenRouter ของบัญชีนี้/iu);
      expect(result?.text).toContain(
        "รุ่นอื่นที่มีชื่อคล้ายกัน (ไม่ใช่รุ่นที่ถาม): OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)",
      );
      expect(result?.text).not.toMatch(/^มี /u);
    },
  );

  it("answers in English for an English question", async () => {
    const result = await ask("Is GPT-6 Luna available?");

    expect(result?.text).toMatch(/^"GPT-6 Luna" is not in this account's OpenRouter catalog/u);
  });
});

describe("AVAILABLE only for an exact name or alias", () => {
  it.each(["มี GPT-5.6 Luna ไหม", "มี OpenAI: GPT-5.6 Luna ไหม", "มี openai/gpt-5.6-luna ไหม"])(
    "%s => AVAILABLE",
    async (text) => {
      const result = await ask(text);

      expect(result?.text).toBe(
        'มี OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna) ในแคตตาล็อก OpenRouter ของบัญชีนี้\nพิมพ์ "เปลี่ยนเป็น openai/gpt-5.6-luna" ถ้าต้องการใช้',
      );
    },
  );

  it("resolves a configured alias through the same exact rule", async () => {
    const result = await ask("มี luna ไหม");

    expect(result?.text).toBe(
      'มี OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna) ในแคตตาล็อก OpenRouter ของบัญชีนี้\n("luna" คือชื่อเรียกที่ตั้งไว้ของ openrouter/openai/gpt-5.6-luna)\nพิมพ์ "เปลี่ยนเป็น openai/gpt-5.6-luna" ถ้าต้องการใช้',
    );
  });

  it("lists a family asked about by name instead of calling one model available", async () => {
    const result = await ask("มีโมเดล OpenAI อะไรบ้าง");

    expect(result?.text).toBe(
      "ในแคตตาล็อก OpenRouter ของบัญชีนี้มี OpenAI 2 รุ่น:\n• OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna)\n• OpenAI: GPT-5.6 Sol (openai/gpt-5.6-sol)",
    );
  });
});

describe("current model and selection state come from the session", () => {
  it.each(["ตอนนี้ใช้โมเดลอะไร", "ใช้โมเดลอะไรอยู่", "What model are you using?"])(
    "%s => the canonical session selection",
    async (text) => {
      await seedSelectedModel();

      const result = await ask(text);

      expect(result?.handled).toBe(true);
      expect(result?.text).toContain(DEEPSEEK_FLASH);
      expect(result?.text).toMatch(/openrouter/u);
      expect(result?.text).toMatch(/เลือกเอง|chosen manually/u);
      // Current state never needs the catalog.
      expect(catalogRequests).toBe(0);
    },
  );

  it("reports the configured default when the session has no override", async () => {
    const result = await ask("ตอนนี้ใช้โมเดลอะไร");

    expect(result?.text).toBe(
      "ตอนนี้ใช้โมเดล qwen/qwen3.8-27b ผ่าน openrouter\nการเลือก: ค่าเริ่มต้นของระบบ",
    );
  });

  it("reports an automatic fallback and a pending switch", async () => {
    await upsertSessionEntry({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      entry: {
        sessionId: "sess-1",
        providerOverride: "openrouter",
        modelOverride: DEEPSEEK_FLASH,
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openrouter",
        modelOverrideFallbackOriginModel: LUNA,
        liveModelSwitchPending: true,
        updatedAt: 1,
      } as SessionEntry,
    });

    const result = await ask("ตอนนี้ใช้โมเดลอะไร");

    expect(result?.text).toBe(
      [
        `ตอนนี้ใช้โมเดล ${DEEPSEEK_FLASH} ผ่าน openrouter`,
        `การเลือก: สลับอัตโนมัติ (fallback) จาก openrouter/${LUNA}`,
        "การเปลี่ยนโมเดลจะมีผลในคำตอบถัดไป",
      ].join("\n"),
    );
  });
});

describe("provider answers come from the catalog or the session", () => {
  it("names a catalog model's provider and developer", async () => {
    const result = await ask("GPT-5.6 Luna มาจากค่ายไหน");

    expect(result?.text).toBe(
      "OpenAI: GPT-5.6 Luna (openai/gpt-5.6-luna) ให้บริการผ่าน OpenRouter · ผู้พัฒนา: openai",
    );
  });

  it("answers for the current model without reading the catalog", async () => {
    await seedSelectedModel();

    const result = await ask("โมเดลที่ใช้อยู่ใช้ provider อะไร");

    expect(result?.text).toBe(
      `โมเดลที่ใช้อยู่ (${DEEPSEEK_FLASH}) ให้บริการผ่าน openrouter · ผู้พัฒนา: deepseek`,
    );
    expect(catalogRequests).toBe(0);
  });
});

describe("an unreadable catalog is claimed and answered, never handed to the agent", () => {
  it.each(["มีโมเดล GPT-6 Luna ไหม", "มี DeepSeek V5 ไหม", "มี luna ไหม"])(
    "%s => deterministic failure reply",
    async (text) => {
      await seedSelectedModel();

      const result = await ask(text, router({ catalogStatus: 503 }));

      expect(result).toEqual({
        handled: true,
        text: "ตอนนี้อ่านแคตตาล็อกโมเดลของ OpenRouter ไม่ได้ จึงยังยืนยันไม่ได้ว่ามีรุ่นนี้หรือไม่ ลองถามใหม่อีกครั้งภายหลัง",
      });
    },
  );
});

describe("everything else is left to the other handlers", () => {
  it.each(["มีข้าวไหม", "มีเวลาไหม", "ใช้โมเดลอะไรดี", "ตอนนี้ใช้โมเดลวิดีโออะไร", "1", "สวัสดีครับ"])(
    "%s is not claimed and reads no catalog",
    async (text) => {
      expect(await ask(text)).toBeUndefined();
      expect(catalogRequests).toBe(0);
    },
  );

  it("does not claim Latin words the catalog does not use, and remembers that", async () => {
    const handle = router();

    expect(await ask("มี iPhone ไหม", handle)).toBeUndefined();
    expect(await ask("มี BGM ไหม", handle)).toBeUndefined();
    // One catalog read taught the handler which words name models.
    expect(catalogRequests).toBe(1);
  });

  it("leaves a longer message that carries another request to the agent", async () => {
    const text = "ช่วยเขียนอีเมลขอบคุณลูกค้าที่สั่งของเมื่อวานให้หน่อย สุภาพ ๆ สั้น ๆ แล้วตอนนี้ใช้โมเดลอะไรอยู่ครับ";
    expect(text.length).toBeGreaterThan(80);

    expect(await ask(text)).toBeUndefined();
  });

  it("does not stall unrecognized chat while the catalog is down", async () => {
    const handle = router({ catalogStatus: 503 });

    expect(await ask("มี BGM ไหม", handle)).toBeUndefined();
    expect(await ask("มี iPhone ไหม", handle)).toBeUndefined();
    // One failed read, then those turns skip the catalog during the backoff.
    expect(catalogRequests).toBe(1);
  });

  it("ignores a non-owner", async () => {
    const handle = router();

    expect(await handle(...ownerTurn("มี GPT-6 Luna ไหม", false))).toBeUndefined();
    expect(await handle(...ownerTurn("ตอนนี้ใช้โมเดลอะไร", false))).toBeUndefined();
    expect(catalogRequests).toBe(0);
  });
});

describe("answering never changes the session", () => {
  it("leaves the selected model exactly as it was", async () => {
    await seedSelectedModel();
    const before = readEntry();
    const handle = router();

    for (const text of [
      "มี GPT-5.6 Luna ไหม",
      "มี luna ไหม",
      "มี GPT-6 Luna ไหม",
      "GPT-5.6 Luna มาจากค่ายไหน",
      "มีโมเดล OpenAI อะไรบ้าง",
      "ตอนนี้ใช้โมเดลอะไร",
    ]) {
      expect((await ask(text, handle))?.handled).toBe(true);
    }

    const after = readEntry();
    expect(after?.providerOverride).toBe("openrouter");
    expect(after?.modelOverride).toBe(DEEPSEEK_FLASH);
    expect(after?.liveModelSwitchPending).toBeUndefined();
    expect(after).toEqual(before);
  });
});

describe("classification is literal", () => {
  it("keeps the owner's wording as the target", () => {
    expect(classifyLineModelStateQuestion("อันนี้ละมีไหม OpenAI: GPT-6 Luna")).toEqual({
      question: { kind: "exists", targets: ["OpenAI: GPT-6 Luna"] },
      explicit: false,
    });
    expect(classifyLineModelStateQuestion("Which provider supplies this model?")).toEqual({
      question: { kind: "provider", targets: [] },
      explicit: true,
    });
    expect(classifyLineModelStateQuestion("Which OpenAI models are configured?")).toEqual({
      question: { kind: "list", targets: ["OpenAI"] },
      explicit: true,
    });
  });
});
