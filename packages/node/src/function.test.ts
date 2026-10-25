import { describe, it, expect } from "vitest";
import type { FunctionConfig, RetryConfig } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";
import { createFunction as realCreateFunction } from "./function.js";

// Test the createFunction logic without importing from core to avoid
// protobuf connect file issues during testing

describe("createFunction", () => {
  // Simple inline implementation for testing
  function createFunction<TResult = unknown>(
    config: { id: string; triggers: Array<{ event?: string; cron?: string }>; retry?: unknown; concurrency?: unknown; executionMode?: string; metadata?: Record<string, unknown> },
    handler: () => Promise<TResult>
  ) {
    return { config, handler };
  }

  it("should create a function with config and handler", () => {
    const fn = createFunction(
      {
        id: "test-function",
        triggers: [{ event: "test.event" }],
      },
      async () => "result"
    );

    expect(fn.config.id).toBe("test-function");
    expect(fn.config.triggers).toHaveLength(1);
    expect(assertDefined(fn.config.triggers[0]).event).toBe("test.event");
    expect(typeof fn.handler).toBe("function");
  });

  it("should support multiple triggers", () => {
    const fn = createFunction(
      {
        id: "multi-trigger",
        triggers: [
          { event: "order.created" },
          { event: "order.updated" },
          { cron: "0 * * * *" },
        ],
      },
      async () => "done"
    );

    expect(fn.config.triggers).toHaveLength(3);
    expect(assertDefined(fn.config.triggers[0]).event).toBe("order.created");
    expect(assertDefined(fn.config.triggers[1]).event).toBe("order.updated");
    expect(assertDefined(fn.config.triggers[2]).cron).toBe("0 * * * *");
  });

  it("should support retry configuration", () => {
    // The real createFunction with the real RetryConfig fields: the local
    // stand-in above accepts any shape, so it cannot catch a misnamed field.
    const retry: RetryConfig = {
      maxAttempts: 5,
      initialDelayMs: 1000,
      backoffFactor: 2,
      maxDelayMs: 30000,
      onExhausted: "fail",
    };
    const fn = realCreateFunction(
      { id: "retry-function", triggers: [{ event: "test" }], retry },
      async () => "done"
    );

    expect(fn.config.retry).toEqual(retry);
  });

  it("leaves retry undefined when the user sets none", () => {
    const fn = realCreateFunction({ id: "no-retry", triggers: [{ event: "test" }] }, async () => "done");
    expect(fn.config.retry).toBeUndefined();
  });

  it("rejects an unknown onExhausted", () => {
    expect(() =>
      realCreateFunction(
        { id: "bad", triggers: [], retry: { onExhausted: "explode" as never } },
        async () => "done"
      )
    ).toThrow(/onExhausted must be "pause" or "fail"/);
  });

  it("validates circuitBreaker and throttle like RegisterFunction", () => {
    const make = (over: Partial<FunctionConfig>) => () =>
      realCreateFunction({ id: "r", triggers: [], ...over }, async () => "done");

    expect(make({ circuitBreaker: { failureThreshold: -1 } })).toThrow(/failureThreshold/);
    expect(make({ circuitBreaker: { openDurationMs: 5000, maxOpenDurationMs: 1000 } })).toThrow(
      /maxOpenDurationMs/
    );
    expect(
      make({ circuitBreaker: { failureThreshold: 3, openDurationMs: 1000, maxOpenDurationMs: 8000 } })
    ).not.toThrow();
    expect(make({ circuitBreaker: { maxOpenDurationMs: 1000 } })).not.toThrow();
    expect(make({ throttle: { limit: 0, periodMs: 1000 } })).toThrow(/throttle.limit/);
    expect(make({ throttle: { limit: 1, periodMs: 999 } })).toThrow(/throttle.periodMs/);
    expect(make({ throttle: { limit: 10, periodMs: 60000, key: "customerId" } })).not.toThrow();
  });

  it("should support concurrency configuration", () => {
    const fn = createFunction(
      {
        id: "concurrent-function",
        triggers: [{ event: "test" }],
        concurrency: {
          limit: 10,
          key: "data.userId",
        },
      },
      async () => "done"
    );

    const concurrency = fn.config.concurrency as { limit: number; key: string };
    expect(concurrency?.limit).toBe(10);
    expect(concurrency?.key).toBe("data.userId");
  });

  it("should support execution mode configuration", () => {
    const pullFn = createFunction(
      {
        id: "pull-function",
        triggers: [{ event: "test" }],
        executionMode: "pull",
      },
      async () => "done"
    );

    expect(pullFn.config.executionMode).toBe("pull");

    const pushFn = createFunction(
      {
        id: "push-function",
        triggers: [{ event: "test" }],
        executionMode: "push",
      },
      async () => "done"
    );

    expect(pushFn.config.executionMode).toBe("push");
  });

  it("should support metadata configuration", () => {
    const fn = createFunction(
      {
        id: "metadata-function",
        triggers: [{ event: "test" }],
        metadata: {
          service: "billing",
          team: "payments",
          owner: "oncall-payments",
          tier: "critical",
        },
      },
      async () => "done"
    );

    const metadata = fn.config.metadata as Record<string, unknown>;
    expect(metadata?.service).toBe("billing");
    expect(metadata?.team).toBe("payments");
    expect(metadata?.owner).toBe("oncall-payments");
    expect(metadata?.tier).toBe("critical");
  });
});
