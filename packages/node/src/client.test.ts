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
      RESUME_RUN: "/ironflow.v1.IronflowService/ResumeRun",
      REGISTER_FUNCTION: "/ironflow.v1.IronflowService/RegisterFunction",
      HEALTH: "/ironflow.v1.IronflowService/Health",
      TRIGGER_SYNC: "/ironflow.v1.IronflowService/TriggerSync",
      INVOKE_FUNCTION_SYNC: "/ironflow.v1.IronflowService/InvokeFunctionSync",
    },
    DEFAULT_SERVER_URL: "http://localhost:9123",
    DEFAULT_TIMEOUTS: actual.DEFAULT_TIMEOUTS,
    InvokeFunctionSyncResponseSchema: actual.InvokeFunctionSyncResponseSchema,
    validate: actual.validate,
    getServerUrl: () => undefined,
    IronflowError: actual.IronflowError,
    connectHTTPError: actual.connectHTTPError,
    AUTH_HELP: actual.AUTH_HELP,
    waitResultFromWire: actual.waitResultFromWire,
    runStatusFromWire: actual.runStatusFromWire,
    runStatusToWire: actual.runStatusToWire,
    RunWaitTimeoutError: actual.RunWaitTimeoutError,
    RunFailedError: actual.RunFailedError,
    RunCancelledError: actual.RunCancelledError,
    UnauthenticatedError: actual.UnauthenticatedError,
    EnterpriseRequiredError: actual.EnterpriseRequiredError,
    UnauthorizedError: actual.UnauthorizedError,
    ConflictError: actual.ConflictError,
    ContendedError: actual.ContendedError,
    ValidationError: actual.ValidationError,
    TriggerSyncResponseSchema: actual.TriggerSyncResponseSchema,
    projectionStateFromWire: actual.projectionStateFromWire,
    rebuildJobFromWire: actual.rebuildJobFromWire,
    // Pure wire mappers — pass them through rather than stubbing, since the
    // webhook tests below assert on exactly the shape they produce.
    webhookVerifyConfigToWire: actual.webhookVerifyConfigToWire,
    webhookGraceToWire: actual.webhookGraceToWire,
    webhookSourceFromWire: actual.webhookSourceFromWire,
    webhookDeliveryFromWire: actual.webhookDeliveryFromWire,
    registeredFunctionFromWire: actual.registeredFunctionFromWire,
    functionHistoryEntryFromWire: actual.functionHistoryEntryFromWire,
    storedEventFromWire: actual.storedEventFromWire,
    runStepFromWire: actual.runStepFromWire,
    stepInspectionFromWire: actual.stepInspectionFromWire,
    consumerGroupFromWire: actual.consumerGroupFromWire,
  };
});

// Import after mocking
const { createClient } = await import("./client.js");
const { ConflictError, ContendedError } = await import("@ironflow/core");

