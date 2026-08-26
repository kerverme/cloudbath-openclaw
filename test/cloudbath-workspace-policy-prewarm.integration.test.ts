import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspacePolicyServiceContext,
  createWorkspacePolicyStateRuntime,
  getWorkspacePolicyRuntimeForTest,
  registerWorkspacePolicyPlugin,
} from "../extensions/cloudbath-line-image-archive/workspace-policy-runtime.test-support.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../src/plugins/hook-runner-global.js";
import { addTestHook } from "../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";

let startedService: OpenClawPluginService | undefined;

beforeEach(() => {
  vi.stubEnv("CLOUDBATH_IMAGE_ARCHIVE_ENABLED", "false");
  vi.stubEnv("CLOUDBATH_IMAGE_ANALYSIS_ENABLED", "false");
  vi.stubEnv("OPEN_CLAW_NOTION_WRITE_TOKEN", "test-value");
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

afterEach(async () => {
  await startedService?.stop?.(createWorkspacePolicyServiceContext());
  startedService = undefined;
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudbath global workspace policy hook across plugin registries", () => {
  it("serves pairing through the global hook owned by an unstarted prewarm registry", async () => {
    const state = createWorkspacePolicyStateRuntime();
    const gateway = registerWorkspacePolicyPlugin(state);
    await gateway.service.start(createWorkspacePolicyServiceContext());
    startedService = gateway.service;
    const gatewayRuntime = getWorkspacePolicyRuntimeForTest();
    expect(gatewayRuntime?.workspaceRegistry).toBeDefined();

    const prewarm = registerWorkspacePolicyPlugin(state);
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      hookName: "before_dispatch",
      handler: prewarm.beforeDispatch,
      pluginId: "cloudbath-line-image-archive",
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const runner = getGlobalHookRunner();
    if (!runner) {
      throw new Error("Global hook runner did not initialize");
    }

    const result = await runner.runBeforeDispatch(
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

    expect(result).toMatchObject({ handled: true });
    expect(result?.text).toMatch(/^Pairing code for UGC:/u);
    expect(result?.text).not.toBe("Workspace policy service is unavailable.");
    expect(getWorkspacePolicyRuntimeForTest()).toBe(gatewayRuntime);
  });
});
