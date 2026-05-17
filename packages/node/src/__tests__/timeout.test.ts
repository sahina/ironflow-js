import { describe, it, expect } from "vitest";
import { createStepClient } from "../step.js";
import { ExecutionContext } from "../internal/context.js";
import { assertDefined } from "../internal/assert-defined.js";
import { StepTimeoutError } from "@ironflow/core";

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-timeout-test",
    function_id: "fn-timeout",
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

describe("step.run() timeout", () => {
  it("completes normally when step finishes before timeout", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    const result = await step.run(
      "fast-step",
      async () => "done",
      { timeout: "5s" }
    );
    expect(result).toBe("done");
  });

  it("throws StepTimeoutError when step exceeds timeout", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    await expect(
      step.run(
        "slow-step",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return "never";
        },
        { timeout: "50ms" }
      )
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it("StepTimeoutError contains step name and timeout", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    try {
      await step.run(
        "my-slow-step",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return "never";
        },
        { timeout: "50ms" }
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StepTimeoutError);
      const timeoutErr = err as StepTimeoutError;
      expect(timeoutErr.stepName).toBe("my-slow-step");
      expect(timeoutErr.timeout).toBe("50ms");
      expect(timeoutErr.retryable).toBe(true);
    }
  });

  it("records timed-out step as failed", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    try {
      await step.run(
        "timeout-step",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return "never";
        },
        { timeout: "50ms" }
      );
    } catch {
      // expected
    }

    const steps = ctx.getExecutedSteps();
    expect(steps.length).toBe(1);
    const step0 = assertDefined(steps[0], "steps[0]");
    expect(step0.status).toBe("failed");
    expect(step0.error?.message).toContain("timed out");
  });

  it("uses function-level stepTimeout as default", async () => {
    const ctx = new ExecutionContext(createRequest(), undefined, undefined, "50ms");
    const step = createStepClient(ctx);

    await expect(
      step.run("slow-step", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return "never";
      })
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it("step-level timeout overrides function-level default", async () => {
    const ctx = new ExecutionContext(createRequest(), undefined, undefined, "10ms");
    const step = createStepClient(ctx);

    // Step-level timeout of 5s should override function-level 10ms
    const result = await step.run(
      "fast-step",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "done";
      },
      { timeout: "5s" }
    );
    expect(result).toBe("done");
  });

  it("no timeout when neither step-level nor function-level set", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    const result = await step.run("no-timeout-step", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "done";
    });
    expect(result).toBe("done");
  });

  it("returns memoized result without applying timeout", async () => {
    const stepId = "run-timeout-test:cached-step:0";
    const ctx = new ExecutionContext(
      createRequest({
        steps: [
          {
            id: stepId,
            name: "cached-step",
            status: "completed",
            output: "cached-value",
          },
        ],
      })
    );
    const step = createStepClient(ctx);

    // Even with a tiny timeout, memoized step should return immediately
    const result = await step.run(
      "cached-step",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return "never";
      },
      { timeout: "1ms" }
    );
    expect(result).toBe("cached-value");
  });
});
