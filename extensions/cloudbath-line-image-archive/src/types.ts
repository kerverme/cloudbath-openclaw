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

export type LineGroupWorkspacePolicyId = "UGC" | "KEEP_WATCHING";

export type UgcCapabilityId =
  | "PRODUCT_LIBRARY"
  | "CHARACTER_LIBRARY"
  | "UGC_PROJECTS"
  | "UGC_SHOTS"
  | "AI_VIDEO_LIBRARY"
  | "AI_IMAGE_LIBRARY";

export type UgcCapabilityAccess = "READ" | "READ_WRITE";

export type NotionTarget = {
  databaseId: string;
  dataSourceId: string;
};

export type WorkspacePolicyConfig = {
  pairingTtlMs: number;
  keepWatching?: {
    notion: NotionTarget;
    r2Prefix: string;
  };
  ugc?: {
    capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  };
};

export type LineGroupPolicyBinding = {
  accountId: string;
  groupId: string;
  policyId: LineGroupWorkspacePolicyId;
  boundByOwnerId: string;
  boundAt: string;
};

export type LineGroupPairingGrant = {
  accountId: string;
  policyId: LineGroupWorkspacePolicyId;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
};

export type FrozenWorkspaceJobScope = Readonly<{
  lineGroupId: string;
  policyId: LineGroupWorkspacePolicyId;
  jobType: "KEEP_WATCHING_MEDIA" | "UGC_WORKFLOW";
  sourceCapabilityIds: readonly UgcCapabilityId[];
  targetDatabaseId: string;
  targetDataSourceId: string;
  r2Prefix: string;
}>;

export type KeepWatchingJobRecord = {
  key: string;
  status: "NEW" | "PROCESSED" | "ERROR";
  scope: FrozenWorkspaceJobScope;
  job: InboundImageJob;
  attempts: number;
  updatedAt: string;
  sha256?: string;
  objectKey?: string;
  fileSize?: number;
  notionPageId?: string;
  error?: string;
};

export type UgcReferenceAsset = Readonly<{
  kind: "identity" | "product" | "style";
  source: "r2" | "https";
  locator: string;
}>;

/**
 * One character frozen into a project. `identityReferences` is the exact set
 * every scene in the project resubmits; the Character Library is not consulted
 * again after this is written.
 */
export type UgcCharacterLock = Readonly<{
  code: string;
  pageId: string;
  /** Notion last-edit stamp at freeze time. Audit evidence, never a re-resolve key. */
  contentIdentity?: string;
  identityReferences: readonly UgcReferenceAsset[];
  styleReferences: readonly UgcReferenceAsset[];
  frozenAt: string;
}>;

/**
 * A distinct piece of work. Product + cast is NOT an identity: the same product
 * with the same characters can be three unrelated stories, each needing its own
 * scenes, lock, costs and outputs. This application-owned id is what separates
 * them; Notion's own Project ID is Notion-managed and cannot be chosen by us.
 */
export type UgcProjectInstance = Readonly<{
  version: 1;
  projectInstanceId: string;
  projectPageId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  productPageId: string;
  characterPageIds: readonly string[];
  createdAt: string;
}>;

/**
 * The project a conversation is currently working on. Persisted so "ต่อ Scene 2"
 * lands on the same project after a restart, and scoped to the trusted
 * account/group/owner triple rather than to model-supplied text.
 */
export type ActiveUgcProject = Readonly<{
  version: 1;
  projectInstanceId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  updatedAt: string;
}>;

/**
 * Durable per-project cast, keyed by project INSTANCE. Two projects sharing a
 * product and cast freeze independently: editing the Character Library later
 * cannot touch an existing project, but a deliberately new project may freeze
 * the then-current references.
 */
export type UgcProjectCharacterLock = Readonly<{
  version: 1;
  projectInstanceId: string;
  projectPageId: string;
  projectRecordId: string;
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  characterLocks: readonly UgcCharacterLock[];
  frozenAt: string;
}>;

/** Continuity trail a later film-director pass can read without re-deriving it. */
export type UgcSceneContinuity = Readonly<{
  sceneNumber: number;
  previousScenePageId?: string;
  characterPageIds: readonly string[];
  characterCodes: readonly string[];
  prompt: string;
  durationSeconds?: number;
  outputR2Key?: string;
  /**
   * Provider-neutral slot for a still carried forward from the previous scene.
   * Populated only when a provider documents support for it; nothing here
   * implies video-to-video capability.
   */
  previousSceneFrameR2Key?: string;
}>;

export type FrozenUgcVideoScope = Readonly<{
  version: 1;
  policyId: "UGC";
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
  productPageId: string;
  characterPageId?: string;
  /** Frozen cast for this scene, in submission order. */
  characterLocks: readonly UgcCharacterLock[];
  projectInstanceId: string;
  projectPageId: string;
  projectRecordId: string;
  shotPageIds: readonly string[];
  /** The scene this scope will generate. Scene 1 for a fresh project. */
  scene: UgcSceneContinuity;
  scenePageId: string;
  referenceAssets: readonly UgcReferenceAsset[];
  frozenPrompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  capabilities: Readonly<Record<UgcCapabilityId, NotionTarget>>;
  r2Prefix: "outbound/line-video";
  createdAt: string;
}>;

export type PendingUgcVideoScope = FrozenUgcVideoScope & {
  sessionKeyHash: string;
};

export type ActiveUgcLineSession = Readonly<{
  accountId: string;
  lineGroupId: string;
  ownerSenderId: string;
}>;

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
