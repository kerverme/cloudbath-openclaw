// Plugin tool contract tests cover bundled plugin tool schemas and invocation contracts.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

type PluginManifestFile = {
  id?: unknown;
  contracts?: {
    tools?: unknown;
  };
};

function walkFiles(dir: string): string[] {
  const gitFiles = listGitFiles(dir);
  if (gitFiles) {
    return gitFiles;
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function repoRelativePath(filePath: string): string {
  return toRepoRelativePath(process.cwd(), filePath);
}

function isSkippedRepoPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => part === "node_modules" || part === "dist" || part.startsWith("."));
}

function listGitFiles(dir: string): string[] | null {
  const relativeDir = repoRelativePath(dir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => !isSkippedRepoPath(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listGitPluginManifestPaths(extensionsDir: string): string[] | null {
  const relativeDir = repoRelativePath(extensionsDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listPluginManifestPaths(extensionsDir: string): string[] {
  const gitPaths = listGitPluginManifestPaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(extensionsDir, entry.name, "openclaw.plugin.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

function isProductionSource(filePath: string): boolean {
  if (!/\.(?:cjs|mjs|js|ts|tsx)$/.test(filePath)) {
    return false;
  }
  const normalized = toRepoPath(filePath);
  return !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized);
}

function readBalancedCallArguments(source: string, openParenIndex: number): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === ")") {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }
  return undefined;
}

/**
 * Removes line and block comments while preserving string/template literals.
 *
 * Applied before every scan below so that (a) an explanatory comment sitting
 * between `registerTool`'s arguments cannot hide the options object from
 * `splitTopLevelArgs`, and (b) commented-out code is never mistaken for a real
 * registration or constant.
 */
function stripTypeScriptComments(source: string): string {
  let out = "";
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function listRegisterToolCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bregisterTool\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openParenIndex = source.indexOf("(", match.index);
    const args = readBalancedCallArguments(source, openParenIndex);
    if (args !== undefined) {
      calls.push(args);
    }
  }
  return calls;
}

function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      const part = args.slice(start, index).trim();
      if (part.length > 0) {
        parts.push(part);
      }
      start = index + 1;
    }
  }
  const part = args.slice(start).trim();
  if (part.length > 0) {
    parts.push(part);
  }
  return parts;
}

