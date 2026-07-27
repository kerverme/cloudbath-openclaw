import type {
  AgentProfile,
  NotionPropertyType,
  ProfileConfiguration,
  RecordIdentityRule,
  SchemaProfile,
  SchemaPropertyDefinition,
  SystemFieldRole,
  ValidatedProfileConfiguration,
} from "./types.js";

const NOTION_PROPERTY_TYPES = new Set<NotionPropertyType>([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
]);
const SYSTEM_FIELD_ROLES = new Set<SystemFieldRole>([
  "recordIdentity",
  "assetId",
  "sha256",
  "r2ObjectKey",
  "receivedAt",
  "lineMessageId",
  "lineGroupId",
  "lineUserId",
  "status",
  "error",
]);
const REQUIRED_SYSTEM_FIELDS = [
  "recordIdentity",
  "sha256",
  "r2ObjectKey",
  "receivedAt",
] as const satisfies readonly SystemFieldRole[];
const SYSTEM_FIELD_TYPES: Partial<Record<SystemFieldRole, NotionPropertyType>> = {
  recordIdentity: "rich_text",
  assetId: "rich_text",
  sha256: "rich_text",
  r2ObjectKey: "rich_text",
  receivedAt: "date",
  lineMessageId: "rich_text",
  lineGroupId: "rich_text",
  lineUserId: "rich_text",
  status: "select",
  error: "rich_text",
};

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function profileIdValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) {
    throw new Error(`${label} must be a lowercase kebab-case identifier`);
  }
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const result = value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return result;
}

function parseIdentityRule(value: unknown, label: string): RecordIdentityRule {
  const raw = objectValue(value, label);
  if (raw.kind === "agent-profile-plus-sha256") {
    return { kind: "agent-profile-plus-sha256" };
  }
  if (raw.kind === "agent-profile-plus-properties") {
    const propertyIds = stringArray(raw.propertyIds, `${label}.propertyIds`);
    if (propertyIds.length === 0 || raw.rejectWhenMissing !== true) {
      throw new Error(`${label} composite identities require propertyIds and rejectWhenMissing=true`);
    }
    return { kind: "agent-profile-plus-properties", propertyIds, rejectWhenMissing: true };
  }
  throw new Error(`${label}.kind is unsupported`);
}

function parseValidationRules(
  value: unknown,
  label: string,
): SchemaPropertyDefinition["validationRules"] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    const ruleLabel = `${label}[${index}]`;
    const raw = objectValue(entry, ruleLabel);
    if (raw.kind === "integer") {
      return { kind: "integer" };
    }
    if (raw.kind === "min" || raw.kind === "max") {
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
        throw new Error(`${ruleLabel}.value must be a finite number`);
      }
      return { kind: raw.kind, value: raw.value };
    }
    if (raw.kind === "regex") {
      const pattern = stringValue(raw.pattern, `${ruleLabel}.pattern`);
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(`${ruleLabel}.pattern must be a valid regular expression`);
      }
      return { kind: "regex", pattern };
    }
    throw new Error(`${ruleLabel}.kind is unsupported`);
  });
}

function parseProperty(value: unknown, label: string): SchemaPropertyDefinition {
  const raw = objectValue(value, label);
  const notionType = stringValue(raw.notionType, `${label}.notionType`) as NotionPropertyType;
  if (!NOTION_PROPERTY_TYPES.has(notionType)) {
    throw new Error(`${label}.notionType is unsupported`);
  }
  const options = raw.options === undefined ? undefined : stringArray(raw.options, `${label}.options`);
  const optionType = notionType === "select" || notionType === "multi_select";
  if (options && !optionType) {
    throw new Error(`${label}.options are allowed only for select and multi_select`);
  }
  if (optionType && (!options || options.length === 0)) {
    throw new Error(`${label}.options are required for select and multi_select`);
  }
  const systemFieldRole =
    raw.systemFieldRole === undefined
      ? undefined
      : (stringValue(raw.systemFieldRole, `${label}.systemFieldRole`) as SystemFieldRole);
  if (systemFieldRole && !SYSTEM_FIELD_ROLES.has(systemFieldRole)) {
    throw new Error(`${label}.systemFieldRole is unsupported`);
  }
  const expectedSystemType = systemFieldRole ? SYSTEM_FIELD_TYPES[systemFieldRole] : undefined;
  if (expectedSystemType && notionType !== expectedSystemType) {
    throw new Error(
      `${label} system field ${systemFieldRole} must use Notion type ${expectedSystemType}`,
    );
  }
  if (raw.aggregatable === true && !["number", "date", "checkbox"].includes(notionType)) {
    throw new Error(`${label} cannot be aggregated with Notion type ${notionType}`);
  }
  return {
    id: stringValue(raw.id, `${label}.id`),
    name: stringValue(raw.name, `${label}.name`),
    notionType,
    required: booleanValue(raw.required, `${label}.required`),
    options,
    extractionDescription:
      raw.extractionDescription === undefined
        ? undefined
        : stringValue(raw.extractionDescription, `${label}.extractionDescription`),
    validationRules: parseValidationRules(raw.validationRules ?? [], `${label}.validationRules`),
    searchable: booleanValue(raw.searchable, `${label}.searchable`),
    aggregatable: booleanValue(raw.aggregatable, `${label}.aggregatable`),
    displayOrder: integerValue(raw.displayOrder, `${label}.displayOrder`),
    systemFieldRole,
  };
}

