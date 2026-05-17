import { describe, expect, it, vi } from "vitest";
import type { StepClient } from "@ironflow/core";
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

  it("await=false: uses step.invokeAsync wrapped in step.run, returns runId", async () => {
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
    expect(stepRun).toHaveBeenCalledWith("spawn.child", expect.any(Function));
    expect(result.runId).toBe("child-run-1");
    expect(result.output).toBeUndefined();
  });
});
