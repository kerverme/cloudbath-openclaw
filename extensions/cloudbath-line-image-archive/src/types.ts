export type ProcessingStatus = "NEW" | "PROCESSED" | "NEED_REVIEW" | "DUPLICATE" | "ERROR";

export type NotionPropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone_number";

export type SystemFieldRole =
  | "recordIdentity"
  | "assetId"
  | "sha256"
  | "r2ObjectKey"
  | "receivedAt"
  | "lineMessageId"
  | "lineGroupId"
  | "lineUserId"
  | "status"
  | "error";

export type SchemaValidationRule =
  | { kind: "min"; value: number }
  | { kind: "max"; value: number }
  | { kind: "integer" }
  | { kind: "regex"; pattern: string };

export type SchemaPropertyDefinition = {
  id: string;
  name: string;
  notionType: NotionPropertyType;
  required: boolean;
  options?: readonly string[];
  extractionDescription?: string;
  validationRules: readonly SchemaValidationRule[];
  searchable: boolean;
  aggregatable: boolean;
  displayOrder: number;
  systemFieldRole?: SystemFieldRole;
};

export type RecordIdentityRule =
  | { kind: "agent-profile-plus-sha256" }
  | {
      kind: "agent-profile-plus-properties";
      propertyIds: readonly string[];
      rejectWhenMissing: true;
    };

export type SuggestedNotionView = {
  name: string;
  purpose: string;
  layout: "table" | "board" | "timeline" | "calendar" | "gallery";
  filterDescription?: string;
  sortDescription?: string;
  groupByPropertyId?: string;
};

export type SchemaProfile = {
  id: string;
  name: string;
  description: string;
  version: number;
  databaseTitle: string;
  properties: readonly SchemaPropertyDefinition[];
  recordIdentityRule: RecordIdentityRule;
  suggestedViews: readonly SuggestedNotionView[];
  exampleQuestions: readonly string[];
};

export type AgentProfile = {
  id: string;
  name: string;
  active: boolean;
  persona: string;
  instructions: string;
  authorizedLineGroupIds: readonly string[];
  adminLineUserIds: readonly string[];
  notionDatabaseId: string;
  schemaProfileId: string;
  schemaVersion: number;
  extractionInstructions: string;
  allowedTools: readonly string[];
  defaultModelAlias: string;
  allowedModelAliases: readonly string[];
  silentToggleCode: string;
  archiveAcknowledgementsEnabled: boolean;
  recordIdentityRule?: RecordIdentityRule;
};

export type ProfileConfiguration = {
  version: 1;
  agentProfiles: readonly AgentProfile[];
  schemaProfiles: readonly SchemaProfile[];
};

export type ValidatedProfileConfiguration = ProfileConfiguration & {
  schemasByKey: ReadonlyMap<string, SchemaProfile>;
  activeProfilesByGroupId: ReadonlyMap<string, AgentProfile>;
};

export type SchemaPlanProposal = {
  proposalId: string;
  agentRoleDescription: string;
  desiredDecisionsAndReports: readonly string[];
  proposedSchema: SchemaProfile;
  propertyRationales: Readonly<Record<string, string>>;
  suggestedViews: readonly SuggestedNotionView[];
  exampleQuestions: readonly string[];
  createdAt: string;
  approved: false;
};

export type SchemaCompatibilityIssue = {
  propertyId: string;
  propertyName: string;
  expectedType: NotionPropertyType;
  actualType?: string;
  reason: string;
};

export type SchemaMigrationProposal = {
  schemaProfileId: string;
  fromVersion?: number;
  toVersion: number;
  missingProperties: readonly SchemaPropertyDefinition[];
  incompatibleProperties: readonly SchemaCompatibilityIssue[];
  possibleRenames: readonly {
    existingName: string;
    proposedName: string;
    reason: string;
  }[];
  unrelatedExistingProperties: readonly string[];
  automaticActions: readonly [];
};

export type ArchiveConfig = {
  enabled: boolean;
  analysisEnabled: boolean;
  imageMaxBytes: number;
  profiles: ValidatedProfileConfiguration;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    endpoint: string;
    keyPrefix: string;
  };
  notion: {
    apiKey: string;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
};

export type InboundImageJob = {
  accountId?: string;
  groupId: string;
  lineTarget: string;
  messageId: string;
  webhookEventId?: string;
  userId?: string;
  senderName?: string;
  sessionKey?: string;
  mediaPath: string;
  mimeType: string;
  receivedAt: string;
};

export type ExtractedFields = {
  values: Readonly<Record<string, unknown>>;
  provider: string;
  model: string;
};

export type PersistedArchiveRecord = {
  key: string;
  job: InboundImageJob;
  agentProfileId: string;
  schemaProfileId: string;
  schemaVersion: number;
  status: ProcessingStatus;
  attempts: number;
  updatedAt: string;
  fileSize?: number;
  sha256?: string;
  objectKey?: string;
  canonicalExtension?: string;
  recordIdentity?: string;
  extractedFields?: ExtractedFields;
  notionPageId?: string;
  error?: string;
};

export type AssetMetadata = {
  sha256: string;
  r2ObjectKey: string;
  canonicalExtension: string;
  fileSize: number;
  mimeType: string;
};

export type BusinessRecordMetadata = {
  agentProfile: AgentProfile;
  schemaProfile: SchemaProfile;
  recordIdentity: string;
  asset: AssetMetadata;
  job: InboundImageJob;
  extractedFields?: ExtractedFields;
  status: ProcessingStatus;
  error?: string;
};

export type NotionWriteResult =
  | { kind: "created"; pageId: string }
  | { kind: "duplicate"; pageId?: string };

export type AsyncKeyedStore<T> = {
  register(key: string, value: T): Promise<void>;
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T; createdAt: number; expiresAt?: number }>>;
};

export type SafeLogger = {
  debug?: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
};
