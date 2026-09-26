/**
 * A synthetic Wellness Notion workspace for the scoped Notion tools: the fixed
 * root page, titled child databases, and pages shaped like the Notion API's own
 * responses (type wrappers, option ids and colors, rich-text annotations,
 * people with avatars, Notion-hosted files behind signed links).
 */
export const WELLNESS_ROOT_PAGE_ID = "39575d42-f42b-808c-8a66-faed4274521b";

/** Temporary storage credential Notion embeds in hosted-file links; must never reach the model. */
export const SIGNED_FILE_TOKEN = "IQoJb3JpZ2luX2VjTEMPORARYSTORAGECREDENTIAL";

export type SyntheticDataSource = {
  databaseId: string;
  dataSourceId: string;
  /** The database's own title. */
  title: string;
  /** What the root page's child_database block says; linked databases say nothing. */
  blockTitle?: string;
  pages: unknown[];
};

export type NotionRequest = { url: string; method: string; body?: unknown };

function richText(content: string) {
  return {
    type: "text",
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: content,
    href: null,
  };
}

function person(index: number) {
  return {
    object: "user",
    id: `9a3b1c2d-0000-4000-8000-${String(index % 10).padStart(12, "0")}`,
    name: `Team member ${index % 3}`,
    avatar_url: `https://s3-us-west-2.amazonaws.com/public.notion-static.com/avatar-${index % 3}.png`,
    type: "person",
    person: { email: `member${index % 3}@example.invalid` },
  };
}

export function recordId(dataSourceIndex: number, index: number): string {
  return `1b2c3d4e-5f60-4718-89ab-${String(dataSourceIndex * 100_000 + index).padStart(12, "0")}`;
}

/** Amounts carry satang so the sum exercises decimal precision. */
export function transactionAmount(index: number): number {
  return 1_250.75 + index * 13.25;
}

export const TRANSACTION_CATEGORIES = ["Operations", "Marketing", "Supplies", "Payroll"] as const;
export const TRANSACTION_STATUSES = ["Paid", "Pending"] as const;

