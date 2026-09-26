import { describe, expect, it, vi } from "vitest";
import { createWellnessTableReader, type WellnessTableRows } from "./notion-tools.js";
import {
  CASHFLOW_FIXTURE,
  cashflowSource,
  syntheticWellnessFetch,
} from "./notion-tools.test-support.js";
import { buildWellnessDataBrief, resolveDateWindow } from "./wellness-data-brief.js";

async function readCashflow(): Promise<WellnessTableRows> {
  vi.stubEnv("NOTION_WELLNESS_READ_TOKEN", "test-only-wellness-credential");
  try {
    return await createWellnessTableReader(syntheticWellnessFetch([cashflowSource(0)])).readTable(
      0,
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

const NOW = Date.parse("2026-09-26T05:00:00.000Z");

describe("buildWellnessDataBrief over a production-shaped bookkeeping table", () => {
  it("sums every money field over every row, and splits money in from money out", async () => {
    const brief = buildWellnessDataBrief({
      title: "Cashflow - Cloudbath",
      table: await readCashflow(),
      now: NOW,
      timeZone: "Asia/Bangkok",
    });

    expect(brief).toMatchObject({ rows: CASHFLOW_FIXTURE.rows, complete: true, dateField: "Date" });
    // Money fields by type and name; the confidence score is a number but not money.
    expect(brief.totals.map((total) => total.field)).toEqual([
      "Amount",
      "Expense Amount",
      "Actual Expense",
    ]);
    expect(brief.totals.find((total) => total.field === "Expense Amount")?.sum).toBe(
      CASHFLOW_FIXTURE.expenseTotal,
    );
    const out = brief.flow?.groups.find((group) => group.value === "Out");
    const inflow = brief.flow?.groups.find((group) => group.value === "In");
    expect(brief.flow?.field).toBe("Direction");
    expect(out?.sums.Amount).toBe(CASHFLOW_FIXTURE.expenseTotal);
    expect(inflow).toMatchObject({ rows: CASHFLOW_FIXTURE.incomeRows });
    expect(inflow?.sums.Amount).toBe(CASHFLOW_FIXTURE.incomeTotal);
  });

  it("reports the latest batch separately from the running total", async () => {
    const brief = buildWellnessDataBrief({
      title: "Cashflow - Cloudbath",
      table: await readCashflow(),
      now: NOW,
      timeZone: "Asia/Bangkok",
    });

    expect(brief.lastDate).toBe(CASHFLOW_FIXTURE.latestDate);
    expect(brief.latest).toMatchObject({
      date: CASHFLOW_FIXTURE.latestDate,
      rows: CASHFLOW_FIXTURE.latestRows,
    });
    expect(brief.latest?.totals.find((total) => total.field === "Expense Amount")?.sum).toBe(
      CASHFLOW_FIXTURE.latestExpense,
    );
    expect(brief.latest?.items).toHaveLength(CASHFLOW_FIXTURE.latestRows);
    expect(brief.latest?.items[0]).toMatchObject({
      Date: CASHFLOW_FIXTURE.latestDate,
      Direction: "Out",
      "Main Category": "Material",
    });
  });

  it("sums a named period in the owner's calendar", async () => {
    const brief = buildWellnessDataBrief({
      title: "Cashflow - Cloudbath",
      table: await readCashflow(),
      range: "this_month",
      now: NOW,
      timeZone: "Asia/Bangkok",
    });

    expect(brief.range).toMatchObject({ name: "this_month", from: "2026-09-01", to: "2026-09-26" });
    // Only the latest batch falls in September; the older rows are June to August.
    expect(brief.range?.rows).toBe(CASHFLOW_FIXTURE.latestRows);
    expect(brief.range?.totals.find((total) => total.field === "Expense Amount")?.sum).toBe(
      CASHFLOW_FIXTURE.latestExpense,
    );
  });

  it("assumes no property names", () => {
    const brief = buildWellnessDataBrief({
      title: "บัญชีรายจ่าย",
      table: {
        complete: true,
        propertyTypes: {
          รายการ: "title",
          วันที่ทำรายการ: "date",
          จำนวนเงิน: "number",
          ประเภทเงิน: "select",
        },
        records: [
          ["ค่าไฟ", "2026-09-01", 1_200.5, "รายจ่าย"],
          ["ค่าน้ำ", "2026-09-03", 300.25, "รายจ่าย"],
          ["เงินโอนเข้า", "2026-09-03", 5_000, "รายรับ"],
        ].map(([name, date, amount, flow], index) => ({
          id: `r${index}`,
          dataSourceIndex: 0,
          properties: { รายการ: name, วันที่ทำรายการ: date, จำนวนเงิน: amount, ประเภทเงิน: flow },
        })),
      },
      now: NOW,
      timeZone: "Asia/Bangkok",
    });

    expect(brief.dateField).toBe("วันที่ทำรายการ");
    expect(brief.totals).toEqual([{ field: "จำนวนเงิน", sum: 6_500.75, rows: 3 }]);
    expect(brief.flow?.groups.find((group) => group.value === "รายจ่าย")?.sums).toEqual({
      จำนวนเงิน: 1_500.75,
    });
    expect(brief.latest).toMatchObject({ date: "2026-09-03", rows: 2 });
  });
});

describe("resolveDateWindow", () => {
  it.each([
    ["today", "2026-09-26", "2026-09-26"],
    ["yesterday", "2026-09-25", "2026-09-25"],
    ["this_week", "2026-09-21", "2026-09-26"],
    ["this_month", "2026-09-01", "2026-09-26"],
    ["last_month", "2026-08-01", "2026-08-31"],
    ["this_year", "2026-01-01", "2026-09-26"],
  ] as const)("%s runs %s..%s in Bangkok", (range, from, to) => {
    expect(resolveDateWindow(range, NOW, "Asia/Bangkok")).toEqual({ from, to });
  });

  it("dates by the owner's zone, not UTC", () => {
    // 2026-09-30T20:00Z is already October 1st in Bangkok.
    expect(
      resolveDateWindow("this_month", Date.parse("2026-09-30T20:00:00Z"), "Asia/Bangkok"),
    ).toEqual({
      from: "2026-10-01",
      to: "2026-10-01",
    });
  });
});
