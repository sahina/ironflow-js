import { describe, expect, it } from "vitest";
import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { CompletedStepSchema } from "@ironflow/core/gen";
import { jobOutputFields, memoSteps, stepYieldedMessage } from "./stream-yield.js";
import { toJson } from "@bufbuild/protobuf";

const fence = { executionSeq: 3n, leaseToken: "tok" };
const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

describe("stepYieldedMessage", () => {
  it("maps sleep", () => {
    const m = stepYieldedMessage("job", { step_id: "s", type: "sleep", until: "2030-01-01T00:00:00Z" }, fence);
    expect(m.yieldInfo.case).toBe("sleep");
    expect(m.executionSeq).toBe(3n);
    expect(m.leaseToken).toBe("tok");
  });

  it("maps wait_for_event with payload and timeout", () => {
    const m = stepYieldedMessage("job", {
      step_id: "s", type: "wait_for_event",
      event_filter: { event: "paid", match: "data.id", match_value: "1", timeout: "1h", payload: { a: 1 } },
    }, fence);
    expect(m.yieldInfo.case).toBe("waitEvent");
    if (m.yieldInfo.case !== "waitEvent") throw new Error();
    expect(m.yieldInfo.value.eventName).toBe("paid");
    expect(json(m.yieldInfo.value.payloadJson)).toEqual({ a: 1 });
    expect(m.yieldInfo.value.timeout).toBeDefined();
  });

  it("maps invoke_function with a non-object input", () => {
    const m = stepYieldedMessage("job", {
      step_id: "s", type: "invoke_function", function_id: "child", input: [1, 2], invoke_timeout_ms: 5000,
    }, fence);
    if (m.yieldInfo.case !== "invokeFunction") throw new Error(m.yieldInfo.case);
    expect(m.yieldInfo.value.functionId).toBe("child");
    expect(m.yieldInfo.value.invokeTimeoutMs).toBe(5000n);
    expect(json(m.yieldInfo.value.inputJson)).toEqual([1, 2]);
  });

  it("maps invoke_function_async with no input to empty bytes", () => {
    const m = stepYieldedMessage("job", { step_id: "s", type: "invoke_function_async", function_id: "child" }, fence);
    if (m.yieldInfo.case !== "invokeFunctionAsync") throw new Error(m.yieldInfo.case);
    expect(m.yieldInfo.value.inputJson.length).toBe(0);
  });
});

describe("memoSteps", () => {
  it("keeps completed rows and surfaces failed invoke rows", () => {
    const steps = memoSteps([
      create(CompletedStepSchema, { stepId: "a", name: "a", output: { ok: true } }),
      create(CompletedStepSchema, {
        stepId: "b", name: "b", status: "failed",
        errorJson: new TextEncoder().encode('{"message":"invoke timed out"}'),
      }),
    ]);
    expect(steps[0]).toMatchObject({ id: "a", status: "completed", output: { ok: true } });
    expect(steps[1]).toMatchObject({ id: "b", status: "failed" });
    expect(JSON.parse(steps[1]!.error!)).toEqual({ message: "invoke timed out" });
  });

  it("prefers output_value over output for a scalar payload (#1963)", () => {
    const steps = memoSteps([
      create(CompletedStepSchema, { stepId: "a", name: "a", outputValue: fromJson(ValueSchema, 42) }),
    ]);
    expect(steps[0]).toMatchObject({ id: "a", status: "completed", output: 42 });
  });
});

describe("jobOutputFields", () => {
  it("sends an object in output", () => {
    expect(jobOutputFields({ a: 1 })).toEqual({ output: { a: 1 } });
  });

  it("sends a scalar in output_value (#2402)", () => {
    const f = jobOutputFields("woke");
    expect(f.output).toBeUndefined();
    expect(toJson(ValueSchema, f.outputValue!)).toBe("woke");
  });

  it("sends nothing for undefined", () => {
    expect(jobOutputFields(undefined)).toEqual({});
  });
});
