/**
 * Read-only answers about the LINE model catalog.
 *
 * A model is AVAILABLE only when the owner's wording equals one of its names
 * after normalization. Anything looser is at most a suggestion: the picker's
 * token search treats "GPT-6 Luna" as a hit for "GPT-5.6 Luna" because "6"
 * occurs in "5.6", which is right for offering choices and wrong as evidence
 * that a model exists.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildModelAliasIndex,
  resolveSessionModelRef,
} from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenRouterAccountModel } from "./model-catalog-tool.js";

const MAX_SUGGESTIONS = 3;

/** A configured model alias (`agents.defaults.models[ref].alias`) and its target. */
export type LineModelAlias = { alias: string; provider: string; model: string };

export type LineCatalogLookup = {
  /** Catalog models the wording names exactly. Empty means NOT available. */
  matches: OpenRouterAccountModel[];
  /** The configured alias the wording used, when it was one. */
  alias?: LineModelAlias;
  /** Catalog models with a similar name. Never evidence of availability. */
  suggestions: OpenRouterAccountModel[];
};

export function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function words(value: string): string[] {
  const normalized = normalizeCatalogText(value);
  return normalized ? normalized.split(" ") : [];
}

const hasLetter = (word: string) => /\p{L}/u.test(word);

/** Every spelling a model answers to, OpenRouter's "Vendor: Name" display form included. */
function catalogNames(model: OpenRouterAccountModel): string[] {
  const slug = model.id.slice(model.id.indexOf("/") + 1);
  return [model.id, slug, model.ref, model.name, model.name.replace(/^[^:]+:\s*/u, "")];
}

/** The vendor segment of a canonical `vendor/model` id, e.g. "openai". */
export function modelVendor(id: string): string | undefined {
  const slash = id.lastIndexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/**
 * Exact lookup against the catalog and the configured aliases.
 *
 * Suggestions share every word of the query that carries a letter, so
 * "GPT-6 Luna" suggests "GPT-5.6 Luna" -- and the caller must present it as
 * a different model that exists, not as the one asked for.
 */
export function lookupCatalogModel(params: {
  query: string;
  models: readonly OpenRouterAccountModel[];
  aliases: readonly LineModelAlias[];
}): LineCatalogLookup {
  const wanted = normalizeCatalogText(params.query);
  if (!wanted) {
    return { matches: [], suggestions: [] };
  }
  const alias = params.aliases.find((entry) => normalizeCatalogText(entry.alias) === wanted);
  const matches = params.models.filter(
    (model) =>
      (alias?.provider === "openrouter" && alias.model === model.id) ||
      catalogNames(model).some((name) => normalizeCatalogText(name) === wanted),
  );
  if (matches.length > 0) {
    return { matches, ...(alias ? { alias } : {}), suggestions: [] };
  }
  const queryWords = words(params.query);
  const lettered = queryWords.filter(hasLetter);
  const suggestions =
    lettered.length === 0
      ? []
      : params.models
          .map((model) => {
            const modelWords = new Set(words(`${model.id} ${model.name}`));
            return {
              model,
              covers: lettered.every((word) => modelWords.has(word)),
              shared: queryWords.filter((word) => modelWords.has(word)).length,
            };
          })
          .filter((candidate) => candidate.covers)
          .toSorted(
            (left, right) =>
              right.shared - left.shared || left.model.name.localeCompare(right.model.name),
          )
          .slice(0, MAX_SUGGESTIONS)
          .map((candidate) => candidate.model);
  return { matches: [], ...(alias ? { alias } : {}), suggestions };
}

/** Catalog models whose vendor or family is exactly the given word(s), e.g. "OpenAI". */
export function listCatalogFamily(
  models: readonly OpenRouterAccountModel[],
  family: string,
): OpenRouterAccountModel[] {
  const wanted = words(family);
  if (wanted.length === 0) {
    return [];
  }
  return models.filter((model) => {
    const modelWords = new Set(words(`${model.id} ${model.name}`));
    return wanted.every((word) => modelWords.has(word));
  });
}

/**
 * Vendor and family words a set of model ids uses -- "openai", "gpt",
 * "deepseek" -- so a question can be recognized as being about models
 * without a hard-coded list of names.
 */
export function modelFamilyWords(ids: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const id of ids) {
    const segments = id.split("/");
    const model = segments.pop() ?? "";
    for (const vendorWord of segments.flatMap(words)) {
      if (vendorWord.length > 1 && hasLetter(vendorWord)) {
        found.add(vendorWord);
      }
    }
    const family = words(model).find(hasLetter);
    if (family && family.length > 1) {
      found.add(family);
    }
  }
  return found;
}

/** True when any word of the target is one of the known model words. */
export function namesKnownModelWord(target: string, known: ReadonlySet<string>): boolean {
  return words(target).some((word) => known.has(word));
}

/**
 * The configured aliases, resolved by core's own alias index so a bare
 * `gpt-5.6` resolves against the same default provider the runtime uses.
 */
export function readLineModelAliases(
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): LineModelAlias[] {
  if (!cfg) {
    return [];
  }
  const defaultProvider = resolveSessionModelRef(cfg, undefined, agentId).provider;
  return [...buildModelAliasIndex({ cfg, defaultProvider }).byAlias.values()].map(
    ({ alias, ref }) => ({ alias, provider: ref.provider, model: ref.model }),
  );
}
