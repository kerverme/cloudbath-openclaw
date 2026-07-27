import {
  resolveDefaultModelForAgent,
  resolveSessionAgentIds,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  AgentProfile,
  ExtractedFields,
  InboundImageJob,
  SchemaProfile,
  SchemaPropertyDefinition,
} from "./types.js";

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function extractionPrompt(agent: AgentProfile, schema: SchemaProfile): string {
  const fields = schema.properties
    .filter((property) => !property.systemFieldRole)
    .toSorted((left, right) => left.displayOrder - right.displayOrder)
    .map((property) => ({
      id: property.id,
      type: property.notionType,
      required: property.required,
      options: property.options,
      description: property.extractionDescription,
      validationRules: property.validationRules,
    }));
  return [
    `Persona: ${agent.persona}`,
    `Agent instructions: ${agent.instructions}`,
    `Extraction instructions: ${agent.extractionInstructions}`,
    "Return only one JSON object keyed by the exact field IDs below.",
    "Use null when evidence is unavailable. Never invent a value.",
    JSON.stringify(fields),
  ].join("\n");
}

function validateRule(property: SchemaPropertyDefinition, value: unknown): string | undefined {
  for (const rule of property.validationRules) {
    if (rule.kind === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      return "must be an integer";
    }
    if (rule.kind === "min" && (typeof value !== "number" || value < rule.value)) {
      return `must be at least ${rule.value}`;
    }
    if (rule.kind === "max" && (typeof value !== "number" || value > rule.value)) {
      return `must be at most ${rule.value}`;
    }
    if (
      rule.kind === "regex" &&
      (typeof value !== "string" || !new RegExp(rule.pattern).test(value))
    ) {
      return "does not match the configured pattern";
    }
  }
  return undefined;
}

function matchesNotionType(property: SchemaPropertyDefinition, value: unknown): boolean {
  switch (property.notionType) {
    case "title":
    case "rich_text":
    case "date":
    case "url":
    case "email":
    case "phone_number":
    case "select":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "multi_select":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  throw new Error("Unsupported Notion property type");
}

export function validateExtractedValues(
  schema: SchemaProfile,
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The configured model returned a non-object extraction");
  }
  const raw = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const knownIds = new Set(schema.properties.map((property) => property.id));
  for (const key of Object.keys(raw)) {
    if (!knownIds.has(key)) {
      throw new Error(`The configured model returned unknown field ${key}`);
    }
  }
  for (const property of schema.properties) {
    if (property.systemFieldRole) {
      continue;
    }
    const value = raw[property.id];
    if (value === undefined || value === null || value === "") {
      if (property.required) {
        throw new Error(`Required extracted field ${property.id} is missing`);
      }
      continue;
    }
    if (!matchesNotionType(property, value)) {
      throw new Error(
        `Extracted field ${property.id} does not match Notion type ${property.notionType}`,
      );
    }
    if (
      property.options &&
      (property.notionType === "select" || property.notionType === "multi_select")
    ) {
      const values = Array.isArray(value) ? value : [value];
      if (!values.every((entry) => typeof entry === "string" && property.options?.includes(entry))) {
        throw new Error(`Extracted field ${property.id} contains an unsupported option`);
      }
    }
    const ruleIssue = validateRule(property, value);
    if (ruleIssue) {
      throw new Error(`Extracted field ${property.id} ${ruleIssue}`);
    }
    result[property.id] = value;
  }
  return result;
}

export async function extractSchemaFieldsWithCurrentModel(params: {
  api: OpenClawPluginApi;
  job: InboundImageJob;
  filePath: string;
  agentProfile: AgentProfile;
  schemaProfile: SchemaProfile;
}): Promise<ExtractedFields> {
  const cfg = params.api.runtime.config.current() as OpenClawConfig;
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    config: cfg,
    sessionKey: params.job.sessionKey,
  });
  const configured = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: true,
  });
  const sessionEntry = params.job.sessionKey
    ? params.api.runtime.agent.session.getSessionEntry({
        sessionKey: params.job.sessionKey,
        agentId,
      })
    : undefined;
  const provider =
    sessionEntry?.providerOverride?.trim() ||
    sessionEntry?.modelProvider?.trim() ||
    configured.provider;
  const model =
    sessionEntry?.modelOverride?.trim() || sessionEntry?.model?.trim() || configured.model;
  const result = await params.api.runtime.mediaUnderstanding.describeImageFileWithModel({
    filePath: params.filePath,
    mime: params.job.mimeType,
    cfg,
    agentDir: params.api.runtime.agent.resolveAgentDir(cfg, agentId),
    provider,
    model,
    prompt: extractionPrompt(params.agentProfile, params.schemaProfile),
    maxTokens: 1_200,
    timeoutMs: 45_000,
  });
  if (!result.text?.trim()) {
    throw new Error("The configured model returned no field extraction");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(result.text));
  } catch {
    throw new Error("The configured model returned invalid extraction JSON");
  }
  return {
    values: validateExtractedValues(params.schemaProfile, parsed),
    provider,
    model,
  };
}
