/**
 * Step Execution Client
 *
 * Implements durable step primitives: run, sleep, sleepUntil, waitForEvent, parallel, map
 */

import type {
  Duration,
  EventFilter,
  IronflowEvent,
  ParallelOptions,
  StepClient,
  StepRunOptions,
  StepResult,
  Logger,
  PublishResult,
} from "@ironflow/core";
import { StepError, StepTimeoutError, isRetryable, parseDuration, InvokeError } from "@ironflow/core";
import { ExecutionContext, BranchContext } from "./internal/context.js";
import {
  YieldSignal,
  type SleepYieldInfo,
  type WaitEventYieldInfo,
  type InvokeFunctionYieldInfo,
  type InvokeFunctionAsyncYieldInfo,
} from "./internal/errors.js";

/**
 * Context interface for step execution
 */
interface StepContext {
  readonly runId: string;
  readonly logger: Logger;
  readonly stepTimeout?: string;
  readonly serverUrl?: string;
  readonly apiKey?: string;
  generateStepId(name: string): string;
  shouldSkipStep(stepId: string): boolean;
  getMemoizedOutput<T>(stepId: string): T | undefined;
  getFailedStep?(stepId: string): unknown | undefined;
  isStepTimedOut?(stepId: string): boolean;
  isResumingFrom(stepId: string, type: "sleep" | "wait_for_event"): boolean;
  getResumeData<T>(): T | undefined;
  markResumeProcessed(): void;
  recordStep(step: StepResult): void;
  createBranchContext(parallelName: string, branchIndex: number): BranchContext;
  registerCompensation(stepName: string, fn: () => Promise<void>): void;
  hasCompensations(): boolean;
  getCompensationsInReverse(): Array<{ stepName: string; fn: () => Promise<void> }>;
}

/**
 * Create a step client for the given execution context
 */
export function createStepClient(ctx: ExecutionContext): StepClient {
  return createStepClientInternal(ctx);
}

/**
 * Internal step client creation that works with any StepContext
 */
function createStepClientInternal(ctx: StepContext): StepClient {
  return {
    run: <T>(name: string, fn: () => Promise<T>, options?: StepRunOptions): Promise<T> =>
      executeStep(ctx, name, fn, options),

    sleep: (name: string, duration: Duration): Promise<void> =>
      executeSleep(ctx, name, duration),

    sleepUntil: (name: string, until: Date | string): Promise<void> =>
      executeSleepUntil(ctx, name, until),

    waitForEvent: <T = unknown>(
      name: string,
      filter: EventFilter
    ): Promise<IronflowEvent<T>> => executeWaitForEvent(ctx, name, filter),

    parallel: <T extends unknown[]>(
      name: string,
      branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
      options?: ParallelOptions
    ): Promise<T> =>
      executeParallel(
        ctx,
        name,
        branches as ((step: StepClient) => Promise<unknown>)[],
        options
      ) as Promise<T>,

    map: <T, R>(
      name: string,
      items: T[],
      fn: (item: T, step: StepClient, index: number) => Promise<R>,
      options?: ParallelOptions
    ): Promise<R[]> => executeMap(ctx, name, items, fn, options),

    compensate: (stepName: string, fn: () => Promise<void>): void => {
      ctx.registerCompensation(stepName, fn);
    },

    invoke: <T = unknown>(
      functionId: string,
      input?: unknown,
      options?: { timeout?: string }
    ): Promise<T> => executeInvoke<T>(ctx, functionId, input, options),

    invokeAsync: (
      functionId: string,
      input?: unknown
    ): Promise<{ runId: string }> => executeInvokeAsync(ctx, functionId, input),

    publish: (topic: string, data: unknown): Promise<PublishResult> =>
      executePublish(ctx, topic, data),
  };
}

/**
 * Wrap a step function with a timeout.
 * If the timeout fires before fn() resolves, throws StepTimeoutError.
 */
async function withStepTimeout<T>(
  fn: () => Promise<T>,
  stepName: string,
  timeout: string
): Promise<T> {
  const timeoutMs = parseDuration(timeout);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StepTimeoutError(stepName, timeout));
    }, timeoutMs);

    fn().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Execute a step with memoization
 *
 * WHY: Use step.run() for any non-idempotent operation (e.g., sending an email,
 * charging a card, calling an external API). Ironflow memoizes the result
 * of the first successful execution. If the workflow retries, this step will
 * be skipped and the previously stored result will be returned.
 */
