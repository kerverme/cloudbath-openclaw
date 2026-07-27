import { describe, expect, it } from "vitest";
import {
  compileNotionProperties,
  createMigrationProposal,
  validateNotionProperties,
} from "./notion-schema.js";
import { validateProfileConfiguration } from "./profiles.js";

function dynamicSchema() {
  return validateProfileConfiguration({
    version: 1,
    agentProfiles: [],
    schemaProfiles: [
      {
        id: "maintenance",
        name: "Maintenance",
        description: "Maintenance evidence",
        version: 2,
        databaseTitle: "Maintenance",
        recordIdentityRule: { kind: "agent-profile-plus-sha256" },
        suggestedViews: [],
        exampleQuestions: [],
        properties: [
          {
            id: "name",
            name: "Ticket",
            notionType: "title",
            required: false,
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 1,
          },
          ...[
            ["identity", "Asset ID", "rich_text", "recordIdentity"],
            ["sha", "Checksum", "rich_text", "sha256"],
            ["r2", "Archive Key", "rich_text", "r2ObjectKey"],
            ["received", "Submitted", "date", "receivedAt"],
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
            id: "priority",
            name: "Priority",
            notionType: "select",
            required: false,
            options: ["LOW", "HIGH"],
            extractionDescription: "Maintenance priority",
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 6,
          },
        ],
      },
    ],
  }).schemaProfiles[0]!;
}

describe("dynamic Notion schema", () => {
  it("compiles the configured names, types, and options", () => {
    expect(compileNotionProperties(dynamicSchema())).toEqual(
      expect.objectContaining({
        Ticket: { title: {} },
        Checksum: { rich_text: {} },
        Priority: { select: { options: [{ name: "LOW" }, { name: "HIGH" }] } },
      }),
    );
  });

  it("validates dynamically without requiring the old archive fields", () => {
    const schema = dynamicSchema();
    const compiled = compileNotionProperties(schema);
    const retrieved = Object.fromEntries(
      Object.entries(compiled).map(([name, value]) => [
        name,
        { type: Object.keys(value)[0], ...value },
      ]),
    );
    expect(validateNotionProperties(schema, retrieved)).toEqual([]);
  });

  it("reports both missing and unexpected configured options", () => {
    const schema = dynamicSchema();
    const compiled = compileNotionProperties(schema);
    const retrieved = Object.fromEntries(
      Object.entries(compiled).map(([name, value]) => [
        name,
        { type: Object.keys(value)[0], ...value },
      ]),
    );
    retrieved.Priority = {
      type: "select",
      select: { options: [{ name: "LOW" }, { name: "UNCONFIGURED" }] },
    };
    expect(validateNotionProperties(schema, retrieved)).toEqual([
      expect.objectContaining({
        propertyId: "priority",
        reason: "missing options: HIGH; unexpected options: UNCONFIGURED",
      }),
    ]);
  });

  it("produces a non-mutating migration proposal", () => {
    const migration = createMigrationProposal({
      schema: dynamicSchema(),
      fromVersion: 1,
      properties: {
        Ticket: { type: "title" },
        "Old Priority": { type: "select", select: { options: [{ name: "LOW" }] } },
        "User Notes": { type: "rich_text" },
      },
    });
    expect(migration.toVersion).toBe(2);
    expect(migration.missingProperties.length).toBeGreaterThan(0);
    expect(migration.unrelatedExistingProperties).toContain("User Notes");
    expect(migration.automaticActions).toEqual([]);
  });
});
