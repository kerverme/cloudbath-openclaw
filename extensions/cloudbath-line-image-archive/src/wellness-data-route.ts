/**
 * Read-only Wellness data questions, answered from one table read.
 *
 * Production: "Cashflow - Cloudbath ใช้ไปเท่าไร" reached the general agent,
 * which ran shell commands, read memory files, searched memory and called
 * `wellness_notion_query` eight times before answering (12 model calls, 122 s).
 * The follow-up "รายจ่ายล่าสุดคืออะไร" was then taken for a reference back to
 * creative work and answered "which Character or VIDEO do you mean?".
 *
 * A turn this route claims never reaches the agent, so no other tool is ever
 * offered or called for it. It reads the whole table in one operation (paging
 * inside the reader), computes every figure in code, and spends exactly one
 * model call — with no tools — to say which figure answers the question.
 * Anything it cannot place plainly is left for the agent, untouched.
 *
 * Access: only the bound owner of a LINE conversation (the same proven claim
 * every Cloudbath route requires), through the same root-page-scoped reader the
 * Wellness tools use.
 */

import { conversationContextKey } from "./conversation-context.js";
import type { WellnessTable, WellnessTableRows } from "./notion-tools.js";
import {
  resolveStoryboardAccessClaim,
  type StoryboardDispatchContext,
  type StoryboardDispatchEvent,
} from "./storyboard-line-router.js";
import type { AsyncKeyedStore, SafeLogger } from "./types.js";
import { buildWellnessDataBrief, type WellnessDataBrief } from "./wellness-data-brief.js";
import {
  chooseWellnessTable,
  readWellnessDataIntent,
  type WellnessDataIntent,
} from "./wellness-data-intent.js";

export const CLOUDBATH_WELLNESS_DATA_REFERENT_NAMESPACE = "cloudbath-wellness-data-referent";
/**
 * How long "the table we were just talking about" stays the default referent.
 * Long enough for a follow-up, short enough that tomorrow's question is read
 * fresh rather than bound to today's table.
 */
export const CLOUDBATH_WELLNESS_DATA_REFERENT_TTL_MS = 30 * 60_000;
/** The owner's calendar, for "this month" and "today". */
const OWNER_TIME_ZONE = "Asia/Bangkok";
/** A previous answer is context for the next one, not a transcript. */
const PREVIOUS_ANSWER_MAX_CHARS = 600;

/** The table this conversation last answered about, and what it said. */
export type WellnessDataConversation = Readonly<{
  dataSourceId: string;
  title?: string;
  question: string;
  answer: string;
  answeredAt: number;
}>;

export type WellnessTableReader = Readonly<{
  listTables(signal?: AbortSignal): Promise<readonly WellnessTable[]>;
  readTable(dataSourceIndex: number, signal?: AbortSignal): Promise<WellnessTableRows>;
}>;

export type WellnessDataAnswerRequest = Readonly<{
  systemPrompt: string;
  messages: ReadonlyArray<Readonly<{ role: "user"; content: string }>>;
  purpose: string;
}>;

export type WellnessDataRouteDeps = Readonly<{
  /** Throws when the Wellness connection is not configured; the turn is then left alone. */
  openReader: () => WellnessTableReader;
  referents: AsyncKeyedStore<WellnessDataConversation>;
  /** One model call, no tools. Returns the reply text. */
  answer: (request: WellnessDataAnswerRequest) => Promise<string>;
  now: () => number;
  logger?: Pick<SafeLogger, "info" | "warn">;
}>;

const SYSTEM_PROMPT = [
  "You answer an owner's question about one of their business data tables.",
  "The SUMMARY below was computed in code over every row read from the table. Use only its numbers;",
  "never estimate, recompute, or invent figures, and never ask to fetch more data.",
  "Pick the figure that answers the QUESTION:",
  "- how much was spent / total: the running total over all rows (`totals`); when `flow` exists, a spending",
  "  question means the money-out group and an income question the money-in group;",
  "- latest / most recent: the `latest` batch (every row on the most recent date), not the running total;",
  "- a named period (this month, today, ...): the `range` section.",
  "When several money fields could answer, prefer the one whose name says expense or spending for a spending",
  "question, and name the field you used.",
  "A running total and the latest batch are different figures, not a contradiction. When PREVIOUS ANSWER gave",
  "one and this question asks for the other, say so in one short clause.",
  "If `complete` is false, say the figures cover only the rows read.",
  "Reply in the language of the QUESTION (Thai if it is Thai), in at most 8 short lines, plain text, with",
  "thousands separators and the currency the field names (บาท / THB when it says THB or baht).",
].join("\n");

function summaryForModel(intent: WellnessDataIntent, brief: WellnessDataBrief, previous?: string) {
  return [
    `QUESTION: ${intent.text}`,
    `SUMMARY: ${JSON.stringify(brief)}`,
    ...(previous ? [`PREVIOUS ANSWER: ${previous}`] : []),
  ].join("\n\n");
}

export class WellnessDataRoute {
  constructor(private readonly deps: WellnessDataRouteDeps) {}

  async handle(
    event: StoryboardDispatchEvent,
    context: StoryboardDispatchContext,
  ): Promise<{ handled: true; text: string } | undefined> {
    if (context.channelId?.trim().toLowerCase() !== "line") {
      return undefined;
    }
    const claim = resolveStoryboardAccessClaim(event, context);
    const intent = claim ? readWellnessDataIntent(event.content ?? "") : undefined;
    if (!claim || !intent) {
      return undefined;
    }
    const key = conversationContextKey(claim);
    try {
      const reader = this.deps.openReader();
      const [tables, previous] = await Promise.all([
        reader.listTables(),
        this.deps.referents.lookup(key),
      ]);
      const choice = chooseWellnessTable({ intent, tables, referent: previous });
      if (!choice) {
        this.deps.logger?.info("wellness_data_unplaced", { operation: intent.operation });
        return undefined;
      }
      const rows = await reader.readTable(choice.table.dataSourceIndex);
      const title = choice.table.title ?? `table ${choice.table.dataSourceIndex}`;
      const brief = buildWellnessDataBrief({
        title,
        table: rows,
        ...(intent.range ? { range: intent.range } : {}),
        now: this.deps.now(),
        timeZone: OWNER_TIME_ZONE,
      });
      const text = (
        await this.deps.answer({
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: summaryForModel(intent, brief, previous?.answer) }],
          purpose: "cloudbath-wellness-data",
        })
      ).trim();
      if (!text) {
        return undefined;
      }
      await this.deps.referents.register(key, {
        dataSourceId: choice.table.dataSourceId,
        ...(choice.table.title ? { title: choice.table.title } : {}),
        question: intent.text,
        answer: text.slice(0, PREVIOUS_ANSWER_MAX_CHARS),
        answeredAt: this.deps.now(),
      });
      this.deps.logger?.info("wellness_data_answered", {
        operation: intent.operation,
        ...(intent.range ? { range: intent.range } : {}),
        tableSource: choice.source,
        dataSourceIndex: choice.table.dataSourceIndex,
        rows: brief.rows,
        complete: brief.complete,
      });
      return { handled: true, text };
    } catch (error) {
      // The general agent still has the Wellness tools; a failure here must
      // cost the owner nothing but the attempt.
      this.deps.logger?.warn("wellness_data_fallback", {
        operation: intent.operation,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return undefined;
    }
  }
}