async function executeStep<T>(
  ctx: StepContext,
  name: string,
  fn: () => Promise<T>,
  options?: StepRunOptions
): Promise<T> {
  const stepId = ctx.generateStepId(name);

  // Check if step is already completed (memoized)
  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`Step memoized: ${name}`, { stepId });
    return ctx.getMemoizedOutput<T>(stepId)!;
  }

  // Execute the step
  const startedAt = new Date();
  ctx.logger.debug(`Step starting: ${name}`, { stepId });

  try {
    const timeoutStr = options?.timeout ?? ctx.stepTimeout;
    const output = timeoutStr
      ? await withStepTimeout(fn, name, timeoutStr)
      : await fn();
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();

    // Record successful step
    const result: StepResult = {
      id: stepId,
      name,
      type: "invoke",
      status: "completed",
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
      output,
    };
    ctx.recordStep(result);

    ctx.logger.debug(`Step completed: ${name}`, { stepId, durationMs });
    return output;
  } catch (error) {
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();

    // Re-throw YieldSignal (it's not a real error)
    if (error instanceof YieldSignal) {
      throw error;
    }

    // Record failed step
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const result: StepResult = {
      id: stepId,
      name,
      type: "invoke",
      status: "failed",
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
      error: {
        message: errorMessage,
        retryable: isRetryable(error),
        stack: errorStack,
      },
    };
    ctx.recordStep(result);

    // Re-throw StepTimeoutError as-is (already has step context)
    if (error instanceof StepTimeoutError) {
      ctx.logger.error(`Step timed out: ${name}`, {
        stepId,
        error: errorMessage,
        durationMs,
      });
      throw error;
    }

    ctx.logger.error(`Step failed: ${name}`, {
      stepId,
      error: errorMessage,
      durationMs,
    });

    // Wrap in StepError for better context
    throw new StepError(errorMessage, {
      stepId,
      stepName: name,
      retryable: isRetryable(error),
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Execute a durable sleep
 *
 * WHY: Use step.sleep() for long-running pauses (minutes, hours, or days).
 * Unlike setTimeout, this is durable—the worker can restart or the server
 * can be upgraded, and the workflow will resume exactly where it left off
 * once the duration has elapsed.
 */
async function executeSleep(
  ctx: StepContext,
  name: string,
  duration: Duration
): Promise<void> {
  const stepId = ctx.generateStepId(name);

  // Check if resuming from this sleep
  if (ctx.isResumingFrom(stepId, "sleep")) {
    ctx.logger.debug(`Sleep resumed: ${name}`, { stepId });
    ctx.markResumeProcessed();
    return;
  }

  // Check if step is already completed (memoized)
  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`Sleep memoized: ${name}`, { stepId });
    return;
  }

  // Calculate wake time. Reject non-positive durations explicitly: a negative
  // or zero duration silently yielded to the server puts SleepUntil in the
  // past, so the scheduler wakes the step on the next tick — which looks like
  // a no-op sleep and is almost always a caller bug (inverted subtraction,
  // unit mix-up, etc.).
  const ms = parseDuration(duration);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `step.sleep(${JSON.stringify(name)}): duration must be a positive finite value, got ${JSON.stringify(duration)} (parsed to ${ms}ms)`,
    );
  }
  const wakeAt = new Date(Date.now() + ms);

  ctx.logger.debug(`Sleep yielding: ${name}`, {
    stepId,
    duration,
    wakeAt: wakeAt.toISOString(),
  });

  // Throw yield signal to pause execution
  const yieldInfo: SleepYieldInfo = {
    step_id: stepId,
    type: "sleep",
    until: wakeAt.toISOString(),
  };

  throw new YieldSignal(yieldInfo);
}

/**
 * Execute a durable sleep until a specific time
 */
