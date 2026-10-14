import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProjectionRunner, startProjectionRunners, stopProjectionRunners, type ProjectionRunner, type ProjectionRunnerConfig } from "./projection-runner.js";
import { UnauthenticatedError, UnauthorizedError, type IronflowProjection, type Logger } from "@ironflow/core";
import { assertDefined } from "./internal/assert-defined.js";

// Mock fetch globally. These tests predate the lease (ADR 0120): Acquire answers as an older
// server, so the runner runs unguarded. projection-runner-lease.test.ts covers the lease.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", (url: string, opts: RequestInit) =>
  String(url).endsWith("/AcquireProjectionLease")
    ? Promise.resolve(new Response(null, { status: 404 }))
    : mockFetch(url, opts));

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

  describe("managed mode: a {} global state means initialState", () => {
    it("uses initialState when the poll currentState is {}", async () => {
      const events = [{ id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 }];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events, currentState: {} })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty

      const runner = createProjectionRunner(createRunnerConfig({
        signal: abortController.signal,
        projection: createManagedProjection({ initialState: () => ({ total: 1000, count: 0 }) }),
      }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      expect(JSON.parse(assertDefined(saveCall)[1].body).state).toEqual({ total: 1100, count: 1 });
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

    it("gives the handler a numeric seq when the poll sends it as a string (#2821)", async () => {
      const handler = vi.fn();
      // protojson renders the int64 seq as a JSON string.
      const events = [{ id: "evt-1", name: "order.completed", data: {}, seq: "42", timestamp: "2025-06-15T12:00:00Z" }];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // ack
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty

      const runner = createProjectionRunner(
        createRunnerConfig({ projection: createExternalProjection(handler), signal: abortController.signal })
      );
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;

      const [event, ctx] = assertDefined(handler.mock.calls[0]);
      expect(event.seq).toBe(42);
      expect(ctx.event.seq).toBe(42);
      const ackCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("AckProjectionEvents"));
      expect(JSON.parse(assertDefined(ackCall)[1].body).lastEventSeq).toBe(42);
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
      await vi.waitFor(() => expect(config.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Projection runner started")
      ));
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

  describe("intake cancellation (#2770)", () => {
    it("discards a poll response fulfilled just before stop", async () => {
      let finishPoll: ((response: Response) => void) | undefined;
      let pollSignal: AbortSignal | null | undefined;
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("PollProjectionEvents")) {
          pollSignal = opts.signal;
          return new Promise<Response>((resolve) => { finishPoll = resolve; });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const projection = createManagedProjection();
      const handler = vi.spyOn(projection.config, "handler");
      const runner = createProjectionRunner(createRunnerConfig({ projection }));
      const polling = runner.start();
      await vi.waitFor(() => expect(finishPoll).toBeDefined());
      assertDefined(finishPoll)(Response.json({ events: [
        { id: "late", name: "order.created", data: { amount: 100 }, seq: 1 },
      ] }));
      await runner.stop();
      await polling;
      expect(assertDefined(pollSignal).aborted).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not restart polling after a stopped unsupported stream", async () => {
      let finishStream: ((response: Response) => void) | undefined;
      mockFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) {
          return new Promise<Response>((resolve) => { finishStream = resolve; });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const runners = startProjectionRunners({
        projections: [createManagedProjection()],
        baseUrl: "http://localhost:9123", headers: {}, logger: createMockLogger(),
      });
      const runner = assertDefined(runners[0]);
      await vi.waitFor(() => expect(finishStream).toBeDefined());
      assertDefined(finishStream)(new Response(null, { status: 404 }));
      await runner.stop();
      await runner.start();
      await runner.startStreaming();
      expect(mockFetch).toHaveBeenCalledTimes(3);
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
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection partition A (no saved state)
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection partition B (no saved state)
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save A (evt-1)
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save B (evt-2)
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save A (evt-3)
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
      // One save per run of same-partition events, in seq order.
      const savedBodies = saveCalls.map((args: unknown[]) => JSON.parse((args[1] as { body: string }).body));
      expect(savedBodies.map((b: any) => [b.partitionKey, b.lastEventSeq, b.state.total])).toEqual([
        ["customer-A", 1, 100],
        ["customer-B", 2, 200],
        ["customer-A", 3, 150],
      ]);
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

    it("starts a partition with no saved state from initialState", async () => {
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
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection partition X (no saved state)
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection partition Y (no saved state)
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

    it("continues a partition from its saved state, not initialState", async () => {
      const events = [
        { id: "evt-2", name: "order.created", data: { amount: 50 }, seq: 2, metadata: { __partition: "customer-A" } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce(mockJsonResponse({ state: { total: 100, count: 1 } })) // GetProjection customer-A
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const getCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("GetProjection"));
      expect(JSON.parse(assertDefined(getCall)[1].body)).toEqual({ name: "order-totals", partition: "customer-A" });
      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      expect(JSON.parse(assertDefined(saveCall)[1].body).state).toEqual({ total: 150, count: 2 });
    });

    it("starts a partition with a saved {} state from initialState", async () => {
      const events = [
        { id: "evt-2", name: "order.created", data: { amount: 50 }, seq: 2, metadata: { __partition: "customer-A" } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce(mockJsonResponse({ state: {} })) // GetProjection customer-A
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValueOnce(mockJsonResponse({ events: [] })); // empty poll

      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      expect(JSON.parse(assertDefined(saveCall)[1].body).state).toEqual({ total: 50, count: 1 });
    });

    it("does not save a partition whose saved state could not be loaded", async () => {
      const events = [
        { id: "evt-2", name: "order.created", data: { amount: 50 }, seq: 2, metadata: { __partition: "customer-A" } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce(mockJsonResponse({}, false, 503)) // GetProjection fails
        .mockResolvedValue(mockJsonResponse({ events: [] }));

      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saveCalls = mockFetch.mock.calls.filter((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      expect(saveCalls).toHaveLength(0);
    });

    it("stops at the first failed save, so the cursor never passes unsaved events", async () => {
      const events = [
        { id: "evt-3", name: "order.created", data: { amount: 50 }, seq: 3, metadata: { __partition: "customer-A" } },
        { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1, metadata: { __partition: "customer-A" } },
        { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2, metadata: { __partition: "customer-B" } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll (out of order on purpose)
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection customer-A
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection customer-B
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save A (evt-1)
        .mockResolvedValueOnce(mockJsonResponse({}, false, 503)) // save B (evt-2) fails
        .mockResolvedValue(mockJsonResponse({ events: [] }));

      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      const saved = mockFetch.mock.calls
        .filter((args: unknown[]) => String(args[0]).includes("SaveProjectionState"))
        .map((args: unknown[]) => JSON.parse((args[1] as { body: string }).body).lastEventSeq);
      expect(saved).toEqual([1, 2]); // evt-3 is never saved past the failed evt-2
    });

    it("resumes a partition whose saved state is not an object", async () => {
      const events = [
        { id: "evt-2", name: "order.created", data: { amount: 50 }, seq: 2, metadata: { __partition: "customer-A" } },
      ];
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ events })) // poll
        .mockResolvedValueOnce(mockJsonResponse({ stateValue: [1, 2] })) // GetProjection customer-A
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValue(mockJsonResponse({ events: [] }));

      const handler = vi.fn((state: unknown) => state);
      const runner = createProjectionRunner(
        createRunnerConfig({ signal: abortController.signal, projection: createManagedProjection({ handler }) })
      );
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      abortController.abort();
      await startPromise;

      expect(handler.mock.calls[0]?.[0]).toEqual([1, 2]);
      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      const body = JSON.parse(assertDefined(saveCall)[1].body);
      expect(body.stateValue).toEqual([1, 2]);
      expect(body).not.toHaveProperty("state");
    });
  });

  describe("poll path parity", () => {
    async function pollOnce(polled: unknown, projection: IronflowProjection) {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse(polled)) // poll
        .mockResolvedValueOnce({ ok: true, status: 200 }) // save
        .mockResolvedValue(mockJsonResponse({ events: [] }));
      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal, projection }));
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await startPromise;
    }

    it("resumes from a currentStateValue that is not an object", async () => {
      const handler = vi.fn((state: unknown) => (state as number) + 1);
      const projection = createManagedProjection({ handler, initialState: () => 0 });
      const events = [{ id: "evt-1", name: "order.created", data: {}, seq: 1 }];
      await pollOnce({ events, currentStateValue: 5 }, projection);

      expect(handler.mock.calls[0]?.[0]).toBe(5);
      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      // Struct holds objects only: the server rejects a number in `state`.
      const body = JSON.parse(assertDefined(saveCall)[1].body);
      expect(body.stateValue).toEqual(6);
      expect(body).not.toHaveProperty("state");
    });

    it("gives the handler a dataValue payload that is not an object", async () => {
      const handler = vi.fn((state: unknown, _event: unknown) => state);
      const projection = createManagedProjection({ handler, initialState: () => ({}) });
      const events = [{ id: "evt-1", name: "order.created", dataValue: 42, seq: 1, timestamp: "2025-01-01T00:00:00Z" }];
      await pollOnce({ events }, projection);

      const event = handler.mock.calls[0]?.[1] as { data: unknown; id: string; timestamp: string };
      expect(event.data).toBe(42);
      expect(event.id).toBe("evt-1");
      expect(event.timestamp).toBe("2025-01-01T00:00:00Z");
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

    it.each(["pending", "fulfilled"])("stops a %s stream read without processing a late event (#2770)", async (readState) => {
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let streamSignal: AbortSignal | null | undefined;
      const savedStates: unknown[] = [];
      const firstEvent = { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 };
      const lateEvent = { id: "evt-2", name: "order.created", data: { amount: 200 }, seq: 2 };
      const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(buildEnvelope(JSON.stringify(firstEvent)));
        },
      });
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) {
          streamSignal = opts.signal;
          assertDefined(streamSignal).addEventListener("abort", () => {
            assertDefined(streamController).error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
          return new Response(streamBody);
        }
        if (url.endsWith("SaveProjectionState")) {
          if (typeof opts.body !== "string") throw new Error("Expected JSON state");
          savedStates.push(JSON.parse(opts.body));
          return new Response("{}");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const projection = createManagedProjection({ batchSize: 1 });
      const handler = vi.spyOn(projection.config, "handler");
      const runner = createProjectionRunner(createRunnerConfig({ projection }));
      const streaming = runner.startStreaming();
      await vi.waitFor(() => expect(savedStates).toHaveLength(1));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(savedStates).toEqual([expect.objectContaining({ state: { total: 100, count: 1 }, lastEventSeq: 1 })]);

      if (readState === "fulfilled") {
        assertDefined(streamController).enqueue(buildEnvelope(JSON.stringify(lateEvent)));
      }
      await runner.stop();
      const abortedAtStop = assertDefined(streamSignal).aborted;
      if (!abortedAtStop) {
        if (readState === "pending") {
          assertDefined(streamController).enqueue(buildEnvelope(JSON.stringify(lateEvent)));
        }
        assertDefined(streamController).close();
      }
      await streaming;

      expect(savedStates).toEqual([expect.objectContaining({ state: { total: 100, count: 1 }, lastEventSeq: 1 })]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(abortedAtStop).toBe(true);
    });

    it("aborts a stream request still opening before stop resolves (#2770)", async () => {
      let streamSignal: AbortSignal | null | undefined;
      let finishOpening: ((response: Response) => void) | undefined;
      let streamFinished = false;
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) {
          streamSignal = opts.signal;
          return new Promise<Response>((resolve, reject) => {
            finishOpening = resolve;
            assertDefined(streamSignal).addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const runner = createProjectionRunner(createRunnerConfig());
      const streaming = runner.startStreaming().then(() => { streamFinished = true; });
      await vi.waitFor(() => expect(finishOpening).toBeDefined());

      await runner.stop();
      const abortedAtStop = assertDefined(streamSignal).aborted;
      const finishedAtStop = streamFinished;
      assertDefined(finishOpening)(new Response(makeStream(emptyTrailer)));
      await streaming;

      expect(abortedAtStop).toBe(true);
      expect(finishedAtStop).toBe(true);
    });

    it("waits for accepted saves and flushes buffered events in order on stop (#2770)", async () => {
      let finishSave: (() => void) | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const savedStates: unknown[] = [];
      const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          for (const seq of [1, 2]) {
            controller.enqueue(buildEnvelope(JSON.stringify({
              id: `evt-${seq}`, name: "order.created", data: { amount: 100 }, seq,
            })));
          }
        },
      });
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) {
          assertDefined(opts.signal).addEventListener("abort", () => {
            assertDefined(streamController).error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
          return new Response(streamBody);
        }
        if (url.endsWith("SaveProjectionState")) {
          savedStates.push(JSON.parse(String(opts.body)));
          expect(opts.signal).toBeUndefined();
          if (savedStates.length === 1) {
            await new Promise<void>((resolve) => { finishSave = resolve; });
          }
          return new Response("{}");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const runner = createProjectionRunner(createRunnerConfig({
        projection: createManagedProjection({ batchSize: 1 }),
      }));
      const streaming = runner.startStreaming();
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      let stopped = false;
      const stopping = runner.stop().then(() => { stopped = true; });
      const alsoStopping = runner.stop();
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(savedStates).toHaveLength(1);

      assertDefined(finishSave)();
      await Promise.all([stopping, alsoStopping, streaming]);
      expect(savedStates).toEqual([
        expect.objectContaining({ state: { total: 100, count: 1 }, lastEventSeq: 1 }),
        expect.objectContaining({ state: { total: 200, count: 2 }, lastEventSeq: 2 }),
      ]);
    });

    it("resolves stop() called while a failed micro-batch save is unwinding (#2770)", async () => {
      let stopping: Promise<void> | undefined;
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) return new Response("{}");
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(buildEnvelope(JSON.stringify({ id: "evt-1", name: "order.created", data: {}, seq: 1 })));
              assertDefined(opts.signal).addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              }, { once: true });
            },
          });
          return new Response(body);
        }
        if (url.endsWith("SaveProjectionState")) return new Response("boom", { status: 500 });
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const logger = createMockLogger();
      // The failed-flush warning fires after flushFailed is set and before the reconnect clears it.
      vi.mocked(logger.warn).mockImplementation((msg) => {
        if (String(msg).includes("flush failed")) stopping ??= runner.stop();
      });
      const runner = createProjectionRunner(createRunnerConfig({
        projection: createManagedProjection({ batchSize: 1 }),
        logger,
      }));
      const streaming = runner.startStreaming();
      await vi.waitFor(() => expect(stopping).toBeDefined());

      await expect(assertDefined(stopping)).resolves.toBeUndefined();
      await expect(streaming).resolves.toBeUndefined();
    });

    it("chains replacements so a stream opens only after every earlier runner stopped (#2770)", async () => {
      let releaseOldest: (() => void) | undefined;
      const oldest = { stop: () => new Promise<void>((resolve) => { releaseOldest = resolve; }) };
      const registered: string[] = [];
      mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
        if (url.endsWith("RegisterProjection")) {
          registered.push(String(opts.headers && (opts.headers as Record<string, string>)["x-gen"]));
          return new Response("{}");
        }
        if (url.endsWith("GetProjection")) return Response.json({});
        if (url.endsWith("StreamProjectionEvents")) return new Response(makeStream(emptyTrailer));
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const logger = createMockLogger();
      // Reconnect 1: the oldest runner hangs in stop(); its replacement waits on it.
      const stopped1 = stopProjectionRunners([oldest as unknown as ProjectionRunner], logger);
      const middle = createProjectionRunner(createRunnerConfig({ headers: { "x-gen": "middle" }, after: stopped1 }));
      void middle.startStreaming();
      // Reconnect 2, before the middle runner ever registered.
      const stopped2 = stopProjectionRunners([middle], logger, stopped1);
      // Reconnect 3 failed before it created runners, so nothing is left to stop.
      const stopped3 = stopProjectionRunners([], logger, stopped2);
      const newest = createProjectionRunner(createRunnerConfig({ headers: { "x-gen": "newest" }, after: stopped3 }));
      const streaming = newest.startStreaming();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registered).toEqual([]);

      assertDefined(releaseOldest)();
      await vi.waitFor(() => expect(registered).toEqual(["newest"]));
      await newest.stop();
      await streaming;
    });

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

    it("continues a streamed partition from its saved state", async () => {
      const event = { id: "evt-2", name: "order.created", data: { amount: 50 }, seq: 2, metadata: { __partition: "customer-A" } };
      const streamBody = makeStream(buildEnvelope(JSON.stringify(event)), emptyTrailer);

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection __global__
        .mockResolvedValueOnce({ ok: true, status: 200, body: streamBody }) // stream
        .mockResolvedValueOnce(mockJsonResponse({ state: { total: 100, count: 1 } })) // GetProjection customer-A
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
      await runStreaming(runner, abortController);

      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      const saveBody = JSON.parse(assertDefined(saveCall)[1].body);
      expect(saveBody.partitionKey).toBe("customer-A");
      expect(saveBody.state).toEqual({ total: 150, count: 2 });
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

    it("treats 501 as a retried stream failure, not an unsupported stream", async () => {
      vi.useFakeTimers();
      try {
        const attemptedAt: number[] = [];
        mockFetch.mockImplementation(async (url: string) => {
          if (String(url).includes("StreamProjectionEvents")) {
            attemptedAt.push(Date.now());
            return { ok: false, status: 501, body: null };
          }
          return { ok: true, status: 200, json: () => Promise.resolve({}) };
        });
        const ac = new AbortController();
        const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal }));
        const streaming = runner.startStreaming();
        await vi.advanceTimersByTimeAsync(7000);
        ac.abort();
        await expect(streaming).resolves.toBeUndefined();
        expect(attemptedAt.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes from a stateValue that is not an object", async () => {
      const event = { id: "evt-1", name: "order.created", data: {}, seq: 1 };
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({ stateValue: 5 })) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: makeStream(buildEnvelope(JSON.stringify(event)), emptyTrailer) }) // stream
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const handler = vi.fn((state: unknown) => (state as number) + 1);
      const projection = createManagedProjection({ handler, initialState: () => 0 });
      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal, projection }));
      await runStreaming(runner, abortController);

      expect(handler.mock.calls[0]?.[0]).toBe(5);
      const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
      // Struct holds objects only: the server rejects a number in `state`.
      const body = JSON.parse(assertDefined(saveCall)[1].body);
      expect(body.stateValue).toEqual(6);
      expect(body).not.toHaveProperty("state");
    });

    it("retries a failed state load instead of streaming from initialState", async () => {
      vi.useFakeTimers();
      try {
        let gets = 0;
        const event = { id: "evt-1", name: "order.created", data: {}, seq: 1 };
        mockFetch.mockImplementation(async (url: string) => {
          const u = String(url);
          if (u.includes("GetProjection")) {
            return ++gets === 1 ? { ok: false, status: 503 } : mockJsonResponse({ state: { count: 5 } });
          }
          if (u.includes("StreamProjectionEvents")) {
            return { ok: true, status: 200, body: makeStream(buildEnvelope(JSON.stringify(event)), emptyTrailer) };
          }
          return { ok: true, status: 200 };
        });
        const handler = vi.fn((state: unknown) => ({ count: (state as { count: number }).count + 1 }));
        const projection = createManagedProjection({ handler, initialState: () => ({ count: 0 }) });
        const ac = new AbortController();
        const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, projection }));
        const streaming = runner.startStreaming();
        await vi.advanceTimersByTimeAsync(2500);
        ac.abort();
        await streaming;

        expect(gets).toBe(2);
        expect(handler.mock.calls[0]?.[0]).toEqual({ count: 5 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives the handler a dataValue payload that is not an object", async () => {
      const event = { id: "evt-1", name: "order.created", dataValue: "hello", seq: 1 };
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 }) // register
        .mockResolvedValueOnce(mockJsonResponse({})) // GetProjection
        .mockResolvedValueOnce({ ok: true, status: 200, body: makeStream(buildEnvelope(JSON.stringify(event)), emptyTrailer) }) // stream
        .mockResolvedValueOnce({ ok: true, status: 200 }); // SaveProjectionState

      const handler = vi.fn((state: unknown, _event: unknown) => state);
      const projection = createManagedProjection({ handler, initialState: () => ({}) });
      const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal, projection }));
      await runStreaming(runner, abortController);

      expect((handler.mock.calls[0]?.[1] as { data: unknown }).data).toBe("hello");
    });

    describe("reconnect failure count", () => {
      const heartbeat = buildEnvelope(JSON.stringify({ kind: "PROJECTION_EVENT_KIND_HEARTBEAT" }));
      const attempts = (logger: Logger) =>
        (logger.info as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => /attempt (\d+)/.exec(String(c[0]))?.[1])
          .filter(Boolean);

      /** Yields the given frames, then fails like a dropped connection. */
      function makeDroppedStream(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
        let i = 0;
        return new ReadableStream({
          pull(controller) {
            if (i < frames.length) controller.enqueue(assertDefined(frames[i++]));
            else controller.error(new Error("connection reset"));
          },
        });
      }

      /** One entry per stream open: a body to serve, or "fail" for a connection error. */
      function serveStreams(opens: (ReadableStream<Uint8Array> | "fail")[], signalOf?: (s: AbortSignal) => ReadableStream<Uint8Array>) {
        let n = 0;
        mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
          if (!String(url).includes("StreamProjectionEvents")) {
            return { ok: true, status: 200, json: () => Promise.resolve({}) };
          }
          const open = opens[Math.min(n++, opens.length - 1)];
          if (open === "fail") throw new Error("fetch failed");
          return { ok: true, status: 200, body: signalOf ? signalOf(opts.signal as AbortSignal) : open };
        });
      }

      it("keeps counting when a batch always fails, even though heartbeats and events arrive", async () => {
        vi.useFakeTimers();
        try {
          const event = { id: "evt-1", name: "order.created", data: {}, seq: 1 };
          // Holds open after the frames, as a live stream does, until the failed flush aborts it.
          serveStreams([], (signal) =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(heartbeat);
                controller.enqueue(buildEnvelope(JSON.stringify(event)));
                signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
              },
            }));
          const logger = createMockLogger();
          const handler = vi.fn(() => {
            throw new Error("handler boom");
          });
          const ac = new AbortController();
          const projection = createManagedProjection({ handler });
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger, projection }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(10_000); // failures at ~0.1s, 2.2s and 6.3s
          ac.abort();
          await streaming;

          expect(attempts(logger)).toEqual(["1", "2"]);
          expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("3 consecutive failures"));
        } finally {
          vi.useRealTimers();
        }
      });

      it("resets the count when a batch succeeds before the failing one", async () => {
        vi.useFakeTimers();
        try {
          const ok = { id: "evt-1", name: "order.created", data: {}, seq: 1 };
          const bad = { id: "evt-2", name: "order.created", data: {}, seq: 2 };
          serveStreams([], (signal) =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(buildEnvelope(JSON.stringify(ok)));
                controller.enqueue(buildEnvelope(JSON.stringify(bad)));
                signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
              },
            }));
          const logger = createMockLogger();
          const handler = vi.fn((s: unknown, e: unknown) => {
            if ((e as { id: string }).id === "evt-2") throw new Error("handler boom");
            return s;
          });
          const ac = new AbortController();
          // batchSize 1: evt-1 is its own batch, and it succeeds on every open.
          const projection = createManagedProjection({ handler, batchSize: 1 });
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger, projection }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(10_000);
          ac.abort();
          await streaming;

          expect(attempts(logger).length).toBeGreaterThanOrEqual(3);
          expect(new Set(attempts(logger))).toEqual(new Set(["1"]));
          expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("consecutive failures"));
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps counting when a batch fails and the server then ends the stream cleanly", async () => {
        vi.useFakeTimers();
        try {
          const event = { id: "evt-1", name: "order.created", data: {}, seq: 1 };
          // Streams are built on each open: a ReadableStream can be read once.
          let opens = 0;
          mockFetch.mockImplementation(async (url: string) => {
            if (!String(url).includes("StreamProjectionEvents")) {
              return { ok: true, status: 200, json: () => Promise.resolve({}) };
            }
            opens++;
            return { ok: true, status: 200, body: makeStream(buildEnvelope(JSON.stringify(event)), emptyTrailer) };
          });
          const logger = createMockLogger();
          const handler = vi.fn(() => {
            throw new Error("handler boom");
          });
          const ac = new AbortController();
          // batchSize 1 flushes on arrival, so the failure is swallowed before the stream ends.
          const projection = createManagedProjection({ handler, batchSize: 1 });
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger, projection }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(7000); // failures at 0s, 2s and 6s
          ac.abort();
          await streaming;

          expect(opens).toBe(3);
          expect(attempts(logger)).toEqual(["1", "2"]);
          expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("3 consecutive failures"));
        } finally {
          vi.useRealTimers();
        }
      });

      it("restarts the count when a stream that delivered frames drops", async () => {
        vi.useFakeTimers();
        try {
          serveStreams(["fail", "fail", makeDroppedStream(heartbeat), "fail"]);
          const logger = createMockLogger();
          const ac = new AbortController();
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(10_000);
          ac.abort();
          await streaming;

          expect(attempts(logger).slice(0, 4)).toEqual(["1", "2", "1", "2"]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("restarts the count after a stream ends cleanly", async () => {
        vi.useFakeTimers();
        try {
          serveStreams(["fail", "fail", makeStream(emptyTrailer), "fail"]);
          const logger = createMockLogger();
          const ac = new AbortController();
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(7500); // fail at 0s and 2s, clean end at 6s, fail at 7s
          ac.abort();
          await streaming;

          expect(attempts(logger)).toEqual(["1", "2", "1"]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe("end-of-stream trailer error", () => {
      const errorTrailer = (code: string) =>
        buildEnvelope(JSON.stringify({ error: { code, message: `${code} message` } }), 0x02);

      async function startWithTrailer(code: string, ...before: Uint8Array[]) {
        mockFetch
          .mockResolvedValueOnce({ ok: true, status: 200 }) // register
          .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) }) // GetProjection
          .mockResolvedValueOnce({ ok: true, status: 200, body: makeStream(...before, errorTrailer(code)) }); // stream
        const runner = createProjectionRunner(createRunnerConfig({ signal: abortController.signal }));
        return runner.startStreaming();
      }

      it.each(["unimplemented", "not_found"])("throws StreamingUnsupportedError on %s", async (code) => {
        const { StreamingUnsupportedError } = await import("./projection-runner.js");
        await expect(startWithTrailer(code)).rejects.toThrow(StreamingUnsupportedError);
      });

      it("throws UnauthenticatedError on unauthenticated", async () => {
        await expect(startWithTrailer("unauthenticated")).rejects.toThrow(UnauthenticatedError);
      });

      it("throws UnauthorizedError on permission_denied", async () => {
        await expect(startWithTrailer("permission_denied")).rejects.toThrow(UnauthorizedError);
      });

      it("saves events received before the error trailer", async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 200 });
        const event = { id: "evt-1", name: "order.created", data: { amount: 100 }, seq: 1 };
        const p = startWithTrailer("unimplemented", buildEnvelope(JSON.stringify(event)));
        await expect(p).rejects.toThrow();
        const saveCall = mockFetch.mock.calls.find((args: unknown[]) => String(args[0]).includes("SaveProjectionState"));
        expect(saveCall).toBeDefined();
        expect(JSON.parse(assertDefined(saveCall)[1].body).lastEventSeq).toBe(1);
      });

      it("backs off and escalates to logger.error on failed_precondition instead of reconnecting every 1s", async () => {
        vi.useFakeTimers();
        try {
          const attemptedAt: number[] = [];
          mockFetch.mockImplementation(async (url: string) => {
            if (String(url).includes("StreamProjectionEvents")) {
              attemptedAt.push(Date.now());
              return { ok: true, status: 200, body: makeStream(errorTrailer("failed_precondition")) };
            }
            return { ok: true, status: 200, json: () => Promise.resolve({}) };
          });
          const logger = createMockLogger();
          const ac = new AbortController();
          const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger }));
          const streaming = runner.startStreaming();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(60_000);
          ac.abort();
          await streaming;

          const gaps = attemptedAt.slice(1).map((at, i) => at - assertDefined(attemptedAt[i]));
          expect(gaps.slice(0, 4)).toEqual([2000, 4000, 8000, 16000]);
          expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed_precondition message"));
        } finally {
          vi.useRealTimers();
        }
      });
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

    it(
      "reconnects and replays exactly once after a failed flush (#2404)",
      async () => {
        const events = [
          { id: "evt-1", name: "order.created", data: {}, seq: 1, timestamp: "2025-01-01T00:00:00Z" },
          { id: "evt-2", name: "order.created", data: {}, seq: 2, timestamp: "2025-01-01T00:00:01Z" },
          { id: "evt-3", name: "order.created", data: {}, seq: 3, timestamp: "2025-01-01T00:00:02Z" },
        ];

        /** A stream that delivers the three events, then holds the read pending until aborted. */
        function makeHoldOpenStream(signal: AbortSignal): ReadableStream<Uint8Array> {
          return new ReadableStream({
            start(controller) {
              for (const e of events) {
                controller.enqueue(buildEnvelope(JSON.stringify(e)));
              }
              signal.addEventListener(
                "abort",
                () => {
                  try {
                    controller.error(new DOMException("Aborted", "AbortError"));
                  } catch {
                    /* already closed/errored */
                  }
                },
                { once: true }
              );
            },
          });
        }

        let streamCallCount = 0;
        let saveCallCount = 0;
        mockFetch.mockImplementation(async (url: string, opts: any) => {
          const u = String(url);
          if (u.includes("RegisterProjection")) {
            return { ok: true, status: 200 };
          }
          if (u.includes("GetProjection")) {
            return { ok: true, status: 200, json: () => Promise.resolve({}) };
          }
          if (u.includes("StreamProjectionEvents")) {
            streamCallCount++;
            if (streamCallCount === 1) {
              return { ok: true, status: 200, body: makeHoldOpenStream(opts.signal) };
            }
            return {
              ok: true,
              status: 200,
              body: makeStream(
                buildEnvelope(JSON.stringify(events[0])),
                buildEnvelope(JSON.stringify(events[1])),
                buildEnvelope(JSON.stringify(events[2])),
                emptyTrailer,
              ),
            };
          }
          if (u.includes("SaveProjectionState")) {
            saveCallCount++;
            if (saveCallCount === 1) {
              return { ok: false, status: 500, text: () => Promise.resolve("boom") };
            }
            return { ok: true, status: 200 };
          }
          throw new Error(`unexpected fetch: ${u}`);
        });

        const ac = new AbortController();
        const projection = createManagedProjection({
          batchSize: 3,
          handler: (s: any) => ({ count: (s.count ?? 0) + 1 }),
          initialState: () => ({}),
        });
        const config = createRunnerConfig({ signal: ac.signal, projection });
        const runner = createProjectionRunner(config);

        const p = runner.startStreaming();
        await vi.waitFor(() => expect(saveCallCount).toBeGreaterThanOrEqual(2), { timeout: 5000 });
        ac.abort();
        await p.catch(() => {});

        // Reconnected: the stream endpoint was fetched twice.
        expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("StreamProjectionEvents")).length).toBe(2);
        // The successful save carries count 3 (not 6): failed-batch state was discarded.
        const saves = mockFetch.mock.calls.filter((c) => String(c[0]).includes("SaveProjectionState"));
        const lastBody = JSON.parse(assertDefined(saves[saves.length - 1])[1].body);
        expect(lastBody.state).toEqual({ count: 3 });
        expect(lastBody.lastEventSeq).toBe(3);
      },
      8000
    );
  });

  // Reconnect CADENCE, which every other streaming test above is blind to by construction: they
  // abort specifically to unblock the reconnect sleep, so its duration is never observed. A flat
  // delay here is what let one workspace log 93,046 consecutive stream errors — two days of a 2s
  // cadence against an engine that was simply down.
  describe("reconnect backoff", () => {
    it("doubles the reconnect delay and caps it, instead of retrying flat forever", async () => {
      vi.useFakeTimers();
      try {
        // Every attempt at the stream fails, as it would against an engine that is not running.
        // Register and GetProjection succeed so the loop is reached at all.
        const attemptedAt: number[] = [];
        mockFetch.mockImplementation(async (url: string) => {
          if (String(url).includes("StreamProjectionEvents")) {
            attemptedAt.push(Date.now());
            throw new Error("fetch failed");
          }
          return { ok: true, status: 200, json: () => Promise.resolve({}) };
        });

        const ac = new AbortController();
        const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal }));
        const streaming = runner.startStreaming();
        // Let register, GetProjection and the first attempt run, then walk the clock far enough
        // for the ladder to reach its ceiling and stay there.
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(120_000);
        ac.abort();
        await streaming.catch(() => {});

        const gaps = attemptedAt.slice(1).map((at, i) => at - assertDefined(attemptedAt[i]));
        // Literals, not a re-derivation of the code's formula: 2s base, doubling, ceiling 30s.
        expect(gaps.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
        // 120s of a flat 2s cadence would be 60 attempts; the ladder makes it a handful.
        expect(attemptedAt.length).toBeLessThan(10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("register retry", () => {
    const runs = {
      polling: (runner: ProjectionRunner) => runner.start(),
      streaming: (runner: ProjectionRunner) => runner.startStreaming(),
    };
    const nextRpc = { polling: "PollProjectionEvents", streaming: "StreamProjectionEvents" } as const;

    it.each(["polling", "streaming"] as const)("retries a failed register with backoff while %s", async (mode) => {
      vi.useFakeTimers();
      try {
        let registers = 0;
        mockFetch.mockImplementation(async (url: string) => {
          const u = String(url);
          if (u.includes("RegisterProjection")) {
            registers++;
            return registers === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
          }
          if (u.includes("StreamProjectionEvents")) return { ok: false, status: 404, body: null };
          return mockJsonResponse({ events: [] });
        });
        const logger = createMockLogger();
        const ac = new AbortController();
        const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger }));
        const run = runs[mode](runner).catch(() => {});
        await vi.advanceTimersByTimeAsync(1900);
        expect(registers).toBe(1); // still waiting out the 2s backoff
        await vi.advanceTimersByTimeAsync(200);

        expect(registers).toBe(2);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("register failed"));
        expect(mockFetch.mock.calls.some((c) => String(c[0]).includes(nextRpc[mode]))).toBe(true);
        ac.abort();
        await run;
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["polling", "streaming"] as const)("stops on an invalid_argument register while %s", async (mode) => {
      // A config error does not fix itself: stop at Error instead of retrying forever.
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ code: "invalid_argument", message: "events is required" }), { status: 400 })
      );
      const logger = createMockLogger();
      const runner = createProjectionRunner(createRunnerConfig({ logger }));

      await runs[mode](runner);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("register failed, stopping"));
    });

    it("escalates register failures to error from the 3rd", async () => {
      vi.useFakeTimers();
      try {
        let registers = 0;
        mockFetch.mockImplementation(async (url: string) => {
          const u = String(url);
          if (u.includes("RegisterProjection")) {
            registers++;
            return registers <= 4 ? { ok: false, status: 503 } : { ok: true, status: 200 };
          }
          if (u.includes("StreamProjectionEvents")) return { ok: false, status: 404, body: null };
          return mockJsonResponse({ events: [] });
        });
        const logger = createMockLogger();
        const ac = new AbortController();
        const runner = createProjectionRunner(createRunnerConfig({ signal: ac.signal, logger }));
        const run = runner.run().catch(() => {});
        await vi.advanceTimersByTimeAsync(60_000);
        expect(registers).toBe(5);
        const register = (fn: Logger["warn"]) =>
          vi.mocked(fn).mock.calls.filter((c) => c[0].includes("register failed")).length;
        expect(register(logger.warn)).toBe(2);
        expect(register(logger.error)).toBe(2);
        ac.abort();
        await run;
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["polling", "streaming"] as const)("stops on a 401 register while %s, without a retry", async (mode) => {
      mockFetch.mockResolvedValue(mockJsonResponse({}, false, 401));
      const logger = createMockLogger();
      const runner = createProjectionRunner(createRunnerConfig({ logger }));

      await expect(runs[mode](runner)).rejects.toThrow(UnauthenticatedError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
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
  describe("auth failure (#1673)", () => {
    it("stops the poll loop with an actionable message instead of 401-looping", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}, false, 401));
      const logger = createMockLogger();
      const runner = createProjectionRunner(createRunnerConfig({ logger }));

      await expect(runner.start()).rejects.toThrow(/IRONFLOW_API_KEY/);
      // register() 401s on the first call — no poll retry cadence behind it.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Projection poll error")
      );
    });
  });
});
