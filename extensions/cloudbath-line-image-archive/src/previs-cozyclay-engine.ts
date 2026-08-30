import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
 * Model Context Protocol -- no CozyClay source is copied into this repository
 * and none of its code is linked into the Cloudbath process or shipped to a
 * browser. The boundary is its documented MCP tool surface.
 *
 * The command is resolved from a pinned, version-verified install (see
 * `previs-cozyclay-runtime.ts`), never through `npx` at request time.
 */
export type CozyClayEngineConfig = Readonly<{
  /** Executable to run; the running Node binary in production. */
  command: string;
  /** Arguments, e.g. ["/opt/cozyclay/mcp/server.mjs"]. */
  args: readonly string[];
  /** Pinned upstream version this deployment verified at startup. */
  pinnedVersion: string;
  /** Hard ceiling on one render, after which the child is killed. */
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
  livePort: number;
}) => Promise<PrevisMcpSession>;

const PROJECT_FILE = "previs.cclayproject";

/**
 * Asks the OS for a free loopback port.
 *
 * CozyClay's stdio server always starts its live hub and rejects port 0, so a
 * port must be chosen here. A fixed one would make two concurrent renders
 * contend for the same socket and could squat a port another service wants.
 * The bind-then-release race is deliberately tolerable: CozyClay returns a null
 * hub on EADDRINUSE and continues memory-only, which is exactly the mode
 * headless rendering uses anyway.
 */
export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("Could not allocate a loopback port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export function createStdioSessionFactory(config: CozyClayEngineConfig): PrevisMcpSessionFactory {
  return async ({ projectRoot, livePort }) => {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: {
        ...process.env,
        // Project I/O is confined to this per-render directory; CozyClay rejects
        // anything that is not a direct child of it.
        COZYCLAY_PROJECT_ROOT: projectRoot,
        COZYCLAY_LIVE_PORT: String(livePort),
        // Telemetry and update checks would make a render reach the network on
        // a path Cloudbath does not control.
        COZYCLAY_TELEMETRY: "0",
        COZYCLAY_DISABLE_UPDATE_CHECK: "1",
      },
      // Bounded: the child's stderr is not piped into this process's own.
      stderr: "ignore",
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
 * Every failure propagates and every path cleans up: the temp project root is
 * removed on success, failure and timeout, and the MCP client is closed so the
 * child process cannot outlive the render. The caller persists nothing until
 * this resolves, so a broken CozyClay cannot leave a partial version behind.
 */
export class CozyClayMcpEngine implements PrevisEngine {
  // `config` is consumed by the default session factory and for the timeout; an
  // injected factory carries its own transport.
  constructor(
    private readonly config: CozyClayEngineConfig,
    private readonly createSession: PrevisMcpSessionFactory = createStdioSessionFactory(config),
    private readonly allocatePort: () => Promise<number> = allocateLoopbackPort,
  ) {}

  async renderProjectArtifact(params: {
    document: PrevisDocument;
    projectName: string;
  }): Promise<string> {
    // Per-render directory: two concurrent renders never share a project file,
    // and mkdtemp's random suffix means neither can guess the other's path.
    const projectRoot = await mkdtemp(path.join(tmpdir(), "cloudbath-previs-"));
    try {
      return await this.withTimeout(this.render(projectRoot, params));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`CozyClay render exceeded ${this.config.timeoutMs}ms`)),
            this.config.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async render(
    projectRoot: string,
    params: { document: PrevisDocument; projectName: string },
  ): Promise<string> {
    const livePort = await this.allocatePort();
    const session = await this.createSession({ projectRoot, livePort });
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
      // Closing the client terminates the stdio child, so a failed render
      // cannot leave an orphan CozyClay process holding the port.
      await session.close().catch(() => undefined);
    }
    const artifact = await readFile(path.join(projectRoot, PROJECT_FILE), "utf8");
    return applyAspectRatioToProjectArtifact(artifact, params.document.aspectRatio);
  }
}
