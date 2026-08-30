import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyAspectRatioToProjectArtifact, compilePrevisPlan } from "./previs-cozyclay.js";
import type { PrevisEngine } from "./previs-store.js";
import type { PrevisDocument } from "./previs-types.js";

/**
 * CozyClay previs engine over MCP stdio.
 *
 * CozyClay is AGPL-3.0-or-later and stays a SEPARATE PROCESS reached over the
 * Model Context Protocol — no CozyClay source is copied into this repository and
 * nothing here links its code into the Cloudbath process. The boundary is the
 * documented MCP tool surface of a pinned `cozyclay` install.
 *
 * The command is configured, never discovered: resolving CozyClay through `npx`
 * at request time would let a fresh upstream release change previs output
 * underneath an in-flight project.
 */
export type CozyClayEngineConfig = Readonly<{
  /** Executable to run, e.g. "node". */
  command: string;
  /** Arguments, e.g. ["/opt/cozyclay/mcp/server.mjs"]. */
  args: readonly string[];
  /** Pinned upstream version this deployment was validated against. */
  pinnedVersion: string;
  /** Loopback port CozyClay's live hub binds. No editor is expected in Phase 1. */
  livePort: number;
  timeoutMs: number;
}>;

/** Only what this module needs from an MCP client, so tests need no child process. */
export type PrevisMcpSession = Readonly<{
  callTool(params: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}>;

export type PrevisMcpSessionFactory = (params: {
  projectRoot: string;
}) => Promise<PrevisMcpSession>;

const PROJECT_FILE = "previs.cclayproject";

export function createStdioSessionFactory(config: CozyClayEngineConfig): PrevisMcpSessionFactory {
  return async ({ projectRoot }) => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: {
        ...process.env,
        // Project I/O is confined to this per-render directory; CozyClay rejects
        // anything that is not a direct child of it.
        COZYCLAY_PROJECT_ROOT: projectRoot,
        COZYCLAY_LIVE_PORT: String(config.livePort),
      },
    });
    const client = new Client({ name: "cloudbath-previs", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    return {
      callTool: (params) =>
        client.callTool({ name: params.name, arguments: params.arguments }) as Promise<{
          content: Array<{ type: string; text?: string }>;
        }>,
      close: () => client.close(),
    };
  };
}

/**
 * Runs a compiled previs plan and returns the `.cclayproject` document.
 *
 * Every failure propagates: the caller persists nothing until this resolves, so
 * an unreachable or broken CozyClay cannot leave a partial previs version in
 * Cloudbath state.
 */
export class CozyClayMcpEngine implements PrevisEngine {
  // `config` is consumed only by the default session factory; an injected
  // factory carries its own transport, so keeping it as a field would be dead.
  constructor(
    config: CozyClayEngineConfig,
    private readonly createSession: PrevisMcpSessionFactory = createStdioSessionFactory(config),
  ) {}

  async renderProjectArtifact(params: {
    document: PrevisDocument;
    projectName: string;
  }): Promise<string> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "cloudbath-previs-"));
    try {
      const session = await this.createSession({ projectRoot });
      try {
        for (const call of compilePrevisPlan(params.document).calls) {
          await session.callTool({ name: call.tool, arguments: call.arguments });
        }
        await session.callTool({
          name: "save_project",
          arguments: {
            path: path.join(projectRoot, PROJECT_FILE),
            name: params.projectName,
            overwrite: true,
          },
        });
      } finally {
        await session.close();
      }
      const artifact = await readFile(path.join(projectRoot, PROJECT_FILE), "utf8");
      return applyAspectRatioToProjectArtifact(artifact, params.document.aspectRatio);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}
