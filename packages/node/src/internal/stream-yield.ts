/**
 * Proto mapping for the streaming worker's yields and memo (#2402).
 * Kept apart from worker-streaming.ts so it is testable without a stream.
 */
import { create, fromJson, toJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate, ValueSchema, type Value } from "@bufbuild/protobuf/wkt";
import { parseDuration } from "@ironflow/core";
import {
  StepYieldedSchema,
  SleepYieldSchema,
  WaitEventYieldSchema,
  InvokeFunctionYieldSchema,
  InvokeFunctionAsyncYieldSchema,
  type CompletedStep,
  type StepYielded,
} from "@ironflow/core/gen";
import type { YieldInfo } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON bytes for a proto bytes field; undefined means no value (empty bytes). */
function jsonBytes(value: unknown): Uint8Array {
  return value === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(value));
}

export function stepYieldedMessage(
  jobId: string,
  info: YieldInfo,
  fence: { executionSeq: bigint; leaseToken: string }
): StepYielded {
  const base = { jobId, stepId: info.step_id, executionSeq: fence.executionSeq, leaseToken: fence.leaseToken };
  switch (info.type) {
    case "sleep":
      return create(StepYieldedSchema, {
        ...base,
        yieldInfo: { case: "sleep", value: create(SleepYieldSchema, { until: timestampFromDate(new Date(info.until)) }) },
      });
    case "wait_for_event": {
      const f = info.event_filter;
      return create(StepYieldedSchema, {
        ...base,
        yieldInfo: {
          case: "waitEvent",
          value: create(WaitEventYieldSchema, {
            eventName: f.event,
            matchExpression: f.match ?? "",
            matchValue: f.match_value ?? "",
            timeout: f.timeout ? timestampFromDate(new Date(Date.now() + parseDuration(f.timeout))) : undefined,
            payloadJson: jsonBytes(f.payload),
          }),
        },
      });
    }
    case "invoke_function":
      return create(StepYieldedSchema, {
        ...base,
        yieldInfo: {
          case: "invokeFunction",
          value: create(InvokeFunctionYieldSchema, {
            functionId: info.function_id,
            inputJson: jsonBytes(info.input),
            invokeTimeoutMs: BigInt(info.invoke_timeout_ms ?? 0),
          }),
        },
      });
    case "invoke_function_async":
      return create(StepYieldedSchema, {
        ...base,
        yieldInfo: {
          case: "invokeFunctionAsync",
          value: create(InvokeFunctionAsyncYieldSchema, { functionId: info.function_id, inputJson: jsonBytes(info.input) }),
        },
      });
  }
}

/**
 * Memo rows for ExecutionContext. A failed row is a failed invoke_function
 * step; its error goes in as a JSON string, which getFailedStep parses back —
 * the same shape the polling worker builds (worker.ts:575-582).
 *
 * output_value carries a memoized payload that isn't a JSON object — a
 * number, string, array, bool or null — which output (a Struct) cannot
 * represent (#1963). Prefer it when set, same priority as Go's payloadAny
 * (sdk/go/ironflow/worker_streaming.go), so a scalar invoke result replays
 * as itself instead of undefined.
 */
export function memoSteps(steps: CompletedStep[]) {
  return steps.map((s) => {
    if (s.status === "failed") {
      return {
        id: s.stepId, name: s.name, status: "failed" as const, output: undefined,
        error: s.errorJson.length ? decoder.decode(s.errorJson) : undefined,
      };
    }
    const output = s.outputValue !== undefined ? toJson(ValueSchema, s.outputValue) : (s.output as JsonObject | undefined);
    return { id: s.stepId, name: s.name, status: "completed" as const, output };
  });
}

/**
 * Job output fields for JobCompleted. A JSON object goes in output; any other
 * value (string, number, array, null) goes in output_value, which the Struct
 * field cannot carry (#2402).
 */
export function jobOutputFields(output: unknown): { output?: JsonObject; outputValue?: Value } {
  if (output === undefined) return {};
  if (output !== null && typeof output === "object" && !Array.isArray(output)) return { output: output as JsonObject };
  return { outputValue: fromJson(ValueSchema, output as JsonValue) };
}