describe("IronflowClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

    it("should fall back to IRONFLOW_API_KEY when apiKey is not provided", async () => {
      vi.stubEnv("IRONFLOW_API_KEY", "env-key");
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal("fetch", mockFetch);

      await createClient({ serverUrl: "http://localhost:9123" }).patchStep("step_123", {});

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/PatchStep",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer env-key",
          },
        })
      );
    });

    // Empty means "not configured", not "force anonymous" — matches Go's
    // `if apiKey == "" { apiKey = GetAPIKey() }`. This is why the fallback uses
    // `||` rather than `??`: `apiKey: process.env.X ?? ""` must still authenticate.
    it("should treat an empty apiKey as unset and fall back", async () => {
      vi.stubEnv("IRONFLOW_API_KEY", "env-key");
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal("fetch", mockFetch);

      await createClient({ serverUrl: "http://localhost:9123", apiKey: "" }).patchStep("step_123", {});

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/PatchStep",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer env-key",
          },
        })
      );
    });

    it("should prefer an explicit apiKey over IRONFLOW_API_KEY", async () => {
      vi.stubEnv("IRONFLOW_API_KEY", "env-key");
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      vi.stubGlobal("fetch", mockFetch);

      await createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "explicit-key",
      }).patchStep("step_123", {});

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/PatchStep",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer explicit-key",
          },
        })
      );
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

  describe("function lifecycle", () => {
    it("wraps get, status, delete, history, version, and rollback RPCs", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "fn-1",
            status: "FUNCTION_STATUS_ACTIVE",
            preferredMode: "EXECUTION_MODE_PULL",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "fn-1",
            status: "FUNCTION_STATUS_PAUSED",
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            entries: [{
              eventId: "evt-1",
              entityVersion: "12",
              functionId: "fn-1",
              changeType: "update",
            }],
            hasMore: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            entry: {
              eventId: "evt-2",
              entityVersion: "9",
              functionId: "fn-1",
              changeType: "update",
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            function: { id: "fn-1", status: "FUNCTION_STATUS_ACTIVE" },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      expect((await client.getFunction("fn-1")).preferredMode).toBe("pull");
      expect((await client.updateFunctionStatus("fn-1", "paused")).status).toBe("paused");
      await client.deleteFunction("fn-1");
      const history = await client.listFunctionHistory("fn-1", {
        limit: 20,
        fromVersion: 13,
      });
      expect(history).toMatchObject({ hasMore: true, entries: [{ entityVersion: 12 }] });
      expect((await client.getFunctionAtVersion("fn-1", 9)).entityVersion).toBe(9);
      expect((await client.rollbackFunction("fn-1", 9, "bad deploy")).status).toBe("active");

      const calls = mockFetch.mock.calls.map(([url, init]) => ({
        path: new URL(url as string).pathname,
        body: JSON.parse((init as RequestInit).body as string),
      }));
      expect(calls).toEqual([
        { path: "/ironflow.v1.IronflowService/GetFunction", body: { id: "fn-1" } },
        {
          path: "/ironflow.v1.IronflowService/UpdateFunctionStatus",
          body: { id: "fn-1", status: "FUNCTION_STATUS_PAUSED" },
        },
        { path: "/ironflow.v1.IronflowService/DeleteFunction", body: { id: "fn-1" } },
        {
          path: "/ironflow.v1.IronflowService/ListFunctionHistory",
          body: { functionId: "fn-1", limit: 20, fromVersion: "13" },
        },
        {
          path: "/ironflow.v1.IronflowService/GetFunctionAtVersion",
          body: { functionId: "fn-1", version: "9" },
        },
        {
          path: "/ironflow.v1.IronflowService/RollbackFunction",
          body: { functionId: "fn-1", version: "9", changeReason: "bad deploy" },
        },
      ]);
    });
  });

  describe("emit", () => {
    it("should trigger a batch of events", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [{ runIds: ["run-1"], eventId: "evt-1" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      const result = await client.triggerBatch([
        { event: "order.placed", data: { id: "1" }, version: 2, idempotencyKey: "order-1" },
      ]);

      expect(result).toEqual([{ runIds: ["run-1"], eventId: "evt-1" }]);
      const [url, init] = assertDefined(mockFetch.mock.calls[0]);
      expect(url).toBe("http://localhost:9123/ironflow.v1.IronflowService/TriggerBatch");
      expect(JSON.parse(init.body as string)).toEqual({
        events: [{ event: "order.placed", data: { id: "1" }, version: 2, idempotencyKey: "order-1" }],
      });
    });

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

    // The guard changed from truthiness to `!== undefined` precisely so a
    // negative reaches the server and comes back as a 400 with the reason,
    // rather than the client dropping it and emitting at version 1 silently.
    // Under the old `if (options?.version)` this assertion fails.
    it("forwards a negative version instead of dropping it", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runIds: [], eventId: "evt-1" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emit("order.placed", { orderId: "123" }, { version: -1 });

      const call = assertDefined(mockFetch.mock.calls[mockFetch.mock.calls.length - 1]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.version).toBe(-1);
    });

    it("sends the version on emitSync", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ eventId: "evt-1", results: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emitSync("order.placed", { orderId: "123" }, { version: 2 });

      const call = assertDefined(mockFetch.mock.calls[mockFetch.mock.calls.length - 1]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.version).toBe(2);
    });
  });

  describe("event reads", () => {
    it("lists events, gets one event, and lists name facets", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            events: [{
              id: "evt-1",
              name: "order.placed",
              timestamp: "2026-08-27T12:00:00.123Z",
              data: { id: "1" },
              source: "sdk",
              processed: true,
              created_at: "2026-08-27T12:00:00.123Z",
              idempotency_key: "order-1",
            }],
            count: 1,
            limit: 25,
            next_cursor: "next",
            has_next: true,
            has_prev: false,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: "evt-1",
            name: "order.placed",
            timestamp: "2026-08-27T12:00:00.123Z",
            source: "sdk",
            processed: true,
            created_at: "2026-08-27T12:00:00.123Z",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            names: [{ name: "order.placed", count: 8 }],
            scanned: 8,
            truncated: false,
            scan_cap: 10000,
          }),
        });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      const page = await client.listEvents({
        names: ["order.placed", "order.shipped"],
        sources: ["sdk"],
        limit: 25,
        cursor: "cur",
      });
      expect(page.events[0]).toMatchObject({ id: "evt-1", idempotencyKey: "order-1" });
      expect(page.hasNext).toBe(true);
      expect((await client.getEvent("evt-1")).id).toBe("evt-1");
      expect((await client.listEventNames({ sources: ["sdk"] })).scanCap).toBe(10000);

      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:9123/api/v1/events?names=order.placed%2Corder.shipped&source=sdk&limit=25&cursor=cur",
        "http://localhost:9123/api/v1/events/evt-1",
        "http://localhost:9123/api/v1/events/names?source=sdk",
      ]);
    });
  });

  describe("run introspection", () => {
    it("returns durable steps and touched entity streams", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            steps: [{ id: "row-1", runId: "run-1", stepId: "charge", stepType: "STEP_TYPE_INVOKE", sequence: 1, status: "STEP_STATUS_COMPLETED", attempt: 1, createdAt: "now", updatedAt: "now" }],
            count: 1,
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ entity_ids: ["order-1"] }) });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      expect((await client.getRunSteps("run-1")).steps[0]?.stepId).toBe("charge");
      expect(await client.getRunStreams("run-1")).toEqual({ entityIds: ["order-1"] });
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:9123/ironflow.v1.IronflowService/GetRunSteps",
        "http://localhost:9123/api/v1/runs/run-1/streams",
      ]);
    });
  });

  describe("consumer group management", () => {
    it("wraps create, get, list, partial update, and delete", async () => {
      const group = {
        id: "cg-1",
        namespace: "default",
        name: "orders",
        pattern: "order.*",
        ackMode: "ACK_MODE_MANUAL",
        backpressure: "BACKPRESSURE_MODE_BUFFER",
        maxInflight: 50,
        maxRedeliveries: 3,
        redeliverDelayMs: 5000,
        status: "CONSUMER_GROUP_STATUS_ACTIVE",
        memberCount: 0,
        createdAt: "2026-08-27T12:00:00Z",
        updatedAt: "2026-08-27T12:00:00Z",
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(group) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(group) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ groups: [group] }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ...group, status: "CONSUMER_GROUP_STATUS_PAUSED", maxInflight: 0 }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      expect((await client.consumerGroups.create({ name: "orders", pattern: "order.*", ackMode: "manual" })).ackMode).toBe("manual");
      expect((await client.consumerGroups.get("orders")).name).toBe("orders");
      expect(await client.consumerGroups.list()).toHaveLength(1);
      expect((await client.consumerGroups.update("orders", { status: "paused", maxInflight: 0 })).status).toBe("paused");
      await client.consumerGroups.delete("orders");

      const bodies = mockFetch.mock.calls.map(([, init]) =>
        JSON.parse((init as RequestInit).body as string)
      );
      expect(bodies[3]).toEqual({
        group: {
          name: "orders",
          namespace: "default",
          maxInflight: 0,
          status: "CONSUMER_GROUP_STATUS_PAUSED",
        },
        updateMask: { paths: ["max_inflight", "status"] },
      });
      expect(mockFetch.mock.calls.map(([url]) => new URL(url as string).pathname)).toEqual([
        "/ironflow.v1.PubSubService/CreateConsumerGroup",
        "/ironflow.v1.PubSubService/GetConsumerGroup",
        "/ironflow.v1.PubSubService/ListConsumerGroups",
        "/ironflow.v1.PubSubService/UpdateConsumerGroup",
        "/ironflow.v1.PubSubService/DeleteConsumerGroup",
      ]);
    });

    it("follows pagination until every consumer group is returned", async () => {
      const firstGroup = {
        id: "cg-1",
        namespace: "default",
        name: "orders",
        pattern: "order.*",
      };
      const secondGroup = {
        id: "cg-2",
        namespace: "default",
        name: "payments",
        pattern: "payment.*",
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ groups: [firstGroup], next_cursor: "cg-page-2" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ groups: [secondGroup] }),
        });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      const groups = await client.consumerGroups.list();

      expect(groups.map((group) => group.name)).toEqual(["orders", "payments"]);
      const bodies = mockFetch.mock.calls.map(([, init]) =>
        JSON.parse((init as RequestInit).body as string)
      );
      expect(bodies).toEqual([
        { limit: 100 },
        { limit: 100, cursor: "cg-page-2" },
      ]);
    });

    it("rejects an empty update before sending a destructive field mask", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.consumerGroups.update("orders", {})).rejects.toThrow(
        "Consumer group update requires at least one field"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getRun", () => {
    it("should make POST request to GetRun endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "RUN_STATUS_COMPLETED",
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
            runs: [
              { id: "run_1", status: "RUN_STATUS_COMPLETED" },
              { id: "run_2", status: "RUN_STATUS_RUNNING" },
            ],
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
            status: "RUN_STATUS_CANCELLED",
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const result = await client.cancelRun("run_123", "User requested");

      expect(result.status).toBe("cancelled");
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

  describe("resumeRun", () => {
    it("should POST the ResumeRun RPC with lowerCamel proto fields", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: "run_123",
            status: "RUN_STATUS_RUNNING",
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
        "http://localhost:9123/ironflow.v1.IronflowService/ResumeRun",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            runId: "run_123",
            fromStep: "step_2",
          }),
        })
      );
    });

    it("should set Authorization header when apiKey is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "run_123", status: "RUN_STATUS_RUNNING" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({
        serverUrl: "http://localhost:9123",
        apiKey: "my-secret",
      });

      await client.resumeRun("run_123");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer my-secret",
          }),
        })
      );
    });

    it("should default fromStep to empty string when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: "run_123", status: "RUN_STATUS_RUNNING" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await client.resumeRun("run_123");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            runId: "run_123",
            fromStep: "",
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

    // #1963: the reason resumeRun moved onto Connect at all. A resume that is
    // already in flight inside the server's dedupe window comes back 409, and
    // request()'s typed-error table turns that into ConflictError. Before the
    // migration this route bypassed request() entirely and threw a bare Error.
    it("should throw ConflictError when the resume is already in flight", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: "already_exists",
              message:
                "a resume for this run is already in flight; wait for it to land before retrying",
            })
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();

      await expect(client.resumeRun("run_123")).rejects.toThrow(ConflictError);
      await expect(client.resumeRun("run_123")).rejects.toThrow(
        "already in flight"
      );
    });

    // #2074: 409 stopped meaning one thing. Connect serializes both
    // `already_exists` (wait for the first resume) and `aborted` (a lost CAS
    // race — re-read and reissue) to it, so the status alone picks the wrong
    // advice for one of them. The discriminator is the Connect code in the
    // error body, which connectRequest used to read only as a message fallback
    // and then discard.
    //
    // The CLASS is the whole discrimination. Both errors carry
    // `retryable: false` — `aborted` means "retry at a higher level", not
    // "reissue these bytes" — so an assertion on the flag alone would pass on
    // every row and prove nothing.
    it.each([
      {
        name: "aborted is contention",
        body: { code: "aborted", message: "resume run contended after retry" },
        want: () => ContendedError,
        notWant: () => ConflictError,
      },
      {
        name: "already_exists is dedupe",
        body: {
          code: "already_exists",
          message: "a resume for this run is already in flight",
        },
        want: () => ConflictError,
        notWant: () => ContendedError,
      },
      {
        // A REST-shaped 409 carries no Connect code at all. It has to keep
        // landing on ConflictError, which is the pre-#2074 behavior.
        name: "no code stays a conflict",
        body: { message: "conflict" },
        want: () => ConflictError,
        notWant: () => ContendedError,
      },
    ])("409 discrimination: $name", async ({ body, want, notWant }) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: () => Promise.resolve(JSON.stringify(body)),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient();
      const error = await client.resumeRun("run_123").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(want());
      expect(error).not.toBeInstanceOf(notWant());
      expect((error as { retryable: boolean }).retryable).toBe(false);
    });

    // request() applies the client timeout and reports through onError; the
    // hand-rolled fetch this replaced did both independently (#1963).
    it("should report failures through onError with the RPC endpoint", async () => {
      const onError = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: () => Promise.resolve("{}"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ onError });

      await expect(client.resumeRun("run_123")).rejects.toThrow();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          method: "resumeRun",
          endpoint: "/ironflow.v1.IronflowService/ResumeRun",
          statusCode: 409,
        })
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
                output: "eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tIiwicmVzdWx0Ijo0Mn0=",
                injected: false,
                completedAt: "2026-03-01T10:00:00Z",
              },
              {
                id: "step_2",
                name: "transform",
                output: "eyJ0cmFuc2Zvcm1lZCI6dHJ1ZX0=",
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
            previousOutput: "eyJvbGQiOiJ2YWx1ZSJ9",
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
      expect(body.new_output).toBe("eyJjb3JyZWN0ZWQiOnRydWV9");
      expect(body.reason).toBe("Manual correction");
    });

    it("should default reason to empty string when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            stepId: "step_1",
            previousOutput: "eyJ4IjoxfQ==",
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
      expect(body.new_output).toBe(
        Buffer.from(JSON.stringify(complexOutput), "utf8").toString("base64")
      );
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
    const okResponse = (results: unknown[]) => ({
      ok: true,
      json: () => Promise.resolve({ eventId: "evt_1", results }),
    });

    it("should return one result per matched run", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_abc123",
            functionId: "my-function",
            status: "RUN_STATUS_COMPLETED",
            output: { total: 99.99 },
            durationMs: 42,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const results = await client.emitSync("order.placed", { orderId: "123" });

      expect(results).toHaveLength(1);
      const result = assertDefined(results[0]);
      expect(result.runId).toBe("run_abc123");
      expect(result.functionId).toBe("my-function");
      expect(result.status).toBe("completed");
      expect(result.output).toEqual({ total: 99.99 });
      expect(result.durationMs).toBe(42);
      expect(result.waitTimedOut).toBe(false);
      expect(result.error).toBeUndefined();
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

    it("should return every run of a fan-out, dropping none", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_1",
            functionId: "fn-a",
            status: "RUN_STATUS_COMPLETED",
            output: { a: 1 },
            durationMs: 10,
          },
          {
            runId: "run_2",
            functionId: "fn-b",
            status: "RUN_STATUS_COMPLETED",
            output: { b: 2 },
            durationMs: 20,
          },
          {
            runId: "run_3",
            functionId: "fn-c",
            status: "RUN_STATUS_COMPLETED",
            output: { c: 3 },
            durationMs: 30,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const results = await client.emitSync("order.placed", {});

      expect(results.map((r) => r.runId)).toEqual(["run_1", "run_2", "run_3"]);
      expect(results.map((r) => r.functionId)).toEqual(["fn-a", "fn-b", "fn-c"]);
      expect(results.map((r) => r.output)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it("should report a mixed fan-out per run instead of throwing", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_ok",
            functionId: "fn-ok",
            status: "RUN_STATUS_COMPLETED",
            output: { ok: true },
            durationMs: 5,
          },
          {
            runId: "run_fail",
            functionId: "fn-fail",
            status: "RUN_STATUS_FAILED",
            output: { partial: true },
            error: { message: "something broke", code: "STEP_FAILED" },
            durationMs: 7,
          },
          {
            runId: "run_cancel",
            functionId: "fn-cancel",
            status: "RUN_STATUS_CANCELLED",
            output: null,
            durationMs: 0,
          },
          {
            runId: "run_slow",
            functionId: "fn-slow",
            status: "RUN_STATUS_RUNNING",
            durationMs: 0,
            waitTimedOut: true,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const results = await client.emitSync("order.placed", {});

      expect(results).toHaveLength(4);
      expect(results.map((r) => r.status)).toEqual([
        "completed",
        "failed",
        "cancelled",
        "running",
      ]);
      expect(assertDefined(results[1]).error).toEqual({
        message: "something broke",
        code: "STEP_FAILED",
      });
      expect(assertDefined(results[1]).output).toEqual({ partial: true });
      expect(assertDefined(results[0]).error).toBeUndefined();
      expect(assertDefined(results[3]).waitTimedOut).toBe(true);
      expect(assertDefined(results[2]).waitTimedOut).toBe(false);
    });

    it("should pass custom timeout in request body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_abc",
            functionId: "fn",
            status: "RUN_STATUS_COMPLETED",
            output: null,
            durationMs: 10,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emitSync("ping", {}, { timeout: 60000 });

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(body.timeout_ms).toBe(60000);
    });

    // The wire is all snake_case in every SDK (browser client.ts:1557-1562, Go
    // client.go:507). Asserting the exact key set, not per-key presence, is what
    // makes a drift back to camelCase fail here: sending both spellings would
    // still satisfy a presence check, and protojson would accept it silently.
    it("should send an all-snake_case body with idempotency_key", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse([]));
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emitSync("ping", {}, { idempotencyKey: "dedupe-1" });

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual([
        "data",
        "event",
        "idempotency_key",
        "timeout_ms",
      ]);
      expect(body.idempotency_key).toBe("dedupe-1");
    });

    it("should omit idempotency_key when not supplied", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse([]));
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.emitSync("ping", {});

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual(["data", "event", "timeout_ms"]);
    });

    // No durationMs — protojson omits it on the wait-timeout branch, which never
    // sets it. Do not add it back: a fixture that supplies it stops testing the
    // shape the server actually sends, and emitSync would throw here in
    // production while staying green. Body verbatim from the integration test.
    it("should surface a wait timeout as a result, not a throw", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_waiting",
            functionId: "slow-function",
            status: "RUN_STATUS_WAITING_FOR_CAPACITY",
            waitTimedOut: true,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const results = await client.emitSync("work.started", {}, { timeout: 1234 });

      const result = assertDefined(results[0]);
      expect(result.waitTimedOut).toBe(true);
      expect(result.status).toBe("waiting_for_capacity");
      expect(result.runId).toBe("run_waiting");
      expect(result.durationMs).toBe(0);
    });

    it("should reject an unspecified wire status", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            runId: "run_unspecified",
            functionId: "my-function",
            status: "RUN_STATUS_UNSPECIFIED",
            durationMs: 0,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.emitSync("order.placed", {})).rejects.toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    });

    // Sibling of invoke's "reject a response missing the required result".
    // The hand-rolled structural cast this method used before could not see a
    // missing field — it returned `runId: undefined` typed as a string.
    //
    // `runId` specifically: the server always writes a non-empty UUID there, so
    // its absence is always a contract violation. Do NOT switch this fixture to
    // omit `durationMs` — protojson drops that field whenever the run measured
    // 0ms, so a response without it is normal, not malformed.
    it("should reject a result item missing a required field", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResponse([
          {
            // runId omitted
            functionId: "my-function",
            status: "RUN_STATUS_COMPLETED",
            durationMs: 3,
          },
        ])
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.emitSync("order.placed", {})).rejects.toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
      });
    });

    it("should return an empty array when the event matched no trigger", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse([]));
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.emitSync("test.event", {})).resolves.toEqual([]);
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

    it("should not turn the wait budget into a transport abort", async () => {
      vi.useFakeTimers();
      try {
        // A fetch that never settles keeps the abort timer armed — with a
        // resolved mock the `finally { clearTimeout }` disarms it immediately
        // and the assertion below would pass for the wrong reason.
        let signal: AbortSignal | undefined;
        const mockFetch = vi.fn().mockImplementation((_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        });
        vi.stubGlobal("fetch", mockFetch);

        const client = createClient({
          serverUrl: "http://localhost:9123",
          // A short client-level timeout must not shorten a sync wait.
          timeout: 1000,
        });
        void client.emitSync("slow.event", {}, { timeout: 20000 }).catch(() => {});
        await Promise.resolve();

        const call = assertDefined(mockFetch.mock.calls[0]);
        expect(JSON.parse(call[1]?.body as string).timeout_ms).toBe(20000);

        // The server is still inside its own 20s budget: the request must live.
        await vi.advanceTimersByTimeAsync(20000);
        expect(assertDefined(signal).aborted).toBe(false);

        // Only past budget + SYNC_TRANSPORT_HEADROOM does the transport give up.
        await vi.advanceTimersByTimeAsync(5001);
        expect(assertDefined(signal).aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("invoke", () => {
    const okResult = (result: unknown) => ({
      ok: true,
      json: () => Promise.resolve({ result }),
    });

    it("should invoke a function by ID and return one result", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResult({
          runId: "run_inv1",
          functionId: "process-order",
          status: "RUN_STATUS_COMPLETED",
          output: { total: 42 },
          durationMs: 12,
        })
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.invoke("process-order", {
        data: { orderId: "123" },
      });

      expect(result).toEqual({
        runId: "run_inv1",
        functionId: "process-order",
        status: "completed",
        output: { total: 42 },
        error: undefined,
        durationMs: 12,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.IronflowService/InvokeFunctionSync",
        expect.objectContaining({ method: "POST" })
      );
      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      // Exact key set, same reason as emitSync above.
      expect(Object.keys(body).sort()).toEqual([
        "data",
        "function_id",
        "timeout_ms",
      ]);
      expect(body.function_id).toBe("process-order");
      expect(body.data).toEqual({ orderId: "123" });
      expect(body.timeout_ms).toBe(30000);
    });

    it("should thread timeout, idempotency_key and metadata into the body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResult({
          runId: "run_inv2",
          functionId: "fn",
          status: "RUN_STATUS_COMPLETED",
          output: null,
          durationMs: 1,
        })
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      await client.invoke("fn", {
        data: {},
        timeout: 5000,
        idempotencyKey: "dedupe-2",
        metadata: { tenant: "acme" },
      });

      const call = assertDefined(mockFetch.mock.calls[0]);
      const body = JSON.parse(call[1]?.body as string);
      expect(Object.keys(body).sort()).toEqual([
        "data",
        "function_id",
        "idempotency_key",
        "metadata",
        "timeout_ms",
      ]);
      expect(body.timeout_ms).toBe(5000);
      expect(body.idempotency_key).toBe("dedupe-2");
      expect(body.metadata).toEqual({ tenant: "acme" });
    });

    it("should throw RunFailedError when the run failed", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResult({
          runId: "run_fail",
          functionId: "fn",
          status: "RUN_STATUS_FAILED",
          output: { partial: true },
          error: { message: "something broke", code: "STEP_FAILED" },
          durationMs: 5,
        })
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const err = await client.invoke("fn", { data: {} }).catch((e) => e);

      expect(err.constructor.name).toBe("RunFailedError");
      expect(err.runId).toBe("run_fail");
      expect(err.code).toBe("RUN_FAILED");
      expect(err.message).toBe("something broke");
      expect(err.output).toEqual({ partial: true });
    });

    it("should throw RunCancelledError when the run was cancelled", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResult({
          runId: "run_cancel",
          functionId: "fn",
          status: "RUN_STATUS_CANCELLED",
          output: null,
          durationMs: 0,
        })
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const err = await client.invoke("fn", { data: {} }).catch((e) => e);

      expect(err.constructor.name).toBe("RunCancelledError");
      expect(err.runId).toBe("run_cancel");
      expect(err.code).toBe("RUN_CANCELLED");
    });

    // Same omitted durationMs as the emitSync case above — and here it decides
    // which error the caller sees: with a required durationMs, validate() throws
    // SchemaValidationError at :734 and the RunWaitTimeoutError check below is
    // never reached.
    it("should throw RunWaitTimeoutError when the wait budget expired", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        okResult({
          runId: "run_waiting",
          functionId: "slow-function",
          status: "RUN_STATUS_RUNNING",
          waitTimedOut: true,
        })
      );
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(
        client.invoke("slow-function", { data: {}, timeout: 1234 })
      ).rejects.toMatchObject({
        name: "RunWaitTimeoutError",
        code: "RUN_WAIT_TIMEOUT",
        retryable: false,
        runId: "run_waiting",
        functionId: "slow-function",
        runStatus: "running",
        timeoutMs: 1234,
      });
    });

    it("should reject a response missing the required result", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.invoke("fn", { data: {} })).rejects.toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
      });
    });

    it("should throw on HTTP error response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('function "nope" not found'),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.invoke("nope", { data: {} })).rejects.toThrow(
        'function "nope" not found'
      );
    });

    it("should not turn the wait budget into a transport abort", async () => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        const mockFetch = vi.fn().mockImplementation((_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        });
        vi.stubGlobal("fetch", mockFetch);

        // Aborting THIS request cancels the run server-side (Q19), so the
        // transport must outlive the wait budget or `waitTimedOut` is
        // unreachable and every timeout kills the run.
        const client = createClient({ serverUrl: "http://localhost:9123", timeout: 1000 });
        void client.invoke("fn", { data: {}, timeout: 20000 }).catch(() => {});
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(20000);
        expect(assertDefined(signal).aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(5001);
        expect(assertDefined(signal).aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("projections", () => {
    it("lists materialized partition keys", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ partitions: ["cust-1", "cust-2"], returned: 2 }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient({ serverUrl: "http://localhost:9123" });

      await expect(client.projections.listPartitions("orders", { query: "cust", limit: 25 })).resolves.toEqual({
        partitions: ["cust-1", "cust-2"],
        returned: 2,
      });
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        "http://localhost:9123/api/v1/projections/orders/partitions?q=cust&limit=25"
      );
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

  describe("webhooks", () => {
    // Every mock body below is snake_case, because that is what the server
    // actually sends: WebhookService registers snakeJSONCodec via
    // SnakeJSONHandlerOptions(). Mocks that spelled these camelCase is how
    // listSources shipped returning undefined for every field but id.
    // The codec is scoped to WebhookService only (ADR 0023) — do not
    // generalize these mocks to another service's tests.
    const okJson = (body: unknown) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(body),
      });
      vi.stubGlobal("fetch", mockFetch);
      return mockFetch;
    };
    const sentBody = (mockFetch: ReturnType<typeof vi.fn>) =>
      JSON.parse(assertDefined(mockFetch.mock.calls[0])[1].body);

    it("should list webhook sources via ConnectRPC", async () => {
      const mockFetch = okJson({
        sources: [
          {
            id: "wh_1",
            name: "Stripe",
            event_prefix: "stripe.",
            source_type: "api",
            verify_secret_set: true,
            verify_secret_prev_set: true,
            verify_secret_prev_expires_at: "2026-03-29T00:00:00Z",
            ingest_token_prefix: "ifwh_1a2b3c4d",
            created_at: "2026-03-28T00:00:00Z",
          },
        ],
      });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const sources = await client.webhooks.listSources();

      expect(sources).toHaveLength(1);
      const s = assertDefined(sources[0]);
      expect(s.id).toBe("wh_1");
      expect(s.name).toBe("Stripe");
      expect(s.eventPrefix).toBe("stripe.");
      expect(s.sourceType).toBe("api");
      expect(s.verifySecretSet).toBe(true);
      expect(s.verifySecretPrevSet).toBe(true);
      expect(s.verifySecretPrevExpiresAt).toBe("2026-03-29T00:00:00Z");
      expect(s.ingestTokenPrefix).toBe("ifwh_1a2b3c4d");
      expect(s.createdAt).toBe("2026-03-28T00:00:00Z");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/ListWebhookSources",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("should send name (not id) on create and surface the write-once token", async () => {
      const mockFetch = okJson({
        id: "wh_1",
        name: "Stripe",
        event_prefix: "stripe.",
        ingest_token: "ifwh_rawsecret",
        ingest_token_prefix: "ifwh_rawsecre",
      });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const source = await client.webhooks.create({
        name: "Stripe",
        eventPrefix: "stripe.",
        verifySecret: "whsec_x",
      });

      // CreateWebhookSourceRequest reserves field 1 (id) and
      // WebhookHandler.CreateWebhookSource rejects an empty Name, so the old
      // shape got InvalidArgument on every call.
      const body = sentBody(mockFetch);
      expect(body.name).toBe("Stripe");
      expect(body).not.toHaveProperty("id");
      expect(source.id).toBe("wh_1");
      expect(source.ingestToken).toBe("ifwh_rawsecret");
    });

    it("should fetch a single source", async () => {
      const mockFetch = okJson({ id: "wh_1", name: "Stripe", event_prefix: "stripe." });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const source = await client.webhooks.getSource("wh_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/GetWebhookSource",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "wh_1" }) })
      );
      expect(source.name).toBe("Stripe");
    });

    it("should send the concurrency token on update and omit it when absent", async () => {
      let mockFetch = okJson({ id: "wh_1", name: "renamed", event_prefix: "stripe." });
      const client = createClient({ serverUrl: "http://localhost:9123" });

      await client.webhooks.updateSource({
        id: "wh_1",
        name: "renamed",
        verifyHeader: "Stripe-Signature",
        expectedUpdatedAt: "2026-03-28T00:00:00Z",
      });
      let body = sentBody(mockFetch);
      expect(body.verify_header).toBe("Stripe-Signature");
      expect(body.expected_updated_at).toBe("2026-03-28T00:00:00Z");

      mockFetch = okJson({ id: "wh_1", name: "renamed", event_prefix: "stripe." });
      await client.webhooks.updateSource({ id: "wh_1", name: "renamed" });
      body = sentBody(mockFetch);
      expect(body).not.toHaveProperty("expected_updated_at");
      // verify_config is preserve-on-omit server-side, which only works if the
      // key is ABSENT. Sending `verify_config: {}` would wipe the descriptor.
      expect(body).not.toHaveProperty("verify_config");
    });

    it("should treat graceSeconds as tri-state on rotateSecret", async () => {
      const client = createClient({ serverUrl: "http://localhost:9123" });
      const response = { id: "wh_1", name: "Stripe", event_prefix: "stripe.", verify_secret_set: true };

      // Omitted → the key is absent, so the server picks its own default.
      // Baking 86400 in here would override IRONFLOW_WEBHOOK_SECRET_GRACE_HOURS_DEFAULT.
      let mockFetch = okJson(response);
      await client.webhooks.rotateSecret({ id: "wh_1", verifySecret: "whsec_new" });
      expect(sentBody(mockFetch)).not.toHaveProperty("grace_seconds");

      // 0 → instant cutover. A truthiness check would drop it and silently
      // leave the old secret verifying for 24 h.
      mockFetch = okJson(response);
      await client.webhooks.rotateSecret({ id: "wh_1", verifySecret: "whsec_new", graceSeconds: 0 });
      expect(sentBody(mockFetch).grace_seconds).toBe(0);

      mockFetch = okJson(response);
      await client.webhooks.rotateSecret({ id: "wh_1", verifySecret: "whsec_new", graceSeconds: 3600 });
      expect(sentBody(mockFetch).grace_seconds).toBe(3600);
    });

    it("should expire the previous secret slot", async () => {
      const mockFetch = okJson({
        id: "wh_1",
        name: "Stripe",
        event_prefix: "stripe.",
        verify_secret_prev_set: false,
      });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const source = await client.webhooks.expireSecretPrev("wh_1", "2026-03-28T00:00:00Z");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/ExpireWebhookSecretPrev",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ id: "wh_1", expected_updated_at: "2026-03-28T00:00:00Z" }),
        })
      );
      // An explicit false must survive as false. Collapsing it to undefined
      // makes "the slot is empty" indistinguishable from "the mapper stopped
      // reading the key".
      expect(source.verifySecretPrevSet).toBe(false);
    });

    it("should disable signature verification with a tri-state grace", async () => {
      const client = createClient({ serverUrl: "http://localhost:9123" });
      const response = { id: "wh_1", name: "Stripe", event_prefix: "stripe." };

      let mockFetch = okJson(response);
      await client.webhooks.disableSignatureVerification({ id: "wh_1" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/DisableWebhookSignatureVerification",
        expect.objectContaining({ method: "POST" })
      );
      expect(sentBody(mockFetch)).not.toHaveProperty("grace_seconds");

      mockFetch = okJson(response);
      await client.webhooks.disableSignatureVerification({ id: "wh_1", graceSeconds: 0 });
      expect(sentBody(mockFetch).grace_seconds).toBe(0);
    });

    it("should rotate the ingest token", async () => {
      const mockFetch = okJson({
        id: "wh_1",
        name: "Stripe",
        event_prefix: "stripe.",
        ingest_token: "ifwh_rotated",
        ingest_token_prefix: "ifwh_rotated",
        updated_at: "2026-03-28T01:00:00Z",
      });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const source = await client.webhooks.rotateIngestToken("wh_1");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9123/ironflow.v1.WebhookService/RotateWebhookIngestToken",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "wh_1" }) })
      );
      expect(source.ingestToken).toBe("ifwh_rotated");
      expect(source.updatedAt).toBe("2026-03-28T01:00:00Z");
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
      okJson({
        deliveries: [
          {
            id: "del-1",
            source_id: "wh_1",
            status: "delivered",
            event_id: "evt-123",
            signature_key: "current",
          },
        ],
        total_count: 1,
      });

      const client = createClient({ serverUrl: "http://localhost:9123" });
      const result = await client.webhooks.listDeliveries({ sourceId: "wh_1", limit: 10 });

      expect(result.deliveries).toHaveLength(1);
      const d = assertDefined(result.deliveries[0]);
      expect(d.id).toBe("del-1");
      expect(d.sourceId).toBe("wh_1");
      expect(d.eventId).toBe("evt-123");
      expect(d.signatureKey).toBe("current");
      expect(result.totalCount).toBe(1);
    });

    it("should return empty deliveries array on empty response", async () => {
      okJson({ deliveries: null, total_count: 0 });

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

  describe("remaining parity wrappers", () => {
    it("gets server capabilities", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          transports: ["websocket"],
          features: ["replay"],
          version: "0.31.0",
          auth_required: true,
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await createClient().getCapabilities();
      expect(result.authRequired).toBe(true);
      expect(result.transports).toEqual(["websocket"]);
    });

    it("lists visible agent tools", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          tools: [{
            qualified_name: "docs.search",
            description: "Search docs",
            input_schema_json: "{}",
            required_scopes: ["docs:read"],
          }],
          next_cursor: "next",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await createClient().agentTools.list("cursor");
      expect(result.tools[0]?.qualifiedName).toBe("docs.search");
      expect(result.nextCursor).toBe("next");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("AgentToolsService/ListTools"),
        expect.objectContaining({ body: JSON.stringify({ cursor: "cursor" }) })
      );
    });

    it("patches secret metadata and rejects an empty patch", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: "renamed" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = createClient();

      await expect(client.secrets.patch("old", {})).rejects.toThrow(
        "Secret patch requires name or description"
      );
      const secret = await client.secrets.patch("old", { name: "renamed" });
      expect(secret.name).toBe("renamed");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/secrets/old"),
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ "X-Ironflow-Environment": "current" }),
          body: JSON.stringify({ name: "renamed" }),
        })
      );
    });

    it("lists environment audit events with filters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          events: [{ id: "audit-1", run_id: "run-1", function_id: "fn-1", event_type: "run.completed", payload: {}, created_at: "2026-08-28T00:00:00Z" }],
          total_count: 1,
          next_cursor: "next",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await createClient().listAuditEvents({ runId: "run-1", limit: 5 });
      expect(result.events[0]?.runId).toBe("run-1");
      expect(result.nextCursor).toBe("next");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/audit?run_id=run-1&limit=5"),
        expect.objectContaining({ method: "GET" })
      );
    });

    it("lists role policies", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ policies: [{ id: "policy-1" }] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const policies = await createClient().roles.listPolicies("role/1");
      expect(policies[0]?.id).toBe("policy-1");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/roles/role%2F1/policies"),
        expect.objectContaining({ method: "GET" })
      );
    });

    it("changes the authenticated user's password", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal("fetch", mockFetch);

      await createClient().users.changePassword("user-1", {
        currentPassword: "old",
        newPassword: "new",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/users/user-1/password"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ current_password: "old", new_password: "new" }),
        })
      );
    });

    it("provisions a tenant", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({
          org: { id: "org-acme", name: "Acme" },
          environment: { id: "env-prod", name: "production" },
          api_key: { key: "ifkey_secret", roles: ["admin"] },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await createClient().tenants.provision({ orgName: "Acme" });
      expect(result.apiKey.key).toBe("ifkey_secret");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/tenants/provision"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});

// #1963: resumeRun is on the Connect RPC now, so it decodes the same protojson
// lowerCamel shape as getRun/listRuns/cancelRun through the shared run mapper.
// It used to POST the REST route, which writes store.Run with snake_case tags —
// a second wire shape and a second decoder (mapRestRunResponse, since deleted)
// that #1919 had to add because `response.json() as Run` read undefined on every
// multi-word property.
describe("resumeRun Connect decoding", () => {
  it("decodes the protojson run shape through the shared mapper", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "run_123",
          functionId: "process-order",
          eventId: "evt_9",
          status: "RUN_STATUS_RUNNING",
          attempt: 2,
          maxAttempts: 3,
          startedAt: "2025-01-01T00:00:00Z",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:02:00Z",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createClient();
    const result = await client.resumeRun("run_123");

    expect(result.functionId).toBe("process-order");
    expect(result.eventId).toBe("evt_9");
    expect(result.maxAttempts).toBe(3);
    expect(result.attempt).toBe(2);
    expect(result.status).toBe("running");
    expect(result.createdAt).toBe("2025-01-01T00:00:00Z");
    expect(result.startedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("rejects a status the SDK cannot name", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "run_123", status: "RUN_STATUS_QUARANTINED" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createClient();
    await expect(client.resumeRun("run_123")).rejects.toThrow();
  });
});

// #1919: PausedStepInfo carries stepType, status and error (proto fields 6/7/8).
// Failed steps are exposed by GetPausedState precisely so they can be repaired
// via injectStepOutput — without these a caller cannot tell a failed step from a
// completed one, which defeats the purpose of the API.
describe("getPausedState step metadata", () => {
  it("surfaces stepType, status and the base64-decoded error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          steps: [
            {
              id: "step_1",
              name: "charge",
              output: "eyJjaGFyZ2VkIjp0cnVlfQ==",
              injected: false,
              completedAt: "2026-03-01T10:00:00Z",
              stepType: "invoke",
              status: "completed",
            },
            {
              id: "step_2",
              name: "ship",
              injected: false,
              completedAt: "2026-03-01T10:01:00Z",
              stepType: "invoke_function",
              status: "failed",
              error: "eyJtZXNzYWdlIjoiYm9vbSJ9",
            },
          ],
          nextStepHint: "retry",
          pauseReason: "injection",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createClient();
    const state = await client.getPausedState("run_123");

    const [ok, bad] = state.steps;
    if (!ok || !bad) throw new Error("expected two steps");

    expect(ok.stepType).toBe("invoke");
    expect(ok.status).toBe("completed");
    expect(ok.output).toEqual({ charged: true });
    // A completed step carries no error.
    expect(ok.error).toBeNull();

    expect(bad.stepType).toBe("invoke_function");
    expect(bad.status).toBe("failed");
    // error is a proto bytes field too, so it also arrives base64-encoded.
    expect(bad.error).toEqual({ message: "boom" });
  });

  // EmitUnpopulated:false omits these when empty, so they must not be undefined.
  it("defaults stepType and status when the server omits them", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          steps: [{ id: "step_1", name: "charge", injected: false, completedAt: "" }],
          nextStepHint: "",
          pauseReason: "",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createClient();
    const state = await client.getPausedState("run_123");

    const [step] = state.steps;
    if (!step) throw new Error("expected one step");

    expect(step.stepType).toBe("");
    expect(step.status).toBe("");
    expect(step.error).toBeNull();
    expect(step.output).toBeNull();
  });
});
