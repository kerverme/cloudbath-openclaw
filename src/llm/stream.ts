// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  complete as runtimeComplete,
  completeSimple as runtimeCompleteSimple,
  stream as runtimeStream,
  streamSimple as runtimeStreamSimple,
} from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { observeAssistantStreamLatency } from "../infra/turn-latency-stream.js";
import "./ai-transport-host.js";

registerBuiltInApiProviders(defaultApiRegistry);

export { getEnvApiKey } from "@openclaw/ai/internal/runtime";

/**
 * Every core provider call funnels through these four, which is why the turn
 * ledger observes first-token here rather than in each provider adapter. The
 * transport records response headers; only this layer sees the first content
 * token, and the two are different numbers.
 */
export const stream: typeof runtimeStream = (model, context, options) =>
  observeAssistantStreamLatency(runtimeStream(model, context, options));

export const streamSimple: typeof runtimeStreamSimple = (model, context, options) =>
  observeAssistantStreamLatency(runtimeStreamSimple(model, context, options));

export const complete: typeof runtimeComplete = async (model, context, options) =>
  await observeAssistantStreamLatency(runtimeStream(model, context, options)).result();

export const completeSimple: typeof runtimeCompleteSimple = async (model, context, options) =>
  await observeAssistantStreamLatency(runtimeStreamSimple(model, context, options)).result();
