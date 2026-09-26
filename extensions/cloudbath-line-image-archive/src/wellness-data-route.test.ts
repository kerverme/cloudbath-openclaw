/**
 * The Wellness data route answers from one table read and one tool-less model
 * call, or leaves the turn to the agent untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { createWellnessTableReader } from "./notion-tools.js";
import {
  CASHFLOW_FIXTURE,
  type NotionRequest,
  productionShapedWellness,
  syntheticWellnessFetch,
} from "./notion-tools.test-support.js";
import type { AsyncKeyedStore } from "./types.js";
import {
  WellnessDataRoute,
  type WellnessDataAnswerRequest,
  type WellnessDataConversation,
} from "./wellness-data-route.js";

const OWNER = "U0987654321";
const GROUP = "C1234567890abcdef";

function memoryStore<T>(): AsyncKeyedStore<T> & { values: Map<string, T> } {
  const values = new Map<string, T>();
  return {
    values,
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) =>
      values.has(key) ? false : (values.set(key, value), true),
    lookup: async (key) => values.get(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function route(overrides: { openReader?: () => never; answer?: () => Promise<string> } = {}) {
  const requests: NotionRequest[] = [];
  const answers: WellnessDataAnswerRequest[] = [];
  const referents = memoryStore<WellnessDataConversation>();
  const openReader = vi.fn(
    overrides.openReader ??
      (() =>
        createWellnessTableReader(syntheticWellnessFetch(productionShapedWellness(), requests))),
  );
  const handler = new WellnessDataRoute({
    openReader,
    referents,
    answer: async (request) => {
      answers.push(request);
      return overrides.answer ? await overrides.answer() : `answer ${answers.length}`;
    },
    now: () => Date.parse("2026-09-26T05:00:00Z"),
  });
  const ask = (content: string, over: { senderIsOwner?: boolean; channelId?: string } = {}) =>
    handler.handle(
      { content, senderId: OWNER, senderIsOwner: over.senderIsOwner ?? true },
      {
        channelId: over.channelId ?? "line",
        accountId: "acct-1",
        conversationId: `line:group:${GROUP}`,
      },
    );
  return { ask, requests, answers, referents, openReader };
}

function summaryOf(request: WellnessDataAnswerRequest) {
  const content = request.messages[0]!.content;
  const summary = /SUMMARY: (.+)/u.exec(content)?.[1];
  return JSON.parse(summary!) as {
    table: string;
    rows: number;
    complete: boolean;
    flow?: { groups: Array<{ value: string; sums: Record<string, number> }> };
    latest?: { rows: number; totals: Array<{ field: string; sum: number }> };
  };
}

describe("WellnessDataRoute", () => {
  it("answers a total from the whole table with one tool-less model call", async () => {
    vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
    const { ask, answers, requests, referents } = route();

    const reply = await ask("ช่วยเช็คหน่อย Cashflow - Cloudbath ใช้ไปเท่าไร");

    expect(reply).toEqual({ handled: true, text: "answer 1" });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ purpose: "cloudbath-wellness-data" });
    expect(Object.keys(answers[0]!)).toEqual(["systemPrompt", "messages", "purpose"]);
    const summary = summaryOf(answers[0]!);
    expect(summary).toMatchObject({ table: "Cashflow - Cloudbath", rows: 164, complete: true });
    expect(summary.flow?.groups.find((group) => group.value === "Out")?.sums.Amount).toBe(
      CASHFLOW_FIXTURE.expenseTotal,
    );
    // One read of one table: discovery, then its two pages.
    expect(requests.filter((request) => request.url.includes("/query"))).toHaveLength(2);
    expect([...referents.values.values()]).toEqual([
      expect.objectContaining({ title: "Cashflow - Cloudbath", answer: "answer 1" }),
    ]);
    vi.unstubAllEnvs();
  });

  it("keeps the table the owner was just asking about for a follow-up", async () => {
    vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
    const { ask, answers } = route();

    await ask("Cashflow - Cloudbath ใช้ไปเท่าไร");
    const reply = await ask("มีรายการกี่รายการ");

    expect(reply?.handled).toBe(true);
    expect(summaryOf(answers[1]!)).toMatchObject({ table: "Cashflow - Cloudbath" });
    expect(answers[1]!.messages[0]!.content).toContain("PREVIOUS ANSWER: answer 1");
    vi.unstubAllEnvs();
  });

  it.each([
    ["another member of the group", "Cashflow - Cloudbath ใช้ไปเท่าไร", { senderIsOwner: false }],
    ["another channel", "Cashflow - Cloudbath ใช้ไปเท่าไร", { channelId: "telegram" }],
    ["creative work", "ค่าใช้จ่ายทำวิดีโอเท่าไร", {}],
    ["ordinary chat", "วันนี้ฝนตกไหม", {}],
  ])("leaves %s to the agent without touching Notion", async (_label, text, over) => {
    const { ask, openReader, answers } = route();

    expect(await ask(text, over)).toBeUndefined();
    expect(openReader).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
  });

  it("leaves a records question with no table to point at", async () => {
    vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
    const { ask, requests, answers } = route();

    expect(await ask("มีรายการกี่รายการ")).toBeUndefined();
    expect(requests.some((request) => request.url.includes("/query"))).toBe(false);
    expect(answers).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("falls back to the agent when the connection or the answer fails", async () => {
    const unconfigured = route({
      openReader: () => {
        throw new Error("Wellness Notion connection is not configured");
      },
    });
    expect(await unconfigured.ask("Cashflow - Cloudbath ใช้ไปเท่าไร")).toBeUndefined();
    expect(unconfigured.answers).toEqual([]);

    vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
    const failing = route({
      answer: async () => {
        throw new Error("provider down");
      },
    });
    expect(await failing.ask("Cashflow - Cloudbath ใช้ไปเท่าไร")).toBeUndefined();
    expect(failing.referents.values.size).toBe(0);
    vi.unstubAllEnvs();
  });
});
