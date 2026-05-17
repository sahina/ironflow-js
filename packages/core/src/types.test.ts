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
} from "./types.js";

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
