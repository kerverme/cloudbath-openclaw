import { describe, expect, it } from "vitest";
import { resolveArchiveConfig, resolveWorkspacePolicyConfig } from "./config.js";

function pluginConfig() {
  return {
    version: 1,
    schemaProfiles: [
      {
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
      },
    ],
    agentProfiles: [
      {
        id: "agent-a",
        name: "Agent A",
        active: true,
        persona: "Evidence agent",
        instructions: "Archive evidence",
        authorizedLineGroupIds: ["C123"],
        adminLineUserIds: ["U123"],
        notionDatabaseId: "database-a",
        schemaProfileId: "evidence",
        schemaVersion: 1,
        extractionInstructions: "Extract visible facts",
        allowedTools: ["archive-image", "write-notion-record"],
        defaultModelAlias: "vision-default",
        allowedModelAliases: ["vision-default"],
        silentToggleCode: "reserved",
        archiveAcknowledgementsEnabled: true,
      },
    ],
  };
}

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLOUDBATH_IMAGE_ARCHIVE_ENABLED: "true",
    CLOUDBATH_IMAGE_ANALYSIS_ENABLED: "false",
    IMAGE_MAX_MB: "12",
    R2_ACCOUNT_ID: "account-placeholder",
    R2_ACCESS_KEY_ID: "access-placeholder",
    R2_SECRET_ACCESS_KEY: "secret-placeholder",
    R2_BUCKET_NAME: "bucket-placeholder",
    R2_KEY_PREFIX: "cloudbath/images",
    OPEN_CLAW_NOTION_WRITE_TOKEN: "notion-placeholder",
    ...overrides,
  };
}

describe("resolveArchiveConfig", () => {
  it("is disabled by default without credentials or profiles", () => {
    const config = resolveArchiveConfig({}, {});
    expect(config.enabled).toBe(false);
    expect(config.profiles.agentProfiles).toEqual([]);
  });

  it("loads Agent Profiles without a global Notion database", () => {
    const config = resolveArchiveConfig(enabledEnv(), pluginConfig());
    expect(config.profiles.activeProfilesByGroupId.get("C123")?.id).toBe("agent-a");
    expect(config.profiles.agentProfiles[0]?.notionDatabaseId).toBe("database-a");
    expect(config.notion).toEqual({ apiKey: "notion-placeholder" });
    expect(config.r2.keyPrefix).toBe("cloudbath/images");
  });

  it("fails closed without the canonical Notion write credential when enabled", () => {
    expect(() =>
      resolveArchiveConfig(enabledEnv({ OPEN_CLAW_NOTION_WRITE_TOKEN: "" }), pluginConfig()),
    ).toThrow("OPEN_CLAW_NOTION_WRITE_TOKEN is required");
  });

  it("does not accept legacy Notion write credential names", () => {
    expect(() =>
      resolveArchiveConfig(
        enabledEnv({
          OPEN_CLAW_NOTION_WRITE_TOKEN: "",
          OPENCLAW_NOTION_WRITE_TOKEN: "legacy-placeholder",
          NOTION_CONSTRUCTION_WRITE_TOKEN: "legacy-placeholder",
        }),
        pluginConfig(),
      ),
    ).toThrow("OPEN_CLAW_NOTION_WRITE_TOKEN is required");
  });

  it("rejects non-HTTPS R2 endpoints", () => {
    expect(() =>
      resolveArchiveConfig(enabledEnv({ R2_ENDPOINT: "http://example.invalid" }), pluginConfig()),
    ).toThrow("HTTPS");
  });
});

describe("resolveWorkspacePolicyConfig", () => {
  it("accepts only explicit fixed KEEP_WATCHING and UGC targets", () => {
    const target = (value: string) => ({
      databaseId: value.repeat(32),
      dataSourceId: value.toUpperCase().repeat(32),
    });
    const config = resolveWorkspacePolicyConfig({
      groupWorkspacePolicies: {
        keepWatching: { notion: target("a"), r2Prefix: "watch/media" },
        ugc: {
          capabilities: {
            PRODUCT_LIBRARY: target("1"),
            CHARACTER_LIBRARY: target("2"),
            UGC_PROJECTS: target("3"),
            UGC_SHOTS: target("4"),
            AI_VIDEO_LIBRARY: target("5"),
            AI_IMAGE_LIBRARY: target("6"),
          },
        },
      },
    });
    expect(config.keepWatching).toEqual({
      notion: { databaseId: "a".repeat(32), dataSourceId: "a".repeat(32) },
      r2Prefix: "watch/media",
    });
    expect(config.ugc?.capabilities.PRODUCT_LIBRARY.databaseId).toBe("1".repeat(32));
  });

  it("fails closed when a required UGC capability target is missing", () => {
    expect(() =>
      resolveWorkspacePolicyConfig({
        groupWorkspacePolicies: { ugc: { capabilities: {} } },
      }),
    ).toThrow("PRODUCT_LIBRARY");
  });

  it("does not let policy configuration replace Agent Profile validation input", () => {
    expect(() =>
      resolveArchiveConfig(enabledEnv(), {
        ...pluginConfig(),
        groupWorkspacePolicies: { pairingTtlMs: 60_000 },
      }),
    ).not.toThrow();
  });
});
