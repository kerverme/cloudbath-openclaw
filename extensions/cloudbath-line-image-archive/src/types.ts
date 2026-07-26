export type ProcessingStatus = "NEW" | "PROCESSED" | "NEED_REVIEW" | "DUPLICATE" | "ERROR";

export type ArchiveConfig = {
  enabled: boolean;
  analysisEnabled: boolean;
  allowedGroupIds: ReadonlySet<string>;
  imageMaxBytes: number;
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
    databaseId: string;
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

export type ImageAnalysis = {
  description: string;
  category?: string;
  tags: string[];
  vendor?: string;
  amount?: number;
  provider: string;
  model: string;
};

export type PersistedArchiveRecord = {
  key: string;
  job: InboundImageJob;
  status: ProcessingStatus;
  attempts: number;
  updatedAt: string;
  fileSize?: number;
  sha256?: string;
  objectKey?: string;
  originalFilename?: string;
  analysis?: ImageAnalysis;
  notionPageId?: string;
  error?: string;
};

export type ArchiveMetadata = {
  receivedAt: string;
  lineMessageId: string;
  lineWebhookEventId?: string;
  lineGroupId: string;
  lineUserId?: string;
  senderName?: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  r2ObjectKey: string;
  analysis?: ImageAnalysis;
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
