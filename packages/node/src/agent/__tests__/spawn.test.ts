import { describe, expect, it, vi } from "vitest";
import type { CompletedStep, StepClient } from "@ironflow/core";
import { ExecutionContext } from "../../internal/context.js";
import { YieldSignal } from "../../internal/errors.js";
import { createStepClient } from "../../step.js";
import { makeSpawn } from "../spawn.js";

describe("makeSpawn()", () => {
  it("await=true (default): uses step.invoke and returns the output, runId omitted", async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: 42 }));
    const step = { invoke } as unknown as StepClient;

    const spawn = makeSpawn(step);
    const result = await spawn("child", { functionId: "child-fn", input: { x: 1 } });

    expect(invoke).toHaveBeenCalledWith("child-fn", { x: 1 });
    expect(result.output).toEqual({ ok: true, value: 42 });
    expect(result.runId).toBeUndefined();
  });

  it("await=false: returns the child runId without waiting for its output", async () => {
    const invokeAsync = vi.fn(async () => ({ runId: "child-run-1" }));
    const stepRun = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
    const step = {
      invokeAsync,
      run: stepRun,
    } as unknown as StepClient;

    const spawn = makeSpawn(step);
    const result = await spawn("child", {
      functionId: "child-fn",
      input: { x: 1 },
      await: false,
    });

    expect(invokeAsync).toHaveBeenCalledWith("child-fn", { x: 1 });
    expect(stepRun).not.toHaveBeenCalled();
    expect(result.runId).toBe("child-run-1");
    expect(result.output).toBeUndefined();
  });

  it.each(["spawn", "invokeAsync"] as const)(
    "%s invokes all five children across replays without duplicating completed invocations",
    async (method) => {
      const completed = new Map<string, CompletedStep>();
      const invokedInputs: unknown[] = [];
      const outputs: Array<Array<string | undefined>> = [];

      // Five engine yields, then completion and one extra replay after completion.
      for (let attempt = 1; attempt <= 7; attempt++) {
        const ctx = new ExecutionContext({
          run_id: "parent-run",
          function_id: "parent",
          attempt,
          event: {
            id: "event-1",
            name: "test.fan-out",
            data: {},
            timestamp: "2026-09-09T00:00:00Z",
          },
          steps: [...completed.values()],
        }, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
        const step = createStepClient(ctx);
        const spawn = makeSpawn(step);

        try {
          const runIds: Array<string | undefined> = [];
          for (const cluster of [1, 2, 3, 4, 5]) {
            const result = method === "spawn"
              ? await spawn(`open-case-${cluster}`, {
                functionId: "child-fn", input: { cluster }, await: false,
              })
              : await step.invokeAsync("child-fn", { cluster });
            runIds.push(result.runId);
          }
          outputs.push(runIds);
        } catch (error) {
          if (!(error instanceof YieldSignal) || error.yieldInfo.type !== "invoke_function_async") {
            throw error;
          }
          const info = error.yieldInfo;
          expect(info.function_id).toBe("child-fn");
          invokedInputs.push(info.input);
          // Model the engine creating a child and persisting the invocation output.
          completed.set(info.step_id, {
            id: info.step_id,
            name: info.function_id,
            status: "completed",
            output: { run_id: `child-run-${invokedInputs.length}` },
          });
        } finally {
          // Wrappers completed before a yield must survive the next replay too.
          for (const result of ctx.getExecutedSteps()) {
            expect(result.status).toBe("completed");
            completed.set(result.id, {
              id: result.id, name: result.name, status: "completed", output: result.output,
            });
          }
        }
      }

      expect(invokedInputs).toEqual([
        { cluster: 1 }, { cluster: 2 }, { cluster: 3 }, { cluster: 4 }, { cluster: 5 },
      ]);
      const expectedRunIds = ["child-run-1", "child-run-2", "child-run-3", "child-run-4", "child-run-5"];
      expect(outputs).toEqual([expectedRunIds, expectedRunIds]);
    },
  );
});