function extractStringLiterals(source: string): string[] {
  const names: string[] = [];
  const pattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Resolves `const NAME = "tool"` / `const NAME = ["a", "b"] as const` string
 * constants declared anywhere in a plugin's production sources.
 *
 * Plugins commonly register tools by exported constant rather than inline
 * literal (`names: [LINE_VIDEO_DRAFT_TOOL_NAME]`,
 * `names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES]`). Without this resolution
 * the literal-only scan below extracts nothing for those calls, the plugin
 * silently contributes zero registered names, and an undeclared tool sails
 * past this contract test — which is exactly how `line_video_draft` shipped
 * missing from the LINE manifest and was rejected at runtime by
 * registry.ts's "plugin must declare contracts.tools for:" check.
 */
function collectPluginStringConstants(sources: readonly string[]): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  for (const source of sources) {
    const scalarPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([^"']+)["']/g;
    let scalarMatch: RegExpExecArray | null;
    while ((scalarMatch = scalarPattern.exec(source))) {
      const name = scalarMatch[1];
      const value = scalarMatch[2];
      if (name && value) {
        constants.set(name, [value]);
      }
    }

    const arrayPattern =
      /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?\s*;/g;
    let arrayMatch: RegExpExecArray | null;
    while ((arrayMatch = arrayPattern.exec(source))) {
      const name = arrayMatch[1];
      const body = arrayMatch[2] ?? "";
      if (!name || /[A-Za-z_$][\w$]*\s*[,\]]/.test(body.replace(/["'][^"']*["']/g, ""))) {
        // Skip arrays holding anything other than plain string literals; a
        // partially-resolved list would be worse than reporting it unresolved.
        continue;
      }
      const values = extractStringLiterals(body);
      if (values.length > 0) {
        constants.set(name, values);
      }
    }
  }
  return constants;
}

type ExtractedToolNames = { names: string[]; unresolved: string[] };

function extractStaticRegisteredToolNamesFromObject(
  source: string,
  constants: Map<string, string[]>,
): ExtractedToolNames {
  const names = new Set<string>();
  const unresolved = new Set<string>();

  const addIdentifier = (identifier: string) => {
    const resolved = constants.get(identifier);
    if (resolved) {
      for (const value of resolved) {
        names.add(value);
      }
      return;
    }
    unresolved.add(identifier);
  };

  const namesPattern = /\bnames\s*:\s*\[([\s\S]*?)\]/g;
  let namesMatch: RegExpExecArray | null;
  while ((namesMatch = namesPattern.exec(source))) {
    const body = namesMatch[1] ?? "";
    for (const name of extractStringLiterals(body)) {
      names.add(name);
    }
    // Entries that are not string literals: bare identifiers and spreads.
    const withoutLiterals = body.replace(/["'][^"']*["']/g, "");
    const identifierPattern = /(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/g;
    let identifierMatch: RegExpExecArray | null;
    while ((identifierMatch = identifierPattern.exec(withoutLiterals))) {
      const identifier = identifierMatch[1];
      if (identifier) {
        addIdentifier(identifier);
      }
    }
  }

  const nameLiteralPattern = /\bname\s*:\s*["']([^"']+)["']/g;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = nameLiteralPattern.exec(source))) {
    if (nameMatch[1]) {
      names.add(nameMatch[1]);
    }
  }

  const nameIdentifierPattern = /\bname\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g;
  let nameIdentifierMatch: RegExpExecArray | null;
  while ((nameIdentifierMatch = nameIdentifierPattern.exec(source))) {
    const identifier = nameIdentifierMatch[1];
    if (identifier) {
      addIdentifier(identifier);
    }
  }

  return { names: [...names], unresolved: [...unresolved] };
}

function extractStaticRegisteredToolNames(
  callArgs: string,
  constants: Map<string, string[]>,
): ExtractedToolNames {
  const args = splitTopLevelArgs(callArgs);
  const names = new Set<string>();
  const unresolved = new Set<string>();
  for (const arg of [args[0]?.trim() ?? "", args[1]?.trim() ?? ""]) {
    if (!arg.startsWith("{")) {
      continue;
    }
    const extracted = extractStaticRegisteredToolNamesFromObject(arg, constants);
    for (const name of extracted.names) {
      names.add(name);
    }
    for (const identifier of extracted.unresolved) {
      unresolved.add(identifier);
    }
  }
  return { names: [...names], unresolved: [...unresolved] };
}

function readManifest(manifestPath: string): PluginManifestFile {
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifestFile;
}

function normalizeManifestTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

