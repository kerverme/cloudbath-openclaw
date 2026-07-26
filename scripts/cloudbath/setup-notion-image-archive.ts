import { pathToFileURL } from "node:url";
import {
  NOTION_API_VERSION,
  createNotionArchiveProperties,
  type NotionPropertyDefinition,
  validateNotionArchiveProperties,
} from "../../extensions/cloudbath-line-image-archive/src/notion-schema.js";

const NOTION_BASE_URL = "https://api.notion.com";
export const NOTION_DATABASE_NAME = "Cloudbath LINE Image Archive";

type FetchLike = typeof fetch;

type SetupEnvironment = {
  NOTION_API_KEY?: string;
  NOTION_PARENT_PAGE_ID?: string;
  NOTION_DATABASE_ID?: string;
};

export type NotionSetupConfig = {
  apiKey: string;
  parentPageId?: string;
  databaseId?: string;
};

type NotionDatabase = {
  id?: string;
  data_sources?: Array<{ id?: string; name?: string }>;
};

type NotionDataSource = {
  id?: string;
  properties?: Record<string, NotionPropertyDefinition>;
};

type NotionChildBlock = {
  id?: string;
  type?: string;
  child_database?: { title?: string };
};

type NotionBlockChildren = {
  results?: NotionChildBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
};

export type NotionSetupResult = {
  kind: "created" | "validated" | "reused";
  databaseId: string;
  dataSourceId: string;
};

function requiredValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

export function readNotionSetupConfig(env: SetupEnvironment): NotionSetupConfig {
  const apiKey = requiredValue(env.NOTION_API_KEY, "NOTION_API_KEY");
  const parentPageId = env.NOTION_PARENT_PAGE_ID?.trim() || undefined;
  const databaseId = env.NOTION_DATABASE_ID?.trim() || undefined;
  if (!databaseId && !parentPageId) {
    throw new Error("NOTION_PARENT_PAGE_ID is required when NOTION_DATABASE_ID is not provided");
  }
  return { apiKey, parentPageId, databaseId };
}

class NotionSetupClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Notion API request failed (${response.status}) while ${init?.method ?? "GET"} ${path}`,
      );
    }
    return (await response.json()) as T;
  }

  private async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    return await this.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(databaseId)}`,
    );
  }

  private async resolveSingleDataSource(databaseId: string): Promise<string> {
    const database = await this.retrieveDatabase(databaseId);
    const dataSourceIds = (database.data_sources ?? [])
      .map((source) => source.id?.trim())
      .filter((id): id is string => Boolean(id));
    if (dataSourceIds.length !== 1) {
      throw new Error(
        `Database ${databaseId} must contain exactly one data source; found ${dataSourceIds.length}`,
      );
    }
    return dataSourceIds[0];
  }

  private async validateDataSource(dataSourceId: string): Promise<void> {
    const dataSource = await this.request<NotionDataSource>(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
    );
    const issues = validateNotionArchiveProperties(dataSource.properties ?? {});
    if (issues.length > 0) {
      throw new Error(`Notion database schema is incompatible:\n- ${issues.join("\n- ")}`);
    }
  }

  async validateDatabase(
    databaseId: string,
    kind: NotionSetupResult["kind"],
  ): Promise<NotionSetupResult> {
    const dataSourceId = await this.resolveSingleDataSource(databaseId);
    await this.validateDataSource(dataSourceId);
    return { kind, databaseId, dataSourceId };
  }

  private async findNamedChildDatabases(parentPageId: string): Promise<string[]> {
    const matches: string[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) {
        query.set("start_cursor", cursor);
      }
      const page = await this.request<NotionBlockChildren>(
        `/v1/blocks/${encodeURIComponent(parentPageId)}/children?${query.toString()}`,
      );
      for (const block of page.results ?? []) {
        if (
          block.type === "child_database" &&
          block.child_database?.title === NOTION_DATABASE_NAME &&
          block.id
        ) {
          matches.push(block.id);
        }
      }
      cursor = page.has_more ? page.next_cursor?.trim() || undefined : undefined;
      if (page.has_more && !cursor) {
        throw new Error("Notion returned a paginated parent page without a next cursor");
      }
    } while (cursor);
    return matches;
  }

  async setup(parentPageId: string): Promise<NotionSetupResult> {
    const matches = await this.findNamedChildDatabases(parentPageId);
    if (matches.length > 1) {
      throw new Error(
        `Found ${matches.length} child databases named "${NOTION_DATABASE_NAME}"; provide NOTION_DATABASE_ID to choose one`,
      );
    }
    if (matches.length === 1) {
      return await this.validateDatabase(matches[0], "reused");
    }

    const created = await this.request<NotionDatabase>("/v1/databases", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: NOTION_DATABASE_NAME } }],
        initial_data_source: {
          title: [{ type: "text", text: { content: NOTION_DATABASE_NAME } }],
          properties: createNotionArchiveProperties(),
        },
      }),
    });
    const databaseId = created.id?.trim();
    if (!databaseId) {
      throw new Error("Notion create database response did not include a database ID");
    }
    return await this.validateDatabase(databaseId, "created");
  }
}

export async function runNotionSetup(
  config: NotionSetupConfig,
  options: {
    fetchImpl?: FetchLike;
    output?: (line: string) => void;
  } = {},
): Promise<NotionSetupResult> {
  const client = new NotionSetupClient(config.apiKey, options.fetchImpl ?? fetch);
  const result = config.databaseId
    ? await client.validateDatabase(config.databaseId, "validated")
    : await client.setup(requiredValue(config.parentPageId, "NOTION_PARENT_PAGE_ID"));
  const output = options.output ?? console.log;
  output(`Notion database ${result.kind}: ${result.databaseId}`);
  output(`Notion data source ID: ${result.dataSourceId}`);
  return result;
}

async function main(): Promise<void> {
  const config = readNotionSetupConfig({
    NOTION_API_KEY: process.env.NOTION_API_KEY,
    NOTION_PARENT_PAGE_ID: process.env.NOTION_PARENT_PAGE_ID,
    NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
  });
  await runNotionSetup(config);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Notion setup failed");
    process.exitCode = 1;
  });
}
