import { describe, it, expect } from "vitest";
import { EventSource } from "./types.js";
import {
  RunStatusSchema,
  RunStatusWireSchema,
  runStatusFromWire,
  runStatusToWire,
  CompletedStepSchema,
  ResumeContextSchema,
  PushRequestEventSchema,
  PushRequestSchema,
  TriggerResponseSchema,
  TriggerSyncResultItemSchema,
  TriggerSyncResponseSchema,
  InvokeFunctionSyncResponseSchema,
  RunResponseSchema,
  ListRunsResponseSchema,
  HealthResponseSchema,
  ErrorResponseSchema,
  AckModeSchema,
  BackpressureModeSchema,
  ConsumerGroupStatusSchema,
  ConsumerGroupResponseSchema,
  ListConsumerGroupsResponseSchema,
  RegisterFunctionResponseSchema,
  JobEventSchema,
  JobAssignmentSchema,
  WSSubscriptionResultSchema,
  WSEventMessageSchema,
  WSSubscriptionErrorSchema,
  WSErrorSchema,
  WSServerMessageSchema,
  parseAndValidate,
  validate,
} from "./schemas.js";
import { SchemaValidationError } from "./errors.js";

describe("RunStatusSchema", () => {
  it.each([
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "paused",
    "waiting_for_capacity",
    "waiting",
  ])(
    "should accept valid status: %s",
    (status) => {
      expect(RunStatusSchema.parse(status)).toBe(status);
    }
  );

  it("should reject invalid status", () => {
    expect(() => RunStatusSchema.parse("invalid")).toThrow();
    expect(() => RunStatusSchema.parse("")).toThrow();
    expect(() => RunStatusSchema.parse(123)).toThrow();
  });
});

describe("RunStatusWireSchema", () => {
  it.each([
    ["RUN_STATUS_RUNNING", "running"],
    ["RUN_STATUS_COMPLETED", "completed"],
    ["RUN_STATUS_FAILED", "failed"],
    ["RUN_STATUS_CANCELLED", "cancelled"],
    ["RUN_STATUS_PAUSED", "paused"],
    ["RUN_STATUS_WAITING_FOR_CAPACITY", "waiting_for_capacity"],
    ["RUN_STATUS_WAITING", "waiting"],
  ])("converts %s to %s", (wireStatus, status) => {
    expect(runStatusFromWire(wireStatus)).toBe(status);
  });

  it.each([
    "RUN_STATUS_UNSPECIFIED",
    "RUN_STATUS_PENDING",
    "RUN_STATUS_FUTURE",
    "failed",
    "",
  ])("rejects non-canonical status %s", (status) => {
    expect(() => RunStatusWireSchema.parse(status)).toThrow();
  });

  it("reports invalid server statuses as a public schema validation error", () => {
    expect(() => runStatusFromWire("RUN_STATUS_FUTURE")).toThrow(
      SchemaValidationError
    );

    try {
      runStatusFromWire("RUN_STATUS_FUTURE");
      expect.unreachable("expected invalid wire status to throw");
    } catch (error) {
      expect(error).toMatchObject({
        name: "SchemaValidationError",
        code: "VALIDATION_ERROR",
        retryable: false,
        message: "Invalid run status from server: RUN_STATUS_FUTURE",
      });
      expect(
        (error as SchemaValidationError).validationErrors
      ).not.toHaveLength(0);
    }
  });
});

describe("CompletedStepSchema", () => {
  it("should validate a completed step", () => {
    const step = {
      id: "step-1",
      name: "myStep",
      status: "completed",
      output: { result: "success" },
    };
    expect(CompletedStepSchema.parse(step)).toEqual(step);
  });

  it("should validate a failed step", () => {
    const step = {
      id: "step-2",
      name: "failedStep",
      status: "failed",
      error: "Something went wrong",
    };
    expect(CompletedStepSchema.parse(step)).toEqual(step);
  });

  it("should require id field", () => {
    expect(() =>
      CompletedStepSchema.parse({ name: "test", status: "completed" })
    ).toThrow();
  });

  it("should require name field", () => {
    expect(() =>
      CompletedStepSchema.parse({ id: "1", status: "completed" })
    ).toThrow();
  });

  it("should require valid status", () => {
    expect(() =>
      CompletedStepSchema.parse({ id: "1", name: "test", status: "running" })
    ).toThrow();
  });
});

