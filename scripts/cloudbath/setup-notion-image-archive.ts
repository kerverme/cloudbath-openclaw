import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  compileNotionProperties,
  createMigrationProposal,
  NOTION_API_VERSION,
  validateNotionProperties,
  type NotionPropertyDefinition,
} from "../../extensions/cloudbath-line-image-archive/src/notion-schema.js";
import {
  schemaKey,
  validateProfileConfiguration,
} from "../../extensions/cloudbath-line-image-archive/src/profiles.js";
import type {
  SchemaMigrationProposal,
  SchemaPlanProposal,
  SchemaProfile,
} from "../../extensions/cloudbath-line-image-archive/src/types.js";

const NOTION_BASE_URL = "https://api.notion.com";
export type NotionSetupMode = "plan" | "create" | "bind" | "validate" | "migration-plan";
type FetchLike = typeof fetch;
type SetupEnvironment = {
  OPEN_CLAW_NOTION_WRITE_TOKEN?: string;
  NOTION_PARENT_PAGE_ID?: string;
  NOTION_DATABASE_ID?: string;
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

export type NotionSetupConfig = {
  mode: NotionSetupMode;
  apiKey?: string;
  parentPageId?: string;
  databaseId?: string;
  schemaProfile: SchemaProfile;
  approvalId?: string;
  fromVersion?: number;
  agentRoleDescription?: string;
  desiredDecisionsAndReports?: readonly string[];
};

export type NotionSetupResult =
  | {
      kind: "planned";
      proposal: SchemaPlanProposal;
    }
  | {
      kind: "created" | "reused" | "bound" | "validated";
      databaseId: string;
      dataSourceId: string;
      schemaProfileId: string;
      schemaVersion: number;
    }
  | {
      kind: "migration-planned";
      databaseId: string;
      dataSourceId: string;
      migration: SchemaMigrationProposal;
    };

type DatabaseSetupResult<K extends "created" | "reused" | "bound" | "validated"> = {
  kind: K;
  databaseId: string;
  dataSourceId: string;
  schemaProfileId: string;
  schemaVersion: number;
};

function requiredValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

export function readNotionSetupEnvironment(env: SetupEnvironment): {
  apiKey?: string;
  parentPageId?: string;
  databaseId?: string;
} {
  return {
    apiKey: env.OPEN_CLAW_NOTION_WRITE_TOKEN?.trim() || undefined,
    parentPageId: env.NOTION_PARENT_PAGE_ID?.trim() || undefined,
    databaseId: env.NOTION_DATABASE_ID?.trim() || undefined,
  };
}

function proposalPayload(params: {
  schemaProfile: SchemaProfile;
  agentRoleDescription: string;
  desiredDecisionsAndReports: readonly string[];
}): string {
  return JSON.stringify({
    schemaProfile: params.schemaProfile,
    agentRoleDescription: params.agentRoleDescription,
    desiredDecisionsAndReports: params.desiredDecisionsAndReports,
  });
}

export function createSchemaPlanProposal(params: {
  schemaProfile: SchemaProfile;
  agentRoleDescription?: string;
  desiredDecisionsAndReports?: readonly string[];
  now?: () => Date;
}): SchemaPlanProposal {
  const agentRoleDescription =
    params.agentRoleDescription?.trim() || params.schemaProfile.description;
  const desiredDecisionsAndReports = params.desiredDecisionsAndReports ?? [];
  const proposalId = crypto
    .createHash("sha256")
    .update(
      proposalPayload({
        schemaProfile: params.schemaProfile,
        agentRoleDescription,
        desiredDecisionsAndReports,
      }),
    )
    .digest("hex");
  const propertyRationales = Object.fromEntries(
    params.schemaProfile.properties.map((property) => [
      property.id,
      property.extractionDescription ||
        (property.systemFieldRole
          ? `Required universal ${property.systemFieldRole} reference`
          : `Supports the ${property.name} business field`),
    ]),
  );
  return {
    proposalId,
    agentRoleDescription,
    desiredDecisionsAndReports,
    proposedSchema: params.schemaProfile,
    propertyRationales,
    suggestedViews: params.schemaProfile.suggestedViews,
    exampleQuestions: params.schemaProfile.exampleQuestions,
    createdAt: (params.now ?? (() => new Date()))().toISOString(),
    approved: false,
  };
}

class NotionSetupClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("Content-Type", "application/json");
    headers.set("Notion-Version", NOTION_API_VERSION);
    const response = await this.fetchImpl(`${NOTION_BASE_URL}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `Notion API request failed (${response.status}) while ${init?.method ?? "GET"} ${path}`,
      );
    }
    return (await response.json()) as T;
  }

  private async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    return await this.request<NotionDatabase>(`/v1/databases/${encodeURIComponent(databaseId)}`);
  }

  async retrieveSchema(databaseId: string): Promise<{
    dataSourceId: string;
    properties: Record<string, NotionPropertyDefinition>;
  }> {
    const database = await this.retrieveDatabase(databaseId);
    const ids = (database.data_sources ?? [])
      .map((source) => source.id?.trim())
      .filter((id): id is string => Boolean(id));
    if (ids.length !== 1) {
      throw new Error(
        `Database ${databaseId} must contain exactly one data source; found ${ids.length}`,
      );
    }
    const dataSource = await this.request<NotionDataSource>(
      `/v1/data_sources/${encodeURIComponent(ids[0])}`,
    );
    return { dataSourceId: ids[0], properties: dataSource.properties ?? {} };
  }

  async validateDatabase<K extends "reused" | "bound" | "validated">(
    databaseId: string,
    schema: SchemaProfile,
    kind: K,
  ): Promise<DatabaseSetupResult<K>> {
    const current = await this.retrieveSchema(databaseId);
    const issues = validateNotionProperties(schema, current.properties);
    if (issues.length > 0) {
      throw new Error(
        `Notion database schema is incompatible:\n- ${issues
          .map((issue) => `${issue.propertyName}: ${issue.reason}`)
          .join("\n- ")}`,
      );
    }
    return {
      kind,
      databaseId,
      dataSourceId: current.dataSourceId,
      schemaProfileId: schema.id,
      schemaVersion: schema.version,
    };
  }

  private async findNamedChildDatabases(parentPageId: string, title: string): Promise<string[]> {
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
        if (block.type === "child_database" && block.child_database?.title === title && block.id) {
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

  async createApprovedDatabase(
    parentPageId: string,
    schema: SchemaProfile,
  ): Promise<DatabaseSetupResult<"created" | "reused">> {
    const matches = await this.findNamedChildDatabases(parentPageId, schema.databaseTitle);
    if (matches.length > 1) {
      throw new Error(
        `Found ${matches.length} child databases named "${schema.databaseTitle}"; provide NOTION_DATABASE_ID`,
      );
    }
    if (matches.length === 1) {
      return await this.validateDatabase(matches[0], schema, "reused");
    }
    const created = await this.request<NotionDatabase>("/v1/databases", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: schema.databaseTitle } }],
        initial_data_source: {
          title: [{ type: "text", text: { content: schema.databaseTitle } }],
          properties: compileNotionProperties(schema),
        },
      }),
    });
    const databaseId = created.id?.trim();
    if (!databaseId) {
      throw new Error("Notion create database response did not include a database ID");
    }
    const validated = await this.validateDatabase(databaseId, schema, "validated");
    return { ...validated, kind: "created" };
  }
}

export async function runNotionSetup(
  config: NotionSetupConfig,
  options: {
    fetchImpl?: FetchLike;
    output?: (line: string) => void;
    now?: () => Date;
  } = {},
): Promise<NotionSetupResult> {
  const proposal = createSchemaPlanProposal({
    schemaProfile: config.schemaProfile,
    agentRoleDescription: config.agentRoleDescription,
    desiredDecisionsAndReports: config.desiredDecisionsAndReports,
    now: options.now,
  });
  const output = options.output ?? console.log;
  if (config.mode === "plan") {
    output(JSON.stringify(proposal, null, 2));
    return { kind: "planned", proposal };
  }
  const client = new NotionSetupClient(
    requiredValue(config.apiKey, "OPEN_CLAW_NOTION_WRITE_TOKEN"),
    options.fetchImpl ?? fetch,
  );
  if (config.mode === "create") {
    if (config.approvalId !== proposal.proposalId) {
      throw new Error(
        `Explicit approval required: rerun create with --approve ${proposal.proposalId}`,
      );
    }
    const result = await client.createApprovedDatabase(
      requiredValue(config.parentPageId, "NOTION_PARENT_PAGE_ID"),
      config.schemaProfile,
    );
    output(`Notion database ${result.kind}: ${result.databaseId}`);
    output(`Notion data source ID: ${result.dataSourceId}`);
    return result;
  }
  const databaseId = requiredValue(config.databaseId, "NOTION_DATABASE_ID");
  if (config.mode === "migration-plan") {
    const current = await client.retrieveSchema(databaseId);
    const migration = createMigrationProposal({
      schema: config.schemaProfile,
      properties: current.properties,
      fromVersion: config.fromVersion,
    });
    const result: NotionSetupResult = {
      kind: "migration-planned",
      databaseId,
      dataSourceId: current.dataSourceId,
      migration,
    };
    output(JSON.stringify(result, null, 2));
    return result;
  }
  const kind = config.mode === "bind" ? "bound" : "validated";
  const result = await client.validateDatabase(databaseId, config.schemaProfile, kind);
  output(`Notion database ${result.kind}: ${result.databaseId}`);
  output(`Notion data source ID: ${result.dataSourceId}`);
  return result;
}

type CliOptions = {
  mode?: NotionSetupMode;
  profileConfigPath?: string;
  schemaProfileId?: string;
  schemaVersion?: number;
  approvalId?: string;
  fromVersion?: number;
  agentRoleDescription?: string;
  desiredDecisionsAndReports: string[];
};

function parseCliArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { desiredDecisionsAndReports: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    switch (flag) {
      case "--mode":
        if (!["plan", "create", "bind", "validate", "migration-plan"].includes(value)) {
          throw new Error(`Unsupported setup mode ${value}`);
        }
        options.mode = value as NotionSetupMode;
        break;
      case "--profile-config":
        options.profileConfigPath = value;
        break;
      case "--schema-profile":
        options.schemaProfileId = value;
        break;
      case "--schema-version":
        options.schemaVersion = Number(value);
        break;
      case "--approve":
        options.approvalId = value;
        break;
      case "--from-version":
        options.fromVersion = Number(value);
        break;
      case "--agent-role":
        options.agentRoleDescription = value;
        break;
      case "--decision":
        options.desiredDecisionsAndReports.push(value);
        break;
      default:
        throw new Error(`Unsupported argument ${flag}`);
    }
  }
  return options;
}

async function loadSchemaProfile(options: CliOptions): Promise<SchemaProfile> {
  const path = requiredValue(options.profileConfigPath, "--profile-config");
  const raw = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  const config = validateProfileConfiguration(raw);
  const id = requiredValue(options.schemaProfileId, "--schema-profile");
  if (!Number.isSafeInteger(options.schemaVersion) || (options.schemaVersion ?? 0) < 1) {
    throw new Error("--schema-version must be a positive integer");
  }
  const schema = config.schemasByKey.get(schemaKey(id, options.schemaVersion as number));
  if (!schema) {
    throw new Error(`Schema Profile ${id}@${options.schemaVersion} was not found in ${path}`);
  }
  return schema;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const env = readNotionSetupEnvironment({
    OPEN_CLAW_NOTION_WRITE_TOKEN: process.env.OPEN_CLAW_NOTION_WRITE_TOKEN,
    NOTION_PARENT_PAGE_ID: process.env.NOTION_PARENT_PAGE_ID,
    NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
  });
  await runNotionSetup({
    mode: cli.mode ?? "plan",
    ...env,
    schemaProfile: await loadSchemaProfile(cli),
    approvalId: cli.approvalId,
    fromVersion: cli.fromVersion,
    agentRoleDescription: cli.agentRoleDescription,
    desiredDecisionsAndReports: cli.desiredDecisionsAndReports,
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Notion setup failed");
    process.exitCode = 1;
  });
}