function parseSchemaProfile(value: unknown, index: number): SchemaProfile {
  const label = `schemaProfiles[${index}]`;
  const raw = objectValue(value, label);
  if (!Array.isArray(raw.properties) || raw.properties.length === 0) {
    throw new Error(`${label}.properties must be a non-empty array`);
  }
  const properties = raw.properties.map((entry, propertyIndex) =>
    parseProperty(entry, `${label}.properties[${propertyIndex}]`),
  );
  const propertyIds = properties.map((property) => property.id);
  const propertyNames = properties.map((property) => property.name);
  const displayOrders = properties.map((property) => property.displayOrder);
  if (new Set(propertyIds).size !== propertyIds.length) {
    throw new Error(`${label} has duplicate property IDs`);
  }
  if (new Set(propertyNames).size !== propertyNames.length) {
    throw new Error(`${label} has duplicate property names`);
  }
  if (new Set(displayOrders).size !== displayOrders.length) {
    throw new Error(`${label} has duplicate displayOrder values`);
  }
  if (properties.filter((property) => property.notionType === "title").length !== 1) {
    throw new Error(`${label} must contain exactly one title property`);
  }
  for (const role of REQUIRED_SYSTEM_FIELDS) {
    if (properties.filter((property) => property.systemFieldRole === role).length !== 1) {
      throw new Error(`${label} must contain exactly one ${role} system field`);
    }
  }
  const identityRule = parseIdentityRule(raw.recordIdentityRule, `${label}.recordIdentityRule`);
  if (identityRule.kind === "agent-profile-plus-properties") {
    for (const propertyId of identityRule.propertyIds) {
      if (!propertyIds.includes(propertyId)) {
        throw new Error(`${label} identity property ${propertyId} does not exist`);
      }
    }
  }
  return {
    id: profileIdValue(raw.id, `${label}.id`),
    name: stringValue(raw.name, `${label}.name`),
    description: stringValue(raw.description, `${label}.description`),
    version: integerValue(raw.version, `${label}.version`),
    databaseTitle: stringValue(raw.databaseTitle, `${label}.databaseTitle`),
    properties,
    recordIdentityRule: identityRule,
    suggestedViews: Array.isArray(raw.suggestedViews)
      ? (raw.suggestedViews as SchemaProfile["suggestedViews"])
      : [],
    exampleQuestions: stringArray(raw.exampleQuestions ?? [], `${label}.exampleQuestions`),
  };
}

function parseAgentProfile(value: unknown, index: number): AgentProfile {
  const label = `agentProfiles[${index}]`;
  const raw = objectValue(value, label);
  const allowedModelAliases = stringArray(raw.allowedModelAliases, `${label}.allowedModelAliases`);
  const defaultModelAlias = stringValue(raw.defaultModelAlias, `${label}.defaultModelAlias`);
  if (!allowedModelAliases.includes(defaultModelAlias)) {
    throw new Error(`${label}.defaultModelAlias must be included in allowedModelAliases`);
  }
  return {
    id: profileIdValue(raw.id, `${label}.id`),
    name: stringValue(raw.name, `${label}.name`),
    active: booleanValue(raw.active, `${label}.active`),
    persona: stringValue(raw.persona, `${label}.persona`),
    instructions: stringValue(raw.instructions, `${label}.instructions`),
    authorizedLineGroupIds: stringArray(
      raw.authorizedLineGroupIds,
      `${label}.authorizedLineGroupIds`,
    ),
    adminLineUserIds: stringArray(raw.adminLineUserIds, `${label}.adminLineUserIds`),
    notionDatabaseId: stringValue(raw.notionDatabaseId, `${label}.notionDatabaseId`),
    schemaProfileId: stringValue(raw.schemaProfileId, `${label}.schemaProfileId`),
    schemaVersion: integerValue(raw.schemaVersion, `${label}.schemaVersion`),
    extractionInstructions: stringValue(
      raw.extractionInstructions,
      `${label}.extractionInstructions`,
    ),
    allowedTools: stringArray(raw.allowedTools, `${label}.allowedTools`),
    defaultModelAlias,
    allowedModelAliases,
    silentToggleCode: stringValue(raw.silentToggleCode, `${label}.silentToggleCode`),
    archiveAcknowledgementsEnabled: booleanValue(
      raw.archiveAcknowledgementsEnabled,
      `${label}.archiveAcknowledgementsEnabled`,
    ),
    recordIdentityRule:
      raw.recordIdentityRule === undefined
        ? undefined
        : parseIdentityRule(raw.recordIdentityRule, `${label}.recordIdentityRule`),
  };
}

