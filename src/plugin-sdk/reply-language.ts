/**
 * The shared reply-language validator and repair, for plugins.
 *
 * There must be exactly one implementation of "is this reply written in the
 * language this conversation expects, and what do we send if it is not".
 * Before this subpath existed the LINE plugin carried its own copy, and the two
 * drifted: core caught a wholly foreign reply while the plugin could not, and
 * each repaired with different rules, so one turn could reach the Control UI
 * and LINE in two different wordings.
 *
 * Core owns the mechanism exported here. Product vocabulary — expected
 * language, permitted proper nouns, fallback wording — is the plugin's, and
 * travels in as `TurnPresentationPolicy` data.
 */
export {
  createReplyLanguageScanner,
  expectedScriptsFor,
  foreignScriptRuns,
  isTechnicalToken,
  validateReplyLanguage,
  type ReplyLanguageScanner,
  type ReplyLanguageValidation,
  type ScriptName,
  type TurnPresentationPolicy,
  type ValidateReplyLanguageOptions,
} from "../infra/reply-language-policy.js";
export {
  finalizeReplyText,
  type FinalizedReply,
  type FinalReplyOutcome,
  type FinalReplyRepairKind,
} from "../infra/reply-language-repair.js";
