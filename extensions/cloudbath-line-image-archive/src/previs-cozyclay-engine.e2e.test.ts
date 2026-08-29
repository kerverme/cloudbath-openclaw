import { describe, expect, it } from "vitest";
import { CozyClayMcpEngine, type CozyClayEngineConfig } from "./previs-cozyclay-engine.js";
import { createPrevisDocument } from "./previs-document.js";

/**
 * Live proof against a real CozyClay MCP server.
 *
 * Opt-in: point CLOUDBATH_COZYCLAY_MCP_SERVER at a pinned checkout's
 * `mcp/server.mjs`. Skipped otherwise so CI needs no CozyClay install — this
 * exercises the genuine headless surface rather than a stub of it, and no
 * browser, editor or GPU is involved.
 */
const serverPath = process.env.CLOUDBATH_COZYCLAY_MCP_SERVER;

describe.runIf(serverPath)("CozyClay MCP engine (live)", () => {
  const config: CozyClayEngineConfig = {
    command: process.execPath,
    args: [serverPath ?? ""],
    pinnedVersion: "1.6.0",
    livePort: 5197,
    timeoutMs: 60_000,
  };

  it("renders a 15s vertical two-hander into a .cclayproject", async () => {
    const document = createPrevisDocument({
      scenePrompt: "Twong walks past Twong2 and they talk quietly",
      durationSeconds: 15,
      aspectRatio: "9:16",
      cast: [
        { characterCode: "CHAR-6", characterPageId: "page-char-6", displayName: "Twong" },
        { characterCode: "CHAR-7", characterPageId: "page-char-7", displayName: "Twong2" },
      ],
      movements: [{ standIn: "A", startSecond: 0, endSecond: 15, beat: "walks past B" }],
    });
    const artifact = await new CozyClayMcpEngine(config).renderProjectArtifact({
      document,
      projectName: "cloudbath-previs",
    });
    const parsed = JSON.parse(artifact);
    expect(parsed).toMatchObject({ app: "cozyclay", kind: "project" });
    const stage = parsed.scenes.scenes[0].stage;
    // Two stand-ins, not three: A is the scene's existing default character.
    expect(stage.characters).toHaveLength(2);
    expect(stage.shotAspect).toBe("9:16");
    for (const character of stage.characters) {
      // Canonical Cloudbath identity never reaches the previs engine.
      expect(JSON.stringify(character)).not.toMatch(/CHAR-6|CHAR-7|Twong/u);
    }
  }, 120_000);
});
