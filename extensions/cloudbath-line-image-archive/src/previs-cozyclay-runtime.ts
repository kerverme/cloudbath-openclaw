import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CozyClayEngineConfig } from "./previs-cozyclay-engine.js";

/**
 * Deterministic production provisioning for the CozyClay previs engine.
 *
 * The version is PINNED and verified at startup against the installed package's
 * own `package.json`. Nothing resolves CozyClay at request time: no `npx`, no
 * "latest", no download. A wrong path or an unexpected version fails closed, so
 * an image that silently shipped a different CozyClay cannot quietly change
 * previs output for an in-flight project.
 */

/** The exact upstream release Cloudbath validates its previs output against. */
export const COZYCLAY_PINNED_VERSION = "1.6.0";
/** Upstream commit inspected for that release; evidence, not a runtime check. */
export const COZYCLAY_PINNED_COMMIT = "00fd01836a1387093edfcab04ab4f887a85dec6c";

/** Where the image installs CozyClay. Overridable for local development only. */
export const COZYCLAY_DEFAULT_ROOT = "/opt/cozyclay";
const MCP_SERVER_RELATIVE_PATH = path.join("mcp", "server.mjs");
const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

export type CozyClayProvisioning = Readonly<{
  /** Installed package root containing `package.json` and `mcp/server.mjs`. */
  root: string;
  version: string;
  serverPath: string;
}>;

async function readInstalledVersion(root: string): Promise<string> {
  const manifestPath = path.join(root, "package.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`CozyClay is not installed at ${root} (missing ${manifestPath})`);
  }
  const parsed: unknown = JSON.parse(raw);
  const name = (parsed as { name?: unknown }).name;
  const version = (parsed as { version?: unknown }).version;
  if (name !== "cozyclay" || typeof version !== "string") {
    throw new Error(`${manifestPath} is not a CozyClay package manifest`);
  }
  return version;
}

/**
 * Resolves and verifies the pinned install. Every failure is fatal: previs is
 * better unavailable than silently rendered by an unverified engine.
 */
export async function resolveCozyClayProvisioning(params: {
  root?: string;
  expectedVersion?: string;
}): Promise<CozyClayProvisioning> {
  const root = path.resolve(params.root?.trim() || COZYCLAY_DEFAULT_ROOT);
  const expectedVersion = params.expectedVersion?.trim() || COZYCLAY_PINNED_VERSION;
  const version = await readInstalledVersion(root);
  if (version !== expectedVersion) {
    throw new Error(
      `CozyClay version mismatch at ${root}: expected ${expectedVersion}, found ${version}`,
    );
  }
  const serverPath = path.join(root, MCP_SERVER_RELATIVE_PATH);
  const stats = await stat(serverPath).catch(() => undefined);
  if (!stats?.isFile()) {
    throw new Error(`CozyClay MCP server is missing at ${serverPath}`);
  }
  return { root, version, serverPath };
}

/** Engine config for a verified install. The command is always the running Node. */
export function cozyClayEngineConfig(
  provisioning: CozyClayProvisioning,
  overrides: { timeoutMs?: number } = {},
): CozyClayEngineConfig {
  return {
    command: process.execPath,
    args: [provisioning.serverPath],
    pinnedVersion: provisioning.version,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
  };
}