describe("bundled plugin tool manifest contracts", () => {
  let toolContractFailures: string[] = [];

  beforeAll(() => {
    listGitTrackedFiles({ pathspecs: "extensions" });
    toolContractFailures = collectToolContractFailures(path.join(process.cwd(), "extensions"));
  });

  it("lists plugin tool contract inputs from git without walking extension roots", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    expectNoReaddirSyncDuring(() => {
      const manifestPaths = listPluginManifestPaths(extensionsDir);
      const sourceFiles = manifestPaths[0]
        ? walkFiles(path.dirname(manifestPaths[0])).filter(isProductionSource)
        : [];

      expect(manifestPaths.length).toBeGreaterThan(0);
      expect(sourceFiles.length).toBeGreaterThan(0);
    });
  });

  it("declares every production registerTool owner in contracts.tools", () => {
    expect(toolContractFailures).toStrictEqual([]);
  });

  // Regression pin for the production failure "[plugins] plugin must declare
  // contracts.tools for: line_video_draft". LINE registers both of its tools by
  // exported constant, so before constant resolution was added above this whole
  // plugin contributed zero names and the generic check passed vacuously.
  it("resolves LINE's constant-named tools and finds both declared", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    const pluginDir = path.join(extensionsDir, "line");
    const manifest = readManifest(path.join(pluginDir, "openclaw.plugin.json"));
    const declaredTools = normalizeManifestTools(manifest.contracts?.tools);

    const sources = walkFiles(pluginDir)
      .filter(isProductionSource)
      .map((filePath) => stripTypeScriptComments(fs.readFileSync(filePath, "utf-8")));
    const constants = collectPluginStringConstants(sources);
    const registered = new Set<string>();
    for (const source of sources) {
      for (const call of listRegisterToolCalls(source)) {
        for (const name of extractStaticRegisteredToolNames(call, constants).names) {
          registered.add(name);
        }
      }
    }

    expect(constants.get("LINE_VIDEO_DRAFT_TOOL_NAME")).toStrictEqual(["line_video_draft"]);
    expect(registered).toContain("line_video_draft");
    expect(registered).toContain("openrouter_account_models");
    expect(declaredTools).toContain("line_video_draft");
    expect(declaredTools).toContain("openrouter_account_models");
  });

  // line_video_draft is the only sanctioned path to a paid LINE video request
  // (video_generate is blocked on the channel), so it must stay in the default
  // tool set. Manifest `optional: true` would hide it behind tools.allow
  // (src/plugins/tools.ts isOptionalToolAllowed), leaving an owner's natural
  // "make me a video" request with no reachable tool at all.
  it("keeps line_video_draft non-optional while openrouter_account_models stays optional", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "extensions", "line", "openclaw.plugin.json"),
        "utf-8",
      ),
    ) as { toolMetadata?: Record<string, { optional?: boolean } | undefined> };

    expect(manifest.toolMetadata?.line_video_draft?.optional).not.toBe(true);
    expect(manifest.toolMetadata?.openrouter_account_models?.optional).toBe(true);
  });
});

function collectToolContractFailures(extensionsDir: string): string[] {
  const failures: string[] = [];

  for (const manifestPath of listPluginManifestPaths(extensionsDir)) {
    const pluginDir = path.dirname(manifestPath);
    const manifest = readManifest(manifestPath);
    const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
    const declaredTools = new Set(normalizeManifestTools(manifest.contracts?.tools));
    const registeredNames = new Set<string>();
    const unresolvedIdentifiers = new Set<string>();
    let registerCallCount = 0;

    const sourcePaths = walkFiles(pluginDir).filter(isProductionSource);
    const sources = sourcePaths.map((filePath) =>
      stripTypeScriptComments(fs.readFileSync(filePath, "utf-8")),
    );
    const constants = collectPluginStringConstants(sources);

    for (const source of sources) {
      for (const call of listRegisterToolCalls(source)) {
        registerCallCount += 1;
        const extracted = extractStaticRegisteredToolNames(call, constants);
        for (const name of extracted.names) {
          registeredNames.add(name);
        }
        for (const identifier of extracted.unresolved) {
          unresolvedIdentifiers.add(identifier);
        }
      }
    }

    if (registerCallCount === 0) {
      continue;
    }
    if (declaredTools.size === 0) {
      failures.push(`${pluginId}: registers agent tools but has no contracts.tools`);
      continue;
    }

    // A tool name this scan cannot statically resolve is reported rather than
    // skipped. Silently ignoring it is what let an undeclared tool ship: the
    // plugin contributed zero names and the subset check below passed
    // vacuously. Failing here keeps the blind spot closed as plugins adopt new
    // ways of naming tools.
    if (unresolvedIdentifiers.size > 0) {
      failures.push(
        `${pluginId}: cannot statically resolve registerTool name(s) ${[...unresolvedIdentifiers].toSorted().join(", ")}; declare them as a string literal or a plain string/string[] const so contracts.tools can be verified`,
      );
      continue;
    }

    const missing = [...registeredNames].filter((name) => !declaredTools.has(name)).toSorted();
    if (missing.length > 0) {
      failures.push(`${pluginId}: missing contracts.tools for ${missing.join(", ")}`);
    }
  }

  return failures;
}
