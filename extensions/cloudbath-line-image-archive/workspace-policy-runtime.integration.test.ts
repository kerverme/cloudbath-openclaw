import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryGetCloudbathWorkspacePolicyRuntime } from "./src/workspace-policy-runtime.js";
import {
  createWorkspacePolicyServiceContext,
  createWorkspacePolicyStateRuntime,
  registerWorkspacePolicyPlugin,
} from "./workspace-policy-runtime.test-support.js";

const startedServices: OpenClawPluginService[] = [];

beforeEach(() => {
  vi.stubEnv("CLOUDBATH_IMAGE_ARCHIVE_ENABLED", "false");
  vi.stubEnv("CLOUDBATH_IMAGE_ANALYSIS_ENABLED", "false");
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "test-value");
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  for (const service of startedServices.splice(0).toReversed()) {
    await service.stop?.(createWorkspacePolicyServiceContext());
  }
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudbath workspace policy runtime across plugin registries", () => {
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
    const rememberImage = vi.spyOn(workflow, "rememberImage").mockResolvedValue();
    const handleCommand = vi
      .spyOn(workflow, "handleBeforeDispatch")
      .mockResolvedValue({ handled: true, text: "character-saved" });
    const prewarm = registerWorkspacePolicyPlugin(state);

    await prewarm.messageReceived(
      {
        from: "line:group:Cpilotgroup",
        senderId: "owner-user",
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

    expect(rememberImage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "line-account",
        groupId: "Cpilotgroup",
        userId: "owner-user",
      }),
    );
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(result).toEqual({ handled: true, text: "character-saved" });
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
