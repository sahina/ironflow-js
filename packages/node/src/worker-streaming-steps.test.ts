import { describe, it, expect, vi } from "vitest";
import type { WorkerMessage } from "@ironflow/core/gen";
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

const cases = (msgs: WorkerMessage[]) => msgs.map((m) => m.payload.case);

describe("streaming worker step rows (#2413)", () => {
  it("sends stepStarted then stepCompleted with job ID and fence", async () => {
    const msgs = await sent(async ({ step }) => step.run("a", async () => ({ n: 1 })));
    expect(cases(msgs)).toEqual(["stepStarted", "stepCompleted", "jobCompleted"]);
    for (const m of msgs.slice(0, 2)) {
      const v = m.payload.value as { jobId: string; stepId: string; executionSeq: bigint; leaseToken: string };
      expect(v).toMatchObject({ jobId: "job-1", stepId: "run-1:a:0", executionSeq: 7n, leaseToken: "tok" });
    }
  });

  it("sends stepStarted then stepFailed for a failing step", async () => {
    const msgs = await sent(async ({ step }) =>
      step.run("a", async () => {
        throw new Error("boom");
      })
    );
    expect(cases(msgs).slice(0, 2)).toEqual(["stepStarted", "stepFailed"]);
    const failed = msgs[1]!.payload.value as { jobId: string; error?: { message: string } };
    expect(failed).toMatchObject({ jobId: "job-1", error: { message: "boom" } });
  });
});

describe("streaming worker retryability (#2413)", () => {
  it("treats a plain throw as retryable and runs no compensation", async () => {
    let compensated = false;
    const msgs = await sent(async ({ step }) => {
      await step.run("a", async () => 1);
      step.compensate("a", async () => {
        compensated = true;
      });
      throw new Error("retryable");
    });
    const failed = msgs.at(-1)!.payload.value as { error?: { retryable: boolean } };
    expect(msgs.at(-1)!.payload.case).toBe("jobFailed");
    expect(failed.error?.retryable).toBe(true);
    expect(compensated).toBe(false);
  });
});