/** One ledger row as the Notion API returns it, about 5.5k chars pretty-printed. */
export function transactionPage(dataSourceId: string, dataSourceIndex: number, index: number) {
  const day = String((index % 28) + 1).padStart(2, "0");
  const category = TRANSACTION_CATEGORIES[index % TRANSACTION_CATEGORIES.length]!;
  const status = TRANSACTION_STATUSES[index % TRANSACTION_STATUSES.length]!;
  return {
    object: "page",
    id: recordId(dataSourceIndex, index),
    created_time: `2026-09-${day}T01:02:00.000Z`,
    last_edited_time: `2026-09-${day}T03:04:00.000Z`,
    created_by: { object: "user", id: person(index).id },
    last_edited_by: { object: "user", id: person(index + 1).id },
    cover: null,
    icon: null,
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    archived: false,
    in_trash: false,
    url: `https://www.notion.so/Transaction-${index}-${recordId(dataSourceIndex, index).replaceAll("-", "")}`,
    public_url: null,
    properties: {
      Name: { id: "title", type: "title", title: [richText(`Transaction ${index}`)] },
      Amount: { id: "%3AabC", type: "number", number: transactionAmount(index) },
      Date: {
        id: "dAtE",
        type: "date",
        date: { start: `2026-09-${day}`, end: null, time_zone: null },
      },
      Category: {
        id: "cAt1",
        type: "select",
        select: {
          id: `5f1e2d3c-aaaa-4bbb-8ccc-00000000000${index % 4}`,
          name: category,
          color: "blue",
        },
      },
      Description: {
        id: "dEsC",
        type: "rich_text",
        rich_text: [richText(`Monthly service charge ${index}`), richText(" and related costs")],
      },
      Status: {
        id: "sTaT",
        type: "status",
        status: { id: "9f1e2d3c-aaaa-4bbb-8ccc-111111111111", name: status, color: "green" },
      },
      Tags: {
        id: "tAgS",
        type: "multi_select",
        multi_select: [
          { id: "7f1e2d3c-aaaa-4bbb-8ccc-ffffffffffff", name: "Ledger", color: "green" },
          { id: "8f1e2d3c-aaaa-4bbb-8ccc-000000000000", name: "Q3", color: "gray" },
        ],
      },
      Project: {
        id: "pRoJ",
        type: "relation",
        relation: [{ id: "2c3d4e5f-6071-4829-9abc-def012345678" }],
        has_more: false,
      },
      "Project Name": {
        id: "rOlL",
        type: "rollup",
        rollup: {
          type: "array",
          array: [{ type: "title", title: [richText("Spa renovation")] }],
          function: "show_original",
        },
      },
      "Amount incl. VAT": {
        id: "fOrM",
        type: "formula",
        formula: { type: "number", number: Math.round(transactionAmount(index) * 107) / 100 },
      },
      Receipt: {
        id: "rEcP",
        type: "files",
        files: [
          {
            name: `receipt-${index}.jpg`,
            type: "file",
            file: {
              url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/space/receipt-${index}.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE%2F20260925%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20260925T000000Z&X-Amz-Expires=3600&X-Amz-Security-Token=${SIGNED_FILE_TOKEN}&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&X-Amz-SignedHeaders=host&x-id=GetObject`,
              expiry_time: "2026-09-25T01:00:00.000Z",
            },
          },
        ],
      },
      Paid: { id: "pAiD", type: "checkbox", checkbox: status === "Paid" },
      Owner: { id: "oWnR", type: "people", people: [person(index)] },
      "Created by": { id: "cRbY", type: "created_by", created_by: person(index) },
      Created: { id: "cRtM", type: "created_time", created_time: `2026-09-${day}T01:02:00.000Z` },
    },
  };
}

export function transactionSource(
  dataSourceIndex: number,
  title: string,
  pageCount: number,
): SyntheticDataSource {
  const suffix = String(dataSourceIndex + 1).repeat(12);
  const dataSourceId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix.slice(0, 12)}`;
  return {
    databaseId: `11111111-1111-4111-8111-${suffix.slice(0, 12)}`,
    dataSourceId,
    title,
    pages: Array.from({ length: pageCount }, (_, index) =>
      transactionPage(dataSourceId, dataSourceIndex, index),
    ),
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * Serves the Notion endpoints the Wellness reader uses, with real pagination.
 * Any other endpoint throws, so a request outside the scoped reads fails the test.
 */
export function syntheticWellnessFetch(
  sources: SyntheticDataSource[],
  requests: NotionRequest[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    if (url.includes(`/v1/blocks/${WELLNESS_ROOT_PAGE_ID}/children`)) {
      return Response.json({
        results: sources.map((source) => ({
          object: "block",
          id: source.databaseId,
          type: "child_database",
          child_database: { title: source.blockTitle ?? source.title },
        })),
        has_more: false,
        next_cursor: null,
      });
    }
    for (const source of sources) {
      if (url.endsWith(`/v1/databases/${source.databaseId}`)) {
        return Response.json({
          object: "database",
          id: source.databaseId,
          title: [{ plain_text: source.title }],
          data_sources: [{ id: source.dataSourceId }],
        });
      }
      if (url.endsWith(`/v1/data_sources/${source.dataSourceId}/query`) && method === "POST") {
        const { page_size: pageSize = 100, start_cursor: startCursor } = (body ?? {}) as {
          page_size?: number;
          start_cursor?: string;
        };
        const offset = startCursor ? Number(startCursor) : 0;
        const results = source.pages.slice(offset, offset + pageSize);
        const nextOffset = offset + results.length;
        const hasMore = nextOffset < source.pages.length;
        return Response.json({
          results,
          has_more: hasMore,
          next_cursor: hasMore ? String(nextOffset) : null,
        });
      }
    }
    throw new Error(`unexpected Notion request: ${method} ${url}`);
  }) as typeof fetch;
}

/**
 * A bookkeeping table shaped like the production one: several money columns
 * (a raw amount, an expense formula, a sparsely filled actual expense), a
 * direction select, and a date. Figures are fixture values only.
 */
export const CASHFLOW_FIXTURE = Object.freeze({
  rows: 164,
  dates: 74,
  expenseTotal: 1_303_307.51,
  latestDate: "2026-09-25",
  latestRows: 13,
  latestExpense: 156_325,
  incomeRows: 6,
  incomeTotal: 300_000,
});

function cashflowPage(
  dataSourceId: string,
  dataSourceIndex: number,
  index: number,
  row: { date: string; amount: number; direction: "Out" | "In"; category: string; payee: string },
) {
  const expense = row.direction === "Out" ? row.amount : 0;
  return {
    object: "page",
    id: recordId(dataSourceIndex, index),
    created_time: `${row.date}T08:00:00.000Z`,
    last_edited_time: `${row.date}T09:00:00.000Z`,
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      Name: { id: "title", type: "title", title: [richText(`${row.category} ${index}`)] },
      Date: { id: "dAtE", type: "date", date: { start: row.date, end: null, time_zone: null } },
      Amount: { id: "aMnT", type: "number", number: row.amount },
      "Expense Amount": {
        id: "eXpA",
        type: "formula",
        formula: { type: "number", number: expense },
      },
      "Actual Expense": {
        id: "aCtE",
        type: "number",
        number: index % 10 === 0 ? expense : null,
      },
      "AI Confidence": { id: "aIcF", type: "number", number: 0.93 },
      Direction: {
        id: "dIrN",
        type: "select",
        select: { id: "d1", name: row.direction, color: "green" },
      },
      "Main Category": {
        id: "mCaT",
        type: "select",
        select: { id: "c1", name: row.category, color: "gray" },
      },
      "To / Payee": { id: "pAyE", type: "rich_text", rich_text: [richText(row.payee)] },
    },
  };
}

export function cashflowSource(
  dataSourceIndex: number,
  title = "Cashflow - Cloudbath",
): SyntheticDataSource {
  const source = transactionSource(dataSourceIndex, title, 0);
  const rows: Array<Parameters<typeof cashflowPage>[3]> = [];
  // 13 rows on the latest date: 12 x 12,000 + 12,325 = 156,325.
  for (let i = 0; i < CASHFLOW_FIXTURE.latestRows; i += 1) {
    rows.push({
      date: CASHFLOW_FIXTURE.latestDate,
      amount: i === 0 ? 12_325 : 12_000,
      direction: "Out",
      category: "Material",
      payee: `Supplier ${i}`,
    });
  }
  // 145 older expenses over 73 earlier dates: 144 x 7,900 + 9,382.51.
  const olderDate = (i: number) => {
    const day = new Date(Date.UTC(2026, 5, 1) + (i % 73) * 86_400_000);
    return day.toISOString().slice(0, 10);
  };
  for (let i = 0; i < 145; i += 1) {
    rows.push({
      date: olderDate(i),
      amount: i === 0 ? 9_382.51 : 7_900,
      direction: "Out",
      category: i % 2 ? "Labour" : "Transport",
      payee: `Vendor ${i}`,
    });
  }
  // 6 money-in rows, which a spending question must not count.
  for (let i = 0; i < CASHFLOW_FIXTURE.incomeRows; i += 1) {
    rows.push({
      date: olderDate(i * 11),
      amount: 50_000,
      direction: "In",
      category: "Cash In",
      payee: "Owner",
    });
  }
  // Notion returns rows in its own order, not by date: interleave them.
  const ordered = rows.map((row, index) => ({ row, key: (index * 37) % rows.length }));
  ordered.sort((left, right) => left.key - right.key);
  return {
    ...source,
    pages: ordered.map(({ row }, index) =>
      cashflowPage(source.dataSourceId, dataSourceIndex, index, row),
    ),
  };
}

/**
 * The production root page's shape: a large untitled linked inbox first, then
 * the bookkeeping table, then two other project tables.
 */
export function productionShapedWellness(): SyntheticDataSource[] {
  return [
    { ...transactionSource(0, "Source Inbox", 240), blockTitle: "" },
    cashflowSource(1),
    transactionSource(2, "BOQ Forecast - Cloudbath", 60),
    { ...transactionSource(3, "Work Packages - Cloudbath", 30), blockTitle: "" },
  ];
}
