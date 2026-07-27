import { describe, expect, it, vi } from "vitest";
import { compileNotionProperties } from "./notion-schema.js";
import { NotionArchiveClient } from "./notion.js";
import { validateProfileConfiguration } from "./profiles.js";
import type { BusinessRecordMetadata, SafeLogger } from "./types.js";

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

function profileData() {
  const config = validateProfileConfiguration({
    version: 1,
    schemaProfiles: [
      {
        id: "finance",
        name: "Finance",
        description: "Finance receipts",
        version: 1,
        databaseTitle: "Finance",
        recordIdentityRule: { kind: "agent-profile-plus-sha256" },
        suggestedViews: [],
        exampleQuestions: [],
        properties: [
          {
            id: "name",
            name: "Receipt",
            notionType: "title",
            required: false,
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 1,
          },
          ...[
            ["identity", "Finance Asset ID", "rich_text", "recordIdentity"],
            ["sha", "Checksum", "rich_text", "sha256"],
            ["r2", "Archive Key", "rich_text", "r2ObjectKey"],
            ["received", "Received", "date", "receivedAt"],
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
            id: "amount",
            name: "Amount",
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
    agentProfiles: [
      {
        id: "finance-agent",
        name: "Finance Agent",
        active: true,
        persona: "Bookkeeper",
        instructions: "Archive receipts",
        authorizedLineGroupIds: ["C1"],
        adminLineUserIds: [],
        notionDatabaseId: "database-finance",
        schemaProfileId: "finance",
        schemaVersion: 1,
        extractionInstructions: "Extract visible amounts",
        allowedTools: ["archive-image", "write-notion-record"],
        defaultModelAlias: "vision-default",
        allowedModelAliases: ["vision-default"],
        silentToggleCode: "reserved",
        archiveAcknowledgementsEnabled: false,
      },
    ],
  });
  return {
    agentProfile: config.agentProfiles[0]!,
    schemaProfile: config.schemaProfiles[0]!,
  };
}

function metadata(): BusinessRecordMetadata {
  const profiles = profileData();
  return {
    ...profiles,
    recordIdentity: `finance-agent:${"a".repeat(64)}`,
    asset: {
      sha256: "a".repeat(64),
      r2ObjectKey: `assets/sha256/aa/${"a".repeat(64)}.png`,
      canonicalExtension: ".png",
      fileSize: 10,
      mimeType: "image/png",
    },
    job: {
      groupId: "C1",
      lineTarget: "line:group:C1",
      messageId: "message",
      mediaPath: "/state/media/inbound/image.png",
      mimeType: "image/png",
      receivedAt: "2026-07-25T01:02:03.000Z",
    },
    extractedFields: {
      values: { amount: 125.5 },
      provider: "provider",
      model: "model",
    },
    status: "PROCESSED",
  };
}

describe("profile-scoped Notion business records", () => {
  it("queries by dynamic record-identity property and writes dynamic schema fields", async () => {
    const record = metadata();
    const compiled = compileNotionProperties(record.schemaProfile);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/databases/database-finance")) {
        return Response.json({ data_sources: [{ id: "source-finance" }] });
      }
      if (url.endsWith("/v1/data_sources/source-finance")) {
        return Response.json({
          properties: Object.fromEntries(
            Object.entries(compiled).map(([name, value]) => [
              name,
              { type: Object.keys(value)[0], ...value },
            ]),
          ),
        });
      }
      if (url.endsWith("/query")) {
        return Response.json({ results: [] });
      }
      if (url.endsWith("/v1/pages")) {
        return Response.json({ id: "page-finance" });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new NotionArchiveClient(
      "token-placeholder",
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      logger,
      fetchImpl,
    );

    await expect(client.createRecord(record)).resolves.toEqual({
      kind: "created",
      pageId: "page-finance",
    });
    const queryBody = JSON.parse(
      requestBody(requests.find((request) => request.url.endsWith("/query"))?.init?.body),
    ) as { filter: { property: string; rich_text: { equals: string } } };
    expect(queryBody.filter).toEqual({
      property: "Finance Asset ID",
      rich_text: { equals: record.recordIdentity },
    });
    const pageBody = JSON.parse(
      requestBody(requests.find((request) => request.url.endsWith("/v1/pages"))?.init?.body),
    ) as { properties: Record<string, unknown> };
    expect(pageBody.properties).toEqual(
      expect.objectContaining({
        Checksum: { rich_text: [{ type: "text", text: { content: "a".repeat(64) } }] },
        Amount: { number: 125.5 },
      }),
    );
    expect(
      requests.every(
        (request) => !["PATCH", "PUT", "DELETE"].includes(request.init?.method ?? "GET"),
      ),
    ).toBe(true);
  });
});
