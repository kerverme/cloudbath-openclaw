// LINE plugin tool-registration contract: manifest declarations must satisfy the
// exact validation registry.registerTool applies, so the bundled LINE plugin can
// never again ship a tool the manifest does not declare.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
  normalizePluginToolNames,
} from "../tool-contracts.js";

const LINE_PLUGIN_DIR = path.join(process.cwd(), "extensions", "line");

type LineManifest = {
  contracts?: { tools?: unknown };
  toolMetadata?: Record<string, { optional?: boolean } | undefined>;
};

function readLineManifest(): LineManifest {
  return JSON.parse(
    fs.readFileSync(path.join(LINE_PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"),
  ) as LineManifest;
}

/**
 * The two tool names extensions/line/index.ts passes to api.registerTool. Kept
 * as literals here on purpose: importing the constants would make this test
 * pass automatically if a rename ever desynced the manifest, which is the exact
 * drift this contract exists to catch.
 */
const LINE_REGISTERED_TOOL_NAMES = ["openrouter_account_models", "line_video_draft"] as const;

describe("LINE plugin tool registration contract", () => {
  it("declares every registered tool, so registerTool's contract check passes", () => {
    const manifest = readLineManifest();
    const declaredNames = normalizePluginToolContractNames(manifest.contracts);
    const toolNames = normalizePluginToolNames([...LINE_REGISTERED_TOOL_NAMES]);

    // This is the precise check registry.ts:672-679 runs before pushing the
    // tool into the registry; a non-empty result is what produced the
    // production log "[plugins] plugin must declare contracts.tools for:
    // line_video_draft" and silently dropped the tool.
    expect(findUndeclaredPluginToolNames({ declaredNames, toolNames })).toStrictEqual([]);
  });

  it("still declares openrouter_account_models (no regression from the video fix)", () => {
    const declaredNames = normalizePluginToolContractNames(readLineManifest().contracts);
    expect(declaredNames).toContain("openrouter_account_models");
  });

  it("registers line_video_draft without the optional flag", () => {
    const indexSource = fs.readFileSync(path.join(LINE_PLUGIN_DIR, "index.ts"), "utf-8");
    const registration = indexSource.slice(
      indexSource.indexOf("names: [LINE_VIDEO_DRAFT_TOOL_NAME]"),
    );
    const optionsEnd = registration.indexOf("}");

    // Optional tools are withheld from the default tool set and only surface
    // when tools.allow lists them (src/plugins/tools.ts isOptionalToolAllowed).
    // line_video_draft is the sole sanctioned path to a paid LINE video
    // request, so it must always be present for the owner's request to route.
    expect(registration.slice(0, optionsEnd)).not.toContain("optional");
    expect(readLineManifest().toolMetadata?.line_video_draft?.optional).not.toBe(true);
  });

  it("keeps openrouter_account_models optional in the manifest", () => {
    expect(readLineManifest().toolMetadata?.openrouter_account_models?.optional).toBe(true);
  });
});
