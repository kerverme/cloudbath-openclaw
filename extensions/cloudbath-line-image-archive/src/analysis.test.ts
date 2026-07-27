import { describe, expect, it } from "vitest";
import { validateExtractedValues } from "./analysis.js";
import { validateProfileConfiguration } from "./profiles.js";

function extractionSchema() {
  return validateProfileConfiguration({
    version: 1,
    agentProfiles: [],
    schemaProfiles: [
      {
        id: "dynamic-extraction",
        name: "Dynamic Extraction",
        description: "Schema-driven extraction test",
        version: 1,
        databaseTitle: "Dynamic Extraction",
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
            required: true,
            validationRules: [{ kind: "min", value: 0 }],
            searchable: false,
            aggregatable: true,
            displayOrder: 6,
          },
          {
            id: "category",
            name: "Category",
            notionType: "select",
            required: false,
            options: ["MATERIAL", "LABOR"],
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 7,
          },
          {
            id: "tags",
            name: "Tags",
            notionType: "multi_select",
            required: false,
            options: ["urgent", "review"],
            validationRules: [],
            searchable: true,
            aggregatable: false,
            displayOrder: 8,
          },
        ],
      },
    ],
  }).schemaProfiles[0]!;
}

describe("schema-driven extraction validation", () => {
  it("accepts values matching dynamic Notion types and options", () => {
    expect(
      validateExtractedValues(extractionSchema(), {
        amount: 125.5,
        category: "MATERIAL",
        tags: ["review"],
      }),
    ).toEqual({
      amount: 125.5,
      category: "MATERIAL",
      tags: ["review"],
    });
  });

  it("rejects type mismatches and unconfigured options", () => {
    expect(() =>
      validateExtractedValues(extractionSchema(), {
        amount: "125.5",
      }),
    ).toThrow("does not match Notion type number");
    expect(() =>
      validateExtractedValues(extractionSchema(), {
        amount: 125.5,
        category: "OTHER",
      }),
    ).toThrow("unsupported option");
  });
});
