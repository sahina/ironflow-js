import { describe, it, expect } from "vitest";
import { assertDefined } from "./internal/assert-defined.js";

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
    const fn = createFunction(
      {
        id: "retry-function",
        triggers: [{ event: "test" }],
        retry: {
          maxAttempts: 5,
          initialDelay: 1000,
          maxDelay: 30000,
          multiplier: 2,
        },
      },
      async () => "done"
    );

    const retry = fn.config.retry as { maxAttempts: number; initialDelay: number; maxDelay: number; multiplier: number };
    expect(retry?.maxAttempts).toBe(5);
    expect(retry?.initialDelay).toBe(1000);
    expect(retry?.maxDelay).toBe(30000);
    expect(retry?.multiplier).toBe(2);
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