async function executeSleepUntil(
  ctx: StepContext,
  name: string,
  until: Date | string
): Promise<void> {
  const stepId = ctx.generateStepId(name);

  // Check if resuming from this sleep
  if (ctx.isResumingFrom(stepId, "sleep")) {
    ctx.logger.debug(`SleepUntil resumed: ${name}`, { stepId });
    ctx.markResumeProcessed();
    return;
  }

  // Check if step is already completed (memoized)
  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`SleepUntil memoized: ${name}`, { stepId });
    return;
  }

  // Parse the target time
  const wakeAt = typeof until === "string" ? new Date(until) : until;

  // Validate the date
  if (isNaN(wakeAt.getTime())) {
    throw new Error(`Invalid date for sleepUntil: ${until}`);
  }
  // A wake time in the past silently wakes on the next scheduler tick. That
  // is almost always a caller bug (stale timestamp, timezone confusion) —
  // fail fast so the error surfaces in the step output rather than producing
  // an instant-complete sleep that looks correct.
  if (wakeAt.getTime() <= Date.now()) {
    throw new Error(
      `step.sleepUntil(${JSON.stringify(name)}): target time must be in the future, got ${wakeAt.toISOString()}`,
    );
  }

  ctx.logger.debug(`SleepUntil yielding: ${name}`, {
    stepId,
    until: wakeAt.toISOString(),
  });

  // Throw yield signal to pause execution
  const yieldInfo: SleepYieldInfo = {
    step_id: stepId,
    type: "sleep",
    until: wakeAt.toISOString(),
  };

  throw new YieldSignal(yieldInfo);
}

/**
 * Execute a durable wait for event
 *
 * WHY: Use step.waitForEvent() to implement choreography-based orchestration.
 * The workflow pauses durably until an external event arrives that matches
 * the provided filter. This is the primary way to handle human-in-the-loop
 * or asynchronous external callbacks.
 */
async function executeWaitForEvent<T = unknown>(
  ctx: StepContext,
  name: string,
  filter: EventFilter
): Promise<IronflowEvent<T>> {
  const stepId = ctx.generateStepId(name);

  // Check if resuming from this wait with the event data
  if (ctx.isResumingFrom(stepId, "wait_for_event")) {
    ctx.logger.debug(`WaitForEvent resumed: ${name}`, { stepId });
    ctx.markResumeProcessed();

    // The resume data contains the event that matched
    const resumeData = ctx.getResumeData<IronflowEvent<T>>();
    if (resumeData) {
      return resumeData;
    }
  }

  // Check if step is already completed (memoized)
  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`WaitForEvent memoized: ${name}`, { stepId });
    const output = ctx.getMemoizedOutput<IronflowEvent<T>>(stepId);
    if (output) {
      return output;
    }
  }

  // Validate the event filter before yielding. An empty event name would
  // produce a correlation that can never match — the step waits forever
  // until it times out, which is impossible to debug from a running workflow.
  if (!filter || typeof filter.event !== "string" || filter.event.trim() === "") {
    throw new Error(
      `step.waitForEvent(${JSON.stringify(name)}): filter.event must be a non-empty string`,
    );
  }
  // Use the trimmed event name for the correlation. Validating the trimmed
  // form but sending the raw " approval.received " wouldn't match the event
  // the producer publishes as "approval.received".
  const eventName = filter.event.trim();

  ctx.logger.debug(`WaitForEvent yielding: ${name}`, { stepId, filter });

  // Convert duration to string. Validate numeric inputs — 0, negatives,
  // NaN, and Infinity all serialize to bogus timeout strings that the
  // server will treat as immediate/past deadlines or parse failures.
  let timeout: string;
  if (filter.timeout === undefined || filter.timeout === null) {
    timeout = "7d";
  } else if (typeof filter.timeout === "number") {
    if (!Number.isFinite(filter.timeout) || filter.timeout <= 0) {
      throw new Error(
        `step.waitForEvent(${JSON.stringify(name)}): filter.timeout must be a positive finite value, got ${filter.timeout}`,
      );
    }
    timeout = durationToString(filter.timeout);
  } else if (typeof filter.timeout === "string") {
    if (filter.timeout.trim() === "") {
      throw new Error(
        `step.waitForEvent(${JSON.stringify(name)}): filter.timeout must be a non-empty string`,
      );
    }
    timeout = filter.timeout;
  } else {
    throw new Error(
      `step.waitForEvent(${JSON.stringify(name)}): filter.timeout must be a string or positive number`,
    );
  }

  // Throw yield signal to pause execution
  const yieldInfo: WaitEventYieldInfo = {
    step_id: stepId,
    type: "wait_for_event",
    event_filter: {
      event: eventName,
      match: filter.match,
      timeout,
    },
  };

  throw new YieldSignal(yieldInfo);
}

/**
 * Execute multiple branches in parallel
 */
