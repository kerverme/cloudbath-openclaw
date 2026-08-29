// Focused public test helpers for plugin runtime, registry, and setup fixtures.

import { AUTH_TOKEN, sendRequest, withGatewayServer } from "../gateway/server-http.test-harness.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../gateway/server/plugins-http.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry as createEmptyPluginRegistryForTest } from "../plugins/registry-empty.js";
import type { OpenClawPluginHttpRouteParams } from "../plugins/types.js";

/** Exercise a plugin-authenticated HTTP route through a token-protected Gateway without credentials. */
export async function requestPluginHttpRouteWithoutGatewayAuthForTest(params: {
  pluginId: string;
  route: OpenClawPluginHttpRouteParams;
  path: string;
}): Promise<Awaited<ReturnType<typeof sendRequest>>> {
  const registry = createEmptyPluginRegistryForTest();
  registry.httpRoutes.push({
    pluginId: params.pluginId,
    source: "test",
    path: params.route.path,
    auth: params.route.auth,
    match: params.route.match ?? "exact",
    handler: params.route.handler,
    ...(params.route.handleUpgrade ? { handleUpgrade: params.route.handleUpgrade } : {}),
    ...(params.route.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.route.gatewayRuntimeScopeSurface }
      : {}),
    ...(params.route.nodeCapability ? { nodeCapability: params.route.nodeCapability } : {}),
  });
  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry,
    log: createSubsystemLogger("plugin-http-test"),
  });
  let response: Awaited<ReturnType<typeof sendRequest>> | undefined;

  await withGatewayServer({
    prefix: "plugin-http-gateway-auth-",
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      handlePluginRequest,
      shouldEnforcePluginGatewayAuth: (pathContext) =>
        shouldEnforceGatewayAuthForPluginPath(registry, pathContext),
    },
    run: async (server) => {
      response = await sendRequest(server, { path: params.path });
    },
  });
  if (!response) {
    throw new Error("Gateway plugin route test did not produce a response");
  }
  return response;
}

export { setDefaultChannelPluginRegistryForTests } from "../commands/channel-test-registry.js";
export {
  createEmptyPluginRegistry,
  createPluginRegistry,
  type PluginRecord,
} from "../plugins/registry.js";
export {
  providerContractLoadError,
  pluginRegistrationContractRegistry,
  resolveProviderContractProvidersForPluginIds,
  resolveWebFetchProviderContractEntriesForPluginId,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../plugins/contracts/registry.js";
export { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
export {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEvent as emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
} from "../infra/diagnostic-events.js";
export { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export { logMessageDispatchStarted, logMessageProcessed } from "../logging/diagnostic.js";
export { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../plugins/provider-contract-public-artifacts.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
export { addTestHook } from "../plugins/hooks.test-helpers.js";
export { createPluginRecord } from "../plugins/status.test-helpers.js";
export {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
export {
  getActivePluginRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
export {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { clearHealthChecksForTest } from "../flows/health-check-registry.js";
export { runProviderCatalog } from "../plugins/provider-discovery.js";
export { onTrustedInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
export {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
  setProviderWizardProvidersResolverForTest,
} from "../plugins/provider-wizard.js";
export { resolveProviderPluginChoice } from "../plugins/provider-auth-choice.runtime.js";
export {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
} from "../plugins/embedding-providers.js";
export {
  clearMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
  type RegisteredMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { PluginHookRegistration } from "../plugins/hook-types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
export { readQueuedEntries as readQueuedDeliveryEntriesForTest } from "../infra/outbound/delivery-queue.test-helpers.js";
export {
  registerProviderPlugin,
  registerProviderPlugins,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
  type RegisteredProviderCollections,
} from "../test-utils/plugin-registration.js";
export {
  createNonExitingRuntimeEnv,
  createNonExitingTypedRuntimeEnv,
  createRuntimeEnv,
  createTypedRuntimeEnv,
} from "../test-utils/plugin-runtime-env.js";
export {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
  selectFirstWizardOption,
  type WizardPrompter,
} from "../test-utils/plugin-setup-wizard.js";
export { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
export { buildPluginApi } from "../plugins/api-builder.js";
export {
  createCapturedPluginRegistration,
  type CapturedPluginRegistration,
} from "../plugins/captured-registration.js";
export { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
export {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
  type PluginRuntimeMediaMock,
} from "./test-helpers/plugin-runtime-mock.js";
