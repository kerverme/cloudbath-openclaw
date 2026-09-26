/**
 * Everything a data question may need from one Wellness table, computed in
 * code over every row that was read.
 *
 * Totals, counts, the latest batch and date-window sums are arithmetic, and a
 * model asked to do them over paged tool results re-queried, shelled out to
 * add numbers, and still had to be trusted with the sum. Here they are computed
 * once; the model that answers only chooses which of these figures the owner
 * asked for and says it.
 *
 * No property is assumed by name. Fields are classified by their Notion type
 * and values, and names only rank them: which numeric fields look like money,
 * which date orders the rows, and which select splits money in from money out.
 */

import type { WellnessRecord, WellnessTableRows } from "./notion-tools.js";
import type { WellnessDateRange } from "./wellness-data-intent.js";

/** Rows listed for the latest batch; the batch's totals always cover all of it. */
const LATEST_ITEMS_LIMIT = 15;

const NUMERIC_TYPES = new Set(["number", "formula", "rollup"]);
const MONEY_FIELD =
  /amount|expense|cost|total|net|price|paid|spend|fee|thb|baht|value|ยอด|จำนวนเงิน|ราคา|บาท|รายจ่าย|รายรับ|ค่าใช้จ่าย|ต้นทุน|เงิน/iu;
const NOT_MONEY = /confidence|rate|count|score|percent|%|\bfx\b|\bid\b|จำนวนครั้ง|อัตรา/iu;
const DATE_FIELD = /date|วันที่/iu;
/** Option values that say which way money moved. */
const FLOW_VALUE = /^(?:in|out|income|expense|inflow|outflow|รายรับ|รายจ่าย|เข้า|ออก|รับ|จ่าย)$/iu;
const CATEGORY_FIELD = /categor|type|หมวด|ประเภท/iu;
const PARTY_FIELD = /payee|vendor|supplier|\bto\b|ผู้รับ|ร้าน/iu;

export type WellnessMoneyTotal = Readonly<{ field: string; sum: number; rows: number }>;
export type WellnessFlowGroup = Readonly<{
  value: string;
  rows: number;
  sums: Readonly<Record<string, number>>;
}>;
export type WellnessRowSummary = Readonly<Record<string, unknown>>;

export type WellnessDataBrief = Readonly<{
  table: string;
  rows: number;
  /** False when the table had more rows than one read may scan. */
  complete: boolean;
  dateField?: string;
  firstDate?: string;
  lastDate?: string;
  /** Each money-looking field summed over every row. */
  totals: readonly WellnessMoneyTotal[];
  /** The same sums split by the field that says money in vs out, when one exists. */
  flow?: Readonly<{ field: string; groups: readonly WellnessFlowGroup[] }>;
  range?: Readonly<{
    name: WellnessDateRange;
    from: string;
    to: string;
    rows: number;
    totals: readonly WellnessMoneyTotal[];
    flow?: readonly WellnessFlowGroup[];
  }>;
  /** Every row on the most recent date: the latest batch, not the running total. */
  latest?: Readonly<{
    date: string;
    rows: number;
    totals: readonly WellnessMoneyTotal[];
    flow?: readonly WellnessFlowGroup[];
    items: readonly WellnessRowSummary[];
  }>;
}>;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayOf(value: unknown): string | undefined {
  const start =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { start?: unknown }).start
        : undefined;
  return typeof start === "string" && /^\d{4}-\d{2}-\d{2}/u.test(start)
    ? start.slice(0, 10)
    : undefined;
}

function fieldsOfType(rows: WellnessTableRows, types: ReadonlySet<string>): string[] {
  return Object.entries(rows.propertyTypes)
    .filter(([, type]) => types.has(type))
    .map(([name]) => name);
}

function chooseMoneyFields(rows: WellnessTableRows): string[] {
  const numeric = fieldsOfType(rows, NUMERIC_TYPES).filter((field) =>
    rows.records.some((record) => typeof record.properties[field] === "number"),
  );
  const plausible = numeric.filter((field) => !NOT_MONEY.test(field));
  const money = plausible.filter((field) => MONEY_FIELD.test(field));
  return money.length > 0 ? money : plausible;
}

function chooseDateField(rows: WellnessTableRows): string | undefined {
  const dated = fieldsOfType(rows, new Set(["date"]));
  const filled = (field: string) =>
    rows.records.filter((record) => dayOf(record.properties[field])).length;
  return (
    dated.find((field) => DATE_FIELD.test(field) && filled(field) > 0) ??
    dated.toSorted((left, right) => filled(right) - filled(left)).find((f) => filled(f) > 0)
  );
}

function chooseFlowField(rows: WellnessTableRows): string | undefined {
  return fieldsOfType(rows, new Set(["select", "status"])).find((field) => {
    const values = new Set(
      rows.records
        .map((record) => record.properties[field])
        .filter((value): value is string => typeof value === "string"),
    );
    return [...values].filter((value) => FLOW_VALUE.test(value.trim())).length >= 2;
  });
}

