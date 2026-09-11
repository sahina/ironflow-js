import { describe, expect, it, vi } from "vitest";
import type { Logger, PushRequest, StepClient } from "@ironflow/core";
import { ExecutionContext } from "./internal/context.js";
import { YieldSignal } from "./internal/errors.js";
import { functionCodeHash } from "./internal/register-functions.js";
import { createStepClient } from "./step.js";

// Opt-in evidence for #2164. These assertions describe the defect, not a
// supported contract. Retire them when ADR 0081 gets routing regression tests.
describe.skipIf(process.env.IRONFLOW_REPRO_2164 !== "1")("executable identity reproduction", () => {
  it("resumes v2 with v1 results despite an identical handler-source hash", async () => {
    const makeHandler = (revision: string, quote: () => Promise<number>) =>
      async (step: StepClient) => {
        const amount = await step.run("quote", quote);
        await step.waitForEvent("approval", { event: "order.approved" });
        return step.run("receipt", async () => ({ revision, amount }));
      };
    const oldQuote = vi.fn(async () => 100);
    const newQuote = vi.fn(async () => 200);
    const v1 = makeHandler("v1", oldQuote);
    const v2 = makeHandler("v2", newQuote);
    expect(functionCodeHash(v1)).toBe(functionCodeHash(v2));
    const request: PushRequest = {
      run_id: "deployment-repro", function_id: "order", attempt: 1,
      event: { id: "event", name: "order.created", data: {}, timestamp: "2026-09-08T00:00:00Z" },
      steps: [],
    };
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const first = new ExecutionContext(request, logger);
    let yielded: YieldSignal | undefined;
    try { await v1(createStepClient(first)); } catch (error) {
      if (!(error instanceof YieldSignal)) throw error;
      yielded = error;
    }
    if (!yielded || yielded.yieldInfo.type !== "wait_for_event") throw new Error("v1 did not wait");
    const completed = first.getExecutedSteps();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.status).toBe("completed");
    const resumed = new ExecutionContext({
      ...request,
      steps: completed.map(({ id, name, status, output }) => ({ id, name, status, output })),
      resume: { step_id: yielded.yieldInfo.step_id, type: "wait_for_event", data: {
        id: "approval", name: "order.approved", data: {}, timestamp: "2026-09-08T00:01:00Z",
      } },
    }, logger);
    expect(await v2(createStepClient(resumed))).toEqual({ revision: "v2", amount: 100 });
    expect(oldQuote).toHaveBeenCalledOnce();
    expect(newQuote).not.toHaveBeenCalled();
    console.log("same source hash; v1 quote=100 -> wait -> v2 receipt uses cached 100; v2 quote=200 skipped");
  });
});
