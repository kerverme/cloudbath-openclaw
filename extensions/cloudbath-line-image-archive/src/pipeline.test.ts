import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveArchiveConfig } from "./config.js";
import { ArchivePipeline } from "./pipeline.js";
import { resolveSchemaForAgent } from "./profiles.js";
import type {
  AsyncKeyedStore,
  BusinessRecordMetadata,
  InboundImageJob,
  PersistedArchiveRecord,
  SafeLogger,
} from "./types.js";

class MemoryStore implements AsyncKeyedStore<PersistedArchiveRecord> {
  readonly values = new Map<string, PersistedArchiveRecord>();

  async register(key: string, value: PersistedArchiveRecord): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async registerIfAbsent(key: string, value: PersistedArchiveRecord): Promise<boolean> {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, structuredClone(value));
    return true;
  }

  async lookup(key: string): Promise<PersistedArchiveRecord | undefined> {
    return this.values.get(key);
  }

  async entries() {
    return [...this.values.entries()].map(([key, value]) => ({
      key,
      value: structuredClone(value),
      createdAt: Date.now(),
    }));
  }
}

const logger: SafeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function rawProfiles() {
  const schema = {
    id: "evidence",
    name: "Evidence",
    description: "Generic evidence",
    version: 1,
    databaseTitle: "Evidence",
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
    ],
  };
  const agent = (id: string, groupId: string) => ({
    id,
    name: id,
    active: true,
    persona: "Evidence agent",
    instructions: "Archive evidence",
    authorizedLineGroupIds: [groupId],
    adminLineUserIds: [],
    notionDatabaseId: `database-${id}`,
    schemaProfileId: "evidence",
    schemaVersion: 1,
    extractionInstructions: "Extract visible facts",
    allowedTools: ["archive-image", "write-notion-record"],
    defaultModelAlias: "vision-default",
    allowedModelAliases: ["vision-default"],
    silentToggleCode: "reserved",
    archiveAcknowledgementsEnabled: false,
  });
  return {
    version: 1,
    schemaProfiles: [schema],
    agentProfiles: [agent("construction", "C1"), agent("finance", "C2")],
  };
}

function config() {
  return resolveArchiveConfig(
    {
      CLOUDBATH_IMAGE_ARCHIVE_ENABLED: "true",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "bucket",
      NOTION_API_KEY: "notion",
    },
    rawProfiles(),
  );
}

describe("universal asset and profile-scoped business records", () => {
  let stateDir: string;
  let mediaPath: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudbath-agent-archive-"));
    const mediaDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(mediaDir, { recursive: true });
    mediaPath = path.join(mediaDir, "same-image.bin");
    await fs.writeFile(
      mediaPath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]),
    );
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function job(groupId: string, messageId: string): InboundImageJob {
    return {
      groupId,
      lineTarget: `line:group:${groupId}`,
      messageId,
      mediaPath,
      mimeType: "image/png",
      receivedAt: "2026-07-25T01:02:03.000Z",
    };
  }

  it("lets two Agent Profiles reference one global R2 object and creates two Notion records", async () => {
    const archiveConfig = config();
    const storedObjects = new Set<string>();
    let uploads = 0;
    const r2Keys: string[] = [];
    const r2 = {
      ensureObject: vi.fn(async ({ objectKey }: { objectKey: string }) => {
        r2Keys.push(objectKey);
        if (storedObjects.has(objectKey)) {
          return { kind: "existing" as const };
        }
        storedObjects.add(objectKey);
        uploads += 1;
        return { kind: "uploaded" as const };
      }),
    };
    const businessRecords: BusinessRecordMetadata[] = [];
    const notion = {
      createRecord: vi.fn(async (metadata: BusinessRecordMetadata) => {
        businessRecords.push(metadata);
        return { kind: "created" as const, pageId: `page-${businessRecords.length}` };
      }),
    };
    const pipeline = new ArchivePipeline({
      config: archiveConfig,
      stateDir,
      store: new MemoryStore(),
      r2,
      notion,
      logger,
    });
    for (const [groupId, messageId] of [
      ["C1", "construction-message"],
      ["C2", "finance-message"],
    ] as const) {
      const agent = archiveConfig.profiles.activeProfilesByGroupId.get(groupId)!;
      await pipeline.enqueue(
        job(groupId, messageId),
        agent,
        resolveSchemaForAgent(archiveConfig.profiles, agent),
      );
    }
    await pipeline.waitForIdle();

    expect(uploads).toBe(1);
    expect(storedObjects.size).toBe(1);
    expect(new Set(r2Keys).size).toBe(1);
    expect(r2Keys[0]).toMatch(/^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);
    expect(businessRecords).toHaveLength(2);
    expect(businessRecords.map((record) => record.agentProfile.id)).toEqual([
      "construction",
      "finance",
    ]);
    expect(new Set(businessRecords.map((record) => record.recordIdentity)).size).toBe(2);
    expect(new Set(businessRecords.map((record) => record.asset.r2ObjectKey)).size).toBe(1);
  });

  it("deduplicates redelivery of the same Agent Profile and LINE message", async () => {
    const archiveConfig = config();
    const store = new MemoryStore();
    const r2 = { ensureObject: vi.fn(async () => ({ kind: "uploaded" as const })) };
    const notion = {
      createRecord: vi.fn(async () => ({ kind: "created" as const, pageId: "page" })),
    };
    const pipeline = new ArchivePipeline({
      config: archiveConfig,
      stateDir,
      store,
      r2,
      notion,
      logger,
    });
    const agent = archiveConfig.profiles.activeProfilesByGroupId.get("C1")!;
    const schema = resolveSchemaForAgent(archiveConfig.profiles, agent);
    await expect(pipeline.enqueue(job("C1", "message"), agent, schema)).resolves.toBe("queued");
    await expect(pipeline.enqueue(job("C1", "message"), agent, schema)).resolves.toBe("duplicate");
    await pipeline.waitForIdle();
    expect(r2.ensureObject).toHaveBeenCalledTimes(1);
    expect(notion.createRecord).toHaveBeenCalledTimes(1);
  });
});
