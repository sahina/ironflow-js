import { describe, it, expect, vi, afterEach } from "vitest";
import { assertDefined } from "./internal/assert-defined.js";

// Mock @ironflow/core before importing client
vi.mock("@ironflow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ironflow/core")>();
  return {
    API_ENDPOINTS: {
      TRIGGER: "/ironflow.v1.IronflowService/Trigger",
      GET_RUN: "/ironflow.v1.IronflowService/GetRun",
      LIST_RUNS: "/ironflow.v1.IronflowService/ListRuns",
      CANCEL_RUN: "/ironflow.v1.IronflowService/CancelRun",
      RETRY_RUN: "/ironflow.v1.IronflowService/RetryRun",
      REGISTER_FUNCTION: "/ironflow.v1.IronflowService/RegisterFunction",
      HEALTH: "/ironflow.v1.IronflowService/Health",
    },
    DEFAULT_SERVER_URL: "http://localhost:9123",
    getServerUrl: () => undefined,
    IronflowError: actual.IronflowError,
    RunFailedError: actual.RunFailedError,
    RunCancelledError: actual.RunCancelledError,
    UnauthenticatedError: actual.UnauthenticatedError,
    EnterpriseRequiredError: actual.EnterpriseRequiredError,
    UnauthorizedError: actual.UnauthorizedError,
    peelProjectionEnvelope: actual.peelProjectionEnvelope,
  };
});

// Import after mocking
const { createClient } = await import("./client.js");

