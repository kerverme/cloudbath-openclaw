import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  requestPluginHttpRouteWithoutGatewayAuthForTest,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2ArchiveClient } from "./src/r2.js";
import { UgcNotionWorkflowClient } from "./src/ugc-workflow.js";
import { tryGetCloudbathWorkspacePolicyRuntime } from "./src/workspace-policy-runtime.js";
import {
  createWorkspacePolicyServiceContext,
  createWorkspacePolicyStateRuntime,
  registerWorkspacePolicyPlugin,
} from "./workspace-policy-runtime.test-support.js";

const startedServices: OpenClawPluginService[] = [];
const temporaryStateDirs: string[] = [];

beforeEach(() => {
  vi.stubEnv("CLOUDBATH_IMAGE_ARCHIVE_ENABLED", "false");
  vi.stubEnv("CLOUDBATH_IMAGE_ANALYSIS_ENABLED", "false");
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "test-value");
  vi.stubEnv("RAILWAY_PUBLIC_DOMAIN", "cloudbath.example");
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  for (const service of startedServices.splice(0).toReversed()) {
    await service.stop?.(createWorkspacePolicyServiceContext());
  }
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  for (const stateDir of temporaryStateDirs.splice(0)) {
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudbath workspace policy runtime across plugin registries", () => {
  it("serves a valid Character capability through the real Gateway without a login token", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_BUCKET_NAME", "test-bucket");
    vi.stubEnv("R2_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext());
    startedServices.push(gateway.service);
    const resolveCharacter = vi
      .spyOn(UgcNotionWorkflowClient.prototype, "resolveCharacterViewAsset")
      .mockResolvedValue({ objectKey: "ugc/characters/twong/v1/main.webp" });
    const fetchPrivateObject = vi
      .spyOn(R2ArchiveClient.prototype, "fetchPrivateObject")
      .mockResolvedValue({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        contentType: "image/png",
      });
    const response = await requestPluginHttpRouteWithoutGatewayAuthForTest({
      pluginId: "cloudbath-line-image-archive",
      route: gateway.httpRoute,
      path: "/c/CHAR-6/abcdefghijklmnop",
    });

    expect(response.res.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(gateway.httpRoute.auth).toBe("plugin");
    expect(resolveCharacter).toHaveBeenCalledOnce();
    expect(fetchPrivateObject).toHaveBeenCalledOnce();
  });

  it("does not let an unstarted duplicate registry clear the active runtime", async () => {
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext());
    startedServices.push(gateway.service);
    const active = tryGetCloudbathWorkspacePolicyRuntime();

    const prewarm = registerWorkspacePolicyPlugin(state);
    await prewarm.service.stop?.(createWorkspacePolicyServiceContext());

    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(active);
  });

  it("resolves UGC tool hooks from the active gateway runtime", async () => {
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext());
    startedServices.push(gateway.service);
    const workflow = tryGetCloudbathWorkspacePolicyRuntime()?.ugcWorkflow;
    if (!workflow) {
      throw new Error("Gateway UGC workflow did not initialize");
    }
    const before = vi
      .spyOn(workflow, "beforeToolCall")
      .mockResolvedValue({ block: true, blockReason: "active-runtime" });
    const after = vi.spyOn(workflow, "afterToolCall").mockResolvedValue();
    const prewarm = registerWorkspacePolicyPlugin(state);

    const beforeResult = await prewarm.beforeToolCall(
      { toolName: "line_video_draft", params: {} },
      { toolName: "line_video_draft", sessionKey: "session-key" },
    );
    await prewarm.afterToolCall(
      { toolName: "line_video_draft", params: {}, result: { ok: true } },
      { toolName: "line_video_draft", sessionKey: "session-key" },
    );

    expect(beforeResult).toEqual({ block: true, blockReason: "active-runtime" });
    expect(before).toHaveBeenCalledWith({
      toolName: "line_video_draft",
      toolParams: {},
      sessionKey: "session-key",
    });
    expect(after).toHaveBeenCalledWith({
      toolName: "line_video_draft",
      result: { ok: true },
      sessionKey: "session-key",
    });
  });

  it("routes latest-image capture and character commands through the active gateway runtime", async () => {
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext());
    startedServices.push(gateway.service);
    const runtime = tryGetCloudbathWorkspacePolicyRuntime();
    const workflow = runtime?.ugcCharacterWorkflow;
    if (!workflow) {
      throw new Error("Gateway UGC character workflow did not initialize");
    }
    vi.spyOn(runtime.workspaceRegistry, "lookup").mockResolvedValue({
      accountId: "line-account",
      groupId: "Cpilotgroup",
      policyId: "UGC",
      boundByOwnerId: "owner-user",
      boundAt: "2026-08-26T00:00:00.000Z",
    });
    const beginInboundImageTurn = vi
      .spyOn(workflow, "beginInboundImageTurn")
      .mockResolvedValue(true);
    const handleCommand = vi
      .spyOn(workflow, "handleBeforeDispatch")
      .mockResolvedValue({ handled: true, text: "character-saved" });
    const prewarm = registerWorkspacePolicyPlugin(state);

    await prewarm.messageReceived(
      {
        from: "line:group:Cpilotgroup",
        senderId: "owner-user",
        content: "",
        messageId: "message-1",
        timestamp: Date.parse("2026-08-26T00:00:00.000Z"),
        metadata: {
          originatingTo: "line:group:Cpilotgroup",
          mediaPath: "/test/state/media/inbound/character.png",
          mediaType: "image/png",
        },
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
      },
    );
    const result = await prewarm.beforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "owner-user",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
        sessionKey: "agent:main:line:group:Cpilotgroup",
      },
    );

    expect(beginInboundImageTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "line-account",
        groupId: "Cpilotgroup",
        userId: "owner-user",
      }),
      expect.objectContaining({
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
      }),
    );
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(result).toEqual({ handled: true, text: "character-saved" });
  });

  it("captures managed LINE media durably before the transient file disappears", async () => {
    const stateDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), "cloudbath-line-character-hook-")),
    );
    temporaryStateDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("R2_ACCOUNT_ID", "test-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_BUCKET_NAME", "test-bucket");
    vi.stubEnv("R2_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
    const imageBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("production-equivalent-line-image"),
    ]);
    const saved = await saveMediaStream(
      (async function* () {
        yield imageBytes;
      })(),
      "image/png",
      "inbound",
      10 * 1024 * 1024,
      "line-image.png",
    );
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext(stateDir));
    startedServices.push(gateway.service);
    const runtime = tryGetCloudbathWorkspacePolicyRuntime();
    if (!runtime?.ugcCharacterWorkflow) {
      throw new Error("Gateway UGC character workflow did not initialize");
    }
    vi.spyOn(runtime.workspaceRegistry, "lookup").mockResolvedValue({
      accountId: "line-account",
      groupId: "Cpilotgroup",
      policyId: "UGC",
      boundByOwnerId: "owner-user",
      boundAt: "2026-08-26T00:00:00.000Z",
    });
    const ensureObject = vi
      .spyOn(R2ArchiveClient.prototype, "ensureObject")
      .mockResolvedValue({ kind: "uploaded" });
    const saveCharacterAsset = vi
      .spyOn(UgcNotionWorkflowClient.prototype, "saveCharacterAsset")
      .mockResolvedValue({
        name: "Kerver",
        characterId: "CHAR-5",
        status: "Active",
        pageId: "character-page",
        viewUrl: "https://cloudbath.example/c/CHAR-5/abcdefghijklmnop",
      });
    const prewarm = registerWorkspacePolicyPlugin(state);

    const messageReceived = prewarm.messageReceived(
      {
        from: "line:group:Cpilotgroup",
        senderId: "owner-user",
        content: "",
        messageId: "message-1",
        runId: "image-run",
        timestamp: Date.parse("2026-08-26T00:00:00.000Z"),
        metadata: {
          originatingTo: "line:group:Cpilotgroup",
          mediaPath: saved.path,
          mediaType: "image/png",
        },
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
        messageId: "message-1",
        runId: "image-run",
      },
    );
    const acknowledgement = await prewarm.beforeDispatch(
      {
        content: "",
        senderId: "owner-user",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        messageId: "message-1",
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
        sessionKey: "agent:main:line:group:Cpilotgroup",
      },
    );
    await messageReceived;
    expect(acknowledgement).toEqual({
      handled: true,
      text: "เห็นรูปแล้ว ต้องการให้ช่วยอะไร?",
    });
    await fsp.unlink(saved.path);
    const result = await prewarm.beforeDispatch(
      {
        content: "เก็บรูปนี้เป็นตัวละครชื่อ Kerver",
        senderId: "owner-user",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "line:group:Cpilotgroup",
        sessionKey: "agent:main:line:group:Cpilotgroup",
      },
    );

    expect(ensureObject).toHaveBeenCalledWith(
      expect.objectContaining({ body: imageBytes, contentType: "image/png" }),
    );
    expect(saveCharacterAsset).toHaveBeenCalledOnce();
    expect(result?.text).toContain("Character ID: CHAR-5");
  });

  it("clears the runtime when its owning service stops", async () => {
    const gateway = registerWorkspacePolicyPlugin(createWorkspacePolicyStateRuntime());
    await gateway.service.start(createWorkspacePolicyServiceContext());
    expect(tryGetCloudbathWorkspacePolicyRuntime()).not.toBeNull();

    await gateway.service.stop?.(createWorkspacePolicyServiceContext());

    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBeNull();
  });

  it("keeps a replacement runtime when the stale service stops", async () => {
    const state = createWorkspacePolicyStateRuntime();
    const first = registerWorkspacePolicyPlugin(state);
    const replacement = registerWorkspacePolicyPlugin(state);
    await first.service.start(createWorkspacePolicyServiceContext());
    const firstRuntime = tryGetCloudbathWorkspacePolicyRuntime();
    await replacement.service.start(createWorkspacePolicyServiceContext());
    startedServices.push(replacement.service);
    const replacementRuntime = tryGetCloudbathWorkspacePolicyRuntime();

    expect(replacementRuntime).not.toBe(firstRuntime);
    await first.service.stop?.(createWorkspacePolicyServiceContext());
    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(replacementRuntime);

    const prewarm = registerWorkspacePolicyPlugin(state);
    const result = await prewarm.beforeDispatch(
      {
        content: "สร้าง pairing UGC",
        senderId: "owner-user",
        senderIsOwner: true,
        isGroup: true,
      },
      {
        channelId: "line",
        accountId: "line-account",
        conversationId: "Cpilotgroup",
        sessionKey: "agent:main:line:group:Cpilotgroup",
      },
    );

    expect(result?.text).toMatch(/^Pairing code for UGC:/u);
    expect(tryGetCloudbathWorkspacePolicyRuntime()).toBe(replacementRuntime);
  });
});
