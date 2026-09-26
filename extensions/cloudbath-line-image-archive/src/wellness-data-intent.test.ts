import { describe, expect, it } from "vitest";
import type { WellnessTable } from "./notion-tools.js";
import { chooseWellnessTable, readWellnessDataIntent } from "./wellness-data-intent.js";

const TABLES: WellnessTable[] = [
  { dataSourceIndex: 0, dataSourceId: "inbox", title: "Source Inbox" },
  { dataSourceIndex: 1, dataSourceId: "cashflow", title: "Cashflow - Cloudbath" },
  { dataSourceIndex: 2, dataSourceId: "boq", title: "BOQ Forecast - Cloudbath" },
  { dataSourceIndex: 3, dataSourceId: "untitled" },
];

describe("readWellnessDataIntent", () => {
  it.each([
    ["ช่วยเช็คหน่อย Cashflow - Cloudbath ใช้ไปเท่าไร", "total", undefined],
    ["Cashflow - Cloudbath ใช้ไปเท่าไร", "total", undefined],
    ["ยอด Cashflow เท่าไร", "total", undefined],
    ["รายจ่ายล่าสุดคืออะไร", "latest", undefined],
    ["รายการล่าสุดมีอะไรบ้าง", "latest", undefined],
    ["เดือนนี้ใช้ไปเท่าไร", "total", "this_month"],
    ["ค่าใช้จ่ายเดือนนี้เท่าไร", "total", "this_month"],
    ["มีรายการกี่รายการ", "count", undefined],
    ["ยอดรวมเท่าไร", "total", undefined],
    ["รายจ่ายล่าสุดกี่รายการ", "count", undefined],
    ["how much did we spend last month", "total", "last_month"],
  ])("claims %s as %s", (text, operation, range) => {
    const intent = readWellnessDataIntent(text);

    expect(intent?.operation).toBe(operation);
    expect(intent?.range).toBe(range);
  });

  it.each([
    "ค่าใช้จ่ายทำวิดีโอเท่าไร",
    "storyboard ล่าสุด",
    "รูปล่าสุด",
    "Character ล่าสุด",
    "ค่าใช้จ่าย OpenRouter เท่าไร",
    "ข่าวรายจ่ายล่าสุด",
    "วันนี้ฝนตกไหม",
    "สรุปข่าวอาทิตย์ที่แล้ว",
    "ใช้โมเดลไรอยู่",
    "แก้อันเมื่อกี้ให้ตอนท้ายแรงขึ้น",
    "ยอดวิวคลิปล่าสุดเท่าไร",
    "ยอดไลก์เท่าไร",
    "รายการอาหารมีอะไรบ้าง",
    "ทำต่อเลย",
    "/status",
  ])("leaves %s alone", (text) => {
    expect(readWellnessDataIntent(text)).toBeUndefined();
  });
});

describe("chooseWellnessTable", () => {
  function choose(text: string, referent?: { dataSourceId: string }) {
    const intent = readWellnessDataIntent(text);
    expect(intent).toBeDefined();
    return chooseWellnessTable({ intent: intent!, tables: TABLES, referent });
  }

  it("takes the table the turn names, by full title or by a word only that title has", () => {
    expect(choose("Cashflow - Cloudbath ใช้ไปเท่าไร")).toMatchObject({
      table: { dataSourceId: "cashflow" },
      source: "named",
    });
    expect(choose("ยอด Cashflow เท่าไร")?.table.dataSourceId).toBe("cashflow");
    expect(choose("BOQ มีรายการกี่รายการ")?.table.dataSourceId).toBe("boq");
  });

  it("never picks a table by a word every title shares", () => {
    // "cloudbath" is in two titles; the one bookkeeping title decides instead.
    expect(choose("Cloudbath ใช้ไปเท่าไร")).toMatchObject({
      table: { dataSourceId: "cashflow" },
      source: "finance_title",
    });
    expect(choose("Cloudbath มีรายการกี่รายการ")).toBeUndefined();
  });

  it("keeps the table the conversation was just about, unless the turn names another", () => {
    expect(choose("รายจ่ายล่าสุดคืออะไร", { dataSourceId: "cashflow" })).toMatchObject({
      table: { dataSourceId: "cashflow" },
      source: "conversation",
    });
    expect(choose("มีรายการกี่รายการ", { dataSourceId: "boq" })?.table.dataSourceId).toBe("boq");
    expect(choose("BOQ ยอดรวมเท่าไร", { dataSourceId: "cashflow" })?.table.dataSourceId).toBe("boq");
  });

  it("only points a money question at the single bookkeeping table", () => {
    expect(choose("รายจ่ายล่าสุดคืออะไร")?.source).toBe("finance_title");
    // Records alone are not money: without a named table or conversation, it is not plain.
    expect(choose("มีรายการกี่รายการ")).toBeUndefined();
    expect(
      chooseWellnessTable({
        intent: readWellnessDataIntent("ยอดรวมเท่าไร")!,
        tables: [
          ...TABLES,
          { dataSourceIndex: 4, dataSourceId: "ledger", title: "Expense ledger" },
        ],
      }),
    ).toBeUndefined();
  });
});
