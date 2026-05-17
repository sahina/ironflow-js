import { describe, it, expect } from "vitest";
import { AuditEventSchema } from "./schemas.js";
import type { FunctionConfig } from "./types.js";

describe("AuditEvent", () => {
  it("validates a well-formed audit event", () => {
    const event = {
      id: "ae-1",
      runId: "run-1",
      functionId: "fn-1",
      eventType: "step.completed",
      payload: { stepId: "s1", durationMs: 150 },
      createdAt: "2026-02-27T00:00:00Z",
    };
    expect(() => AuditEventSchema.parse(event)).not.toThrow();
  });

  it("validates audit event with metadata", () => {
    const event = {
      id: "ae-2",
      runId: "run-1",
      functionId: "fn-1",
      eventType: "run.created",
      payload: { runId: "run-1" },
      metadata: { user: "test", region: "us-east-1" },
      createdAt: "2026-02-27T00:00:00Z",
    };
    const parsed = AuditEventSchema.parse(event);
    expect(parsed.metadata).toEqual({ user: "test", region: "us-east-1" });
  });

  it("accepts optional stepId", () => {
    const event = {
      id: "ae-3",
      runId: "run-1",
      functionId: "fn-1",
      stepId: "step-1",
      eventType: "step.started",
      payload: {},
      createdAt: "2026-02-27T00:00:00Z",
    };
    const parsed = AuditEventSchema.parse(event);
    expect(parsed.stepId).toBe("step-1");
  });

  it("rejects audit event with empty id", () => {
    const event = {
      id: "",
      runId: "run-1",
      functionId: "fn-1",
      eventType: "step.completed",
      payload: {},
      createdAt: "2026-02-27T00:00:00Z",
    };
    expect(() => AuditEventSchema.parse(event)).toThrow();
  });

  it("rejects audit event with missing required fields", () => {
    const event = {
      id: "ae-1",
      // missing runId, functionId, eventType
      payload: {},
      createdAt: "2026-02-27T00:00:00Z",
    };
    expect(() => AuditEventSchema.parse(event)).toThrow();
  });
});

describe("FunctionConfig recording", () => {
  it("accepts recording config", () => {
    const config: FunctionConfig = {
      id: "test-fn",
      triggers: [{ event: "test.event" }],
      recording: true,
      recordingRetention: "90d",
    };
    expect(config.recording).toBe(true);
    expect(config.recordingRetention).toBe("90d");
  });

  it("recording fields are optional", () => {
    const config: FunctionConfig = {
      id: "test-fn",
      triggers: [{ event: "test.event" }],
    };
    expect(config.recording).toBeUndefined();
    expect(config.recordingRetention).toBeUndefined();
  });
});
