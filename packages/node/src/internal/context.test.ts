import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionContext, BranchContext } from "./context.js";
import { assertDefined } from "./assert-defined.js";
import { EventSource, createEventDefinitionRegistry, defineEvent, type PushRequest, type StepResult } from "@ironflow/core";

// Helper to create a minimal valid PushRequest
function createPushRequest(overrides: Partial<PushRequest> = {}): PushRequest {
  return {
    run_id: "run-123",
    function_id: "test-function",
    attempt: 1,
    event: {
      id: "evt-1",
      name: "test.event",
      data: { key: "value" },
      timestamp: "2024-01-01T00:00:00Z",
    },
    steps: [],
    ...overrides,
  };
}

describe("ExecutionContext", () => {
  describe("constructor", () => {
    it("should initialize with run information", () => {
      const request = createPushRequest();
      const ctx = new ExecutionContext(request);

      expect(ctx.runId).toBe("run-123");
      expect(ctx.functionId).toBe("test-function");
      expect(ctx.attempt).toBe(1);
    });

    it("should parse event from request", () => {
      const request = createPushRequest({
        event: {
          id: "evt-custom",
          name: "order.created",
          data: { orderId: "123" },
          timestamp: "2024-06-15T12:00:00Z",
          idempotency_key: "idp-key-1",
          source: EventSource.WEBHOOK,
          metadata: { trace_id: "abc" },
        },
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.event.id).toBe("evt-custom");
      expect(ctx.event.name).toBe("order.created");
      expect(ctx.event.data).toEqual({ orderId: "123" });
      expect(ctx.event.timestamp).toBeInstanceOf(Date);
      expect(ctx.event.idempotencyKey).toBe("idp-key-1");
      expect(ctx.event.source).toBe(EventSource.WEBHOOK);
      expect(ctx.event.metadata).toEqual({ trace_id: "abc" });
    });

    it("should build run info", () => {
      const request = createPushRequest();
      const ctx = new ExecutionContext(request);

      expect(ctx.runInfo.id).toBe("run-123");
      expect(ctx.runInfo.functionId).toBe("test-function");
      expect(ctx.runInfo.attempt).toBe(1);
      expect(ctx.runInfo.startedAt).toBeInstanceOf(Date);
    });

    it("should provide logger", () => {
      const ctx = new ExecutionContext(createPushRequest());

      expect(ctx.logger).toBeDefined();
      expect(typeof ctx.logger.debug).toBe("function");
      expect(typeof ctx.logger.info).toBe("function");
      expect(typeof ctx.logger.warn).toBe("function");
      expect(typeof ctx.logger.error).toBe("function");
    });

    it("should accept custom logger", () => {
      const customLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const ctx = new ExecutionContext(createPushRequest(), customLogger);

      ctx.logger.info("test");
      expect(customLogger.info).toHaveBeenCalledWith("test");
    });

    it("should store completed steps for memoization", () => {
      const request = createPushRequest({
        steps: [
          { id: "run-123:step1:0", name: "step1", status: "completed", output: { result: "done" } },
          { id: "run-123:step2:0", name: "step2", status: "completed", output: 42 },
        ],
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.shouldSkipStep("run-123:step1:0")).toBe(true);
      expect(ctx.shouldSkipStep("run-123:step2:0")).toBe(true);
      expect(ctx.shouldSkipStep("run-123:step3:0")).toBe(false);
    });

    it("should store resume context", () => {
      const request = createPushRequest({
        resume: {
          step_id: "run-123:sleepStep:0",
          type: "sleep",
        },
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.isResumingFrom("run-123:sleepStep:0", "sleep")).toBe(true);
      expect(ctx.isResumingFrom("run-123:sleepStep:0", "wait_for_event")).toBe(false);
      expect(ctx.isResumingFrom("other-step:0", "sleep")).toBe(false);
    });
  });

  describe("generateStepId", () => {
    it("should generate unique step IDs", () => {
      const ctx = new ExecutionContext(createPushRequest());

      const id1 = ctx.generateStepId("myStep");
      const id2 = ctx.generateStepId("myStep");
      const id3 = ctx.generateStepId("otherStep");

      expect(id1).toBe("run-123:myStep:0");
      expect(id2).toBe("run-123:myStep:1");
      expect(id3).toBe("run-123:otherStep:0");
    });

    it("should include run ID in step ID", () => {
      const ctx = new ExecutionContext(createPushRequest({ run_id: "custom-run-id" }));

      const stepId = ctx.generateStepId("test");
      expect(stepId).toContain("custom-run-id");
    });

    it("should increment counter per step name", () => {
      const ctx = new ExecutionContext(createPushRequest());

      // Create multiple steps with same name
      for (let i = 0; i < 5; i++) {
        const id = ctx.generateStepId("repeatedStep");
        expect(id).toBe(`run-123:repeatedStep:${i}`);
      }
    });
  });

  describe("memoization", () => {
    it("should skip completed steps", () => {
      const request = createPushRequest({
        steps: [
          { id: "run-123:memoized:0", name: "memoized", status: "completed", output: "cached" },
        ],
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.shouldSkipStep("run-123:memoized:0")).toBe(true);
    });

    it("should not skip failed steps", () => {
      const request = createPushRequest({
        steps: [
          { id: "run-123:failed:0", name: "failed", status: "failed", error: "oops" },
        ],
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.shouldSkipStep("run-123:failed:0")).toBe(false);
    });

    it("should return memoized output", () => {
      const request = createPushRequest({
        steps: [
          { id: "run-123:step:0", name: "step", status: "completed", output: { data: [1, 2, 3] } },
        ],
      });
      const ctx = new ExecutionContext(request);

      const output = ctx.getMemoizedOutput<{ data: number[] }>("run-123:step:0");
      expect(output).toEqual({ data: [1, 2, 3] });
    });

    it("should return undefined for non-existent step", () => {
      const ctx = new ExecutionContext(createPushRequest());

      expect(ctx.getMemoizedOutput("nonexistent")).toBeUndefined();
    });

    it("should return undefined for non-completed step", () => {
      const request = createPushRequest({
        steps: [
          { id: "run-123:failed:0", name: "failed", status: "failed", error: "error" },
        ],
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.getMemoizedOutput("run-123:failed:0")).toBeUndefined();
    });
  });

  describe("resume context", () => {
    it("should detect resume from sleep", () => {
      const request = createPushRequest({
        resume: { step_id: "run-123:sleep:0", type: "sleep" },
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.isResumingFrom("run-123:sleep:0", "sleep")).toBe(true);
    });

    it("should detect resume from wait_for_event", () => {
      const request = createPushRequest({
        resume: {
          step_id: "run-123:wait:0",
          type: "wait_for_event",
          data: { eventId: "evt-matching", payload: { approved: true } },
        },
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.isResumingFrom("run-123:wait:0", "wait_for_event")).toBe(true);
      expect(ctx.getResumeData()).toEqual({ eventId: "evt-matching", payload: { approved: true } });
    });

    it("should mark resume as processed", () => {
      const request = createPushRequest({
        resume: { step_id: "run-123:step:0", type: "sleep" },
      });
      const ctx = new ExecutionContext(request);

      expect(ctx.hasResumeBeenProcessed()).toBe(false);
      ctx.markResumeProcessed();
      expect(ctx.hasResumeBeenProcessed()).toBe(true);
    });

    it("should return false when no resume context", () => {
      const ctx = new ExecutionContext(createPushRequest());

      expect(ctx.isResumingFrom("any-step", "sleep")).toBe(false);
    });
  });

  describe("step recording", () => {
    it("should record executed steps", () => {
      const ctx = new ExecutionContext(createPushRequest());

      const step1: StepResult = {
        id: "run-123:step1:0",
        name: "step1",
        type: "invoke",
        status: "completed",
        started_at: "2024-01-01T00:00:00Z",
        ended_at: "2024-01-01T00:00:01Z",
        duration_ms: 1000,
        output: "result1",
      };

      const step2: StepResult = {
        id: "run-123:step2:0",
        name: "step2",
        type: "invoke",
        status: "completed",
        started_at: "2024-01-01T00:00:01Z",
        ended_at: "2024-01-01T00:00:02Z",
        duration_ms: 1000,
        output: "result2",
      };

      ctx.recordStep(step1);
      ctx.recordStep(step2);

      const executed = ctx.getExecutedSteps();
      expect(executed).toHaveLength(2);
      expect(executed[0]).toEqual(step1);
      expect(executed[1]).toEqual(step2);
    });

    it("should return a copy of executed steps", () => {
      const ctx = new ExecutionContext(createPushRequest());

      ctx.recordStep({
        id: "s1",
        name: "test",
        type: "invoke",
        status: "completed",
        started_at: "",
        ended_at: "",
        duration_ms: 0,
      });

      const steps1 = ctx.getExecutedSteps();
      const steps2 = ctx.getExecutedSteps();

      expect(steps1).not.toBe(steps2); // Different array instances
      expect(steps1).toEqual(steps2); // Same content
    });
  });

  describe("upcasting", () => {
    it("should upcast event data when eventDefinitions are provided", () => {
      const registry = createEventDefinitionRegistry();
      registry.register(defineEvent({ name: "order.created", version: 1 }));
      registry.register(defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: unknown) => ({
          ...(data as Record<string, unknown>),
          currency: "USD",
        }),
      }));

      const request = createPushRequest({
        event: {
          id: "evt-1",
          name: "order.created",
          version: 1,
          data: { orderId: "123", total: 50 },
          timestamp: "2024-01-01T00:00:00Z",
        },
      });

      const ctx = new ExecutionContext(request, undefined, registry);

      expect(ctx.event.data).toEqual({
        orderId: "123",
        total: 50,
        currency: "USD",
      });
      expect(ctx.event.version).toBe(1);
    });

    it("should not modify event data when no eventDefinitions provided", () => {
      const request = createPushRequest({
        event: {
          id: "evt-1",
          name: "order.created",
          version: 1,
          data: { orderId: "123" },
          timestamp: "2024-01-01T00:00:00Z",
        },
      });

      const ctx = new ExecutionContext(request);

      expect(ctx.event.data).toEqual({ orderId: "123" });
    });

    it("should not modify event data when event is already at latest version", () => {
      const registry = createEventDefinitionRegistry();
      registry.register(defineEvent({ name: "order.created", version: 1 }));
      registry.register(defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: unknown) => ({
          ...(data as Record<string, unknown>),
          currency: "USD",
        }),
      }));

      const request = createPushRequest({
        event: {
          id: "evt-1",
          name: "order.created",
          version: 2,
          data: { orderId: "123", currency: "EUR" },
          timestamp: "2024-01-01T00:00:00Z",
        },
      });

      const ctx = new ExecutionContext(request, undefined, registry);

      expect(ctx.event.data).toEqual({ orderId: "123", currency: "EUR" });
    });

    it("should chain multiple upcasters", () => {
      const registry = createEventDefinitionRegistry();
      registry.register(defineEvent({ name: "order.created", version: 1 }));
      registry.register(defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: unknown) => ({
          ...(data as Record<string, unknown>),
          currency: "USD",
        }),
      }));
      registry.register(defineEvent({
        name: "order.created",
        version: 3,
        upcast: (data: unknown) => ({
          ...(data as Record<string, unknown>),
          version: "v3",
        }),
      }));

      const request = createPushRequest({
        event: {
          id: "evt-1",
          name: "order.created",
          version: 1,
          data: { orderId: "123" },
          timestamp: "2024-01-01T00:00:00Z",
        },
      });

      const ctx = new ExecutionContext(request, undefined, registry);

      expect(ctx.event.data).toEqual({
        orderId: "123",
        currency: "USD",
        version: "v3",
      });
    });

    it("should default to version 1 when event has no version", () => {
      const registry = createEventDefinitionRegistry();
      registry.register(defineEvent({ name: "order.created", version: 1 }));
      registry.register(defineEvent({
        name: "order.created",
        version: 2,
        upcast: (data: unknown) => ({
          ...(data as Record<string, unknown>),
          upgraded: true,
        }),
      }));

      const request = createPushRequest({
        event: {
          id: "evt-1",
          name: "order.created",
          data: { orderId: "123" },
          timestamp: "2024-01-01T00:00:00Z",
        },
      });

      const ctx = new ExecutionContext(request, undefined, registry);

      expect(ctx.event.data).toEqual({ orderId: "123", upgraded: true });
    });
  });

  describe("createBranchContext", () => {
    it("should create a branch context", () => {
      const ctx = new ExecutionContext(createPushRequest());
      const branch = ctx.createBranchContext("parallel", 0);

      expect(branch).toBeInstanceOf(BranchContext);
    });

    it("should scope step IDs to branch", () => {
      const ctx = new ExecutionContext(createPushRequest());
      const branch0 = ctx.createBranchContext("parallel", 0);
      const branch1 = ctx.createBranchContext("parallel", 1);

      const id0 = branch0.generateStepId("step");
      const id1 = branch1.generateStepId("step");

      expect(id0).toContain(":parallel:0:");
      expect(id1).toContain(":parallel:1:");
      expect(id0).not.toBe(id1);
    });
  });
});

