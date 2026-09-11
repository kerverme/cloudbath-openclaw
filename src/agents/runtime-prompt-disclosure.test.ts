/**
 * What the system prompt's Runtime line is allowed to name.
 *
 * Production incident: after shell and status tools were removed from unbound
 * LINE groups, a group reply still recited the container hostname, the kernel
 * string, the Node version and the workspace path — and correctly said exec
 * was unavailable. The data was never in a tool result; it was in the prompt.
 * These tests drive the real builders rather than the scope helper alone, so
 * they fail if the Runtime line regains a field by any route.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeDisclosureScope } from "./runtime-prompt-disclosure.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";
import { buildRuntimeLine } from "./system-prompt.js";

/** The exact values production leaked, so a regression reads unmistakably. */
const RUNTIME = {
  sessionKey: "agent:main:line:group:cdb23ef53fcf7fbde85371b7ba0cd6bb7",
  host: "098421575cd6",
  os: "Linux 6.12.12+bpo-cloud-amd64",
  arch: "x64",
  node: "v22.19.0",
  model: "openrouter/deepseek/deepseek-v4-flash-0731",
  defaultModel: "openrouter/deepseek/deepseek-v4-flash-0731",
  shell: "/bin/sh",
  channel: "line",
} as const;

/**
 * A real directory: `repoRoot` only resolves for one that exists, so a fake
 * path would make the "no workspace path" assertions pass vacuously. macOS
 * resolves tmp through a symlink, hence realpath.
 */
let workspaceDir: string;

beforeAll(() => {
  workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-disclosure-")));
});

/**
 * `repoRoot` is only rendered for a configured or git-rooted directory, so the
 * config names it explicitly — otherwise the "no workspace path" assertion
 * would pass for the wrong reason.
 */
function promptParamsFor(params: { chatType: "direct" | "group"; senderIsOwner: boolean }) {
  return buildSystemPromptParams({
    agentId: "main",
    config: { agents: { defaults: { repoRoot: workspaceDir } } } as OpenClawConfig,
    workspaceDir,
    cwd: workspaceDir,
    disclosureScope: resolveRuntimeDisclosureScope(params),
    runtime: { ...RUNTIME, chatType: params.chatType },
  });
}

function runtimeLineFor(params: { chatType: "direct" | "group"; senderIsOwner: boolean }) {
  const { runtimeInfo } = promptParamsFor(params);
  return buildRuntimeLine(runtimeInfo, runtimeInfo.channel, [], "high");
}

describe("an ordinary group is not told where the bot runs", () => {
  const line = () => runtimeLineFor({ chatType: "group", senderIsOwner: false });

  it("names no container hostname", () => {
    expect(line()).not.toContain("098421575cd6");
    expect(line()).not.toContain("host=");
  });

  it("names no OS, kernel or architecture", () => {
    expect(line()).not.toContain("6.12.12+bpo-cloud-amd64");
    expect(line()).not.toContain("Linux");
    expect(line()).not.toContain("os=");
    expect(line()).not.toContain("arch=");
  });

  it("names no Node runtime version", () => {
    expect(line()).not.toContain("v22.19.0");
    expect(line()).not.toContain("node=");
  });

  it("names no shell or workspace path", () => {
    expect(line()).not.toContain("shell=");
    expect(line()).not.toContain(workspaceDir);
    expect(line()).not.toContain("repo=");
  });

  it("still carries what the agent needs to behave correctly", () => {
    // Withholding deployment facts must not blind the agent to its own
    // conversation: session, channel and capabilities drive routing and replies.
    expect(line()).toContain("agent=main");
    expect(line()).toContain("channel=line");
    expect(line()).toContain("session=agent:main:line:group:");
    expect(line()).toContain("thinking=high");
  });

  it("restricts a group even when the owner is the one speaking", () => {
    // The reply is visible to everyone else in the room, so owner presence is
    // not consent to publish the hostname to it.
    const ownerInGroup = runtimeLineFor({ chatType: "group", senderIsOwner: true });

    expect(ownerInGroup).not.toContain("098421575cd6");
    expect(ownerInGroup).not.toContain("host=");
  });

  it("restricts a direct chat with someone who is not the owner", () => {
    expect(runtimeLineFor({ chatType: "direct", senderIsOwner: false })).not.toContain("host=");
  });
});

describe("the owner's private chat keeps full diagnostics", () => {
  const line = () => runtimeLineFor({ chatType: "direct", senderIsOwner: true });

  it("still names host, OS, Node and shell", () => {
    expect(line()).toContain("host=098421575cd6");
    expect(line()).toContain("os=Linux 6.12.12+bpo-cloud-amd64 (x64)");
    expect(line()).toContain("node=v22.19.0");
    expect(line()).toContain("shell=/bin/sh");
  });

  it("still names the workspace root", () => {
    expect(line()).toContain(`repo=${workspaceDir}`);
  });
});

describe("the default is restricted, not permissive", () => {
  it("withholds deployment facts when no scope is passed at all", () => {
    // A caller that has not thought about disclosure must not leak by omission.
    const { runtimeInfo } = buildSystemPromptParams({
      agentId: "main",
      workspaceDir,
      runtime: { ...RUNTIME },
    });

    expect(buildRuntimeLine(runtimeInfo)).not.toContain("host=");
    expect(runtimeInfo.host).toBeUndefined();
  });

  it("resolves the scope from owner identity in a direct chat only", () => {
    expect(resolveRuntimeDisclosureScope({ chatType: "direct", senderIsOwner: true })).toBe(
      "operator",
    );
    for (const params of [
      { chatType: "group" as const, senderIsOwner: true },
      { chatType: "group" as const, senderIsOwner: false },
      { chatType: "direct" as const, senderIsOwner: false },
      {},
    ]) {
      expect(resolveRuntimeDisclosureScope(params)).toBe("restricted");
    }
  });
});

describe("the model still knows its own runtime", () => {
  it("leaves the real values on the object the runtime keeps", () => {
    // Only the PROMPT is minimized. Tools that need the real host, paths or
    // environment must keep working, so nothing is replaced with a fake value.
    const { runtimeInfo } = promptParamsFor({ chatType: "direct", senderIsOwner: true });

    expect(runtimeInfo.host).toBe("098421575cd6");
    expect(runtimeInfo.repoRoot).toBe(workspaceDir);
  });
});
