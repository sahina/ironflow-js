/**
 * Internal error classes for step execution (Node.js specific)
 */

/**
 * Yield information union type
 */
export type YieldInfo = SleepYieldInfo | WaitEventYieldInfo | InvokeFunctionYieldInfo | InvokeFunctionAsyncYieldInfo;

/**
 * Sleep yield information
 */
export interface SleepYieldInfo {
  step_id: string;
  type: "sleep";
  until: string;
}

/**
 * Wait for event yield information
 */
export interface WaitEventYieldInfo {
  step_id: string;
  type: "wait_for_event";
  event_filter: {
    event: string;
    match?: string;
    timeout?: string;
  };
}

/**
 * Invoke function yield information
 */
export interface InvokeFunctionYieldInfo {
  step_id: string;
  type: "invoke_function";
  function_id: string;
  input?: unknown;
  invoke_timeout_ms?: number;
}

/**
 * Invoke function async yield information
 */
export interface InvokeFunctionAsyncYieldInfo {
  step_id: string;
  type: "invoke_function_async";
  function_id: string;
  input?: unknown;
}

/**
 * Internal signal to yield execution (not a real error).
 * Used internally to implement sleep and waitForEvent.
 *
 * @internal
 */
export class YieldSignal extends Error {
  /** Information about the yield operation */
  readonly yieldInfo: YieldInfo;

  constructor(yieldInfo: YieldInfo) {
    super("Yield signal");
    this.name = "YieldSignal";
    this.yieldInfo = yieldInfo;
  }
}

/**
 * Check if an error is a YieldSignal
 *
 * @param error - The error to check
 * @returns true if the error is a YieldSignal
 * @internal
 */
export function isYieldSignal(error: unknown): error is YieldSignal {
  return error instanceof YieldSignal;
}
