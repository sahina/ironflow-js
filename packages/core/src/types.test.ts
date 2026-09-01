import { describe, it, expect } from "vitest";
import {
  createRunId,
  createFunctionId,
  createStepId,
  createEventId,
  createJobId,
  createWorkerId,
  createSubscriptionId,
  type RunId,
  type FunctionId,
  type StepId,
  type EventId,
  type JobId,
  type WorkerId,
  type SubscriptionId,
  type EmitSyncResult,
  type InvokeSyncResult,
  type InvokeSyncOptions,
} from "./types.js";

describe("EmitSyncResult", () => {
  it("carries the per-run outcome emitSync() no longer throws for", () => {
    const result: EmitSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      status: "failed",
      output: undefined,
      error: { message: "boom", code: "STEP_FAILED" },
      durationMs: 12,
      waitTimedOut: false,
    };

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("boom");
    expect(result.waitTimedOut).toBe(false);
  });

  it("reports an expired wait budget on a run that is still alive", () => {
    const result: EmitSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      status: "running",
      output: undefined,
      durationMs: 30_000,
      waitTimedOut: true,
    };

    expect(result.waitTimedOut).toBe(true);
    expect(result.status).toBe("running");
  });

  it("rejects a status outside RunStatus", () => {
    const result: EmitSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      // @ts-expect-error status is RunStatus since #1920 — an unknown wire status
      // throws SchemaValidationError during parsing and never reaches a caller.
      status: "RUN_STATUS_FUTURE",
      output: undefined,
      durationMs: 0,
      waitTimedOut: false,
    };

    expect(result.runId).toBe("run-1");
  });

  it("requires waitTimedOut so a mapper cannot silently drop it", () => {
    // @ts-expect-error waitTimedOut is required on the per-run shape.
    const result: EmitSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      status: "completed",
      output: undefined,
      durationMs: 0,
    };

    expect(result.runId).toBe("run-1");
  });

  it("is an array-per-call shape: one element per matched run", () => {
    const results: EmitSyncResult[] = [
      { runId: "run-1", functionId: "fn-1", status: "completed", output: 1, durationMs: 1, waitTimedOut: false },
      { runId: "run-2", functionId: "fn-2", status: "failed", output: undefined, durationMs: 2, waitTimedOut: false },
    ];

    expect(results.map((r) => r.functionId)).toEqual(["fn-1", "fn-2"]);
  });
});

describe("InvokeSyncResult", () => {
  it("drops waitTimedOut — invoke() throws RunWaitTimeoutError instead", () => {
    const result: InvokeSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      status: "completed",
      output: { ok: true },
      durationMs: 5,
    };

    expect(result.output).toEqual({ ok: true });
    // @ts-expect-error waitTimedOut is not part of the single-run invoke shape.
    expect(result.waitTimedOut).toBeUndefined();
  });

  it("accepts a mapped EmitSyncResult — the wire shape is the same RunResult", () => {
    const perRun: EmitSyncResult = {
      runId: "run-1",
      functionId: "fn-1",
      status: "completed",
      output: undefined,
      durationMs: 5,
      waitTimedOut: false,
    };
    const result: InvokeSyncResult = perRun;

    expect(result.runId).toBe("run-1");
  });
});

describe("InvokeSyncOptions", () => {
  it("carries the wait budget, dedup key and metadata", () => {
    const options: InvokeSyncOptions<{ orderId: string }> = {
      data: { orderId: "123" },
      timeout: 60_000,
      idempotencyKey: "key-1",
      metadata: { source: "test" },
    };

    expect(options.data.orderId).toBe("123");
    expect(options.timeout).toBe(60_000);
    expect(options.idempotencyKey).toBe("key-1");
  });

  it("requires only data", () => {
    const options: InvokeSyncOptions = { data: null };
    expect(options.timeout).toBeUndefined();
  });
});

