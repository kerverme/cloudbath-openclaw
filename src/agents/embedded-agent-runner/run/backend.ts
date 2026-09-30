/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { runWithSessionModelScope } from "../../../sessions/session-model-scope.js";
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 *
 * The attempt runs inside its session's model scope, carrying the model it
 * executes, so plugin tools and helpers that complete text mid-attempt use the
 * same model as the agent turn around them.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const sessionKey = params.sessionKey?.trim();
  const scope = sessionKey
    ? {
        sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        runModel: {
          provider: params.provider,
          model: params.modelId,
          ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
        },
      }
    : undefined;
  return runWithSessionModelScope(scope, () => runAgentHarnessAttempt(params));
}