describe("ResumeContextSchema", () => {
  it("should validate sleep resume context", () => {
    const ctx = {
      step_id: "step-1",
      type: "sleep",
    };
    expect(ResumeContextSchema.parse(ctx)).toEqual(ctx);
  });

  it("should validate wait_for_event resume context with data", () => {
    const ctx = {
      step_id: "step-2",
      type: "wait_for_event",
      data: { eventId: "evt-123", payload: { key: "value" } },
    };
    expect(ResumeContextSchema.parse(ctx)).toEqual(ctx);
  });

  it("should require step_id", () => {
    expect(() => ResumeContextSchema.parse({ type: "sleep" })).toThrow();
  });

  it("should require valid type", () => {
    expect(() =>
      ResumeContextSchema.parse({ step_id: "1", type: "invalid" })
    ).toThrow();
  });
});

describe("PushRequestEventSchema", () => {
  it("should validate a complete event", () => {
    const event = {
      id: "evt-123",
      name: "order.created",
      data: { orderId: "123" },
      timestamp: "2024-01-01T00:00:00Z",
      version: 1,
      idempotency_key: "key-1",
      source: EventSource.WEBHOOK,
      metadata: { trace_id: "abc" },
    };
    expect(PushRequestEventSchema.parse(event)).toEqual(event);
  });

  it("should validate minimal event", () => {
    const event = {
      id: "evt-1",
      name: "test",
      data: null,
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(PushRequestEventSchema.parse(event)).toEqual({ ...event, version: 1 });
  });

  it("should require id field", () => {
    expect(() =>
      PushRequestEventSchema.parse({
        name: "test",
        data: {},
        timestamp: "2024-01-01T00:00:00Z",
      })
    ).toThrow();
  });

  it("should require name field", () => {
    expect(() =>
      PushRequestEventSchema.parse({
        id: "1",
        data: {},
        timestamp: "2024-01-01T00:00:00Z",
      })
    ).toThrow();
  });

  it("should require timestamp field", () => {
    expect(() =>
      PushRequestEventSchema.parse({ id: "1", name: "test", data: {} })
    ).toThrow();
  });
});

describe("Event version support", () => {
  it("PushRequestEventSchema accepts version field", () => {
    const result = PushRequestEventSchema.safeParse({
      id: "evt-1",
      name: "order.placed",
      data: { orderId: "123" },
      timestamp: "2024-01-01T00:00:00Z",
      version: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(2);
    }
  });

  it("PushRequestEventSchema defaults version to 1", () => {
    const result = PushRequestEventSchema.safeParse({
      id: "evt-1",
      name: "order.placed",
      data: { orderId: "123" },
      timestamp: "2024-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
    }
  });

  it("JobEventSchema accepts version field", () => {
    const result = JobEventSchema.safeParse({
      id: "evt-1",
      name: "order.placed",
      data: { orderId: "123" },
      timestamp: "2024-01-01T00:00:00Z",
      version: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(3);
    }
  });
});

describe("PushRequestSchema", () => {
  const validEvent = {
    id: "evt-1",
    name: "test",
    data: {},
    timestamp: "2024-01-01T00:00:00Z",
  };

  it("should validate a complete push request", () => {
    const request = {
      run_id: "run-123",
      function_id: "fn-1",
      attempt: 1,
      event: validEvent,
      steps: [{ id: "s1", name: "step1", status: "completed", output: {} }],
      resume: { step_id: "s1", type: "sleep" },
    };
    const result = PushRequestSchema.parse(request);
    expect(result.run_id).toBe("run-123");
    expect(result.steps).toHaveLength(1);
  });

  it("should default steps to empty array when null", () => {
    const request = {
      run_id: "run-1",
      function_id: "fn-1",
      attempt: 1,
      event: validEvent,
      steps: null,
    };
    const result = PushRequestSchema.parse(request);
    expect(result.steps).toEqual([]);
  });

  it("should default steps to empty array when undefined", () => {
    const request = {
      run_id: "run-1",
      function_id: "fn-1",
      attempt: 1,
      event: validEvent,
    };
    const result = PushRequestSchema.parse(request);
    expect(result.steps).toEqual([]);
  });

  it("should require run_id", () => {
    expect(() =>
      PushRequestSchema.parse({
        function_id: "fn-1",
        attempt: 1,
        event: validEvent,
      })
    ).toThrow();
  });

  it("should require function_id", () => {
    expect(() =>
      PushRequestSchema.parse({
        run_id: "run-1",
        attempt: 1,
        event: validEvent,
      })
    ).toThrow();
  });

  it("should require attempt", () => {
    expect(() =>
      PushRequestSchema.parse({
        run_id: "run-1",
        function_id: "fn-1",
        event: validEvent,
      })
    ).toThrow();
  });

  it("should require event", () => {
    expect(() =>
      PushRequestSchema.parse({
        run_id: "run-1",
        function_id: "fn-1",
        attempt: 1,
      })
    ).toThrow();
  });
});

describe("TriggerResponseSchema", () => {
  it("should validate response with runIds", () => {
    const response = {
      runIds: ["run-1", "run-2"],
      eventId: "evt-1",
    };
    expect(TriggerResponseSchema.parse(response)).toEqual(response);
  });

  it("should validate response without runIds", () => {
    const response = { eventId: "evt-1" };
    expect(TriggerResponseSchema.parse(response)).toEqual(response);
  });

  it("should require eventId", () => {
    expect(() => TriggerResponseSchema.parse({ runIds: [] })).toThrow();
  });
});

describe("RunResponseSchema", () => {
  it("should validate a complete run response", () => {
    const response = {
      id: "run-1",
      functionId: "fn-1",
      eventId: "evt-1",
      status: "completed",
      attempt: 1,
      maxAttempts: 3,
      input: { key: "value" },
      output: { result: "success" },
      error: { message: "test", code: "ERR" },
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:01:00Z",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:01:00Z",
    };
    expect(RunResponseSchema.parse(response)).toEqual(response);
  });

  // Connect marshals with protojson EmitUnpopulated:false, so a zero-valued
  // scalar is OMITTED from the response entirely — never sent as 0 or "". A run
  // on its first attempt, or one created by a direct invoke, really does arrive
  // missing these keys. Requiring them made zod throw on valid runs (#1919).
  //
  // The previous version of this test supplied `attempt: 0` and
  // `status: "pending"` explicitly — a body protojson cannot emit, and a status
  // the proto reserves — so it asserted a shape that never reaches the client.
  it("decodes a run whose zero-valued fields the server omitted", () => {
    const response = {
      id: "run-1",
      status: "RUN_STATUS_RUNNING",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const parsed = RunResponseSchema.parse(response);

    expect(parsed.id).toBe("run-1");
    expect(parsed.status).toBe("RUN_STATUS_RUNNING");
    // Absent on the wire, defaulted here — callers still get the field.
    expect(parsed.functionId).toBe("");
    expect(parsed.eventId).toBe("");
    expect(parsed.attempt).toBe(0);
    expect(parsed.maxAttempts).toBe(0);
  });

  // The narrowest body the server can send: protojson omits every zero-valued
  // field, so a run whose id is the only populated one arrives as a single key.
  it("decodes a response carrying only the run id", () => {
    const parsed = RunResponseSchema.parse({ id: "run-1" });

    expect(parsed.id).toBe("run-1");
    expect(parsed.status).toBe("");
    expect(parsed.createdAt).toBe("");
    expect(parsed.updatedAt).toBe("");
  });

  // id is the one field the server always populates, so it stays required.
  it("still rejects a response with no id", () => {
    expect(() => RunResponseSchema.parse({ status: "RUN_STATUS_RUNNING" })).toThrow();
  });
});

describe("ListRunsResponseSchema", () => {
  it("should validate response with runs", () => {
    const response = {
      runs: [
        {
          id: "run-1",
          functionId: "fn-1",
          eventId: "evt-1",
          status: "completed",
          attempt: 1,
          maxAttempts: 3,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
      nextCursor: "cursor-123",
      totalCount: 100,
    };
    expect(ListRunsResponseSchema.parse(response)).toEqual(response);
  });

  it("should validate empty response", () => {
    const response = {};
    expect(ListRunsResponseSchema.parse(response)).toEqual({});
  });
});

describe("HealthResponseSchema", () => {
  it("should validate health response", () => {
    const response = { status: "ok" };
    expect(HealthResponseSchema.parse(response)).toEqual(response);
  });
});

describe("ErrorResponseSchema", () => {
  it("should validate error response", () => {
    const response = { code: "ERR_CODE", message: "Error message" };
    expect(ErrorResponseSchema.parse(response)).toEqual(response);
  });

  it("should accept empty object", () => {
    expect(ErrorResponseSchema.parse({})).toEqual({});
  });
});

describe("JobEventSchema", () => {
  it("should validate job event", () => {
    const event = {
      id: "evt-1",
      name: "test.event",
      data: { key: "value" },
      timestamp: "2024-01-01T00:00:00Z",
    };
    expect(JobEventSchema.parse(event)).toEqual({ ...event, version: 1 });
  });

  it("should accept metadata field", () => {
    const event = {
      id: "evt-1",
      name: "order.placed",
      data: { orderId: "o-1" },
      timestamp: "2024-01-01T00:00:00Z",
      metadata: {
        causationId: "cmd-001",
        correlationId: "corr-xyz",
        tenantId: "tenant-42",
      },
    };
    const parsed = JobEventSchema.parse(event);
    expect(parsed.metadata).toEqual({
      causationId: "cmd-001",
      correlationId: "corr-xyz",
      tenantId: "tenant-42",
    });
  });

  it("should allow metadata to be omitted", () => {
    const event = {
      id: "evt-1",
      name: "test",
      data: {},
      timestamp: "2024-01-01T00:00:00Z",
    };
    const parsed = JobEventSchema.parse(event);
    expect(parsed.metadata).toBeUndefined();
  });
});

describe("JobAssignmentSchema", () => {
  it("should validate complete job assignment", () => {
    const assignment = {
      job_id: "job-1",
      run_id: "run-1",
      function_id: "fn-1",
      attempt: 1,
      event: {
        id: "evt-1",
        name: "test",
        data: {},
        timestamp: "2024-01-01T00:00:00Z",
      },
      completed_steps: [{ step_id: "s1", name: "step1", output: {} }],
      actor_id: "actor-1",
      context: { trace_id: "trace-1", metadata: { key: "value" } },
    };
    const expected = {
      ...assignment,
      event: { ...assignment.event, version: 1 },
    };
    expect(JobAssignmentSchema.parse(assignment)).toEqual(expected);
  });

  it("keeps event.source on the wire (cron exemption, #1948)", () => {
    const parsed = JobAssignmentSchema.parse({
      job_id: "job-1", run_id: "run-1", function_id: "fn-1", attempt: 1,
      event: { id: "evt-1", name: "ironflow/cron.fn-1", data: { type: "cron" }, timestamp: "2024-01-01T00:00:00Z", source: "cron" },
      completed_steps: [],
    });
    expect(parsed.event.source).toBe("cron");
  });

  it("should require job_id", () => {
    expect(() =>
      JobAssignmentSchema.parse({
        run_id: "run-1",
        function_id: "fn-1",
        attempt: 1,
        event: { id: "1", name: "t", data: {}, timestamp: "2024-01-01T00:00:00Z" },
        completed_steps: [],
      })
    ).toThrow();
  });

  // A triggering event with no metadata is serialized server-side as JSON null
  // (not omitted); the schema must accept it and normalize null -> undefined,
  // not reject the whole assignment. Regression guard for the bug where
  // REST-emitted events stranded every run with "expected record, received null".
  it("should accept a null event.metadata and normalize it to undefined", () => {
    const parsed = JobAssignmentSchema.parse({
      job_id: "job-1",
      run_id: "run-1",
      function_id: "fn-1",
      attempt: 1,
      event: {
        id: "evt-1",
        name: "test",
        data: {},
        timestamp: "2024-01-01T00:00:00Z",
        metadata: null,
      },
      completed_steps: [],
    });
    expect(parsed.event.metadata).toBeUndefined();
  });
});

describe("WSSubscriptionResultSchema", () => {
  it("should validate subscription result", () => {
    const result = {
      type: "subscription_result",
      results: [
        { pattern: "test.*", status: "ok", subscriptionId: "sub-1" },
        { pattern: "error.*", status: "error", code: "ERR", message: "Failed" },
      ],
    };
    expect(WSSubscriptionResultSchema.parse(result)).toEqual(result);
  });
});

describe("WSEventMessageSchema", () => {
  it("should validate event message", () => {
    const message = {
      type: "event",
      subscriptionId: "sub-1",
      topic: "test.topic",
      data: { key: "value" },
      meta: { timestamp: "2024-01-01T00:00:00Z", sequence: 1 },
      eventId: "evt-1",
    };
    expect(WSEventMessageSchema.parse(message)).toEqual(message);
  });
});

describe("WSSubscriptionErrorSchema", () => {
  it("should validate subscription error", () => {
    const error = {
      type: "subscription_error",
      subscriptionId: "sub-1",
      code: "ERR_CODE",
      message: "Error occurred",
      retrying: true,
    };
    expect(WSSubscriptionErrorSchema.parse(error)).toEqual(error);
  });
});

describe("WSErrorSchema", () => {
  it("should validate general error", () => {
    const error = {
      type: "error",
      code: "GENERAL_ERROR",
      message: "Something went wrong",
    };
    expect(WSErrorSchema.parse(error)).toEqual(error);
  });
});

describe("WSServerMessageSchema (discriminated union)", () => {
  it("should parse subscription_result type", () => {
    const msg = {
      type: "subscription_result",
      results: [{ pattern: "test", status: "ok", subscriptionId: "s1" }],
    };
    const result = WSServerMessageSchema.parse(msg);
    expect(result.type).toBe("subscription_result");
  });

  it("should parse event type", () => {
    const msg = {
      type: "event",
      subscriptionId: "s1",
      topic: "test.topic",
      data: {},
    };
    const result = WSServerMessageSchema.parse(msg);
    expect(result.type).toBe("event");
  });

  it("should parse subscription_error type", () => {
    const msg = {
      type: "subscription_error",
      subscriptionId: "s1",
      code: "ERR",
      message: "test",
      retrying: false,
    };
    const result = WSServerMessageSchema.parse(msg);
    expect(result.type).toBe("subscription_error");
  });

  it("should parse error type", () => {
    const msg = {
      type: "error",
      code: "ERR",
      message: "test",
    };
    const result = WSServerMessageSchema.parse(msg);
    expect(result.type).toBe("error");
  });

  it("should reject unknown type", () => {
    const msg = { type: "unknown" };
    expect(() => WSServerMessageSchema.parse(msg)).toThrow();
  });
});

describe("parseAndValidate", () => {
  it("should parse valid JSON and validate", () => {
    const json = '"completed"';
    const result = parseAndValidate(RunStatusSchema, json, "test context");
    expect(result).toBe("completed");
  });

  it("should throw SchemaValidationError for invalid JSON", () => {
    expect(() =>
      parseAndValidate(RunStatusSchema, "invalid json", "test")
    ).toThrow(SchemaValidationError);
    expect(() =>
      parseAndValidate(RunStatusSchema, "invalid json", "test")
    ).toThrow("Invalid JSON");
  });

  it("should throw SchemaValidationError for validation failure", () => {
    const json = '"invalid_status"';
    expect(() => parseAndValidate(RunStatusSchema, json, "test")).toThrow(
      SchemaValidationError
    );
    expect(() => parseAndValidate(RunStatusSchema, json, "test")).toThrow(
      "Validation failed"
    );
  });

  it("should include context in error message", () => {
    try {
      parseAndValidate(RunStatusSchema, "bad json", "my context");
    } catch (error) {
      expect((error as Error).message).toContain("my context");
    }
  });

  it("should include validation errors", () => {
    try {
      parseAndValidate(RunStatusSchema, '"invalid"', "test");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).validationErrors).toBeDefined();
    }
  });
});

describe("validate", () => {
  it("should validate already parsed data", () => {
    const result = validate(RunStatusSchema, "completed", "test");
    expect(result).toBe("completed");
  });

  it("should throw SchemaValidationError for invalid data", () => {
    expect(() => validate(RunStatusSchema, "invalid", "test")).toThrow(
      SchemaValidationError
    );
  });

  it("should include context in error message", () => {
    try {
      validate(RunStatusSchema, "invalid", "my context");
    } catch (error) {
      expect((error as Error).message).toContain("my context");
    }
  });

  it("should validate complex objects", () => {
    const event = {
      id: "evt-1",
      name: "test",
      data: { key: "value" },
      timestamp: "2024-01-01T00:00:00Z",
    };
    const result = validate(PushRequestEventSchema, event, "event validation");
    expect(result).toEqual({ ...event, version: 1 });
  });
});

describe("TriggerSyncResultItemSchema", () => {
  it("validates a completed sync result item", () => {
    const result = TriggerSyncResultItemSchema.parse({
      runId: "run_123",
      functionId: "my-fn",
      status: "RUN_STATUS_COMPLETED",
      output: { result: true },
      durationMs: 150,
      waitTimedOut: true,
    });
    expect(result.runId).toBe("run_123");
    expect(result.status).toBe("completed");
    expect(result.durationMs).toBe(150);
    expect(result.waitTimedOut).toBe(true);
  });

  it("validates without optional fields", () => {
    const result = TriggerSyncResultItemSchema.parse({
      runId: "run_123",
      functionId: "my-fn",
      status: "RUN_STATUS_FAILED",
      durationMs: 50,
    });
    expect(result.output).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.waitTimedOut).toBe(false);
  });

  it("validates with error field", () => {
    const result = TriggerSyncResultItemSchema.parse({
      runId: "run_123",
      functionId: "my-fn",
      status: "RUN_STATUS_FAILED",
      error: { message: "timeout", code: "TIMEOUT" },
      durationMs: 30000,
    });
    expect(result.error?.message).toBe("timeout");
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("rejects missing required fields", () => {
    expect(() => TriggerSyncResultItemSchema.parse({ runId: "r" })).toThrow();
  });
});

// Verbatim from the real server — tests/integration/invoke_function_sync_test.go,
// TestInvokeFunctionSync_WaitTimeoutKeepsRunAlive. protojson omits zero-valued
// scalars, so a wait-timeout result carries neither durationMs (never set on
// that branch) nor output. Both schemas must parse it: without the durationMs
// default, validate() throws and RunWaitTimeoutError becomes unreachable.
const waitTimedOutWire = {
  runId: "f2665086-8758-407b-9eae-6d86ee78e2cc",
  functionId: "sync-invoke-slow",
  status: "RUN_STATUS_RUNNING",
  waitTimedOut: true,
};

describe("wait-timeout wire body (no durationMs)", () => {
  it("InvokeFunctionSyncResponseSchema parses it and defaults durationMs to 0", () => {
    const parsed = InvokeFunctionSyncResponseSchema.parse({ result: waitTimedOutWire });
    expect(parsed.result.durationMs).toBe(0);
    expect(parsed.result.waitTimedOut).toBe(true);
    expect(parsed.result.status).toBe("running");
  });

  it("TriggerSyncResponseSchema parses it and defaults durationMs to 0", () => {
    const parsed = TriggerSyncResponseSchema.parse({
      eventId: "evt_1",
      results: [waitTimedOutWire],
    });
    expect(parsed.results?.[0]?.durationMs).toBe(0);
    expect(parsed.results?.[0]?.waitTimedOut).toBe(true);
  });
});

describe("TriggerSyncResponseSchema", () => {
  it("validates response with results", () => {
    const result = TriggerSyncResponseSchema.parse({
      eventId: "evt_123",
      results: [{
        runId: "run_1", functionId: "fn-1", status: "RUN_STATUS_COMPLETED", durationMs: 100,
      }],
    });
    expect(result.eventId).toBe("evt_123");
    expect(result.results).toHaveLength(1);
  });

  it("validates response without results", () => {
    const result = TriggerSyncResponseSchema.parse({ eventId: "evt_123" });
    expect(result.results).toBeUndefined();
  });

  it("rejects missing eventId", () => {
    expect(() => TriggerSyncResponseSchema.parse({ results: [] })).toThrow();
  });
});

describe("InvokeFunctionSyncResponseSchema", () => {
  const wireResult = {
    runId: "run_123",
    functionId: "my-fn",
    status: "RUN_STATUS_COMPLETED",
    output: { ok: true },
    durationMs: 150,
  };

  it("round-trips a single completed result", () => {
    const parsed = InvokeFunctionSyncResponseSchema.parse({ result: wireResult });

    expect(parsed.result.runId).toBe("run_123");
    expect(parsed.result.functionId).toBe("my-fn");
    expect(parsed.result.status).toBe("completed");
    expect(parsed.result.output).toEqual({ ok: true });
    expect(parsed.result.durationMs).toBe(150);
    expect(parsed.result.waitTimedOut).toBe(false);
  });

  it("round-trips a failed result with its error", () => {
    const parsed = InvokeFunctionSyncResponseSchema.parse({
      result: {
        runId: "run_123",
        functionId: "my-fn",
        status: "RUN_STATUS_FAILED",
        error: { message: "boom", code: "STEP_FAILED" },
        durationMs: 30,
      },
    });

    expect(parsed.result.status).toBe("failed");
    expect(parsed.result.error?.message).toBe("boom");
    expect(parsed.result.error?.code).toBe("STEP_FAILED");
    expect(parsed.result.output).toBeUndefined();
  });

  it("carries waitTimedOut for a run that outlived its wait budget", () => {
    const parsed = InvokeFunctionSyncResponseSchema.parse({
      result: {
        runId: "run_123",
        functionId: "my-fn",
        status: "RUN_STATUS_RUNNING",
        durationMs: 30_000,
        waitTimedOut: true,
      },
    });

    expect(parsed.result.waitTimedOut).toBe(true);
    expect(parsed.result.status).toBe("running");
  });

  it("carries no eventId — run_id is the correlator for a direct invoke", () => {
    const parsed = InvokeFunctionSyncResponseSchema.parse({
      result: wireResult,
      eventId: "evt_123",
    });

    expect(parsed).not.toHaveProperty("eventId");
  });

  it("rejects a missing result — the server always sets it", () => {
    expect(() => InvokeFunctionSyncResponseSchema.parse({})).toThrow();
  });

  it("rejects a repeated-results payload shaped like TriggerSync", () => {
    expect(() =>
      InvokeFunctionSyncResponseSchema.parse({ results: [wireResult], eventId: "evt_1" })
    ).toThrow();
  });

  it("throws SchemaValidationError for an unknown wire status", () => {
    expect(() =>
      validate(
        InvokeFunctionSyncResponseSchema,
        { result: { ...wireResult, status: "RUN_STATUS_FUTURE" } },
        "invoke sync response"
      )
    ).toThrow(SchemaValidationError);
  });

  it("names the offending path in the validation error", () => {
    try {
      validate(
        InvokeFunctionSyncResponseSchema,
        { result: { ...wireResult, status: "RUN_STATUS_FUTURE" } },
        "invoke sync response"
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(
        (error as SchemaValidationError).validationErrors?.join(" ")
      ).toContain("result.status");
    }
  });
});

describe("AckModeSchema", () => {
  it.each(["ACK_MODE_AUTO", "ACK_MODE_MANUAL", "ACK_MODE_UNSPECIFIED"])(
    "accepts valid value: %s",
    (value) => {
      expect(AckModeSchema.parse(value)).toBe(value);
    }
  );

  it("rejects invalid value", () => {
    expect(() => AckModeSchema.parse("INVALID")).toThrow();
  });
});

describe("BackpressureModeSchema", () => {
  it.each([
    "BACKPRESSURE_MODE_DROP",
    "BACKPRESSURE_MODE_BLOCK",
    "BACKPRESSURE_MODE_BUFFER",
    "BACKPRESSURE_MODE_UNSPECIFIED",
  ])("accepts valid value: %s", (value) => {
    expect(BackpressureModeSchema.parse(value)).toBe(value);
  });

  it("rejects invalid value", () => {
    expect(() => BackpressureModeSchema.parse("INVALID")).toThrow();
  });
});

describe("ConsumerGroupStatusSchema", () => {
  it.each([
    "CONSUMER_GROUP_STATUS_ACTIVE",
    "CONSUMER_GROUP_STATUS_PAUSED",
    "CONSUMER_GROUP_STATUS_DELETED",
    "CONSUMER_GROUP_STATUS_UNSPECIFIED",
  ])("accepts valid value: %s", (value) => {
    expect(ConsumerGroupStatusSchema.parse(value)).toBe(value);
  });

  it("rejects invalid value", () => {
    expect(() => ConsumerGroupStatusSchema.parse("INVALID")).toThrow();
  });
});

describe("ConsumerGroupResponseSchema", () => {
  it("validates a full consumer group response", () => {
    const result = ConsumerGroupResponseSchema.parse({
      id: "cg_1",
      namespace: "default",
      name: "my-group",
      pattern: "orders.*",
      ackMode: "ACK_MODE_MANUAL",
      backpressure: "BACKPRESSURE_MODE_BUFFER",
      maxInflight: 100,
      maxRedeliveries: 3,
      redeliverDelayMs: 5000,
      status: "CONSUMER_GROUP_STATUS_ACTIVE",
      memberCount: 2,
    });
    expect(result.id).toBe("cg_1");
    expect(result.name).toBe("my-group");
  });

  it("validates with only required fields", () => {
    const result = ConsumerGroupResponseSchema.parse({
      id: "cg_1",
      namespace: "default",
      name: "my-group",
      pattern: "orders.*",
    });
    expect(result.ackMode).toBeUndefined();
    expect(result.memberCount).toBeUndefined();
  });
});

describe("ListConsumerGroupsResponseSchema", () => {
  it("validates response with groups", () => {
    const result = ListConsumerGroupsResponseSchema.parse({
      groups: [{ id: "cg_1", namespace: "default", name: "g1", pattern: "*" }],
      totalCount: 1,
      nextCursor: "cursor_abc",
    });
    expect(result.groups).toHaveLength(1);
    expect(result.totalCount).toBe(1);
  });

  it("validates empty response", () => {
    const result = ListConsumerGroupsResponseSchema.parse({});
    expect(result.groups).toBeUndefined();
  });
});

describe("RegisterFunctionResponseSchema", () => {
  it("validates created response", () => {
    const result = RegisterFunctionResponseSchema.parse({ created: true });
    expect(result.created).toBe(true);
  });

  it("validates empty response", () => {
    const result = RegisterFunctionResponseSchema.parse({});
    expect(result.created).toBeUndefined();
  });
});

describe("runStatusToWire (#1919)", () => {
  it("encodes every public status to its canonical proto enum name", () => {
    expect(runStatusToWire("running")).toBe("RUN_STATUS_RUNNING");
    expect(runStatusToWire("completed")).toBe("RUN_STATUS_COMPLETED");
    expect(runStatusToWire("failed")).toBe("RUN_STATUS_FAILED");
    expect(runStatusToWire("cancelled")).toBe("RUN_STATUS_CANCELLED");
    expect(runStatusToWire("paused")).toBe("RUN_STATUS_PAUSED");
    expect(runStatusToWire("waiting_for_capacity")).toBe(
      "RUN_STATUS_WAITING_FOR_CAPACITY"
    );
    expect(runStatusToWire("waiting")).toBe("RUN_STATUS_WAITING");
  });

  it("round-trips with runStatusFromWire", () => {
    for (const status of [
      "running",
      "completed",
      "failed",
      "cancelled",
      "paused",
      "waiting_for_capacity",
      "waiting",
    ] as const) {
      expect(runStatusFromWire(runStatusToWire(status))).toBe(status);
    }
  });

  // The proto RESERVES RUN_STATUS_PENDING, so a bare uppercase transform would
  // mint a value the server silently discards. It must fail client-side.
  it("rejects the retired pending status", () => {
    expect(() => runStatusToWire("pending")).toThrow();
  });

  // A plain object literal would resolve these off Object.prototype, return a
  // truthy function, and silently send an unfiltered request.
  it("rejects inherited object properties", () => {
    expect(() => runStatusToWire("toString")).toThrow();
    expect(() => runStatusToWire("constructor")).toThrow();
    expect(() => runStatusToWire("hasOwnProperty")).toThrow();
    expect(() => runStatusToWire("__proto__")).toThrow();
  });

  it("rejects unknown and non-string values", () => {
    expect(() => runStatusToWire("nonsense")).toThrow();
    expect(() => runStatusToWire("COMPLETED")).toThrow();
    expect(() => runStatusToWire("RUN_STATUS_COMPLETED")).toThrow();
    expect(() => runStatusToWire(undefined)).toThrow();
    expect(() => runStatusToWire(3)).toThrow();
  });
});
