import { describe, it, expect, vi } from "vitest";
import { defineEvent, createEventDefinitionRegistry } from "@ironflow/core";
import { createStreamingWorker } from "./worker-streaming.js";

// worker-streaming.test.ts drives a hand-rolled mock class, so it cannot see
// the real ExecutionContext wiring. The streaming worker built its context
// without eventDefinitions and dropped event.version, so handlers received
// un-upcast data (#2414). This drives the real executeJob and reads what the
// handler receives.

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const registry = createEventDefinitionRegistry();
registry.register(defineEvent({ name: "order.placed", version: 1 }));
registry.register(
  defineEvent({
    name: "order.placed",
    version: 2,
    upcast: (d) => ({ total: (d as { amount: number }).amount }),
  })
);

/** Run one job through the real StreamingWorker and return the event the handler saw. */
async function handlerEvent(version: number, data: Record<string, unknown>) {
  let seen: { data: unknown; version?: number } | undefined;
  const fn = {
    config: { id: "fn" },
    handler: async ({ event }: { event: { data: unknown; version?: number } }) => {
      seen = event;
      return {};
    },
  } as unknown as Parameters<typeof createStreamingWorker>[0]["functions"][number];

  const worker = createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    logger: noopLogger,
    eventDefinitions: registry,
  });

  const job = {
    jobId: "job-1",
    runId: "run-1",
    functionId: "fn",
    attempt: 1,
    event: { id: "e1", name: "order.placed", data, version, timestamp: undefined },
    completedSteps: [],
  };

  // Terminal reporting goes out over a stream this test does not open, so
  // failures after the handler ran are irrelevant.
  await (worker as unknown as {
    executeJob(job: unknown, signal: AbortSignal): Promise<void>;
  })
    .executeJob(job, new AbortController().signal)
    .catch(() => {});

  expect(seen).toBeDefined();
  return seen!;
}

describe("streaming worker upcasting (#2414)", () => {
  it("upcasts a v1 event to the latest version before the handler runs", async () => {
    const event = await handlerEvent(1, { amount: 7 });
    expect(event.data).toEqual({ total: 7 });
  });

  it("does not upcast an event already at the latest version", async () => {
    const event = await handlerEvent(2, { total: 7 });
    expect(event.data).toEqual({ total: 7 });
    expect(event.version).toBe(2);
  });
});
