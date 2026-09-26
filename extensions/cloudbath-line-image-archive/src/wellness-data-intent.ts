/**
 * Whether a turn is a read-only question about Wellness business data, and
 * which Wellness table it is about.
 *
 * Deterministic on purpose. A data question answered by the general agent took
 * 8-12 model calls in production (commands, memory search, repeated queries);
 * one answered here reads its table once. So this module only claims what it
 * can read plainly — an operation (how much / how many / latest / list) over a
 * money or record noun — and leaves everything else to the agent.
 *
 * Like `conversation-utterance.ts`, the markers are linguistic classes, not a
 * table of product phrases: no table, database or amount is named here. Which
 * table a turn means comes from the titles discovered under the Wellness root
 * page, or from the table this conversation was just talking about.
 */

import type { WellnessTable } from "./notion-tools.js";
import { normalizeStoryboardText } from "./storyboard-request.js";

export type WellnessDataOperation = "count" | "latest" | "total" | "list";

/** Calendar windows a question may name, resolved in the owner's time zone. */
export type WellnessDateRange =
  | "today"
  | "yesterday"
  | "this_week"
  | "this_month"
  | "last_month"
  | "this_year";

export type WellnessDataIntent = Readonly<{
  text: string;
  operation: WellnessDataOperation;
  range?: WellnessDateRange;
  /**
   * The turn names money itself ("รายจ่าย", "ใช้ไป", "cashflow"), not just
   * records. Only such a turn may be pointed at the one finance-looking table
   * when nothing else says which table it means.
   */
  moneyNoun: boolean;
}>;

/**
 * Thai compounds a bare noun would otherwise swallow: "ยอดวิว" is a view count
 * and "รายการอาหาร" a menu. The noun only counts when what follows it is a
 * boundary or one of the words that keep it about records and money.
 */
const NOUN_END =
  "(?=$|[^\\u0E00-\\u0E7F]|เงิน|รวม|ใช้|จ่าย|คงเหลือ|ค้าง|ล่าสุด|ทั้งหมด|เดือน|วัน|ปี|เท่า|กี่|ที่|นี้|ของ|มี|คือ|ประมาณ)";

/** Money and bookkeeping nouns, and the Thai verb phrases that mean "spent". */
const MONEY_NOUN = new RegExp(
  `รายจ่าย|รายรับ|ค่าใช้จ่าย|ธุรกรรม|กระแสเงินสด|ใช้(?:เงิน)?ไป|จ่าย(?:เงิน)?ไป|(?:ยอด|งบ)${NOUN_END}|\\bcash\\s*flow\\b|\\bexpenses?\\b|\\bincome\\b|\\bspen(?:d|t|ding)\\b|\\btransactions?\\b|\\binvoices?\\b|\\bpayments?\\b|\\bledger\\b|\\bcosts?\\b`,
  "iu",
);

/** Records of any table. Weak evidence: only with a table the turn or the conversation names. */
const RECORD_NOUN = new RegExp(
  `รายการ${NOUN_END}|\\brecords?\\b|\\bentries\\b|\\brows?\\b|\\bitems?\\b`,
  "iu",
);

const COUNT = /กี่(?:รายการ|ครั้ง|อัน|แถว|บิล|ใบ)|จำนวน(?:รายการ|ครั้ง)|\bhow\s+many\b|\bcount\b/iu;
/** "last month" is a period, not the latest records. */
const LATEST =
  /ล่าสุด|\b(?:latest|most\s+recent|recent|last(?!\s+(?:week|month|year|night|day|time)))\b/iu;
const TOTAL =
  /เท่า(?:ไร|ไหร่|ไร่)|กี่บาท|ยอดรวม|รวม(?:ทั้งหมด|เป็น)?|ทั้งหมด|\bhow\s+much\b|\btotal\b|\bsum\b/iu;
const LIST = /อะไรบ้าง|มีอะไร|คืออะไร|อะไร|\bwhat\b|\blist\b|\bshow\b/iu;

/**
 * Creative work, AI services, and the news: questions about these share the
 * money and recency words ("ค่าใช้จ่ายทำวิดีโอ", "ข่าวรายจ่ายล่าสุด") and are
 * never about the Wellness books.
 */