function totalsOf(records: readonly WellnessRecord[], fields: readonly string[]) {
  return fields.map((field) => {
    const values = records
      .map((record) => record.properties[field])
      .filter((value): value is number => typeof value === "number");
    return {
      field,
      sum: round2(values.reduce((sum, value) => sum + value, 0)),
      rows: values.length,
    };
  });
}

function flowOf(records: readonly WellnessRecord[], field: string, money: readonly string[]) {
  const groups = new Map<string, WellnessRecord[]>();
  for (const record of records) {
    const value = record.properties[field];
    const key = typeof value === "string" && value ? value : "(none)";
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups].map(([value, grouped]) => ({
    value,
    rows: grouped.length,
    sums: Object.fromEntries(totalsOf(grouped, money).map((total) => [total.field, total.sum])),
  }));
}

/** The calendar day in the owner's zone, as `YYYY-MM-DD`. */
function localDay(at: number, timeZone: string, offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(
    new Date(at + offsetDays * 86_400_000),
  );
}

export function resolveDateWindow(
  range: WellnessDateRange,
  now: number,
  timeZone: string,
): Readonly<{ from: string; to: string }> {
  const today = localDay(now, timeZone);
  const [year, month] = today.split("-").map(Number) as [number, number];
  const pad = (value: number) => String(value).padStart(2, "0");
  if (range === "today") {
    return { from: today, to: today };
  }
  if (range === "yesterday") {
    const yesterday = localDay(now, timeZone, -1);
    return { from: yesterday, to: yesterday };
  }
  if (range === "this_week") {
    // Monday-first, as Thai calendars and business weeks run.
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: localDay(now, timeZone, -weekday), to: today };
  }
  if (range === "this_month") {
    return { from: `${year}-${pad(month)}-01`, to: today };
  }
  if (range === "last_month") {
    const lastYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;
    const days = new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate();
    return {
      from: `${lastYear}-${pad(lastMonth)}-01`,
      to: `${lastYear}-${pad(lastMonth)}-${days}`,
    };
  }
  return { from: `${year}-01-01`, to: today };
}

function describeRow(
  record: WellnessRecord,
  fields: Readonly<{
    title?: string;
    date?: string;
    money: readonly string[];
    flow?: string;
    category?: string;
    party?: string;
  }>,
): WellnessRowSummary {
  const pick = (field: string | undefined) =>
    field !== undefined && record.properties[field] != null && record.properties[field] !== ""
      ? { [field]: record.properties[field] }
      : {};
  return {
    ...pick(fields.title),
    ...pick(fields.date),
    ...Object.assign({}, ...fields.money.map((field) => pick(field))),
    ...pick(fields.flow),
    ...pick(fields.category),
    ...pick(fields.party),
  };
}

export function buildWellnessDataBrief(params: {
  title: string;
  table: WellnessTableRows;
  range?: WellnessDateRange;
  now: number;
  timeZone: string;
}): WellnessDataBrief {
  const { table } = params;
  const money = chooseMoneyFields(table);
  const dateField = chooseDateField(table);
  const flowField = chooseFlowField(table);
  const textFields = fieldsOfType(table, new Set(["select", "status", "rich_text"]));
  const rowFields = {
    title: fieldsOfType(table, new Set(["title"]))[0],
    date: dateField,
    money,
    flow: flowField,
    category: textFields.find((field) => field !== flowField && CATEGORY_FIELD.test(field)),
    party: textFields.find((field) => PARTY_FIELD.test(field)),
  };
  const dated = dateField
    ? table.records
        .map((record) => ({ record, day: dayOf(record.properties[dateField]) }))
        .filter((entry): entry is { record: WellnessRecord; day: string } => Boolean(entry.day))
    : [];
  const days = dated.map((entry) => entry.day).toSorted();
  const lastDate = days.at(-1);
  const section = (records: readonly WellnessRecord[]) => ({
    rows: records.length,
    totals: totalsOf(records, money),
    ...(flowField ? { flow: flowOf(records, flowField, money) } : {}),
  });
  const window = params.range
    ? resolveDateWindow(params.range, params.now, params.timeZone)
    : undefined;
  const inWindow = window
    ? dated.filter((entry) => entry.day >= window.from && entry.day <= window.to)
    : [];
  const latestBatch = lastDate ? dated.filter((entry) => entry.day === lastDate) : [];
  return {
    table: params.title,
    rows: table.records.length,
    complete: table.complete,
    ...(dateField ? { dateField } : {}),
    ...(days[0] ? { firstDate: days[0] } : {}),
    ...(lastDate ? { lastDate } : {}),
    totals: totalsOf(table.records, money),
    ...(flowField
      ? { flow: { field: flowField, groups: flowOf(table.records, flowField, money) } }
      : {}),
    ...(window && params.range
      ? {
          range: {
            name: params.range,
            ...window,
            ...section(inWindow.map((entry) => entry.record)),
          },
        }
      : {}),
    ...(lastDate
      ? {
          latest: {
            date: lastDate,
            ...section(latestBatch.map((entry) => entry.record)),
            items: latestBatch
              .slice(0, LATEST_ITEMS_LIMIT)
              .map((entry) => describeRow(entry.record, rowFields)),
          },
        }
      : {}),
  };
}
