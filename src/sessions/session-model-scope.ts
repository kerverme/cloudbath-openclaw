// Carries the session a turn belongs to across async work, so a text-model
// call made on the turn's behalf (a plugin completion, a helper) resolves the
// model the owner pinned for that session instead of the configured default.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A provider/model a text completion runs on, with the session's auth profile. */
export type SessionTextModel = Readonly<{
  provider: string;
  model: string;
  authProfileId?: string;
}>;

export type SessionModelScope = Readonly<{
  sessionKey: string;
  agentId?: string;
  /**
   * The model the current run attempt executes. Set only inside an attempt, so
   * a helper called mid-run stays on the run's model even if the owner switches
   * before the run restarts on the new one.
   */
  runModel?: SessionTextModel;
}>;

// One store per process: dispatch, the embedded runner and the lazily loaded
// plugin LLM runtime must all see the same scope.
const sessionModelScopeStorage = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionModelScope"),
  () => new AsyncLocalStorage<SessionModelScope>(),
);

/** Runs `run` inside `scope`; without a scope it simply runs. */
export function runWithSessionModelScope<T>(scope: SessionModelScope | undefined, run: () => T): T {
  return scope ? sessionModelScopeStorage.run(scope, run) : run();
}

export function currentSessionModelScope(): SessionModelScope | undefined {
  return sessionModelScopeStorage.getStore();
}
