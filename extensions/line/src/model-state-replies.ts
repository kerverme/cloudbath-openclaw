/**
 * The words of every deterministic model-state answer, in Thai and English.
 *
 * Every fact here comes from the caller: the session's canonical selection or
 * the account's catalog. Nothing is inferred.
 */
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  catalogModelLabel,
  modelVendor,
  type LineCatalogLookup,
  type LineModelAlias,
} from "./model-catalog-lookup.js";
import type { OpenRouterAccountModel } from "./model-catalog-tool.js";

const MAX_LISTED_MODELS = 10;

export type SelectedModel = { provider: string; model: string };

function bulletList(models: readonly OpenRouterAccountModel[]): string {
  const shown = models.slice(0, MAX_LISTED_MODELS).map((model) => `• ${catalogModelLabel(model)}`);
  return shown.join("\n");
}

function vendorOf(selected: SelectedModel): string | undefined {
  return selected.provider === "openrouter" ? modelVendor(selected.model) : undefined;
}

type SelectionState = {
  source: "manual" | "auto" | "default";
  fallbackFrom?: string;
  pending: boolean;
  locked: boolean;
  lastRun?: string;
};

export function readSelectionState(
  selected: SelectedModel,
  entry: SessionEntry | undefined,
): SelectionState {
  // Same condition resolveSessionModelRef treats as a session selection.
  const hasOverride = Boolean(entry?.modelOverride?.trim());
  const origin =
    entry?.modelOverrideFallbackOriginProvider && entry.modelOverrideFallbackOriginModel
      ? `${entry.modelOverrideFallbackOriginProvider}/${entry.modelOverrideFallbackOriginModel}`
      : undefined;
  const lastRun =
    entry?.modelProvider && entry.model ? `${entry.modelProvider}/${entry.model}` : undefined;
  return {
    source: !hasOverride ? "default" : entry?.modelOverrideSource === "auto" ? "auto" : "manual",
    ...(origin ? { fallbackFrom: origin } : {}),
    pending: entry?.liveModelSwitchPending === true,
    locked: entry?.modelSelectionLocked === true,
    ...(lastRun && lastRun !== `${selected.provider}/${selected.model}` ? { lastRun } : {}),
  };
}

export type Replies = {
  current(selected: SelectedModel, state: SelectionState): string;
  currentProvider(selected: SelectedModel): string;
  available(lookup: LineCatalogLookup): string;
  provider(lookup: LineCatalogLookup): string;
  notAvailable(target: string, lookup: LineCatalogLookup): string;
  family(target: string, models: readonly OpenRouterAccountModel[]): string;
  summary(models: readonly OpenRouterAccountModel[]): string;
  catalogUnavailable(): string;
};