export function schemaKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function validateProfileConfiguration(value: unknown): ValidatedProfileConfiguration {
  const raw = objectValue(value, "plugin config");
  if (raw.version !== 1) {
    throw new Error("plugin config.version must be 1");
  }
  if (!Array.isArray(raw.agentProfiles) || !Array.isArray(raw.schemaProfiles)) {
    throw new Error("plugin config requires agentProfiles and schemaProfiles arrays");
  }
  const schemaProfiles = raw.schemaProfiles.map(parseSchemaProfile);
  const agentProfiles = raw.agentProfiles.map(parseAgentProfile);
  const schemaKeys = schemaProfiles.map((profile) => schemaKey(profile.id, profile.version));
  const agentIds = agentProfiles.map((profile) => profile.id);
  if (new Set(schemaKeys).size !== schemaKeys.length) {
    throw new Error("Schema Profile IDs and versions must be unique");
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw new Error("Agent Profile IDs must be unique");
  }

  const schemasByKey = new Map(
    schemaProfiles.map((profile) => [schemaKey(profile.id, profile.version), profile]),
  );
  const activeProfilesByGroupId = new Map<string, AgentProfile>();
  for (const profile of agentProfiles) {
    const schema = schemasByKey.get(schemaKey(profile.schemaProfileId, profile.schemaVersion));
    if (!schema) {
      throw new Error(
        `Agent Profile ${profile.id} references missing schema ${profile.schemaProfileId}@${profile.schemaVersion}`,
      );
    }
    const identityRule = profile.recordIdentityRule ?? schema.recordIdentityRule;
    if (identityRule.kind === "agent-profile-plus-properties") {
      const propertyIds = new Set(schema.properties.map((property) => property.id));
      for (const propertyId of identityRule.propertyIds) {
        if (!propertyIds.has(propertyId)) {
          throw new Error(`Agent Profile ${profile.id} identity property ${propertyId} is missing`);
        }
      }
    }
    if (!profile.active) {
      continue;
    }
    for (const requiredTool of ["archive-image", "write-notion-record"]) {
      if (!profile.allowedTools.includes(requiredTool)) {
        throw new Error(
          `Active Agent Profile ${profile.id} must allow ${requiredTool} for image ingestion`,
        );
      }
    }
    if (profile.authorizedLineGroupIds.length === 0) {
      throw new Error(`Active Agent Profile ${profile.id} must authorize at least one LINE group`);
    }
    for (const groupId of profile.authorizedLineGroupIds) {
      const existing = activeProfilesByGroupId.get(groupId);
      if (existing) {
        throw new Error(
          `Ambiguous LINE group ${groupId} is assigned to Agent Profiles ${existing.id} and ${profile.id}`,
        );
      }
      activeProfilesByGroupId.set(groupId, profile);
    }
  }

  return {
    version: 1,
    agentProfiles,
    schemaProfiles,
    schemasByKey,
    activeProfilesByGroupId,
  } satisfies ValidatedProfileConfiguration;
}

export function resolveSchemaForAgent(
  config: ValidatedProfileConfiguration,
  agentProfile: AgentProfile,
): SchemaProfile {
  const schema = config.schemasByKey.get(
    schemaKey(agentProfile.schemaProfileId, agentProfile.schemaVersion),
  );
  if (!schema) {
    throw new Error(`Schema Profile for Agent Profile ${agentProfile.id} is unavailable`);
  }
  return schema;
}

export function serializeProfileConfiguration(
  config: ValidatedProfileConfiguration,
): ProfileConfiguration {
  return {
    version: 1,
    agentProfiles: config.agentProfiles,
    schemaProfiles: config.schemaProfiles,
  };
}
