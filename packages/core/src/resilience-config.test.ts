import { describe, expect, it } from "vitest";
import { IronflowError, RetryAfterError, isRetryable } from "./errors.js";
import { registeredFunctionFromWire } from "./types.js";
import { JobAssignmentSchema, PushRequestSchema } from "./schemas.js";

describe("registeredFunctionFromWire resilience settings", () => {
  it("reads retry.onExhausted, circuitBreaker and throttle", () => {
    const fn = registeredFunctionFromWire({
      id: "fn",
      retry: { maxAttempts: 25, onExhausted: "pause" },
      circuitBreaker: { failureThreshold: 3, openDurationMs: "1000", maxOpenDurationMs: 8000 },
      throttle: { limit: 10, periodMs: 60000, key: "customerId" },
    });
    expect(fn.retry?.onExhausted).toBe("pause");
    expect(fn.circuitBreaker).toEqual({ failureThreshold: 3, openDurationMs: 1000, maxOpenDurationMs: 8000 });
    expect(fn.throttle).toEqual({ limit: 10, periodMs: 60000, key: "customerId" });
  });

  it("leaves them unset when the server sent none", () => {
    const fn = registeredFunctionFromWire({ id: "fn", retry: { maxAttempts: 3 } });
    expect(fn.retry?.onExhausted).toBeUndefined();
    expect(fn.circuitBreaker).toBeUndefined();
    expect(fn.throttle).toBeUndefined();
  });
});

describe("RetryAfterError", () => {
  it("is retryable through isRetryable", () => {
    expect(isRetryable(new RetryAfterError("slow down", 1000))).toBe(true);
    expect(new RetryAfterError("slow down", 1000)).toBeInstanceOf(IronflowError);
  });
});

describe("push and pull wire schemas carry the retry budget", () => {
  const event = { id: "e", name: "n", data: {}, timestamp: "2024-01-01T00:00:00Z" };

  it("PushRequestSchema keeps max_attempts and on_exhausted", () => {
    const parsed = PushRequestSchema.parse({
      run_id: "r", function_id: "f", attempt: 2, max_attempts: 5, on_exhausted: "fail", event,
    });
    expect(parsed.max_attempts).toBe(5);
    expect(parsed.on_exhausted).toBe("fail");
  });

  it("JobAssignmentSchema keeps max_attempts and on_exhausted", () => {
    const parsed = JobAssignmentSchema.parse({
      job_id: "j", run_id: "r", function_id: "f", attempt: 2, max_attempts: 5, on_exhausted: "pause",
      event, completed_steps: [],
    });
    expect(parsed.max_attempts).toBe(5);
    expect(parsed.on_exhausted).toBe("pause");
  });

  it("both accept a request from an engine that predates them", () => {
    expect(PushRequestSchema.parse({ run_id: "r", function_id: "f", attempt: 1, event }).max_attempts).toBeUndefined();
    expect(
      JobAssignmentSchema.parse({ job_id: "j", run_id: "r", function_id: "f", attempt: 1, event, completed_steps: [] })
        .on_exhausted,
    ).toBeUndefined();
  });
});
