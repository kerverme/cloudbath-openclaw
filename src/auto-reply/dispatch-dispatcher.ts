// Reply dispatcher lifecycle helpers used by auto-reply dispatch paths.
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

type ReplyDispatcherSettledTask = () => Promise<void> | void;

const settledTasksByDispatcher = new WeakMap<ReplyDispatcher, Set<ReplyDispatcherSettledTask>>();

/** Register post-delivery work owned by the dispatcher's settle lifecycle. */
export function registerReplyDispatcherSettledTask(
  dispatcher: ReplyDispatcher,
  task: ReplyDispatcherSettledTask,
): void {
  const tasks = settledTasksByDispatcher.get(dispatcher) ?? new Set<ReplyDispatcherSettledTask>();
  tasks.add(task);
  settledTasksByDispatcher.set(dispatcher, tasks);
}

async function runReplyDispatcherSettledTasks(dispatcher: ReplyDispatcher): Promise<void> {
  const tasks = settledTasksByDispatcher.get(dispatcher);
  if (!tasks) {
    return;
  }
  settledTasksByDispatcher.delete(dispatcher);
  for (const task of tasks) {
    await task();
  }
}

/** Mark a dispatcher complete, wait for pending work, then run optional cleanup. */
export async function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<void> {
  params.dispatcher.markComplete();
  try {
    await params.dispatcher.waitForIdle();
    await runReplyDispatcherSettledTasks(params.dispatcher);
  } finally {
    // waitForIdle can throw. Settled tasks own per-run state that must still be
    // released, so run whatever the try path did not reach; the helper clears
    // the registry first, making this a no-op once the success path has run.
    // Failures here are swallowed rather than masking the original error.
    try {
      await runReplyDispatcherSettledTasks(params.dispatcher);
    } catch {
      // A cleanup task that throws must not replace the dispatch error.
    }
    settledTasksByDispatcher.delete(params.dispatcher);
    await params.onSettled?.();
  }
}

/** Run work with a dispatcher and always drain it before returning or throwing. */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    await settleReplyDispatcher(params);
  }
}