describe("Branded ID Factories", () => {
  describe("createRunId", () => {
    it("should create a RunId from string", () => {
      const id = createRunId("run-123");
      expect(id).toBe("run-123");
    });

    it("should preserve the original string value", () => {
      const original = "run-abc-def-123";
      const id = createRunId(original);
      expect(String(id)).toBe(original);
    });

    it("should work with empty string", () => {
      const id = createRunId("");
      expect(id).toBe("");
    });

    it("should be usable as a string", () => {
      const id: RunId = createRunId("run-1");
      const str: string = id;
      expect(str).toBe("run-1");
    });
  });

  describe("createFunctionId", () => {
    it("should create a FunctionId from string", () => {
      const id = createFunctionId("my-function");
      expect(id).toBe("my-function");
    });

    it("should be usable as a string", () => {
      const id: FunctionId = createFunctionId("fn-1");
      const str: string = id;
      expect(str).toBe("fn-1");
    });
  });

  describe("createStepId", () => {
    it("should create a StepId from string", () => {
      const id = createStepId("step-456");
      expect(id).toBe("step-456");
    });

    it("should be usable as a string", () => {
      const id: StepId = createStepId("step-1");
      const str: string = id;
      expect(str).toBe("step-1");
    });
  });

  describe("createEventId", () => {
    it("should create an EventId from string", () => {
      const id = createEventId("evt-789");
      expect(id).toBe("evt-789");
    });

    it("should be usable as a string", () => {
      const id: EventId = createEventId("evt-1");
      const str: string = id;
      expect(str).toBe("evt-1");
    });
  });

  describe("createJobId", () => {
    it("should create a JobId from string", () => {
      const id = createJobId("job-123");
      expect(id).toBe("job-123");
    });

    it("should be usable as a string", () => {
      const id: JobId = createJobId("job-1");
      const str: string = id;
      expect(str).toBe("job-1");
    });
  });

  describe("createWorkerId", () => {
    it("should create a WorkerId from string", () => {
      const id = createWorkerId("worker-abc");
      expect(id).toBe("worker-abc");
    });

    it("should be usable as a string", () => {
      const id: WorkerId = createWorkerId("worker-1");
      const str: string = id;
      expect(str).toBe("worker-1");
    });
  });

  describe("createSubscriptionId", () => {
    it("should create a SubscriptionId from string", () => {
      const id = createSubscriptionId("sub-xyz");
      expect(id).toBe("sub-xyz");
    });

    it("should be usable as a string", () => {
      const id: SubscriptionId = createSubscriptionId("sub-1");
      const str: string = id;
      expect(str).toBe("sub-1");
    });
  });

  describe("Type safety", () => {
    it("branded IDs can be compared with strings", () => {
      const runId = createRunId("run-1");
      expect(runId === "run-1").toBe(true);
    });

    it("branded IDs can be used in string operations", () => {
      const runId = createRunId("run-123");
      expect(runId.startsWith("run-")).toBe(true);
      expect(runId.length).toBe(7);
    });

    it("branded IDs can be concatenated", () => {
      const runId = createRunId("run-1");
      const stepId = createStepId("step-1");
      const combined = `${runId}:${stepId}`;
      expect(combined).toBe("run-1:step-1");
    });

    it("branded IDs can be used in template literals", () => {
      const id = createEventId("evt-123");
      const msg = `Event ID: ${id}`;
      expect(msg).toBe("Event ID: evt-123");
    });

    it("branded IDs can be used as object keys", () => {
      const id = createRunId("run-1");
      const obj: Record<string, number> = { [id]: 42 };
      expect(obj["run-1"]).toBe(42);
    });

    it("branded IDs can be used in arrays", () => {
      const ids = [
        createRunId("run-1"),
        createRunId("run-2"),
        createRunId("run-3"),
      ];
      expect(ids).toHaveLength(3);
      expect(ids.includes("run-2" as RunId)).toBe(true);
    });
  });
});
