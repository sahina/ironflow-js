import { describe, it, expect } from "vitest";
import { createStepClient } from "../step.js";
import { YieldSignal, type InvokeFunctionYieldInfo } from "../internal/errors.js";
import { InvokeError } from "@ironflow/core";
import { ExecutionContext } from "../internal/context.js";

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-invoke-test",
    function_id: "fn-parent",
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

describe("step.invoke()", () => {
  it("throws YieldSignal with type invoke_function when not memoized", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    let thrown: unknown;
    try {
      await step.invoke("charge-card", { amount: 100 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(YieldSignal);
    const signal = thrown as YieldSignal;
    expect(signal.yieldInfo.type).toBe("invoke_function");
    if (signal.yieldInfo.type === "invoke_function") {
      expect(signal.yieldInfo.function_id).toBe("charge-card");
      expect(signal.yieldInfo.input).toEqual({ amount: 100 });
      expect(signal.yieldInfo.step_id).toContain("charge-card");
    }
  });

  it("returns memoized result when step is completed", async () => {
    const stepId = "run-invoke-test:charge-card:0";
    const ctx = new ExecutionContext(
      createRequest({
        steps: [
          {
            id: stepId,
            name: "charge-card",
            status: "completed",
            output: { charge_id: "ch_123" },
          },
        ],
      })
    );
    const step = createStepClient(ctx);

    const result = await step.invoke<{ charge_id: string }>("charge-card");
    expect(result).toEqual({ charge_id: "ch_123" });
  });

  it("throws InvokeError when step is memoized as failed", async () => {
    const stepId = "run-invoke-test:charge-card:0";
    const errorData = JSON.stringify({
      message: "invoked function 'charge-card' failed",
      function_id: "charge-card",
      child_run_id: "run-child-abc",
      cause: "card declined",
      retryable: false,
    });
    const ctx = new ExecutionContext(
      createRequest({
        steps: [
          {
            id: stepId,
            name: "charge-card",
            status: "failed",
            error: errorData,
          },
        ],
      })
    );
    const step = createStepClient(ctx);

    let thrown: unknown;
    try {
      await step.invoke("charge-card");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvokeError);
    const invokeErr = thrown as InvokeError;
    expect(invokeErr.functionId).toBe("charge-card");
    expect(invokeErr.childRunId).toBe("run-child-abc");
    expect(invokeErr.errorCause).toBe("card declined");
  });

  it("uses default timeout of 30000ms when no timeout option given", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    let thrown: unknown;
    try {
      await step.invoke("my-fn");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(YieldSignal);
    const signal = thrown as YieldSignal;
    const yieldInfo = signal.yieldInfo as InvokeFunctionYieldInfo;
    expect(yieldInfo.type).toBe("invoke_function");
    expect(yieldInfo.invoke_timeout_ms).toBe(30000);
  });

  it("parses timeout option and sets invoke_timeout_ms", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    let thrown: unknown;
    try {
      await step.invoke("my-fn", undefined, { timeout: "1m" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(YieldSignal);
    const signal = thrown as YieldSignal;
    const yieldInfo = signal.yieldInfo as InvokeFunctionYieldInfo;
    expect(yieldInfo.type).toBe("invoke_function");
    expect(yieldInfo.invoke_timeout_ms).toBe(60000);
  });

  it("throws InvokeError when step is timed_out", async () => {
    // A step with status "timed_out" should throw InvokeError, not re-yield
    const stepId = "run-invoke-test:charge-card:0";
    const timedOutRequest = createRequest({
      steps: [
        {
          id: stepId,
          name: "charge-card",
          status: "timed_out",
          output: undefined,
          error: undefined,
        },
      ],
    });

    const ctx1 = new ExecutionContext(timedOutRequest);
    const step1 = createStepClient(ctx1);
    await expect(step1.invoke("charge-card", { amount: 100 })).rejects.toBeInstanceOf(InvokeError);

    const ctx2 = new ExecutionContext(timedOutRequest);
    const step2 = createStepClient(ctx2);
    try {
      await step2.invoke("charge-card", { amount: 100 });
    } catch (e) {
      expect(e).toBeInstanceOf(InvokeError);
      const invokeErr = e as InvokeError;
      expect(invokeErr.errorCause).toContain("timed out");
    }
  });
});

describe("step.invokeAsync()", () => {
  it("throws YieldSignal with type invoke_function_async when not memoized", async () => {
    const ctx = new ExecutionContext(createRequest());
    const step = createStepClient(ctx);

    let thrown: unknown;
    try {
      await step.invokeAsync("send-email", { to: "user@example.com" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(YieldSignal);
    const signal = thrown as YieldSignal;
    expect(signal.yieldInfo.type).toBe("invoke_function_async");
    if (signal.yieldInfo.type === "invoke_function_async") {
      expect(signal.yieldInfo.function_id).toBe("send-email");
      expect(signal.yieldInfo.input).toEqual({ to: "user@example.com" });
      expect(signal.yieldInfo.step_id).toContain("send-email");
    }
  });

  it("returns { runId } when step is memoized as completed", async () => {
    const stepId = "run-invoke-test:send-email:0";
    const ctx = new ExecutionContext(
      createRequest({
        steps: [
          {
            id: stepId,
            name: "send-email",
            status: "completed",
            output: { run_id: "run-child-xyz" },
          },
        ],
      })
    );
    const step = createStepClient(ctx);

    const result = await step.invokeAsync("send-email");
    expect(result).toEqual({ runId: "run-child-xyz" });
  });
});