function vendorCounts(models: readonly OpenRouterAccountModel[]): string {
  const counts = new Map<string, number>();
  for (const model of models) {
    const vendor = modelVendor(model.id) ?? model.id;
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(
      ([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName),
    )
    .slice(0, MAX_LISTED_MODELS)
    .map(([vendor, count]) => `• ${vendor} (${count})`)
    .join("\n");
}

function aliasNote(alias: LineModelAlias | undefined, thai: boolean): string {
  if (!alias) {
    return "";
  }
  return thai
    ? `\n("${alias.alias}" คือชื่อเรียกที่ตั้งไว้ของ ${alias.provider}/${alias.model})`
    : `\n("${alias.alias}" is the configured alias for ${alias.provider}/${alias.model})`;
}

export const THAI_REPLIES: Replies = {
  current: (selected, state) =>
    [
      `ตอนนี้ใช้โมเดล ${selected.model} ผ่าน ${selected.provider}`,
      state.source === "manual"
        ? "การเลือก: เลือกเอง"
        : state.source === "auto"
          ? `การเลือก: สลับอัตโนมัติ (fallback)${state.fallbackFrom ? ` จาก ${state.fallbackFrom}` : ""}`
          : "การเลือก: ค่าเริ่มต้นของระบบ",
      ...(state.pending ? ["การเปลี่ยนโมเดลจะมีผลในคำตอบถัดไป"] : []),
      ...(state.locked ? ["การเลือกโมเดลถูกล็อกไว้"] : []),
      ...(state.lastRun ? [`คำตอบล่าสุดใช้ ${state.lastRun}`] : []),
    ].join("\n"),
  currentProvider: (selected) => {
    const vendor = vendorOf(selected);
    return `โมเดลที่ใช้อยู่ (${selected.model}) ให้บริการผ่าน ${selected.provider}${vendor ? ` · ผู้พัฒนา: ${vendor}` : ""}`;
  },
  available: (lookup) =>
    `มี ${lookup.matches.map(catalogModelLabel).join(", ")} ในแคตตาล็อก OpenRouter ของบัญชีนี้${aliasNote(lookup.alias, true)}\nพิมพ์ "เปลี่ยนเป็น ${lookup.matches[0]!.id}" ถ้าต้องการใช้`,
  provider: (lookup) =>
    lookup.matches
      .map(
        (model) =>
          `${catalogModelLabel(model)} ให้บริการผ่าน OpenRouter · ผู้พัฒนา: ${modelVendor(model.id) ?? "-"}`,
      )
      .join("\n") + aliasNote(lookup.alias, true),
  notAvailable: (target, lookup) =>
    [
      `ไม่มี "${target}" ในแคตตาล็อก OpenRouter ของบัญชีนี้`,
      ...(lookup.alias
        ? [
            `("${lookup.alias.alias}" คือชื่อเรียกที่ตั้งไว้ของ ${lookup.alias.provider}/${lookup.alias.model} ซึ่งไม่อยู่ในแคตตาล็อกนี้)`,
          ]
        : []),
      ...(lookup.suggestions.length > 0
        ? [`รุ่นอื่นที่มีชื่อคล้ายกัน (ไม่ใช่รุ่นที่ถาม): ${lookup.suggestions.map(catalogModelLabel).join(", ")}`]
        : []),
    ].join("\n"),
  family: (target, models) =>
    models.length === 0
      ? `ไม่มีโมเดล "${target}" ในแคตตาล็อก OpenRouter ของบัญชีนี้`
      : `ในแคตตาล็อก OpenRouter ของบัญชีนี้มี ${target} ${models.length} รุ่น:\n${bulletList(models)}${models.length > MAX_LISTED_MODELS ? `\nและอีก ${models.length - MAX_LISTED_MODELS} รุ่น` : ""}`,
  summary: (models) =>
    `ในแคตตาล็อก OpenRouter ของบัญชีนี้มีทั้งหมด ${models.length} รุ่น:\n${vendorCounts(models)}`,
  catalogUnavailable: () =>
    "ตอนนี้อ่านแคตตาล็อกโมเดลของ OpenRouter ไม่ได้ จึงยังยืนยันไม่ได้ว่ามีรุ่นนี้หรือไม่ ลองถามใหม่อีกครั้งภายหลัง",
};

export const ENGLISH_REPLIES: Replies = {
  current: (selected, state) =>
    [
      `Current model: ${selected.model} via ${selected.provider}`,
      state.source === "manual"
        ? "Selection: chosen manually"
        : state.source === "auto"
          ? `Selection: automatic fallback${state.fallbackFrom ? ` from ${state.fallbackFrom}` : ""}`
          : "Selection: configured default",
      ...(state.pending ? ["A model switch takes effect from the next reply"] : []),
      ...(state.locked ? ["Model selection is locked"] : []),
      ...(state.lastRun ? [`The last reply used ${state.lastRun}`] : []),
    ].join("\n"),
  currentProvider: (selected) => {
    const vendor = vendorOf(selected);
    return `The current model (${selected.model}) is served by ${selected.provider}${vendor ? ` · developer: ${vendor}` : ""}`;
  },
  available: (lookup) =>
    `${lookup.matches.map(catalogModelLabel).join(", ")} is in this account's OpenRouter catalog${aliasNote(lookup.alias, false)}\nSend "switch to ${lookup.matches[0]!.id}" to use it`,
  provider: (lookup) =>
    lookup.matches
      .map(
        (model) =>
          `${catalogModelLabel(model)} is served by OpenRouter · developer: ${modelVendor(model.id) ?? "-"}`,
      )
      .join("\n") + aliasNote(lookup.alias, false),
  notAvailable: (target, lookup) =>
    [
      `"${target}" is not in this account's OpenRouter catalog`,
      ...(lookup.alias
        ? [
            `("${lookup.alias.alias}" is the configured alias for ${lookup.alias.provider}/${lookup.alias.model}, which is not in this catalog)`,
          ]
        : []),
      ...(lookup.suggestions.length > 0
        ? [
            `Other models with similar names (not the one asked for): ${lookup.suggestions.map(catalogModelLabel).join(", ")}`,
          ]
        : []),
    ].join("\n"),
  family: (target, models) =>
    models.length === 0
      ? `No "${target}" models are in this account's OpenRouter catalog`
      : `This account's OpenRouter catalog has ${models.length} ${target} models:\n${bulletList(models)}${models.length > MAX_LISTED_MODELS ? `\nand ${models.length - MAX_LISTED_MODELS} more` : ""}`,
  summary: (models) =>
    `This account's OpenRouter catalog has ${models.length} models:\n${vendorCounts(models)}`,
  catalogUnavailable: () =>
    "I can't read the OpenRouter model catalog right now, so I can't confirm whether that model is available. Please ask again shortly.",
};
