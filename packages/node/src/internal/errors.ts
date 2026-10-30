import { NonRetryableError } from "@ironflow/core";
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
    payload?: unknown;
    event: string;
    match?: string;
    match_value?: string;
    timeout?: string;
    on_timeout?: "fail" | "return-null";
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

// A scope keeps its signal until the invocation ends. No durable operation may
// continue after yielding, even if application code catches the thrown signal.
export class SwallowedYieldError extends NonRetryableError {
  constructor() {
    super("A durable step yield was caught or swallowed. Rethrow yielding-step signals; catch errors inside step.run instead. For a wait timeout branch use onTimeout: 'return-null'.");
  }
}

export class YieldGuard {
  private pending = false;
  constructor(private readonly invocation = { failed: false }) {}
  branch(): YieldGuard { return new YieldGuard(this.invocation); }
  assertClear(): void {
    this.assertReturned();
    if (this.invocation.failed) throw new SwallowedYieldError();
  }
  // An already-running sibling may finish and memoize its effect even after
  // another scope fails. Only this scope's swallowed signal invalidates it.
  assertReturned(): void {
    if (this.pending) {
      this.invocation.failed = true;
      throw new SwallowedYieldError();
    }
  }
  normalizeError(error: unknown): unknown {
    if (isYieldSignal(error) && !this.invocation.failed) return error;
    try { this.assertClear(); }
    catch (guardError) { return guardError; }
    return error;
  }
  yield(info: YieldInfo): never {
    this.pending = true;
    throw new YieldSignal(info);
  }
}
