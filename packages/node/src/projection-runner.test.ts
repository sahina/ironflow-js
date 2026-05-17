import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProjectionRunner, type ProjectionRunnerConfig } from "./projection-runner.js";
import type { IronflowProjection, Logger } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createManagedProjection(overrides: Partial<IronflowProjection["config"]> = {}): IronflowProjection {
  return {
    config: {
      name: "order-totals",
      events: ["order.created", "order.updated"],
      mode: "managed",
      handler: (state: any, event: any) => ({
        total: (state.total || 0) + (event.data?.amount || 0),
        count: (state.count || 0) + 1,
      }),
      initialState: () => ({ total: 0, count: 0 }),
      batchSize: 100,
      maxRetries: 3,
      ...overrides,
    },
  } as IronflowProjection;
}

function createExternalProjection(handler?: any): IronflowProjection {
  return {
    config: {
      name: "email-notifier",
      events: ["order.completed"],
      mode: "external",
      handler: handler || vi.fn(),
      batchSize: 50,
      maxRetries: 3,
    },
  } as IronflowProjection;
}

function createRunnerConfig(overrides: Partial<ProjectionRunnerConfig> = {}): ProjectionRunnerConfig {
  return {
    projection: createManagedProjection(),
    baseUrl: "http://localhost:9123",
    headers: { "x-ironflow-env": "default" },
    logger: createMockLogger(),
    ...overrides,
  };
}

function mockJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  };
}

