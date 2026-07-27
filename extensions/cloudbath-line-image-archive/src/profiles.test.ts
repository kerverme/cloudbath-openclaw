import { describe, expect, it } from "vitest";
import { resolveSchemaForAgent, validateProfileConfiguration } from "./profiles.js";

function schema(id = "evidence", version = 1) {
  return {
    id,
    name: id,
    description: "Configurable evidence",
    version,
    databaseTitle: `${id} database`,
    recordIdentityRule: { kind: "agent-profile-plus-sha256" },
    suggestedViews: [],
    exampleQuestions: [],
    properties: [
      {
        id: "name",
        name: "Name",
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
        ["r2", "R2 Object Key", "rich_text", "r2ObjectKey"],
        ["received", "Received At", "date", "receivedAt"],
      ].map(([propertyId, name, notionType, systemFieldRole], index) => ({
        id: propertyId,
        name,
        notionType,
        systemFieldRole,
        required: true,
        validationRules: [],
        searchable: true,
        aggregatable: notionType === "date",
        displayOrder: index + 2,
      })),
    ],
  };
}

function agent(id: string, groupId: string, schemaProfileId = "evidence") {
  return {
    id,
    name: id,
    active: true,
    persona: "Evidence coordinator",
    instructions: "Archive evidence",
    authorizedLineGroupIds: [groupId],
    adminLineUserIds: [],
    notionDatabaseId: `database-${id}`,
    schemaProfileId,
    schemaVersion: 1,
    extractionInstructions: "Extract visible facts only",
    allowedTools: ["archive-image", "write-notion-record"],
    defaultModelAlias: "vision-default",
    allowedModelAliases: ["vision-default"],
    silentToggleCode: "reserved",
    archiveAcknowledgementsEnabled: true,
  };
}

describe("Agent Profile configuration", () => {
  it("routes each LINE group to one active Agent Profile", () => {
    const config = validateProfileConfiguration({
      version: 1,
      schemaProfiles: [schema(), schema("finance")],
      agentProfiles: [agent("construction", "C1"), agent("finance", "C2", "finance")],
    });
    expect(config.activeProfilesByGroupId.get("C1")?.id).toBe("construction");
    expect(resolveSchemaForAgent(config, config.activeProfilesByGroupId.get("C2")!).id).toBe(
      "finance",
    );
  });

  it("fails safely on ambiguous LINE group routing", () => {
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema()],
        agentProfiles: [agent("one", "C1"), agent("two", "C1")],
      }),
    ).toThrow("Ambiguous LINE group C1");
  });

  it("rejects duplicate Agent Profile IDs and missing schema versions", () => {
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema()],
        agentProfiles: [agent("same", "C1"), agent("same", "C2")],
      }),
    ).toThrow("Agent Profile IDs must be unique");
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema()],
        agentProfiles: [agent("one", "C1", "missing")],
      }),
    ).toThrow("references missing schema");
  });

  it("rejects invalid profile IDs and non-positive schema versions", () => {
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema("Invalid Schema")],
        agentProfiles: [],
      }),
    ).toThrow("lowercase kebab-case");
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema("evidence", 0)],
        agentProfiles: [],
      }),
    ).toThrow("positive integer");
  });

  it("requires active ingest profiles to allow archive and Notion writes", () => {
    const incomplete = agent("one", "C1");
    incomplete.allowedTools = ["archive-image"];
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [schema()],
        agentProfiles: [incomplete],
      }),
    ).toThrow("must allow write-notion-record");
  });

  it("rejects ingestible schemas missing required semantic fields", () => {
    const invalid = schema();
    invalid.properties = invalid.properties.filter(
      (property) =>
        !("systemFieldRole" in property) || property.systemFieldRole !== "sha256",
    );
    expect(() =>
      validateProfileConfiguration({
        version: 1,
        schemaProfiles: [invalid],
        agentProfiles: [],
      }),
    ).toThrow("exactly one sha256 system field");
  });
});