describe("IronflowClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("constructor", () => {
    it("should use default server URL when not provided", () => {
      const client = createClient();
      expect(client).toBeDefined();
    });

    it("should use provided server URL", () => {
      const client = createClient({
        serverUrl: "http://custom:9999",
      });
      expect(client).toBeDefined();
    });
  });

  describe("registerFunction", () => {
    it("should make POST request to RegisterFunction endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ created: true }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.registerFunction({
        id: "test-function",
        name: "Test Function",
        triggers: [{ event: "test.event" }],
        endpointUrl: "http://localhost:3000/api/ironflow",
        preferredMode: "push",
      });

      expect(result.created).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/RegisterFunction",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("should throw error on failed request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"code": "invalid_argument"}'),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(
        client.registerFunction({
          id: "test-function",
        })
      ).rejects.toThrow();
    });
  });

  describe("emit", () => {
    it("should make POST request to Trigger endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            runIds: ["run_123"],
            eventId: "evt_456",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.emit("test.event", { foo: "bar" });

      expect(result.runIds).toEqual(["run_123"]);
      expect(result.eventId).toBe("evt_456");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/Trigger",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should send version when provided in options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            runIds: ["run-1"],
            eventId: "evt-1",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      await client.emit("order.placed", { orderId: "123" }, { version: 2 });

      const call = assertDefined(mockFetch.mock.calls[mockFetch.mock.calls.length - 1]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.version).toBe(2);
    });
  });

  describe("getRun", () => {
    it("should make POST request to GetRun endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "completed",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.getRun("run_123");

      expect(result.id).toBe("run_123");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/ironflow.v1.IronflowService/GetRun"),
        expect.any(Object)
      );
    });
  });

  describe("listRuns", () => {
    it("should make POST request to ListRuns endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            runs: [{ id: "run_1" }, { id: "run_2" }],
            totalCount: 2,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.listRuns({ limit: 10 });

      expect(result.runs).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });
  });

  describe("cancelRun", () => {
    it("should make POST request to CancelRun endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "cancelled",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.cancelRun("run_123", "User requested");

      expect(result.status).toBe("cancelled");
    });
  });

  describe("retryRun", () => {
    it("sends retry request with runId", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "running",
            functionId: "my-func",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.retryRun("run_123");

      expect(result.id).toBe("run_123");
      expect(result.status).toBe("running");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/RetryRun",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.id).toBe("run_123");
      expect(body.fromStep).toBeUndefined();
    });

    it("sends fromStep when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "running",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.retryRun("run_123", "step-3");

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.id).toBe("run_123");
      expect(body.fromStep).toBe("step-3");
    });

    it("throws on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("run not found"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.retryRun("run_123")).rejects.toThrow("run not found");
    });
  });

  describe("health", () => {
    it("should return health status", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.health();

      expect(result).toBe("healthy");
    });
  });

  describe("publish", () => {
    it("should make POST request to PubSubService/Publish", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_abc123",
            sequence: "42",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.publish("notifications", {
        userId: "123",
        message: "Hello!",
      });

      expect(result.eventId).toBe("msg_abc123");
      expect(result.sequence).toBe(42);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.PubSubService/Publish",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.topic).toBe("notifications");
      expect(body.data).toEqual({ userId: "123", message: "Hello!" });
    });

    it("should pass idempotency key when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_def456",
            sequence: "1",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.publish(
        "orders",
        { orderId: "o-1" },
        { idempotencyKey: "idem-key-123" }
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.idempotencyKey).toBe("idem-key-123");
    });

    it("should default data to empty object when null", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_001",
            sequence: "0",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.publish("ping", null);

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.data).toEqual({});
    });

    it("should parse sequence as integer", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            eventId: "msg_002",
            sequence: "100",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.publish("test", { x: 1 });

      expect(result.sequence).toBe(100);
      expect(typeof result.sequence).toBe("number");
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("internal error"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(
        client.publish("test", { x: 1 })
      ).rejects.toThrow("internal error");
    });
  });

  describe("listTopics", () => {
    it("should return array of TopicInfo", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            topics: [
              {
                name: "notifications",
                messageCount: 42,
                consumerCount: 3,
                firstMessageAt: "2026-01-01T00:00:00Z",
                lastMessageAt: "2026-02-01T00:00:00Z",
              },
              {
                name: "orders",
                messageCount: 100,
                consumerCount: 1,
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const topics = await client.listTopics();

      expect(topics).toHaveLength(2);
      const t0 = assertDefined(topics[0], "topics[0]");
      const t1 = assertDefined(topics[1], "topics[1]");
      expect(t0.name).toBe("notifications");
      expect(t0.messageCount).toBe(42);
      expect(t0.consumerCount).toBe(3);
      expect(t0.firstMessageAt).toBe("2026-01-01T00:00:00Z");
      expect(t0.lastMessageAt).toBe("2026-02-01T00:00:00Z");
      expect(t1.name).toBe("orders");
      expect(t1.firstMessageAt).toBeUndefined();
      expect(t1.lastMessageAt).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.PubSubService/ListTopics",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should return empty array when topics is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const topics = await client.listTopics();

      expect(topics).toEqual([]);
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("service unavailable"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.listTopics()).rejects.toThrow("service unavailable");
    });
  });

  describe("getTopicStats", () => {
    it("should return TopicStats for a topic", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "notifications",
            messageCount: 42,
            consumerCount: 3,
            lag: 5,
            firstSeq: 1,
            lastSeq: 42,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const stats = await client.getTopicStats("notifications");

      expect(stats.name).toBe("notifications");
      expect(stats.messageCount).toBe(42);
      expect(stats.consumerCount).toBe(3);
      expect(stats.lag).toBe(5);
      expect(stats.firstSeq).toBe(1);
      expect(stats.lastSeq).toBe(42);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.PubSubService/GetTopicStats",
        expect.objectContaining({
          method: "POST",
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.topic).toBe("notifications");
    });

    it("should default missing fields to zero", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "empty-topic",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const stats = await client.getTopicStats("empty-topic");

      expect(stats.messageCount).toBe(0);
      expect(stats.consumerCount).toBe(0);
      expect(stats.lag).toBe(0);
      expect(stats.firstSeq).toBe(0);
      expect(stats.lastSeq).toBe(0);
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("topic not found"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(
        client.getTopicStats("unknown")
      ).rejects.toThrow("topic not found");
    });
  });

  describe("patchStep", () => {
    it("should make POST request to /api/v1/steps/patch", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      await client.patchStep("step_123", { result: "fixed" }, "manual fix");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/steps/patch",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            step_id: "step_123",
            output: { result: "fixed" },
            reason: "manual fix",
          }),
        })
      );
    });

    it("should set Authorization header when apiKey is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "test-key",
      });

      await client.patchStep("step_123", { result: "fixed" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/steps/patch",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
        })
      );
    });

    it("should default reason to empty string when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.patchStep("step_123", { result: "fixed" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            step_id: "step_123",
            output: { result: "fixed" },
            reason: "",
          }),
        })
      );
    });

    it("should throw error on failed request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("step not found"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(
        client.patchStep("step_123", { result: "fixed" })
      ).rejects.toThrow("step not found");
    });
  });

  describe("resumeRun", () => {
    it("should make POST request to /api/v1/runs/resume", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "running",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.resumeRun("run_123", "step_2");

      expect(result.id).toBe("run_123");
      expect(result.status).toBe("running");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/runs/resume",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: "run_123",
            from_step: "step_2",
          }),
        })
      );
    });

    it("should set Authorization header when apiKey is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "run_123", status: "running" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "my-secret",
      });

      await client.resumeRun("run_123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/runs/resume",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer my-secret",
          },
        })
      );
    });

    it("should default from_step to empty string when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "run_123", status: "running" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.resumeRun("run_123");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            run_id: "run_123",
            from_step: "",
          }),
        })
      );
    });

    it("should throw error on failed request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("internal server error"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.resumeRun("run_123")).rejects.toThrow(
        "internal server error"
      );
    });
  });

  describe("listFunctions", () => {
    it("should make GET request to /api/v1/functions", async () => {
      const mockFunctions = [
        { id: "fn_1", name: "Function 1" },
        { id: "fn_2", name: "Function 2" },
      ];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ functions: mockFunctions }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.listFunctions();

      expect(result).toEqual(mockFunctions);
      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/functions",
        expect.objectContaining({
          method: "GET",
        })
      );
    });

    it("should set Authorization header when apiKey is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ functions: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "fn-key",
      });

      await client.listFunctions();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/functions",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer fn-key",
          },
        })
      );
    });

    it("should return empty array when functions is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      const result = await client.listFunctions();

      expect(result).toEqual([]);
    });

    it("should throw error on failed request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.listFunctions()).rejects.toThrow(
        "List functions failed: 503"
      );
    });
  });

  describe("listWorkers", () => {
    it("should make GET request to /api/v1/workers", async () => {
      const mockWorkers = [
        { id: "worker_1", functionId: "fn_1" },
        { id: "worker_2", functionId: "fn_2" },
      ];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ workers: mockWorkers }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.listWorkers();

      expect(result).toEqual(mockWorkers);
      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/workers",
        expect.objectContaining({
          method: "GET",
        })
      );
    });

    it("should set Authorization header when apiKey is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ workers: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "worker-key",
      });

      await client.listWorkers();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/workers",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer worker-key",
          },
        })
      );
    });

    it("should return empty array when workers is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      const result = await client.listWorkers();

      expect(result).toEqual([]);
    });

    it("should throw error on failed request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.listWorkers()).rejects.toThrow(
        "List workers failed: 500"
      );
    });
  });

  describe("streams", () => {
    describe("append", () => {
      it("should make POST request to AppendEvent endpoint", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              entityVersion: "3",
              eventId: "evt_abc123",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({
          serverUrl: "http://localhost:9123",
        });

        const result = await client.streams.append(
          "order-123",
          {
            name: "order.created",
            data: { total: 100 },
            entityType: "order",
          },
          { expectedVersion: 2 }
        );

        expect(result.entityVersion).toBe(3);
        expect(result.eventId).toBe("evt_abc123");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/ironflow.v1.EntityStreamService/AppendEvent",
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
          })
        );

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.entity_id).toBe("order-123");
        expect(body.entity_type).toBe("order");
        expect(body.event_name).toBe("order.created");
        expect(body.data).toEqual({ total: 100 });
        expect(body.expected_version).toBe(2);
      });

      it("should use default options when not provided", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              entity_version: 1,
              event_id: "evt_def456",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        await client.streams.append("user-456", {
          name: "user.registered",
          data: { email: "test@example.com" },
          entityType: "user",
        });

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.expected_version).toBe(-1);
        expect(body.idempotency_key).toBe("");
        expect(body.version).toBe(1);
      });

      it("should throw on 409 Conflict with version conflict message", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () =>
            Promise.resolve(
              JSON.stringify({ message: "version conflict" })
            ),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        await expect(
          client.streams.append("order-123", {
            name: "order.created",
            data: {},
            entityType: "order",
          })
        ).rejects.toThrow("version conflict");
      });

      it("should include raw error body when response is not JSON", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          text: () => Promise.resolve("Conflict: entity version mismatch"),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        await expect(
          client.streams.append("order-456", {
            name: "order.updated",
            data: {},
            entityType: "order",
          })
        ).rejects.toThrow("Conflict: entity version mismatch");
      });

      it("should include metadata in request body when provided", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ entity_version: 1, event_id: "evt_meta_001" }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();
        await client.streams.append(
          "order-123",
          {
            name: "order.placed",
            data: { total: 50 },
            entityType: "order",
          },
          {
            expectedVersion: 0,
            metadata: {
              causationId: "cmd-abc",
              correlationId: "corr-xyz",
              tenantId: "tenant-42",
            },
          }
        );

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.metadata).toEqual({
          causationId: "cmd-abc",
          correlationId: "corr-xyz",
          tenantId: "tenant-42",
        });
      });

      it("should omit metadata from body when not provided", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ entity_version: 1, event_id: "evt_no_meta" }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();
        await client.streams.append("order-999", {
          name: "order.placed",
          data: {},
          entityType: "order",
        });

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body).not.toHaveProperty("metadata");
      });
    });

    describe("read", () => {
      it("should make POST request to ReadStream endpoint", async () => {
        const mockEvents = [
          {
            id: "evt_1",
            name: "order.created",
            data: { total: 100 },
            entityVersion: "1",
            version: 1,
            timestamp: "2026-01-01T00:00:00Z",
            source: "api",
          },
          {
            id: "evt_2",
            name: "order.updated",
            data: { total: 200 },
            entityVersion: "2",
            version: 1,
            timestamp: "2026-01-02T00:00:00Z",
          },
        ];
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              events: mockEvents,
              totalCount: 2,
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({
          serverUrl: "http://localhost:9123",
        });

        const result = await client.streams.read("order-123", { limit: 10 });

        expect(result.events).toHaveLength(2);
        expect(result.totalCount).toBe(2);
        const e0 = assertDefined(result.events[0], "events[0]");
        const e1 = assertDefined(result.events[1], "events[1]");
        expect(e0.id).toBe("evt_1");
        expect(e0.name).toBe("order.created");
        expect(e0.data).toEqual({ total: 100 });
        expect(e0.entityVersion).toBe(1);
        expect(e0.source).toBe("api");
        expect(e1.source).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/ironflow.v1.EntityStreamService/ReadStream",
          expect.objectContaining({
            method: "POST",
          })
        );

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.entity_id).toBe("order-123");
        expect(body.limit).toBe(10);
      });

      it("should use default options when not provided", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [],
              totalCount: 0,
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        const result = await client.streams.read("order-123");

        expect(result.events).toEqual([]);
        expect(result.totalCount).toBe(0);

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.from_version).toBe(0);
        expect(body.limit).toBe(0);
        expect(body.direction).toBe("forward");
      });

      it("should handle missing events array in response", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        const result = await client.streams.read("order-123");

        expect(result.events).toEqual([]);
        expect(result.totalCount).toBe(0);
      });
    });

    describe("getInfo", () => {
      it("should make POST request to GetStreamInfo endpoint", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              entityId: "order-123",
              entityType: "order",
              version: "5",
              eventCount: "5",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-05T00:00:00Z",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({
          serverUrl: "http://localhost:9123",
        });

        const result = assertDefined(
          await client.streams.getInfo("order-123"),
          "streams.getInfo result"
        );

        expect(result.entityId).toBe("order-123");
        expect(result.entityType).toBe("order");
        expect(result.version).toBe(5);
        expect(result.eventCount).toBe(5);
        expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
        expect(result.updatedAt).toBe("2026-01-05T00:00:00Z");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/ironflow.v1.EntityStreamService/GetStreamInfo",
          expect.objectContaining({
            method: "POST",
          })
        );

        const call = assertDefined(mockFetch.mock.calls[0]);
        const body = JSON.parse(call[1]?.body as string);
        expect(body.entity_id).toBe("order-123");
      });

      it("returns null when stream does not exist (404 stream not found)", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "stream not found" })),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });

        const result = await client.streams.getInfo("never-written");

        expect(result).toBeNull();
      });

      it("rethrows on non-404 errors", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "internal server error" })),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });

        await expect(client.streams.getInfo("order-123")).rejects.toThrow(
          "internal server error"
        );
      });

      it("rethrows 404s with unrelated messages", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          text: () =>
            Promise.resolve(JSON.stringify({ message: "route not found" })),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });

        await expect(client.streams.getInfo("order-123")).rejects.toThrow(
          "route not found"
        );
      });
    });
  });

  describe("pauseRun", () => {
    it("should make POST request to PauseRun endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "paused" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.pauseRun("run_abc123");

      expect(result.status).toBe("paused");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/PauseRun",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_abc123");
    });

    it("should return pause_requested status", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "pause_requested" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.pauseRun("run_xyz");

      expect(result.status).toBe("pause_requested");
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"code": "invalid_argument"}'),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.pauseRun("run_abc123")).rejects.toThrow();
    });
  });

  describe("getPausedState", () => {
    it("should return paused state with multiple steps mapped to camelCase", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            steps: [
              {
                id: "step_1",
                name: "fetch-data",
                output: '{"url":"https://example.com","result":42}',
                injected: false,
                completedAt: "2026-03-01T10:00:00Z",
              },
              {
                id: "step_2",
                name: "transform",
                output: '{"transformed":true}',
                injected: true,
                completedAt: "2026-03-01T10:01:00Z",
              },
            ],
            nextStepHint: "validate",
            pauseReason: "manual_pause",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.getPausedState("run_abc123");

      expect(result.steps).toHaveLength(2);
      const s0 = assertDefined(result.steps[0], "steps[0]");
      const s1 = assertDefined(result.steps[1], "steps[1]");
      expect(s0.id).toBe("step_1");
      expect(s0.name).toBe("fetch-data");
      expect(s0.output).toEqual({
        url: "https://example.com",
        result: 42,
      });
      expect(s0.injected).toBe(false);
      expect(s0.completedAt).toBe("2026-03-01T10:00:00Z");
      expect(s1.id).toBe("step_2");
      expect(s1.injected).toBe(true);
      expect(result.nextStepHint).toBe("validate");
      expect(result.pauseReason).toBe("manual_pause");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/GetPausedState",
        expect.objectContaining({
          method: "POST",
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_abc123");
    });

    it("should handle step with null output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            steps: [
              {
                id: "step_1",
                name: "fetch-data",
                output: "",
                injected: false,
                completedAt: "2026-03-01T10:00:00Z",
              },
            ],
            nextStepHint: "process",
            pauseReason: "",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.getPausedState("run_abc123");

      expect(assertDefined(result.steps[0]).output).toBeNull();
    });

    it("should handle empty steps array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            steps: [],
            nextStepHint: "first-step",
            pauseReason: "pause_on_start",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.getPausedState("run_abc123");

      expect(result.steps).toEqual([]);
      expect(result.nextStepHint).toBe("first-step");
      expect(result.pauseReason).toBe("pause_on_start");
    });

    it("should handle missing steps in response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            nextStepHint: "step-a",
            pauseReason: "",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.getPausedState("run_abc123");

      expect(result.steps).toEqual([]);
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("run not found"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.getPausedState("run_abc123")).rejects.toThrow(
        "run not found"
      );
    });
  });

  describe("injectStepOutput", () => {
    it("should make POST request to InjectStepOutput endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            stepId: "step_xyz",
            previousOutput: '{"old":"value"}',
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
      });

      const result = await client.injectStepOutput(
        "run_abc123",
        "step_xyz",
        { corrected: true },
        "Manual correction"
      );

      expect(result.stepId).toBe("step_xyz");
      expect(result.previousOutput).toEqual({ old: "value" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/InjectStepOutput",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_abc123");
      expect(body.step_id).toBe("step_xyz");
      expect(body.new_output).toBe('{"corrected":true}');
      expect(body.reason).toBe("Manual correction");
    });

    it("should default reason to empty string when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            stepId: "step_1",
            previousOutput: '{"x":1}',
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.injectStepOutput("run_abc123", "step_1", { y: 2 });

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.reason).toBe("");
    });

    it("should handle null previous_output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            stepId: "step_1",
            previousOutput: "",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      const result = await client.injectStepOutput("run_abc123", "step_1", {
        new: "data",
      });

      expect(result.previousOutput).toBeNull();
    });

    it("should stringify newOutput in the request body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            step_id: "step_1",
            previous_output: "null",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const complexOutput = { nested: { items: [1, 2, 3], flag: true } };

      await client.injectStepOutput("run_abc123", "step_1", complexOutput);

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.new_output).toBe(JSON.stringify(complexOutput));
    });

    it("should throw on server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("step not found in run"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(
        client.injectStepOutput("run_abc123", "step_xyz", { x: 1 })
      ).rejects.toThrow("step not found in run");
    });
  });

  describe("createClient", () => {
    it("should create a new client instance", () => {
      const client = createClient({ serverUrl: "http://test:9123" });
      expect(client).toBeDefined();
    });
  });

  describe("emitSync", () => {
    it("should return EmitSyncResult when run completes successfully", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                runId: "run_abc123",
                functionId: "my-function",
                status: "completed",
                output: { total: 99.99 },
                durationMs: 42,
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.emitSync("order.placed", { orderId: "123" });

      expect(result.runId).toBe("run_abc123");
      expect(result.functionId).toBe("my-function");
      expect(result.status).toBe("completed");
      expect(result.output).toEqual({ total: 99.99 });
      expect(result.durationMs).toBe(42);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/TriggerSync",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.event).toBe("order.placed");
      expect(body.data).toEqual({ orderId: "123" });
      expect(body.timeout_ms).toBe(30000);
    });

    it("should pass custom timeout in request body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                runId: "run_abc",
                functionId: "fn",
                status: "completed",
                output: null,
                durationMs: 10,
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emitSync("ping", {}, { timeout: 60000 });

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.timeout_ms).toBe(60000);
    });

    it("should throw RunFailedError when run status is failed", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                runId: "run_fail",
                functionId: "my-function",
                status: "failed",
                output: null,
                error: { message: "something broke", code: "STEP_FAILED" },
                durationMs: 5,
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      const err = await client.emitSync("order.placed", {}).catch((e) => e);
      expect(err.constructor.name).toBe("RunFailedError");
      expect(err.runId).toBe("run_fail");
      expect(err.code).toBe("RUN_FAILED");
    });

    it("should throw RunCancelledError when run status is cancelled", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [
              {
                runId: "run_cancel",
                functionId: "my-function",
                status: "cancelled",
                output: null,
                durationMs: 0,
              },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      const err = await client.emitSync("order.placed", {}).catch((e) => e);
      expect(err.constructor.name).toBe("RunCancelledError");
      expect(err.runId).toBe("run_cancel");
      expect(err.code).toBe("RUN_CANCELLED");
    });

    it("should throw IronflowError when server returns empty results", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.emitSync("test.event", {})).rejects.toThrow(
        "No results returned from TriggerSync"
      );
    });

    it("should throw on HTTP error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("internal server error"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.emitSync("test.event", {})).rejects.toThrow(
        "internal server error"
      );
    });
  });

  describe("projections", () => {
    describe("get", () => {
      // Wire shape mirrors `internal/server/server.go:2531` ProjectionResponse:
      // embedded ProjectionRegistry (envelope-level fields) + nested `state`
      // ProjectionState row carrying user state under `.state.state`.
      it("peels wire envelope and returns flat ProjectionStateResult", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-summary",
              version: 10,
              mode: "managed",
              last_event_seq: 42,
              updated_at: "2026-01-01T00:00:00Z",
              state: {
                projection_name: "order-summary",
                environment_id: "env_default",
                partition_key: "__global__",
                state: { totalOrders: 42 },
                last_event_id: "evt-42",
                last_event_seq: 42,
                last_event_time: "2026-01-01T00:00:00Z",
                version: 10,
                updated_at: "2026-01-01T00:00:00Z",
              },
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.get<{ totalOrders: number }>(
          "order-summary"
        );

        expect(result.name).toBe("order-summary");
        expect(result.partition).toBe("__global__");
        expect(result.state).toEqual({ totalOrders: 42 });
        expect(result.lastEventId).toBe("evt-42");
        expect(result.lastEventSeq).toBe(42);
        expect(result.lastEventTime).toEqual(new Date("2026-01-01T00:00:00Z"));
        expect(result.version).toBe(10);
        expect(result.mode).toBe("managed");
        expect(result.updatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/api/v1/projections/order-summary",
          expect.objectContaining({ method: "GET" })
        );
      });

      it("returns empty state when server omits inner state row", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "fresh",
              version: 1,
              mode: "managed",
              last_event_seq: 0,
              updated_at: "2026-01-01T00:00:00Z",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.get("fresh");

        expect(result.state).toEqual({});
        expect(result.partition).toBe("__global__");
        expect(result.lastEventTime).toBeUndefined();
        expect(result.lastEventSeq).toBe(0);
      });

      it("threads partition option through query string and echoes it back when no state row", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "by-customer",
              version: 1,
              mode: "managed",
              last_event_seq: 0,
              updated_at: "2026-01-01T00:00:00Z",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.get("by-customer", {
          partition: "customer-99",
        });

        expect(result.partition).toBe("customer-99");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/api/v1/projections/by-customer?partition=customer-99",
          expect.objectContaining({ method: "GET" })
        );
      });

      it("throws PROJECTION_ENVELOPE_DRIFT when inner state.state field is missing", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "drifted",
              version: 1,
              mode: "managed",
              last_event_seq: 0,
              updated_at: "2026-01-01T00:00:00Z",
              state: {
                projection_name: "drifted",
                partition_key: "__global__",
                last_event_id: "evt-1",
              },
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        await expect(client.projections.get("drifted")).rejects.toThrow(
          /projection envelope drift/
        );
      });

      it("should throw on server error", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: "projection not found" }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();

        await expect(
          client.projections.get("missing-projection")
        ).rejects.toThrow("projection not found");
      });
    });

    describe("list", () => {
      it("should return array of projection statuses", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                name: "order-summary",
                status: "active",
                eventCount: 100,
                lastEventAt: "2026-01-01T00:00:00Z",
                errorCount: 0,
                lastError: "",
                consumerName: "proj-order-summary",
              },
              {
                name: "user-stats",
                status: "paused",
                eventCount: 50,
                lastEventAt: "2026-02-01T00:00:00Z",
                errorCount: 2,
                lastError: "timeout",
                consumerName: "proj-user-stats",
              },
            ]),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.list();

        expect(result).toHaveLength(2);
        expect(assertDefined(result[0]).name).toBe("order-summary");
        expect(assertDefined(result[0]).status).toBe("active");
        expect(assertDefined(result[1]).name).toBe("user-stats");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/api/v1/projections",
          expect.objectContaining({ method: "GET" })
        );
      });

      it("should return empty array when no projections exist", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve([]),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient();
        const result = await client.projections.list();

        expect(result).toEqual([]);
      });
    });

    describe("getStatus", () => {
      it("should return operational status for a projection", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-summary",
              status: "active",
              mode: "managed",
              lastEventSeq: 250,
              lag: 0,
              updatedAt: "2026-03-01T00:00:00Z",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.getStatus("order-summary");

        expect(result.name).toBe("order-summary");
        expect(result.status).toBe("active");
        expect(result.lastEventSeq).toBe(250);
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/api/v1/projections/order-summary/status",
          expect.objectContaining({ method: "GET" })
        );
      });
    });

    describe("rebuild", () => {
      it("should trigger a rebuild and return job status", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              name: "order-summary",
              status: "running",
              progress: 0,
              startedAt: "2026-03-01T12:00:00Z",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({ serverUrl: "http://localhost:9123" });
        const result = await client.projections.rebuild("order-summary");

        expect(result.name).toBe("order-summary");
        expect(result.status).toBe("running");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:9123/api/v1/projections/order-summary/rebuild",
          expect.objectContaining({ method: "POST" })
        );
      });
    });
  });

  describe("getRunStateAt", () => {
    it("should POST to TimeTravelService/GetRunStateAt with ISO timestamp", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            runId: "run_123",
            status: "running",
            steps: [{ id: "step_1", name: "charge", status: "completed", output: { charged: true } }],
            timestamp: "2026-01-15T10:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const ts = new Date("2026-01-15T10:00:00Z");
      const result = await client.getRunStateAt("run_123", ts);

      expect(result.runId).toBe("run_123");
      expect(result.status).toBe("running");
      expect(result.steps).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.TimeTravelService/GetRunStateAt",
        expect.objectContaining({ method: "POST" })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_123");
      expect(body.timestamp).toBe("2026-01-15T10:00:00.000Z");
    });
  });

  describe("getRunTimeline", () => {
    it("should POST to TimeTravelService/GetRunTimeline and return events array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [
              { id: "evt_1", eventType: "step.started", stepId: "step_1", stepName: "charge", summary: "Step started", significant: true, timestamp: "2026-01-01T00:00:00Z" },
              { id: "evt_2", eventType: "step.completed", stepId: "step_1", stepName: "charge", summary: "Step completed", significant: true, timestamp: "2026-01-01T00:00:01Z" },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.getRunTimeline("run_123");

      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.TimeTravelService/GetRunTimeline",
        expect.objectContaining({ method: "POST" })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_123");
    });

    it("should return empty array when events is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.getRunTimeline("run_123");

      expect(result).toEqual([]);
    });
  });

  describe("getStepOutputAt", () => {
    it("should POST to TimeTravelService/GetStepOutputAt", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            stepId: "step_1",
            output: { charged: true, amount: 99.99 },
            timestamp: "2026-01-15T10:00:01Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const ts = new Date("2026-01-15T10:00:01Z");
      const result = await client.getStepOutputAt("run_123", "step_1", ts);

      expect(result.stepId).toBe("step_1");
      expect(result.output).toEqual({ charged: true, amount: 99.99 });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.TimeTravelService/GetStepOutputAt",
        expect.objectContaining({ method: "POST" })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_123");
      expect(body.step_id).toBe("step_1");
      expect(body.timestamp).toBe("2026-01-15T10:00:01.000Z");
    });
  });

  describe("getAuditTrail", () => {
    it("should POST to AuditService/GetAuditTrail and return entries", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            entries: [
              { id: "audit_1", type: "run.started", timestamp: "2026-01-01T00:00:00Z", data: { runId: "run_123" } },
              { id: "audit_2", type: "step.completed", timestamp: "2026-01-01T00:00:05Z", data: { stepId: "step_1" } },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.getAuditTrail("run_123");

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).id).toBe("audit_1");
      expect(assertDefined(result[0]).type).toBe("run.started");
      expect(assertDefined(result[1]).type).toBe("step.completed");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.AuditService/GetAuditTrail",
        expect.objectContaining({ method: "POST" })
      );

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.run_id).toBe("run_123");
    });
  });

  // ============================================================================
  // secrets sub-client
  // ============================================================================

  describe("secrets.get", () => {
    it("should GET /api/v1/secrets/:name and return secret", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "stripe-key",
            value: "sk_live_abc",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.secrets.get("stripe-key");

      expect(result.name).toBe("stripe-key");
      expect(result.value).toBe("sk_live_abc");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/secrets/stripe-key",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "secret not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.secrets.get("missing")).rejects.toThrow("secret not found");
    });
  });

  describe("secrets.set", () => {
    it("should POST /api/v1/secrets and return created secret", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "db-password",
            value: "s3cr3t",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.secrets.set("db-password", "s3cr3t");

      expect(result.name).toBe("db-password");
      expect(result.value).toBe("s3cr3t");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/secrets",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.name).toBe("db-password");
      expect(body.value).toBe("s3cr3t");
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.secrets.set("x", "y")).rejects.toThrow("internal server error");
    });
  });

  describe("secrets.update", () => {
    it("should PUT /api/v1/secrets/:name and return updated secret", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            name: "stripe-key",
            value: "sk_live_new",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-02-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.secrets.update("stripe-key", "sk_live_new");

      expect(result.value).toBe("sk_live_new");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/secrets/stripe-key",
        expect.objectContaining({ method: "PUT" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.value).toBe("sk_live_new");
    });
  });

  describe("secrets.list", () => {
    it("should GET /api/v1/secrets and return list entries", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: "stripe-key", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
            { name: "db-password", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
          ]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.secrets.list();

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).name).toBe("stripe-key");
      expect(assertDefined(result[1]).name).toBe("db-password");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/secrets",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when server returns empty array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.secrets.list();
      expect(result).toEqual([]);
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.secrets.list()).rejects.toThrow("server error");
    });
  });

  describe("secrets.delete", () => {
    it("should DELETE /api/v1/secrets/:name", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.secrets.delete("stripe-key");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/secrets/stripe-key",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "secret not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.secrets.delete("missing")).rejects.toThrow("secret not found");
    });
  });

  // ============================================================================
  // streams.listStreams + streams.getEntityHistory
  // ============================================================================

  describe("streams.listStreams", () => {
    it("should GET /api/v1/streams and return list", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            streams: [
              { entityId: "order-1", entityType: "order", version: 3, eventCount: 3, lastEventAt: "2026-01-01T00:00:00Z" },
              { entityId: "order-2", entityType: "order", version: 1, eventCount: 1, lastEventAt: "2026-01-02T00:00:00Z" },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.streams.listStreams();

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).entityId).toBe("order-1");
      expect(assertDefined(result[0]).entityType).toBe("order");
      expect(assertDefined(result[0]).version).toBe(3);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/streams",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when streams is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.streams.listStreams();
      expect(result).toEqual([]);
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.streams.listStreams()).rejects.toThrow("server error");
    });
  });

  describe("streams.getEntityHistory", () => {
    it("should GET /api/v1/streams/:entityId/history and return events", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            events: [
              { eventName: "order.created", data: { total: 100 }, version: 1, timestamp: "2026-01-01T00:00:00Z" },
              { eventName: "order.shipped", data: { carrier: "ups" }, version: 2, timestamp: "2026-01-02T00:00:00Z" },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.streams.getEntityHistory("order-123");

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).eventName).toBe("order.created");
      expect(assertDefined(result[0]).version).toBe(1);
      expect(assertDefined(result[1]).eventName).toBe("order.shipped");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/streams/order-123/history",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when events is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.streams.getEntityHistory("order-999");
      expect(result).toEqual([]);
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "entity not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.streams.getEntityHistory("missing")).rejects.toThrow("entity not found");
    });
  });

  // ============================================================================
  // projects sub-client
  // ============================================================================

  describe("projects.list", () => {
    it("should GET /api/v1/projects and return projects array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "proj_1", name: "my-service", description: "", org_id: "org_default", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          ]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.projects.list();

      expect(result).toHaveLength(1);
      expect(assertDefined(result[0]).id).toBe("proj_1");
      expect(assertDefined(result[0]).name).toBe("my-service");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/projects",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when server returns empty array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.projects.list();
      expect(result).toEqual([]);
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.projects.list()).rejects.toThrow("server error");
    });
  });

  describe("projects.create", () => {
    it("should POST /api/v1/projects and return new project", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "proj_new",
            name: "new-service",
            description: "A new service",
            org_id: "org_default",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.projects.create({ name: "new-service", description: "A new service" });

      expect(result.id).toBe("proj_new");
      expect(result.name).toBe("new-service");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/projects",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.name).toBe("new-service");
      expect(body.description).toBe("A new service");
    });
  });

  describe("projects.update", () => {
    it("should PUT /api/v1/projects/:id and return updated project", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "proj_1",
            name: "renamed-service",
            description: "",
            org_id: "org_default",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.projects.update("proj_1", { name: "renamed-service" });

      expect(result.name).toBe("renamed-service");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/projects/proj_1",
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  describe("projects.delete", () => {
    it("should DELETE /api/v1/projects/:id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.projects.delete("proj_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/projects/proj_1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "project not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.projects.delete("missing")).rejects.toThrow("project not found");
    });
  });

  // ============================================================================
  // environments sub-client
  // ============================================================================

  describe("environments.list", () => {
    it("should GET /api/v1/environments and return environments array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "env_1", name: "production", project_id: "proj_1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
            { id: "env_2", name: "staging", project_id: "proj_1", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
          ]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.environments.list();

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).id).toBe("env_1");
      expect(assertDefined(result[0]).name).toBe("production");
      expect(assertDefined(result[1]).name).toBe("staging");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/environments",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when server returns empty array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.environments.list();
      expect(result).toEqual([]);
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.environments.list()).rejects.toThrow("server error");
    });
  });

  describe("environments.create", () => {
    it("should POST /api/v1/environments and return new environment", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "env_new",
            name: "staging",
            project_id: "proj_1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.environments.create({ name: "staging", project_id: "proj_1" });

      expect(result.id).toBe("env_new");
      expect(result.name).toBe("staging");
      expect(result.project_id).toBe("proj_1");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/environments",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.name).toBe("staging");
      expect(body.project_id).toBe("proj_1");
    });
  });

  describe("environments.update", () => {
    it("should PUT /api/v1/environments/:id and return updated environment", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "env_1",
            name: "staging-v2",
            project_id: "proj_1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.environments.update("env_1", { name: "staging-v2" });

      expect(result.name).toBe("staging-v2");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/environments/env_1",
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  describe("environments.delete", () => {
    it("should DELETE /api/v1/environments/:id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.environments.delete("env_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/environments/env_1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "environment not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.environments.delete("missing")).rejects.toThrow("environment not found");
    });
  });

  describe("schemas.register", () => {
    it("should POST /api/v1/events/schemas and return created schema", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            event_name: "order.placed",
            version: 1,
            schema_json: JSON.stringify({ type: "object" }),
            created_at: "2026-03-28T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.schemas.register({
        name: "order.placed",
        version: 1,
        schema: { type: "object" },
      });

      expect(result.event_name).toBe("order.placed");
      expect(result.version).toBe(1);
      expect(result.created_at).toBe("2026-03-28T00:00:00Z");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/schemas",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.event_name).toBe("order.placed");
      expect(body.version).toBe(1);
      expect(body.schema_json).toBe(JSON.stringify({ type: "object" }));
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(
        client.schemas.register({ name: "x", version: 1, schema: {} })
      ).rejects.toThrow("internal server error");
    });
  });

  describe("schemas.list", () => {
    it("should GET /api/v1/events/schemas and return array", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            schemas: [
              { event_name: "order.placed", version: 1, schema_json: "{}", created_at: "2026-03-28T00:00:00Z" },
              { event_name: "order.placed", version: 2, schema_json: "{}", created_at: "2026-03-29T00:00:00Z" },
            ],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.schemas.list();

      expect(result).toHaveLength(2);
      expect(assertDefined(result[0]).event_name).toBe("order.placed");
      expect(assertDefined(result[1]).version).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/schemas",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should return empty array when schemas is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.schemas.list();
      expect(result).toEqual([]);
    });
  });

  describe("schemas.get", () => {
    it("should GET /api/v1/events/schemas/:name and return schema", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            event_name: "order.placed",
            version: 2,
            schema_json: JSON.stringify({ type: "object" }),
            created_at: "2026-03-28T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.schemas.get("order.placed");

      expect(result.event_name).toBe("order.placed");
      expect(result.version).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/schemas/order.placed",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "schema not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.schemas.get("nonexistent")).rejects.toThrow("schema not found");
    });
  });

  describe("schemas.getVersion", () => {
    it("should GET /api/v1/events/schemas/:name/:version and return schema", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            event_name: "order.placed",
            version: 1,
            schema_json: JSON.stringify({ type: "object" }),
            created_at: "2026-03-28T00:00:00Z",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.schemas.getVersion("order.placed", 1);

      expect(result.version).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/schemas/order.placed/1",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("schemas.delete", () => {
    it("should DELETE /api/v1/events/schemas/:name/:version", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.schemas.delete("order.placed", 1);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/schemas/order.placed/1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("should throw on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "schema not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.schemas.delete("nonexistent", 1)).rejects.toThrow("schema not found");
    });
  });

  describe("schemas.testUpcast", () => {
    it("should POST /api/v1/events/upcast and return result", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { orderId: "123", totalV2: 99.99 },
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.schemas.testUpcast({
        eventName: "order.placed",
        fromVersion: 1,
        toVersion: 2,
        data: { orderId: "123", total: 99.99 },
      });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/events/upcast",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.eventName).toBe("order.placed");
      expect(body.fromVersion).toBe(1);
      expect(body.toVersion).toBe(2);
    });

    it("should return failure result with error message", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: false,
            error: "no upcaster registered for version 1 → 3",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.schemas.testUpcast({
        eventName: "order.placed",
        fromVersion: 1,
        toVersion: 3,
        data: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no upcaster");
    });

    it("should throw on 500", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal server error" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(
        client.schemas.testUpcast({ eventName: "x", fromVersion: 1, toVersion: 2, data: {} })
      ).rejects.toThrow("internal server error");
    });
  });

  describe("webhooks", () => {
    it("should list webhook sources via ConnectRPC", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sources: [
            {
              id: "stripe",
              eventPrefix: "stripe.",
              sourceType: "api",
              createdAt: "2026-03-28T00:00:00Z",
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const sources = await client.webhooks.listSources();

      expect(sources).toHaveLength(1);
      expect(assertDefined(sources[0]).id).toBe("stripe");
      expect(assertDefined(sources[0]).eventPrefix).toBe("stripe.");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/ListWebhookSources",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should delete a webhook source", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.webhooks.deleteSource("stripe");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/DeleteWebhookSource",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ id: "stripe" }),
        })
      );
    });

    it("should list webhook deliveries with filters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          deliveries: [
            {
              id: "del-1",
              sourceId: "stripe",
              status: "delivered",
              eventId: "evt-123",
            },
          ],
          totalCount: 1,
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.webhooks.listDeliveries({ sourceId: "stripe", limit: 10 });

      expect(result.deliveries).toHaveLength(1);
      expect(assertDefined(result.deliveries[0]).id).toBe("del-1");
      expect(assertDefined(result.deliveries[0]).sourceId).toBe("stripe");
      expect(result.totalCount).toBe(1);
    });

    it("should return empty deliveries array on empty response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ deliveries: null, totalCount: 0 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.webhooks.listDeliveries();

      expect(result.deliveries).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("should throw on error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ message: "internal error" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.webhooks.listSources()).rejects.toThrow();
    });
  });

  describe("users", () => {
    it("should create a user", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "user-1",
          org_id: "org_default",
          email: "alice@example.com",
          name: "Alice",
          roles: ["admin"],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const user = await client.users.create({
        email: "alice@example.com",
        password: "secret",
        roles: ["admin"],
      });

      expect(user.id).toBe("user-1");
      expect(user.email).toBe("alice@example.com");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should list users", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { id: "user-1", email: "alice@example.com" },
          { id: "user-2", email: "bob@example.com" },
        ]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const users = await client.users.list();

      expect(users).toHaveLength(2);
      expect(assertDefined(users[0]).email).toBe("alice@example.com");
    });

    it("should get a user by id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "user-1", email: "alice@example.com" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const user = await client.users.get("user-1");

      expect(user.id).toBe("user-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users/user-1",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should update a user", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "user-1", email: "alice@example.com", name: "Alice Smith" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const user = await client.users.update("user-1", { name: "Alice Smith" });

      expect(user.name).toBe("Alice Smith");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users/user-1",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    it("should delete a user", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.users.delete("user-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/users/user-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("tenants", () => {
    it("should list tenants", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { id: "org_acme", name: "Acme Corp", env_count: 2, key_count: 3, created_at: "2026-01-01" },
        ]),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const tenants = await client.tenants.list();

      expect(tenants).toHaveLength(1);
      expect(assertDefined(tenants[0]).id).toBe("org_acme");
      expect(assertDefined(tenants[0]).name).toBe("Acme Corp");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/api/v1/tenants",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should throw EnterpriseRequiredError on 402", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        json: () => Promise.resolve({ error: "enterprise license required" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      await expect(client.tenants.list()).rejects.toThrow();
    });
  });

  describe("getAuditTrail", () => {
    it("should call AuditService/GetAuditTrail with run_id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          entries: [
            {
              id: "ae-1",
              run_id: "run-123",
              function_id: "fn-1",
              event_type: "step.completed",
              created_at: "2026-03-28T00:00:00Z",
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const entries = await client.getAuditTrail("run-123");

      expect(entries).toHaveLength(1);
      expect(assertDefined(entries[0]).id).toBe("ae-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.AuditService/GetAuditTrail",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("run-123"),
        })
      );
    });

    it("should return empty array when entries is undefined", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const entries = await client.getAuditTrail("run-123");

      expect(entries).toEqual([]);
    });
  });
});