describe("BranchContext", () => {
  let parentCtx: ExecutionContext;

  beforeEach(() => {
    parentCtx = new ExecutionContext(createPushRequest({
      steps: [
        { id: "run-123:parallel:0:memoized:0", name: "memoized", status: "completed", output: "cached" },
      ],
      resume: { step_id: "run-123:parallel:1:wait:0", type: "wait_for_event", data: { event: "test" } },
    }));
  });

  describe("generateStepId", () => {
    it("should generate scoped step IDs", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      const id = branch.generateStepId("myStep");
      expect(id).toBe("run-123:parallel:0:myStep:0");
    });

    it("should maintain independent counters per branch", () => {
      const branch0 = parentCtx.createBranchContext("parallel", 0);
      const branch1 = parentCtx.createBranchContext("parallel", 1);

      expect(branch0.generateStepId("step")).toBe("run-123:parallel:0:step:0");
      expect(branch0.generateStepId("step")).toBe("run-123:parallel:0:step:1");
      expect(branch1.generateStepId("step")).toBe("run-123:parallel:1:step:0");
    });
  });

  describe("nesting", () => {
    it("should support nested branch contexts", () => {
      const branch0 = parentCtx.createBranchContext("outer", 0);
      const nestedBranch = branch0.createBranchContext("inner", 1);

      const id = nestedBranch.generateStepId("deepStep");
      expect(id).toBe("run-123:outer:0:inner:1:deepStep:0");
    });
  });

  describe("delegation to parent", () => {
    it("should delegate shouldSkipStep to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      expect(branch.shouldSkipStep("run-123:parallel:0:memoized:0")).toBe(true);
      expect(branch.shouldSkipStep("nonexistent")).toBe(false);
    });

    it("should delegate getMemoizedOutput to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      expect(branch.getMemoizedOutput("run-123:parallel:0:memoized:0")).toBe("cached");
      expect(branch.getMemoizedOutput("nonexistent")).toBeUndefined();
    });

    it("should delegate isResumingFrom to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 1);

      expect(branch.isResumingFrom("run-123:parallel:1:wait:0", "wait_for_event")).toBe(true);
      expect(branch.isResumingFrom("other", "sleep")).toBe(false);
    });

    it("should delegate getResumeData to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 1);

      expect(branch.getResumeData()).toEqual({ event: "test" });
    });

    it("should delegate markResumeProcessed to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      branch.markResumeProcessed();

      expect(parentCtx.hasResumeBeenProcessed()).toBe(true);
    });

    it("should delegate recordStep to parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      branch.recordStep({
        id: "run-123:parallel:0:branchStep:0",
        name: "branchStep",
        type: "invoke",
        status: "completed",
        started_at: "",
        ended_at: "",
        duration_ms: 0,
      });

      const parentSteps = parentCtx.getExecutedSteps();
      expect(parentSteps).toHaveLength(1);
      expect(assertDefined(parentSteps[0]).id).toBe("run-123:parallel:0:branchStep:0");
    });
  });

  describe("properties", () => {
    it("should expose runId from parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      expect(branch.runId).toBe("run-123");
    });

    it("should expose logger from parent", () => {
      const branch = parentCtx.createBranchContext("parallel", 0);

      expect(branch.logger).toBe(parentCtx.logger);
    });
  });
});
