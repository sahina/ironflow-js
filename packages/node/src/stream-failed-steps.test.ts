import { describe, it, expect, vi } from "vitest";
import type { WorkerMessage } from "@ironflow/core/gen";
import { NonRetryableError } from "@ironflow/core";
import { toBinary, fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { WorkerMessageSchema } from "@ironflow/core/gen";
import { createStreamingWorker } from "./worker-streaming.js";

// The engine writes step rows only from stepStarted/stepCompleted/stepFailed
// that carry the job ID and the execution fence (#2413). Drives the real
// executeJob and reads what goes out on the stream.

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function sent(handler: (ctx: any) => Promise<unknown>): Promise<WorkerMessage[]> {
  const fn = { config: { id: "fn" }, handler } as unknown as Parameters<
    typeof createStreamingWorker
  >[0]["functions"][number];
  const worker = createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    logger: noopLogger,
  });
  const out: WorkerMessage[] = [];
  (worker as unknown as { sendMessage: (m: WorkerMessage) => void }).sendMessage = (m) => out.push(m);
  const job = {
    jobId: "job-1",
    runId: "run-1",
    functionId: "fn",
    attempt: 1,
    executionSeq: 7n,
    leaseToken: "tok",
    event: { id: "e1", name: "e", data: {}, version: 1, timestamp: undefined },
    completedSteps: [],
  };
  await (worker as unknown as { executeJob(j: unknown, s: AbortSignal): Promise<void> })
    .executeJob(job, new AbortController().signal);
  return out;
}


// A failed job re-sends its completed steps. A non-object output must ride in
// output_value: output holds only an object, so [1,2] went out as {} and the
// engine overwrote the stored row (#2874).
describe("streaming jobFailed steps", () => {
  it("carry non-object outputs in output_value", async () => {
    for (const v of [[1, 2], "str", 42, true]) {
      const msgs = await sent(async ({ step }) => {
        await step.run("a", async () => v);
        throw new NonRetryableError("x");
      });
      const jf = msgs.at(-1)!;
      expect(jf.payload.case).toBe("jobFailed");
      const wire = fromBinary(WorkerMessageSchema, toBinary(WorkerMessageSchema, jf));
      const step = (wire.payload.value as any).steps[0];
      expect(step.output).toBeUndefined();
      expect(toJson(ValueSchema, step.outputValue)).toEqual(v);
    }
  });

  it("keeps an object output in output", async () => {
    const msgs = await sent(async ({ step }) => {
      await step.run("a", async () => ({ k: 1 }));
      throw new NonRetryableError("x");
    });
    const step = (msgs.at(-1)!.payload.value as any).steps[0];
    expect(step.output).toEqual({ k: 1 });
    expect(step.outputValue).toBeUndefined();
  });
});

// A BigInt result fails the streaming job non-retryably (SERIALIZATION_ERROR)
// instead of a retryable error from the encoder (#2874).
describe("streaming worker: unencodable output", () => {
  it("fails the job non-retryably and sends no unencodable step", async () => {
    const msgs = await sent(async ({ step }) => {
      await step.run("calc", async () => 1n);
      return { ok: true };
    });
    expect(msgs.some((m) => m.payload.case === "stepCompleted")).toBe(false);
    const jf = msgs.at(-1)!;
    expect(jf.payload.case).toBe("jobFailed");
    const err = (jf.payload.value as any).error;
    expect(err.code).toBe("SERIALIZATION_ERROR");
    expect(err.retryable).toBe(false);
  });
});