async function executeParallel<T>(
  ctx: StepContext,
  name: string,
  branches: ((step: StepClient) => Promise<T>)[],
  options: ParallelOptions = {}
): Promise<T[]> {
  const { concurrency, onError = "failFast" } = options;

  ctx.logger.debug(`Starting parallel execution: ${name}`, {
    branchCount: branches.length,
    concurrency,
    onError,
  });

  const results: (T | Error)[] = new Array(branches.length);
  let firstError: Error | null = null;
  let yieldSignal: YieldSignal | null = null;
  const cancelled = { value: false };

  // Pre-create branch contexts and step clients for each branch
  const branchStepClients = branches.map((_, index) => {
    const branchCtx = ctx.createBranchContext(name, index);
    return createStepClientInternal(branchCtx);
  });

  const executeBranch = async (index: number): Promise<void> => {
    if (cancelled.value && onError === "failFast") return;

    try {
      const scopedStep = branchStepClients[index]!;
      const branchFn = branches[index]!;
      const result = await branchFn(scopedStep);
      results[index] = result;
    } catch (error) {
      if (error instanceof YieldSignal) {
        yieldSignal = error;
        cancelled.value = true;
      } else {
        const err = error instanceof Error ? error : new Error(String(error));
        results[index] = err;

        if (onError === "failFast" && !firstError) {
          firstError = err;
          cancelled.value = true;
        }
      }
    }
  };

  // Execute with optional concurrency limit
  if (concurrency && concurrency > 0) {
    const pending: Promise<void>[] = [];

    for (let i = 0; i < branches.length; i++) {
      if (cancelled.value && onError === "failFast") break;

      if (pending.length >= concurrency) {
        await Promise.race(pending);
      }

      const promise = executeBranch(i).finally(() => {
        const idx = pending.indexOf(promise);
        if (idx !== -1) pending.splice(idx, 1);
      });
      pending.push(promise);
    }

    await Promise.all(pending);
  } else {
    await Promise.all(branches.map((_, i) => executeBranch(i)));
  }

  // Handle yield signal
  if (yieldSignal) {
    throw yieldSignal;
  }

  // Handle errors based on mode
  if (onError === "failFast" && firstError) {
    throw firstError;
  }

  if (onError !== "allSettled") {
    const errorIndex = results.findIndex((r) => r instanceof Error);
    if (errorIndex !== -1) {
      throw results[errorIndex];
    }
  }

  ctx.logger.debug(`Parallel execution completed: ${name}`, {
    successCount: results.filter((r) => !(r instanceof Error)).length,
    errorCount: results.filter((r) => r instanceof Error).length,
  });

  return results as T[];
}

/**
 * Map over items with parallel execution
 */
async function executeMap<T, R>(
  ctx: StepContext,
  name: string,
  items: T[],
  fn: (item: T, step: StepClient, index: number) => Promise<R>,
  options: ParallelOptions = {}
): Promise<R[]> {
  ctx.logger.debug(`Starting map execution: ${name}`, {
    itemCount: items.length,
    options,
  });

  const branches = items.map((item, index) => {
    return async (step: StepClient): Promise<R> => {
      return await fn(item, step, index);
    };
  });

  return executeParallel(ctx, name, branches, options);
}

/**
 * Execute registered compensations in reverse order.
 * Each compensation is executed as a durable step (memoized).
 * Compensation failures are recorded but don't stop remaining compensations.
 */
export async function executeCompensations(ctx: ExecutionContext): Promise<void> {
  const compensations = ctx.getCompensationsInReverse();

  for (const { stepName, fn } of compensations) {
    const compStepName = `compensate:${stepName}`;
    const stepId = ctx.generateStepId(compStepName);

    // Check memoization - skip if already completed
    if (ctx.shouldSkipStep(stepId)) {
      ctx.logger.debug(`Compensation memoized: ${compStepName}`, { stepId });
      continue;
    }

    const startedAt = new Date();

    try {
      await fn();
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();

      const result: StepResult = {
        id: stepId,
        name: compStepName,
        type: "compensate",
        status: "completed",
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        compensation_for: stepName,
      };
      ctx.recordStep(result);

      ctx.logger.debug(`Compensation completed: ${compStepName}`, { stepId, durationMs });
    } catch (error) {
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      const result: StepResult = {
        id: stepId,
        name: compStepName,
        type: "compensate",
        status: "failed",
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        compensation_for: stepName,
        error: {
          message: errorMessage,
          retryable: false,
          stack: errorStack,
        },
      };
      ctx.recordStep(result);

      ctx.logger.error(`Compensation failed: ${compStepName}`, {
        stepId,
        error: errorMessage,
        durationMs,
      });
      // Don't throw - continue with remaining compensations
    }
  }
}

