import { describe, it, expect, vi } from "vitest";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient, executeCompensations } from "./step.js";
import { assertDefined } from "./internal/assert-defined.js";

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-1",
    function_id: "fn-1",
    attempt: 1,
    event: {
      id: "evt-1",
      name: "test.event",
      data: {},
      timestamp: new Date().toISOString(),
    },
    steps: [],
    ...overrides,
  };
}

describe("step.compensate()", () => {
  it("registers compensation handler", () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    step.compensate("my-step", async () => {});

    expect(ctx.hasCompensations()).toBe(true);
  });

  it("throws when registering duplicate compensation", () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    step.compensate("my-step", async () => {});
    expect(() => step.compensate("my-step", async () => {})).toThrow(
      "Compensation already registered for step: my-step"
    );
  });

  it("no compensations run when all steps succeed", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    const compensateFn = vi.fn();
    await step.run("step-1", async () => "result");
    step.compensate("step-1", compensateFn);

    // No failure - compensation function should not have been called
    expect(compensateFn).not.toHaveBeenCalled();
  });
});

describe("executeCompensations()", () => {
  it("executes compensations in reverse order", async () => {
    const ctx = new ExecutionContext(createRequest());
    const order: string[] = [];

    ctx.registerCompensation("step-1", async () => { order.push("comp-1"); });
    ctx.registerCompensation("step-2", async () => { order.push("comp-2"); });
    ctx.registerCompensation("step-3", async () => { order.push("comp-3"); });

    await executeCompensations(ctx);

    expect(order).toEqual(["comp-3", "comp-2", "comp-1"]);
  });

  it("records compensation steps with correct type and fields", async () => {
    const ctx = new ExecutionContext(createRequest());

    ctx.registerCompensation("step-1", async () => {});

    await executeCompensations(ctx);

    const steps = ctx.getExecutedSteps();
    expect(steps).toHaveLength(1);
    const s0 = assertDefined(steps[0]);
    expect(s0.type).toBe("compensate");
    expect(s0.name).toBe("compensate:step-1");
    expect(s0.compensation_for).toBe("step-1");
    expect(s0.status).toBe("completed");
    expect(s0.started_at).toBeDefined();
    expect(s0.ended_at).toBeDefined();
  });

  it("skips memoized compensation steps", async () => {
    const compensateFn = vi.fn();
    const ctx = new ExecutionContext(createRequest({
      steps: [{
        id: "run-1:compensate:step-1:0",
        name: "compensate:step-1",
        status: "completed",
        output: null,
      }],
    }));

    ctx.registerCompensation("step-1", compensateFn);

    await executeCompensations(ctx);

    expect(compensateFn).not.toHaveBeenCalled();
  });

  it("continues executing remaining compensations on failure", async () => {
    const ctx = new ExecutionContext(createRequest());
    const order: string[] = [];

    ctx.registerCompensation("step-1", async () => { order.push("comp-1"); });
    ctx.registerCompensation("step-2", async () => { throw new Error("comp-2 failed"); });
    ctx.registerCompensation("step-3", async () => { order.push("comp-3"); });

    await executeCompensations(ctx);

    // step-3 runs first (reverse), then step-2 (fails), then step-1 continues
    expect(order).toEqual(["comp-3", "comp-1"]);

    const steps = ctx.getExecutedSteps();
    expect(steps).toHaveLength(3);

    // Find the failed compensation
    const failedStep = steps.find(s => s.name === "compensate:step-2");
    expect(failedStep?.status).toBe("failed");
    expect(failedStep?.error?.message).toBe("comp-2 failed");
  });

  it("records failed compensation with error details", async () => {
    const ctx = new ExecutionContext(createRequest());

    ctx.registerCompensation("step-1", async () => { throw new Error("refund failed"); });

    await executeCompensations(ctx);

    const steps = ctx.getExecutedSteps();
    expect(steps).toHaveLength(1);
    const s0 = assertDefined(steps[0]);
    expect(s0.status).toBe("failed");
    expect(s0.error?.message).toBe("refund failed");
    expect(s0.error?.retryable).toBe(false);
    expect(s0.compensation_for).toBe("step-1");
  });

  it("does nothing when no compensations registered", async () => {
    const ctx = new ExecutionContext(createRequest());

    expect(ctx.hasCompensations()).toBe(false);

    await executeCompensations(ctx);

    expect(ctx.getExecutedSteps()).toHaveLength(0);
  });
});
