export const NOTION_API_VERSION = "2026-03-11";

export const NOTION_REQUIRED_PROPERTIES = [
  ["Name", "title"],
  ["Received At", "date"],
  ["LINE Message ID", "rich_text"],
  ["LINE Webhook Event ID", "rich_text"],
  ["LINE Group ID", "rich_text"],
  ["LINE User ID", "rich_text"],
  ["Sender Name", "rich_text"],
  ["Original Filename", "rich_text"],
  ["MIME Type", "rich_text"],
  ["File Size", "number"],
  ["SHA-256", "rich_text"],
  ["R2 Object Key", "rich_text"],
  ["AI Description", "rich_text"],
  ["Category", "select"],
  ["Tags", "multi_select"],
  ["Vendor", "rich_text"],
  ["Amount", "number"],
  ["Status", "select"],
  ["Error", "rich_text"],
] as const;

export const NOTION_STATUS_OPTIONS = [
  "NEW",
  "PROCESSED",
  "NEED_REVIEW",
  "DUPLICATE",
  "ERROR",
] as const;

export type NotionPropertyDefinition = {
  type?: string;
  select?: {
    options?: Array<{ name?: string }>;
  };
};

export function createNotionArchiveProperties(): Record<string, unknown> {
  return Object.fromEntries(
    NOTION_REQUIRED_PROPERTIES.map(([name, type]) => {
      if (name === "Status") {
        return [
          name,
          {
            select: {
              options: NOTION_STATUS_OPTIONS.map((optionName) => ({ name: optionName })),
            },
          },
        ];
      }
      return [name, { [type]: {} }];
    }),
  );
}

export function validateNotionArchiveProperties(
  properties: Record<string, NotionPropertyDefinition>,
): string[] {
  const issues: string[] = [];
  for (const [name, expectedType] of NOTION_REQUIRED_PROPERTIES) {
    const property = properties[name];
    if (!property) {
      issues.push(`Missing property "${name}" (expected ${expectedType})`);
      continue;
    }
    if (property.type !== expectedType) {
      issues.push(
        `Property "${name}" has type ${property.type ?? "unknown"} (expected ${expectedType})`,
      );
    }
  }

  const actualStatusOptions = properties.Status?.select?.options
    ?.map((option) => option.name?.trim())
    .filter((name): name is string => Boolean(name));
  const expectedStatusOptions = [...NOTION_STATUS_OPTIONS];
  const statusOptionsMatch =
    actualStatusOptions?.length === expectedStatusOptions.length &&
    expectedStatusOptions.every((name) => actualStatusOptions.includes(name));
  if (!statusOptionsMatch) {
    issues.push(
      `Property "Status" must have exactly these select options: ${expectedStatusOptions.join(", ")}`,
    );
  }

  return issues;
}