/**
 * Execute a durable invoke (calls another function and waits for result)
 */
async function executeInvoke<T>(
  ctx: StepContext,
  functionId: string,
  input?: unknown,
  options?: { timeout?: string }
): Promise<T> {
  const stepId = ctx.generateStepId(functionId);

  // Check memoization — completed
  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`Invoke memoized: ${functionId}`, { stepId });
    return ctx.getMemoizedOutput<T>(stepId)!;
  }

  // Check for failed invoke step — surface as InvokeError
  const failedStepError = ctx.getFailedStep?.(stepId);
  if (failedStepError !== undefined) {
    throw parseInvokeError(functionId, failedStepError);
  }

  // Check for timed out invoke step
  if (ctx.isStepTimedOut?.(stepId)) {
    throw new InvokeError(functionId, undefined, "invoke timed out");
  }

  // Calculate timeout
  let timeoutMs = 30000;
  if (options?.timeout) {
    timeoutMs = parseDuration(options.timeout);
  }

  ctx.logger.debug(`Invoke yielding: ${functionId}`, { stepId, timeoutMs });

  const yieldInfo: InvokeFunctionYieldInfo = {
    step_id: stepId,
    type: "invoke_function",
    function_id: functionId,
    input,
    invoke_timeout_ms: timeoutMs,
  };
  throw new YieldSignal(yieldInfo);
}

/**
 * Execute a fire-and-forget invoke (calls another function without waiting)
 */
async function executeInvokeAsync(
  ctx: StepContext,
  functionId: string,
  input?: unknown
): Promise<{ runId: string }> {
  const stepId = ctx.generateStepId(functionId);

  if (ctx.shouldSkipStep(stepId)) {
    ctx.logger.debug(`InvokeAsync memoized: ${functionId}`, { stepId });
    const output = ctx.getMemoizedOutput<{ run_id: string }>(stepId)!;
    return { runId: output.run_id };
  }

  // Surface a previously failed async invoke step as an error to the caller.
  const failedStepError = ctx.getFailedStep?.(stepId);
  if (failedStepError !== undefined) {
    throw parseInvokeError(functionId, failedStepError);
  }

  ctx.logger.debug(`InvokeAsync yielding: ${functionId}`, { stepId });

  const yieldInfo: InvokeFunctionAsyncYieldInfo = {
    step_id: stepId,
    type: "invoke_function_async",
    function_id: functionId,
    input,
  };
  throw new YieldSignal(yieldInfo);
}

/**
 * Parse engine error data for a failed invoke step into an InvokeError.
 */
function parseInvokeError(functionId: string, errorData: unknown): InvokeError {
  if (typeof errorData === "object" && errorData !== null) {
    const e = errorData as Record<string, unknown>;
    return new InvokeError(
      (e["function_id"] as string) || functionId,
      (e["child_run_id"] as string) || undefined,
      (e["cause"] as string) || (e["message"] as string) || "unknown error"
    );
  }
  return new InvokeError(functionId, undefined, String(errorData));
}

/**
 * Execute a durable publish to a developer pub/sub topic.
 * Wraps step.run() so the publish is memoized and retried like any other step.
 */
async function executePublish(
  ctx: StepContext,
  topic: string,
  data: unknown
): Promise<PublishResult> {
  return executeStep(ctx, `publish:${topic}`, async () => {
    const serverUrl = ctx.serverUrl;
    if (!serverUrl) {
      throw new Error("Server URL not configured for publish step");
    }

    const url = `${serverUrl}/ironflow.v1.PubSubService/Publish`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (ctx.apiKey) {
      headers["Authorization"] = `Bearer ${ctx.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ topic, data: data ?? {} }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Publish failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      eventId: string;
      sequence: string;
    };

    return {
      eventId: result.eventId,
      sequence: parseInt(result.sequence, 10) || 0,
    };
  });
}

/**
 * Convert a duration to a string representation
 */
function durationToString(duration: number): string {
  const ms = duration;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  if (seconds > 0) return `${seconds}s`;
  return `${ms}ms`;
}
