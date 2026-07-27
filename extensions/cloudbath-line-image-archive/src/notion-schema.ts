import type {
  NotionPropertyType,
  SchemaCompatibilityIssue,
  SchemaMigrationProposal,
  SchemaProfile,
  SchemaPropertyDefinition,
} from "./types.js";

export const NOTION_API_VERSION = "2026-03-11";

export type NotionPropertyDefinition = {
  id?: string;
  name?: string;
  type?: string;
  select?: { options?: Array<{ name?: string }> };
  multi_select?: { options?: Array<{ name?: string }> };
};

function propertyOptions(property: SchemaPropertyDefinition): Array<{ name: string }> {
  return (property.options ?? []).map((name) => ({ name }));
}

export function compileNotionProperties(
  schema: SchemaProfile,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...schema.properties]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((property) => {
        if (property.notionType === "select" || property.notionType === "multi_select") {
          return [
            property.name,
            { [property.notionType]: { options: propertyOptions(property) } },
          ];
        }
        return [property.name, { [property.notionType]: {} }];
      }),
  );
}

function actualOptions(
  property: NotionPropertyDefinition,
  type: "select" | "multi_select",
): string[] {
  return (
    property[type]?.options
      ?.map((option) => option.name?.trim())
      .filter((name): name is string => Boolean(name)) ?? []
  );
}

export function validateNotionProperties(
  schema: SchemaProfile,
  properties: Record<string, NotionPropertyDefinition>,
): SchemaCompatibilityIssue[] {
  const issues: SchemaCompatibilityIssue[] = [];
  for (const expected of schema.properties) {
    const actual = properties[expected.name];
    if (!actual) {
      issues.push({
        propertyId: expected.id,
        propertyName: expected.name,
        expectedType: expected.notionType,
        reason: "missing",
      });
      continue;
    }
    if (actual.type !== expected.notionType) {
      issues.push({
        propertyId: expected.id,
        propertyName: expected.name,
        expectedType: expected.notionType,
        actualType: actual.type,
        reason: "incompatible type",
      });
      continue;
    }
    if (expected.notionType === "select" || expected.notionType === "multi_select") {
      const actualNames = actualOptions(actual, expected.notionType);
      const missingOptions = (expected.options ?? []).filter((name) => !actualNames.includes(name));
      const unexpectedOptions = actualNames.filter(
        (name) => !(expected.options ?? []).includes(name),
      );
      if (missingOptions.length > 0 || unexpectedOptions.length > 0) {
        const differences = [
          missingOptions.length > 0 ? `missing options: ${missingOptions.join(", ")}` : undefined,
          unexpectedOptions.length > 0
            ? `unexpected options: ${unexpectedOptions.join(", ")}`
            : undefined,
        ].filter((value): value is string => Boolean(value));
        issues.push({
          propertyId: expected.id,
          propertyName: expected.name,
          expectedType: expected.notionType,
          actualType: actual.type,
          reason: differences.join("; "),
        });
      }
    }
  }
  return issues;
}

export function createMigrationProposal(params: {
  schema: SchemaProfile;
  properties: Record<string, NotionPropertyDefinition>;
  fromVersion?: number;
}): SchemaMigrationProposal {
  const issues = validateNotionProperties(params.schema, params.properties);
  const missingNames = new Set(
    issues.filter((issue) => issue.reason === "missing").map((issue) => issue.propertyName),
  );
  const missingProperties = params.schema.properties.filter((property) =>
    missingNames.has(property.name),
  );
  const incompatibleProperties = issues.filter((issue) => issue.reason !== "missing");
  const expectedNames = new Set(params.schema.properties.map((property) => property.name));
  const unrelatedExistingProperties = Object.keys(params.properties).filter(
    (name) => !expectedNames.has(name),
  );
  const possibleRenames = missingProperties.flatMap((missing) => {
    const compatible = unrelatedExistingProperties.filter(
      (name) => params.properties[name]?.type === missing.notionType,
    );
    return compatible.map((existingName) => ({
      existingName,
      proposedName: missing.name,
      reason: "same Notion type; administrator review required",
    }));
  });
  return {
    schemaProfileId: params.schema.id,
    fromVersion: params.fromVersion,
    toVersion: params.schema.version,
    missingProperties,
    incompatibleProperties,
    possibleRenames,
    unrelatedExistingProperties,
    automaticActions: [],
  };
}

export function notionTypeSupportsAggregation(type: NotionPropertyType): boolean {
  return type === "number" || type === "date" || type === "checkbox";
}