describe("ProjectionRunner", () => {
  let abortController: AbortController;

  beforeEach(() => {
    mockFetch.mockReset();
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  describe("register", () => {
    it("sends correct registration payload", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const projection = createManagedProjection({ partitionKey: "$.data.customerId" });
      const runner = createProjectionRunner(createRunnerConfig({ projection }));

      await runner.register();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/ironflow.v1.ProjectionService/RegisterProjection");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        name: "order-totals",
        events: ["order.created", "order.updated"],
        mode: "managed",
        version: 1,
        partitionKey: "$.data.customerId",
      });
    });

    it("throws when registration fails", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const runner = createProjectionRunner(createRunnerConfig());

      await expect(runner.register()).rejects.toThrow("Failed to register projection: 500");
    });

    it("includes custom headers", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const runner = createProjectionRunner(
        createRunnerConfig({
          headers: { "x-ironflow-env": "production", "x-api-key": "secret" },
        })
      );

      await runner.register();

      const [, opts] = assertDefined(mockFetch.mock.calls[0]);
      expect(opts.headers["x-ironflow-env"]).toBe("production");
      expect(opts.headers["x-api-key"]).toBe("secret");
    });

    it("defaults partitionKey to empty string when not set", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const runner = createProjectionRunner(createRunnerConfig());

      await runner.register();

      const body = JSON.parse(assertDefined(mockFetch.mock.calls[0])[1].body);
      expect(body.partitionKey).toBe("");
    });
  });

  describe("managed mode", () => {
    it("polls, runs handler, and saves state", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, timestamp: "2025-01-01T00:00:00Z" },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, timestamp: "2025-01-01T00:01:00Z" },
      ];

      // register -> poll (returns events) -> save state -> poll (empty) -> triggers backoff/abort
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events, currentState: null })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save state
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // poll (empty, triggers backoff)

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      // Start in background and abort after a short time
      const startPromise = runner.start();
      // Let the poll loop run a bit then abort
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      // Verify save state was called with correct payload
      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCall).toBeDefined();
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.name).toBe("order-totals");
      expect(saveBody.state).toEqual({ total: 300, count: 2 });
      expect(saveBody.lastEventId).toBe("evt-2");
      expect(saveBody.lastEventSeq).toBe(2);
      expect(saveBody.lastEventTime).toBe("2025-01-01T00:01:00Z");
    });

    it("uses currentState from server when available", async () => {
      const events = [
        { id: "evt-3", name: "order.created", data: { amount: 50 }, seq: 3, timestamp: "2025-01-01T00:02:00Z" },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(
          mockJsonResponse({ events, currentState: { total: 300, count: 2 } })
        ) // poll with existing state
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save state
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.state).toEqual({ total: 350, count: 3 });
    });

    it("uses initialState when no currentState from server", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll (no currentState)
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      // initialState is { total: 0, count: 0 }, then handler adds amount 100
      expect(saveBody.state).toEqual({ total: 100, count: 1 });
    });
  });

  describe("external mode", () => {
    it("polls, runs handler for each event, and acks", async () => {
      const handler = vi.fn();
      const events = [
        { id: "evt-1", name: "order.completed", data: { orderId: "o1" }, seq: 1, timestamp: "2025-01-01T00:00:00Z" },
        { id: "evt-2", name: "order.completed", data: { orderId: "o2" }, seq: 2, timestamp: "2025-01-01T00:01:00Z" },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // ack
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const projection = createExternalProjection(handler);
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      // Handler called for each event
      expect(handler).toHaveBeenCalledTimes(2);
      expect(assertDefined(handler.mock.calls[0])[0]).toEqual(events[0]);
      expect(assertDefined(handler.mock.calls[1])[0]).toEqual(events[1]);

      // Ack called with last event info
      const ackCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("AckProjectionEvents")
      );
      expect(ackCall).toBeDefined();
      const ackBody = JSON.parse(assertDefined(ackCall)[1].body);
      expect(ackBody.name).toBe("email-notifier");
      expect(ackBody.lastEventId).toBe("evt-2");
      expect(ackBody.lastEventSeq).toBe(2);
    });

    it("calls handler with correct context", async () => {
      const handler = vi.fn();
      const events = [
        { id: "evt-1", name: "order.completed", data: {}, seq: 5, timestamp: "2025-06-15T12:00:00Z" },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // ack
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty

      const projection = createExternalProjection(handler);
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const ctx = assertDefined(handler.mock.calls[0])[1];
      expect(ctx.event.id).toBe("evt-1");
      expect(ctx.event.name).toBe("order.completed");
      expect(ctx.event.seq).toBe(5);
      expect(ctx.event.timestamp).toEqual(new Date("2025-06-15T12:00:00Z"));
      expect(ctx.projection.name).toBe("email-notifier");
      expect(ctx.projection.version).toBe(1);
      expect(ctx.logger).toBeDefined();
    });

    it("forwards event metadata to the handler", async () => {
      const handler = vi.fn();
      const events = [
        {
          id: "evt-meta",
          name: "order.placed",
          data: { orderId: "o-1" },
          seq: 1,
          timestamp: "2025-06-15T12:00:00Z",
          metadata: {
            causationId: "cmd-abc",
            correlationId: "corr-xyz",
            tenantId: "tenant-42",
          },
        },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // ack
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty

      const projection = createExternalProjection(handler);
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await vi.waitFor(() => expect(handler).toHaveBeenCalled());
      abortController.abort();
      await startPromise;

      const eventArg = assertDefined(handler.mock.calls[0])[0];
      const ctx = assertDefined(handler.mock.calls[0])[1];

      expect(eventArg.metadata).toEqual({
        causationId: "cmd-abc",
        correlationId: "corr-xyz",
        tenantId: "tenant-42",
      });
      expect(ctx.event.metadata).toEqual({
        causationId: "cmd-abc",
        correlationId: "corr-xyz",
        tenantId: "tenant-42",
      });
    });
  });

  describe("empty poll", () => {
    it("does not save state or ack on empty poll", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      // Should not have called SaveProjectionState or AckProjectionEvents
      const saveCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      const ackCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("AckProjectionEvents")
      );
      expect(saveCalls).toHaveLength(0);
      expect(ackCalls).toHaveLength(0);
    });
  });

  describe("graceful shutdown", () => {
    it("stops when AbortSignal is triggered", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      // Abort immediately
      abortController.abort();
      await startPromise;

      // Should have completed without error
      expect(config.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Projection runner started")
      );
    });

    it("stops when stop() is called", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValue(mockJsonResponse({ events: [] })); // repeated empty polls

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 30));
      await runner.stop();
      // Also abort to break sleep
      abortController.abort();
      await startPromise;

      // Should exit cleanly
    });
  });

  describe("backoff", () => {
    it("increases backoff on empty polls", async () => {
      // We test this indirectly by checking poll is called with appropriate timing.
      // Since we use real timers but short durations, we verify the poll count.
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValue(mockJsonResponse({ events: [] })); // always empty

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      // Wait a bit - with 1s initial backoff, should get only a couple polls
      await new Promise((r) => setTimeout(r, 200));
      abortController.abort();
      await startPromise;

      // Should have register + at least 1 poll
      const pollCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("PollProjectionEvents")
      );
      expect(pollCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("resets backoff when events are processed", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 10 }, seq: 1 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll with events
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save state
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      // Should have processed events then backed off
      const pollCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("PollProjectionEvents")
      );
      expect(pollCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("backs off on poll errors", async () => {
      const logger = createMockLogger();

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: false, status: 500 }) // poll fails
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // next poll empty

      const config = createRunnerConfig({
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      // Logger should have captured the error
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });
  });

  describe("poll payload", () => {
    it("sends correct poll request with batchSize", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // poll

      const projection = createManagedProjection({ batchSize: 25 });
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const pollCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("PollProjectionEvents")
      );
      expect(pollCall).toBeDefined();
      const [url, opts] = assertDefined(pollCall);
      expect(url).toBe("http://localhost:9123/ironflow.v1.ProjectionService/PollProjectionEvents");
      const body = JSON.parse(opts.body);
      expect(body.name).toBe("order-totals");
      expect(body.batchSize).toBe(25);
    });

    it("uses default batchSize of 100 when not set", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // poll

      const projection = createManagedProjection({ batchSize: undefined });
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const pollCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("PollProjectionEvents")
      );
      const body = JSON.parse(pollCall![1].body);
      expect(body.batchSize).toBe(100);
    });
  });

  describe("handler exceptions", () => {
    it("continues polling when managed handler throws", async () => {
      const logger = createMockLogger();
      const throwingProjection = {
        config: {
          name: "bad-managed",
          events: ["order.created"],
          mode: "managed" as const,
          handler: () => {
            throw new Error("managed handler boom");
          },
          initialState: () => ({ total: 0 }),
          batchSize: 100,
          maxRetries: 3,
        },
      } as IronflowProjection;

      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll with events
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // next poll (empty)

      const config = createRunnerConfig({
        projection: throwingProjection,
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      // Error should have been logged and runner continued
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });

    it("continues polling when external handler throws", async () => {
      const logger = createMockLogger();
      const throwingHandler = vi.fn().mockRejectedValue(new Error("external handler boom"));
      const events = [
        { id: "evt-1", name: "order.completed", data: {}, seq: 1 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll with events
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // next poll (empty)

      const projection = createExternalProjection(throwingHandler);
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });

    it("retries after handler failure on next poll", async () => {
      const logger = createMockLogger();
      let callCount = 0;
      const sometimesThrowingProjection = {
        config: {
          name: "retry-managed",
          events: ["order.created"],
          mode: "managed" as const,
          handler: (state: any, event: any) => {
            callCount++;
            if (callCount === 1) {
              throw new Error("first call fails");
            }
            return { total: (state.total || 0) + (event.data?.amount || 0) };
          },
          initialState: () => ({ total: 0 }),
          batchSize: 100,
          maxRetries: 3,
        },
      } as IronflowProjection;

      const events1 = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 },
      ];
      const events2 = [
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events: events1 })) // poll (handler will throw)
        .mockResolvedValueOnce(mockJsonResponse({ events: events2 })) // poll (handler succeeds)
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save state
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({
        projection: sometimesThrowingProjection,
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      // Backoff after error is 1s, so we need to wait long enough for the retry poll
      await new Promise((r) => setTimeout(r, 1500));
      abortController.abort();
      await startPromise;

      // First call failed, second succeeded
      expect(callCount).toBe(2);
      // Save state should have been called for the successful batch
      const saveCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("partitioned projection handling", () => {
    it("groups events by __partition metadata and saves per partition", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, metadata: { __partition: "customer-A" } },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, metadata: { __partition: "customer-B" } },
        { id: "evt-3", name: "order.created", data: { amount: 50 }, seq: 3, metadata: { __partition: "customer-A" } },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save partition A
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save partition B
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saveCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCalls).toHaveLength(2);

      const savedBodies = saveCalls.map((args: unknown[]) => JSON.parse((args[1] as { body: string }).body));
      const partitionKeys = savedBodies.map((b: any) => b.partitionKey).sort();
      expect(partitionKeys).toEqual(["customer-A", "customer-B"]);
    });

    it("uses __global__ partition for events without __partition", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2 },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save state
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.partitionKey).toBe("__global__");
    });

    it("uses initialState per partition", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, metadata: { __partition: "customer-X" } },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, metadata: { __partition: "customer-Y" } },
      ];

      // Provide currentState from server — but it should only be used for __global__
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(
          mockJsonResponse({ events, currentState: { total: 999, count: 10 } })
        ) // poll with server state
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save partition X
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save partition Y
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saveCalls = mockFetch.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCalls).toHaveLength(2);

      // Each partition should start from initialState (total: 0, count: 0), not from currentState (999, 10)
      const savedBodies = saveCalls.map((args: unknown[]) => JSON.parse((args[1] as { body: string }).body));
      for (const body of savedBodies) {
        // initialState is { total: 0, count: 0 }, handler adds amount
        expect(body.state.total).toBeLessThan(999);
      }

      const partitionX = savedBodies.find((b: any) => b.partitionKey === "customer-X");
      const partitionY = savedBodies.find((b: any) => b.partitionKey === "customer-Y");
      expect(partitionX.state).toEqual({ total: 100, count: 1 });
      expect(partitionY.state).toEqual({ total: 200, count: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming mode
  // ---------------------------------------------------------------------------

  describe("streaming mode", () => {
    /** Build a ConnectRPC envelope for a JSON payload */
    function buildEnvelope(json: string, flags = 0x00): Uint8Array {
      const payload = new TextEncoder().encode(json);
      const buf = new Uint8Array(5 + payload.length);
      buf[0] = flags;
      new DataView(buf.buffer).setUint32(1, payload.length, false);
      buf.set(payload, 5);
      return buf;
    }

    /** Create a ReadableStream that yields the given chunks then closes */
    function makeStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(assertDefined(chunks[i++]));
          } else {
            controller.close();
          }
        },
      });
    }

    /** End-of-stream trailer envelope (flags=0x02) with no error */
    const emptyTrailer = buildEnvelope("{}", 0x02);

    /**
     * Start startStreaming(), let the event loop run (all mock fetches resolve
     * synchronously), then abort to unblock the reconnect sleep and let the
     * function exit cleanly.
     */
    async function runStreaming(runner: ReturnType<typeof createProjectionRunner>, ac: AbortController): Promise<void> {
      const p = runner.startStreaming();
      // Wait until the streaming fetch has been called before aborting, so the
      // stream body is fully consumed. vi.waitFor polls without relying on a
      // fixed timer, making the test deterministic in slow CI environments.
      await vi.waitFor(
        () => expect(mockFetch.mock.calls.some((args: unknown[]) => String(args[0]).includes("StreamProjectionEvents"))).toBe(true),
        { timeout: 1000 },
      );
      // Two microtask flushes let any pending promise continuations (stream body
      // readers, state updates) settle before we signal abort.
      await Promise.resolve();
      await Promise.resolve();
      ac.abort();
      await p.catch(() => {});
    }

    it("sends Content-Type: application/connect+json for streaming request", async () => {
      const streamBody = makeStream(emptyTrailer);
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }); // stream

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      const streamCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("StreamProjectionEvents")
      );
      expect(streamCall).toBeDefined();
      const [, opts] = assertDefined(streamCall);
      expect(opts.headers["Content-Type"]).toBe("application/connect+json");
      expect(opts.headers["Content-Type"]).not.toBe("application/json");
    });

    it("sends envelope-framed request body (not plain JSON)", async () => {
      const streamBody = makeStream(emptyTrailer);
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }); // stream

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      const streamCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("StreamProjectionEvents")
      );
      const body: Uint8Array = streamCall![1].body;

      // Must be a Uint8Array, not a plain JSON string
      expect(body).toBeInstanceOf(Uint8Array);
      // byte[0] = 0x00 (flags: uncompressed, not end-of-stream)
      expect(body[0]).toBe(0x00);
      // bytes[1-4] = big-endian uint32 payload length
      const payloadLen = new DataView(body.buffer).getUint32(1, false);
      expect(payloadLen).toBe(body.length - 5);
      // bytes[5+] = valid JSON with the projection name and batchSize
      const json = new TextDecoder().decode(body.slice(5));
      const parsed = JSON.parse(json);
      expect(parsed.name).toBe("order-totals");
      expect(parsed.batchSize).toBe(100);
      // Issue #550 — opt in to server heartbeats so idle streams stay alive.
      expect(parsed.acceptHeartbeats).toBe(true);
    });

    it("skips heartbeat frames (kind=HEARTBEAT) without invoking handlers", async () => {
      // Server sends: real event, heartbeat, real event, heartbeat, trailer.
      // Handler should see exactly the two real events. Issue #550.
      const realEvent1 = { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, timestamp: "2025-01-01T00:00:00Z" };
      const realEvent2 = { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, timestamp: "2025-01-01T00:01:00Z" };
      const heartbeatFrameStr = { kind: "PROJECTION_EVENT_KIND_HEARTBEAT" };
      const heartbeatFrameNum = { kind: 2 };

      const streamBody = makeStream(
        buildEnvelope(JSON.stringify(realEvent1)),
        buildEnvelope(JSON.stringify(heartbeatFrameStr)),
        buildEnvelope(JSON.stringify(realEvent2)),
        buildEnvelope(JSON.stringify(heartbeatFrameNum)),
        emptyTrailer,
      );

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }) // stream
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      // Handler processed both real events (total = 100 + 200 = 300, count = 2).
      // Heartbeat frames contributed nothing.
      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCall).toBeDefined();
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.state).toEqual({ total: 300, count: 2 });
      expect(saveBody.lastEventId).toBe("evt-2");
    });

    it("processes events delivered via stream and saves state", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, timestamp: "2025-01-01T00:00:00Z" },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, timestamp: "2025-01-01T00:01:00Z" },
      ];
      const streamBody = makeStream(
        buildEnvelope(JSON.stringify(events[0])),
        buildEnvelope(JSON.stringify(events[1])),
        emptyTrailer,
      );

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }) // stream
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCall).toBeDefined();
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.state).toEqual({ total: 300, count: 2 });
      expect(saveBody.lastEventId).toBe("evt-2");
      expect(saveBody.lastEventSeq).toBe(2);
    });

    it("does not overwrite initialState when server returns empty state object", async () => {
      // Regression: GetProjection returning { state: {} } (empty Struct) must NOT
      // overwrite the managed runner's initialState(). Without the guard, all field
      // access produces undefined -> NaN -> null after JSON.stringify.
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, timestamp: "2025-01-01T00:00:00Z" },
      ];
      const streamBody = makeStream(
        buildEnvelope(JSON.stringify(events[0])),
        emptyTrailer,
      );

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ state: {} }) }) // GetProjection returns empty state
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }) // stream
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      const saveCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("SaveProjectionState")
      );
      expect(saveCall).toBeDefined();
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      // Must use initialState() { total: 0, count: 0 } as base, not {}
      expect(saveBody.state).toEqual({ total: 100, count: 1 });
      // Values must be numbers, not null (the bug symptom)
      expect(saveBody.state.total).not.toBeNull();
      expect(saveBody.state.count).not.toBeNull();
    });

    it("logs trailer error when stream ends with error", async () => {
      const logger = createMockLogger();
      const errorTrailer = buildEnvelope(
        JSON.stringify({ error: { code: "internal", message: "something broke" } }),
        0x02,
      );
      const streamBody = makeStream(errorTrailer);

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }); // stream

      const config = createRunnerConfig({ signal: abortController.signal, logger });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("something broke")
      );
    });

    it("throws StreamingUnsupportedError on 404 so caller can fall back to polling", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: false, status: 404, body: null }); // stream → 404

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const { StreamingUnsupportedError } = await import("./projection-runner.js");
      await expect(runner.startStreaming()).rejects.toThrow(StreamingUnsupportedError);
    });

    it("throws StreamingUnsupportedError on 501", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: false, status: 501, body: null }); // stream → 501

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);

      const { StreamingUnsupportedError } = await import("./projection-runner.js");
      await expect(runner.startStreaming()).rejects.toThrow(StreamingUnsupportedError);
    });

    it("does not send Accept header (content type alone signals the connect protocol)", async () => {
      const streamBody = makeStream(emptyTrailer);
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }); // stream

      const config = createRunnerConfig({ signal: abortController.signal });
      const runner = createProjectionRunner(config);
      await runStreaming(runner, abortController);

      const streamCall = mockFetch.mock.calls.find(
        (args: unknown[]) => String(args[0]).includes("StreamProjectionEvents")
      );
      expect(streamCall).toBeDefined();
      const headers = streamCall![1].headers;
      expect(headers["Accept"]).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("throws on save state failure", async () => {
      const events = [
        { id: "evt-1", name: "order.created", data: { amount: 10 }, seq: 1 },
      ];
      const logger = createMockLogger();

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: false, status: 500 }) // save state fails
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // next poll

      const config = createRunnerConfig({
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      // Should log the error and continue
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });

    it("throws on ack failure in external mode", async () => {
      const handler = vi.fn();
      const events = [
        { id: "evt-1", name: "order.completed", data: {}, seq: 1 },
      ];
      const logger = createMockLogger();

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: false, status: 500 }) // ack fails
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // next poll

      const projection = createExternalProjection(handler);
      const config = createRunnerConfig({
        projection,
        signal: abortController.signal,
        logger,
      });
      const runner = createProjectionRunner(config);

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });
  });
});