const OTHER_DOMAIN =
  /วิดีโอ|วีดีโอ|คลิป|สตอรี่บอร์ด|ภาพ|รูป|ตัวละคร|ฉาก|ข่าว|โมเดล|โทเค็น|เครดิต|\b(?:video|clip|storyboard|images?|pictures?|character|scene|news|model|tokens?|credits?|api|openrouter|openai|anthropic)\b/iu;

const RANGES: ReadonlyArray<readonly [RegExp, WellnessDateRange]> = [
  [/วันนี้|\btoday\b/iu, "today"],
  [/เมื่อวาน|\byesterday\b/iu, "yesterday"],
  [/(?:สัปดาห์|อาทิตย์)นี้|\bthis\s+week\b/iu, "this_week"],
  [/เดือน(?:ที่แล้ว|ก่อน)|\blast\s+month\b/iu, "last_month"],
  [/เดือนนี้|\bthis\s+month\b/iu, "this_month"],
  [/ปีนี้|\bthis\s+year\b/iu, "this_year"],
];

export function readWellnessDataIntent(content: string): WellnessDataIntent | undefined {
  const text = normalizeStoryboardText(content);
  if (!text || text.startsWith("/") || OTHER_DOMAIN.test(text)) {
    return undefined;
  }
  const moneyNoun = MONEY_NOUN.test(text);
  if (!moneyNoun && !RECORD_NOUN.test(text)) {
    return undefined;
  }
  // Count before latest before total: "รายจ่ายล่าสุดกี่รายการ" asks how many,
  // and "ยอดล่าสุดเท่าไร" asks about the latest records, not the running total.
  const operation: WellnessDataOperation | undefined = COUNT.test(text)
    ? "count"
    : LATEST.test(text)
      ? "latest"
      : TOTAL.test(text)
        ? "total"
        : LIST.test(text)
          ? "list"
          : undefined;
  if (!operation) {
    return undefined;
  }
  const range = RANGES.find(([pattern]) => pattern.test(text))?.[1];
  return Object.freeze({ text, operation, ...(range ? { range } : {}), moneyNoun });
}

/** A table this conversation was just answering about. */
export type WellnessDataReferent = Readonly<{
  dataSourceId: string;
  title?: string;
}>;

export type WellnessTableChoice = Readonly<{
  table: WellnessTable;
  source: "named" | "conversation" | "finance_title";
}>;

/** Titles that name a bookkeeping table in either language. */
const FINANCE_TITLE =
  /cash\s*flow|expense|ledger|transaction|finance|spend|บัญชี|รายจ่าย|รายรับ|การเงิน|กระแสเงินสด/iu;

function words(value: string): string[] {
  return normalizeStoryboardText(value)
    .toLocaleLowerCase()
    .split(/[\s\-–—_/|:,()[\]]+/u)
    .filter(Boolean);
}

/**
 * Which discovered table the turn means, or undefined when that is not plain.
 *
 * A table the turn names outranks the one the conversation was about, which
 * outranks the single bookkeeping-titled table. A name matches by its whole
 * title or by a word only that title has ("cashflow" when only one title says
 * it), so a word every title shares ("cloudbath") picks nothing.
 */
export function chooseWellnessTable(params: {
  intent: WellnessDataIntent;
  tables: readonly WellnessTable[];
  referent?: WellnessDataReferent;
}): WellnessTableChoice | undefined {
  const text = params.intent.text.toLocaleLowerCase();
  const titled = params.tables.filter((table) => table.title);
  const wordCounts = new Map<string, number>();
  for (const table of titled) {
    for (const word of new Set(words(table.title!))) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const named = titled.filter((table) => {
    const title = table.title!.toLocaleLowerCase();
    if (text.includes(title)) {
      return true;
    }
    return words(title).some(
      (word) => wordCounts.get(word) === 1 && word.length >= 3 && text.includes(word),
    );
  });
  if (named.length === 1) {
    return { table: named[0]!, source: "named" };
  }
  if (named.length > 1) {
    return undefined;
  }
  const remembered = params.referent
    ? params.tables.find((table) => table.dataSourceId === params.referent!.dataSourceId)
    : undefined;
  if (remembered) {
    return { table: remembered, source: "conversation" };
  }
  if (!params.intent.moneyNoun) {
    return undefined;
  }
  const finance = titled.filter((table) => FINANCE_TITLE.test(table.title!));
  return finance.length === 1 ? { table: finance[0]!, source: "finance_title" } : undefined;
}
