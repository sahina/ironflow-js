import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { JobAssignmentSchema, type WorkerMessage } from "@ironflow/core/gen";
import { createStreamingWorker } from "./worker-streaming.js";

// The streaming worker must echo the execution fence (execution_seq + lease_token)
// it received on the JobAssignment back onto every mutating message it sends
// (#1206, ADR 0037, chunk 3e). Without the echo, the engine's ingress fence guard
// has nothing to validate and rejects the capacity worker.
//
// StreamingWorker is not exported, so we drive it through the factory and reach
// its private message path via `as any`, capturing outgoing messages by replacing
// sendMessage (normally wired to the gRPC stream).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWorker(functions: any[] = []): { w: any; captured: WorkerMessage[] } {
  const w = createStreamingWorker({
    serverUrl: "http://localhost:0",
    functions,
  }) as any;
  const captured: WorkerMessage[] = [];
  w.sendMessage = (m: WorkerMessage) => captured.push(m);
  return { w, captured };
}

describe("streaming worker fence echo (#1206 chunk 3e)", () => {
  it("echoes the fence on JobAck", async () => {
    const { w, captured } = makeWorker();
    const job = create(JobAssignmentSchema, {
      jobId: "job-1",
      runId: "run-1",
      functionId: "fn-x",
      executionSeq: 7n,
      leaseToken: "tok-ack",
    });

    await w.handleJobAssignment(job);

    const ack = captured.find((m) => m.payload.case === "jobAck");
    expect(ack, "JobAck must be sent").toBeDefined();
    const value = ack!.payload.value as { executionSeq: bigint; leaseToken: string };
    expect(value.executionSeq).toBe(7n);
    expect(value.leaseToken).toBe("tok-ack");
  });

  it("echoes the supplied fence on JobCompleted", async () => {
    const { w, captured } = makeWorker();

    await w.sendJobCompleted("job-1", { ok: true }, 5, {
      executionSeq: 11n,
      leaseToken: "tok-done",
    });

    const done = captured.find((m) => m.payload.case === "jobCompleted");
    expect(done, "JobCompleted must be sent").toBeDefined();
    const value = done!.payload.value as { executionSeq: bigint; leaseToken: string };
    expect(value.executionSeq).toBe(11n);
    expect(value.leaseToken).toBe("tok-done");
  });

  it("echoes the supplied fence on JobFailed", async () => {
    const { w, captured } = makeWorker();

    await w.sendJobFailed(
      "job-1",
      { message: "boom", code: "ERR", retryable: false },
      { executionSeq: 13n, leaseToken: "tok-fail" }
    );

    const failed = captured.find((m) => m.payload.case === "jobFailed");
    expect(failed, "JobFailed must be sent").toBeDefined();
    const value = failed!.payload.value as { executionSeq: bigint; leaseToken: string };
    expect(value.executionSeq).toBe(13n);
    expect(value.leaseToken).toBe("tok-fail");
  });

  // D1 (#1206, ADR 0037): a cancel deletes the job from activeJobs. A compute-bound
  // handler that finishes AFTER the cancel must still send the terminal with the
  // real fence captured from the assignment — NOT an empty token, which the engine
  // would treat as a protocol violation and fenceDisconnect the whole stream.
  it("stamps the captured fence on a completion that races a cancel", async () => {
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    // Handler ignores the abort signal (compute-bound) and finishes when released.
    const fn = {
      config: { id: "fn-slow" },
      handler: async () => {
        await handlerGate;
        return { ok: true };
      },
    };
    const { w, captured } = makeWorker([fn]);

    const job = create(JobAssignmentSchema, {
      jobId: "job-1",
      runId: "run-1",
      functionId: "fn-slow",
      executionSeq: 9n,
      leaseToken: "tok-live",
    });

    await w.handleJobAssignment(job); // starts executeJob in the background
    // Engine cancels (e.g. pause-for-injection): aborts + deletes from activeJobs.
    w.handleJobCancel("job-1", "pause-for-injection");
    // The handler finishes only now — after the job is gone from activeJobs.
    releaseHandler();
    await new Promise((r) => setTimeout(r, 30));

    const done = captured.find((m) => m.payload.case === "jobCompleted");
    expect(done, "JobCompleted must be sent").toBeDefined();
    const value = done!.payload.value as { executionSeq: bigint; leaseToken: string };
    expect(value.executionSeq, "must carry the captured seq, not 0").toBe(9n);
    expect(value.leaseToken, "must carry the captured token, not empty").toBe("tok-live");
  });
});
