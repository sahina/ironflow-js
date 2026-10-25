/**
 * Retry and resilience helpers shared by serve, both workers and registration.
 */

import { isIronflowError } from "@ironflow/core";
import type {
  CircuitBreakerConfig,
  FunctionConfig,
  RetryConfig,
  ThrottleConfig,
} from "@ironflow/core";

/**
 * The retry delay a thrown value asks for, in whole milliseconds, or 0 when it
 * asks for none. Only a retryable `RetryAfterError` carries one, and a
 * `step.run` body that throws it reaches the handler wrapped in a `StepError`,
 * so the wrapper's cause counts too.
 */
export function retryAfterMsOf(error: unknown): number {
  if (!isIronflowError(error) || !error.retryable) return 0;
  if (
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number" &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs > 0
  ) {
    return Math.ceil(error.retryAfterMs);
  }
  return error.code === "STEP_FAILED" ? retryAfterMsOf(error.cause) : 0;
}

/**
 * Whether a failure ends the run, so its compensations must run now.
 *
 * A non-retryable error is always terminal. A retryable one is terminal only
 * when the run's policy is "fail" and this was the last attempt. Under "pause"
 * the run is held for resume and must not be compensated. An empty policy or
 * budget (an engine that predates them) keeps the old rule.
 */
export function isTerminalFailure(
  retryable: boolean,
  run: { attempt: number; maxAttempts?: number; onExhausted?: string }
): boolean {
  if (!retryable) return true;
  return (
    run.onExhausted === "fail" &&
    (run.maxAttempts ?? 0) > 0 &&
    run.attempt >= (run.maxAttempts ?? 0)
  );
}

/** The wire's exhaustion policy, or "" for anything this SDK does not know. */
export function onExhaustedOf(wire: string | undefined): "pause" | "fail" | "" {
  return wire === "pause" || wire === "fail" ? wire : "";
}

function nonNegativeInt(owner: string, field: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${owner}: ${field} must be an integer >= 0 (got ${String(value)})`);
  }
}

/**
 * The same path check the server applies to throttle keys (Go validateEventPath):
 * an optional leading `$.`, then no empty path or empty segment.
 */
function eventPathProblem(key: string): string | undefined {
  const path = key.startsWith("$.") ? key.slice(2) : key;
  if (path === "") return "path is empty";
  if (path.startsWith(".") || path.endsWith(".")) return "path must not start or end with '.'";
  if (path.includes("..")) return "path must not contain empty segments ('..')";
  return undefined;
}

/**
 * Reject resilience settings the server would reject, at definition time.
 * Mirrors RegisterFunction's validation.
 */
export function validateResilienceConfig(
  config: Pick<FunctionConfig, "id" | "retry" | "circuitBreaker" | "throttle">
): void {
  const owner = `function ${config.id}`;

  const onExhausted: unknown = config.retry?.onExhausted;
  if (onExhausted !== undefined && onExhausted !== "pause" && onExhausted !== "fail") {
    throw new Error(`${owner}: retry.onExhausted must be "pause" or "fail" (got ${JSON.stringify(onExhausted)})`);
  }

  const cb = config.circuitBreaker;
  if (cb) {
    nonNegativeInt(owner, "circuitBreaker.failureThreshold", cb.failureThreshold);
    nonNegativeInt(owner, "circuitBreaker.openDurationMs", cb.openDurationMs);
    nonNegativeInt(owner, "circuitBreaker.maxOpenDurationMs", cb.maxOpenDurationMs);
    if (
      cb.openDurationMs &&
      cb.maxOpenDurationMs &&
      cb.maxOpenDurationMs < cb.openDurationMs
    ) {
      throw new Error(`${owner}: circuitBreaker.maxOpenDurationMs must be 0 or at least openDurationMs`);
    }
  }

  const th = config.throttle;
  if (th) {
    if (typeof th.limit !== "number" || !Number.isInteger(th.limit) || th.limit < 1) {
      throw new Error(`${owner}: throttle.limit must be an integer >= 1 (got ${String(th.limit)})`);
    }
    if (typeof th.periodMs !== "number" || !Number.isInteger(th.periodMs) || th.periodMs < 1000) {
      throw new Error(`${owner}: throttle.periodMs must be an integer >= 1000 (got ${String(th.periodMs)})`);
    }
    if (th.key !== undefined && th.key !== "") {
      const reason = eventPathProblem(th.key);
      if (reason) throw new Error(`${owner}: throttle.key ${reason}`);
    }
  }
}

/**
 * The RegisterFunction body fields for the retry and resilience settings.
 * Each is present only when the user set it, so the server's defaults apply to
 * everything else.
 */
export function resilienceBody(config: {
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  throttle?: ThrottleConfig;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (config.retry) body.retry = config.retry;
  const cb = config.circuitBreaker;
  if (cb) {
    const wire: Record<string, number> = {};
    if (cb.failureThreshold !== undefined) wire.failureThreshold = cb.failureThreshold;
    if (cb.openDurationMs !== undefined) wire.openDurationMs = cb.openDurationMs;
    if (cb.maxOpenDurationMs !== undefined) wire.maxOpenDurationMs = cb.maxOpenDurationMs;
    if (Object.keys(wire).length > 0) body.circuitBreaker = wire;
  }
  const th = config.throttle;
  if (th) {
    body.throttle = {
      limit: th.limit,
      periodMs: th.periodMs,
      ...(th.key ? { key: th.key } : {}),
    };
  }
  return body;
}
