import { describe, expect, it, vi } from "vitest";
import { compileNotionProperties } from "../../extensions/cloudbath-line-image-archive/src/notion-schema.js";
import { validateProfileConfiguration } from "../../extensions/cloudbath-line-image-archive/src/profiles.js";
import {
  createSchemaPlanProposal,
  readNotionSetupEnvironment,
  runNotionSetup,
} from "./setup-notion-image-archive.js";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected a string request body");
  }
  return body;
}

function schemaProfile() {
  return validateProfileConfiguration({
    version: 1,
    agentProfiles: [],
    schemaProfiles: [
      {
        id: "inventory",
        name: "Inventory",
        description: "Inventory deliveries",
        version: 2,
        databaseTitle: "Cloudbath Inventory Deliveries",
        recordIdentityRule: { kind: "agent-profile-plus-sha256" },
        suggestedViews: [],
        exampleQuestions: ["Which deliveries need review?"],
        properties: [
          {
            id: "name",
            name: "Delivery",
            notionType: "title",
            required: false,
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 1,
          },
          ...[
            ["identity", "Asset ID", "rich_text", "recordIdentity"],
            ["sha", "SHA-256", "rich_text", "sha256"],
            ["r2", "R2 Key", "rich_text", "r2ObjectKey"],
            ["received", "Received At", "date", "receivedAt"],
          ].map(([id, name, notionType, systemFieldRole], index) => ({
            id,
            name,
            notionType,
            systemFieldRole,
            required: true,
            validationRules: [],
            searchable: true,
            aggregatable: notionType === "date",
            displayOrder: index + 2,
          })),
          {
            id: "quantity",
            name: "Quantity",
            notionType: "number",
            required: false,
            validationRules: [{ kind: "min", value: 0 }],
            searchable: false,
            aggregatable: true,
            displayOrder: 6,
          },
        ],
      },
    ],
  }).schemaProfiles[0]!;
}

function retrievedProperties() {
  return Object.fromEntries(
    Object.entries(compileNotionProperties(schemaProfile())).map(([name, property]) => [
      name,
      { type: Object.keys(property)[0], ...property },
    ]),
  );
}

function database() {
  return { id: "database-1", data_sources: [{ id: "source-1" }] };
}

describe("generic Notion Schema Profile setup", () => {
  it("reads only approved environment names and plan performs no API call", async () => {
    const reads: string[] = [];
    const env = new Proxy(
      {
        OPENCLAW_NOTION_WRITE_TOKEN: "token-placeholder",
        NOTION_PARENT_PAGE_ID: "parent-1",
        NOTION_DATABASE_ID: undefined,
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(readNotionSetupEnvironment(env)).toEqual({
      apiKey: "token-placeholder",
      parentPageId: "parent-1",
      databaseId: undefined,
    });
    expect(reads).toEqual([
      "OPENCLAW_NOTION_WRITE_TOKEN",
      "NOTION_PARENT_PAGE_ID",
      "NOTION_DATABASE_ID",
    ]);
    const fetchImpl = vi.fn();
    const result = await runNotionSetup(
      { mode: "plan", schemaProfile: schemaProfile() },
      { fetchImpl: fetchImpl as typeof fetch, output: vi.fn(), now: () => new Date(0) },
    );
    expect(result.kind).toBe("planned");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the exact proposal ID before database creation", async () => {
    const schema = schemaProfile();
    const proposal = createSchemaPlanProposal({ schemaProfile: schema });
    await expect(
      runNotionSetup(
        {
          mode: "create",
          schemaProfile: schema,
          apiKey: "token",
          parentPageId: "parent",
          approvalId: "wrong",
        },
        { fetchImpl: vi.fn() as typeof fetch },
      ),
    ).rejects.toThrow(`--approve ${proposal.proposalId}`);
  });

  it("creates exactly one approved database from a dynamic Schema Profile", async () => {
    const schema = schemaProfile();
    const approvalId = createSchemaPlanProposal({ schemaProfile: schema }).proposalId;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.includes("/v1/blocks/parent-1/children")) {
        return Response.json({ results: [], has_more: false });
      }
      if (url.endsWith("/v1/databases") && init?.method === "POST") {
        return Response.json(database());
      }
      if (url.endsWith("/v1/databases/database-1")) {
        return Response.json(database());
      }
      if (url.endsWith("/v1/data_sources/source-1")) {
        return Response.json({ properties: retrievedProperties() });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const result = await runNotionSetup(
      {
        mode: "create",
        schemaProfile: schema,
        apiKey: "token-placeholder",
        parentPageId: "parent-1",
        approvalId,
      },
      { fetchImpl, output: vi.fn() },
    );
    expect(result.kind).toBe("created");
    const creates = requests.filter(
      (request) => request.url.endsWith("/v1/databases") && request.init?.method === "POST",
    );
    expect(creates).toHaveLength(1);
    const body = JSON.parse(requestBody(creates[0]?.init?.body)) as {
      title: Array<{ text: { content: string } }>;
      initial_data_source: { properties: Record<string, unknown> };
    };
    expect(body.title[0]?.text.content).toBe(schema.databaseTitle);
    expect(body.initial_data_source.properties).toEqual(compileNotionProperties(schema));
  });

  it.each(["bind", "validate"] as const)(
    "%s validates an existing database without mutation",
    async (mode) => {
      const methods: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return requestUrl(input).endsWith("/v1/databases/database-1")
          ? Response.json(database())
          : Response.json({ properties: retrievedProperties() });
      }) as typeof fetch;
      const result = await runNotionSetup(
        {
          mode,
          schemaProfile: schemaProfile(),
          apiKey: "token",
          databaseId: "database-1",
        },
        { fetchImpl, output: vi.fn() },
      );
      expect(result.kind).toBe(mode === "bind" ? "bound" : "validated");
      expect(methods).toEqual(["GET", "GET"]);
    },
  );

  it("migration-plan never deletes, renames, or changes property types", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (requestUrl(input).endsWith("/v1/databases/database-1")) {
        return Response.json(database());
      }
      return Response.json({
        properties: {
          Delivery: { type: "title" },
          "User Notes": { type: "rich_text" },
        },
      });
    }) as typeof fetch;
    const result = await runNotionSetup(
      {
        mode: "migration-plan",
        schemaProfile: schemaProfile(),
        apiKey: "token",
        databaseId: "database-1",
        fromVersion: 1,
      },
      { fetchImpl, output: vi.fn() },
    );
    expect(result.kind).toBe("migration-planned");
    if (result.kind === "migration-planned") {
      expect(result.migration.automaticActions).toEqual([]);
      expect(result.migration.unrelatedExistingProperties).toContain("User Notes");
    }
    expect(methods).toEqual(["GET", "GET"]);
  });
});
