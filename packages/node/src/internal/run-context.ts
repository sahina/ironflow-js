/**
 * Run context propagation via AsyncLocalStorage.
 *
 * When a function handler executes, the SDK sets the current run ID.
 * createClient() picks it up automatically and includes X-Ironflow-Run-ID
 * header on all requests — linking entity events to the run that created them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RunContext {
  runId: string;
}

const runContextStorage = new AsyncLocalStorage<RunContext>();

/**
 * Execute a callback within a run context.
 * Any createClient() calls inside will automatically include the run ID.
 */
export function withRunContext<T>(runId: string, fn: () => T): T {
  return runContextStorage.run({ runId }, fn);
}

/**
 * Get the current run ID from context, or undefined if not in a run.
 */
export function getCurrentRunId(): string | undefined {
  return runContextStorage.getStore()?.runId;
}
