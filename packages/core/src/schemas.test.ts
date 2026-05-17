import { describe, it, expect } from "vitest";
import { EventSource } from "./types.js";
import {
  RunStatusSchema,
  CompletedStepSchema,
  ResumeContextSchema,
  PushRequestEventSchema,
  PushRequestSchema,
  TriggerResponseSchema,
  TriggerSyncResultItemSchema,
  TriggerSyncResponseSchema,
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
  it.each(["pending", "running", "completed", "failed", "cancelled", "paused"])(
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

  it("should validate minimal run response", () => {
    const response = {
      id: "run-1",
      functionId: "fn-1",
      eventId: "evt-1",
      status: "pending",
      attempt: 0,
      maxAttempts: 3,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(RunResponseSchema.parse(response)).toEqual(response);
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
      status: "completed",
      output: { result: true },
      durationMs: 150,
    });
    expect(result.runId).toBe("run_123");
    expect(result.status).toBe("completed");
    expect(result.durationMs).toBe(150);
  });

  it("validates without optional fields", () => {
    const result = TriggerSyncResultItemSchema.parse({
      runId: "run_123",
      functionId: "my-fn",
      status: "failed",
      durationMs: 50,
    });
    expect(result.output).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("validates with error field", () => {
    const result = TriggerSyncResultItemSchema.parse({
      runId: "run_123",
      functionId: "my-fn",
      status: "failed",
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

describe("TriggerSyncResponseSchema", () => {
  it("validates response with results", () => {
    const result = TriggerSyncResponseSchema.parse({
      eventId: "evt_123",
      results: [{
        runId: "run_1", functionId: "fn-1", status: "completed", durationMs: 100,
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
