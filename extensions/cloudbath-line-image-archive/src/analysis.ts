import {
  resolveDefaultModelForAgent,
  resolveSessionAgentIds,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ImageAnalysis, InboundImageJob } from "./types.js";

const ANALYSIS_PROMPT = `Analyze this archived image and return only a JSON object with:
description (concise string), category (short string), tags (array of short strings),
vendor (string or null), and amount (number or null).
Use vendor and amount only when the image appears to be a receipt, invoice, or payment slip.
Do not include markdown fences or any keys other than those listed.`;

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : undefined;
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function analyzeImageWithCurrentModel(params: {
  api: OpenClawPluginApi;
  job: InboundImageJob;
  filePath: string;
}): Promise<ImageAnalysis> {
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
  const agentDir = params.api.runtime.agent.resolveAgentDir(cfg, agentId);

  const result = await params.api.runtime.mediaUnderstanding.describeImageFileWithModel({
    filePath: params.filePath,
    mime: params.job.mimeType,
    cfg,
    agentDir,
    provider,
    model,
    prompt: ANALYSIS_PROMPT,
    maxTokens: 500,
    timeoutMs: 45_000,
  });
  if (!result.text?.trim()) {
    throw new Error("The configured model returned no image analysis");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFence(result.text)) as Record<string, unknown>;
  } catch {
    throw new Error("The configured model returned invalid analysis JSON");
  }

  const description = optionalString(parsed.description);
  if (!description) {
    throw new Error("The configured model did not return an image description");
  }
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map(optionalString)
        .filter((value): value is string => Boolean(value))
        .slice(0, 20)
    : [];

  return {
    description,
    category: optionalString(parsed.category),
    tags,
    vendor: optionalString(parsed.vendor),
    amount: parseAmount(parsed.amount),
    provider,
    model,
  };
}
