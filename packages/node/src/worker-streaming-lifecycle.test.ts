import { describe, it, expect, vi, afterEach } from "vitest";
import { createStreamingWorker } from "./worker-streaming.js";

// Job lifecycle across a dropped stream, a redelivery and a cancel (#2479).
// Drives the real StreamingWorker; only the engine side of the stream is replaced.

const streams = vi.hoisted(
  () => [] as { drop: () => void; sent: { payload: { case?: string } }[] }[]
);

vi.mock("@connectrpc/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@connectrpc/connect")>()),
  createClient: () => ({
    connect: (messages: AsyncIterable<unknown>, opts?: { signal?: AbortSignal }) => {
      let drop = () => {};
      const ended = new Promise<void>((_, reject) => {
        drop = () => reject(new Error("dropped"));
        opts?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
      });
      const stream = { drop, sent: [] as { payload: { case?: string } }[] };
      streams.push(stream);
      void (async () => {
        for await (const message of messages) stream.sent.push(message as never);
      })();
      return (async function* () {
        await ended;
      })();
    },
  }),
}));

type ActiveJob = { jobId: string; abortController: AbortController };
type Internals = {
  activeJobs: Map<string, ActiveJob>;
  handleJobAssignment(job: unknown): Promise<void>;
  handleEngineMessage(message: unknown): Promise<void>;
};

const gates: (() => void)[] = [];
const sideEffect = vi.fn();
const workers: ReturnType<typeof createStreamingWorker>[] = [];

// Each run of the handler waits on its own gate, then runs one step.
const handler = vi.fn(async ({ step }: { step: { run: (n: string, f: () => unknown) => Promise<unknown> } }) => {
  await new Promise<void>((resolve) => gates.push(resolve));
  await step.run("work", sideEffect);
  return { ok: true };
});

function makeWorker() {
  const fn = { config: { id: "fn" }, handler } as unknown as Parameters<
    typeof createStreamingWorker
  >[0]["functions"][number];
  const worker = createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    maxConcurrentJobs: 2,
    reconnectDelay: 5,
    logger: false,
  });
  workers.push(worker);
  return { worker, internals: worker as unknown as Internals };
}

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

async function startAndWaitForStream(worker: ReturnType<typeof makeWorker>["worker"]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const open = streams.length;
  void worker.start();
  await vi.waitFor(() => expect(streams).toHaveLength(open + 1));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const cases = (i: number) => streams[i]!.sent.map((m) => m.payload.case);

describe("streaming worker job lifecycle (#2479)", () => {
  afterEach(() => {
    for (const worker of workers.splice(0)) worker.stop();
    streams.length = 0;
    gates.length = 0;
    handler.mockClear();
    sideEffect.mockClear();
    vi.unstubAllGlobals();
  });

  it("aborts its jobs when the stream drops and reports nothing on the next stream", async () => {
    const { worker, internals } = makeWorker();
    await startAndWaitForStream(worker);
    await internals.handleJobAssignment(job);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const { abortController } = internals.activeJobs.get("job-1")!;

    streams[0]!.drop();
    await vi.waitFor(() => expect(streams).toHaveLength(2));

    expect(abortController.signal.aborted).toBe(true);
    expect(internals.activeJobs.size).toBe(0);

    gates[0]!();
    await flush();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(cases(1)).not.toContain("jobCompleted");
    expect(cases(1)).not.toContain("jobFailed");
    expect(cases(1)).not.toContain("stepResult");
  });

  it("keeps the entry of a redelivered job when the old execution ends", async () => {
    const { worker, internals } = makeWorker();
    await startAndWaitForStream(worker);
    await internals.handleJobAssignment(job);
    await internals.handleJobAssignment(job);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const second = internals.activeJobs.get("job-1")!;

    gates[0]!();
    await flush();

    expect(internals.activeJobs.get("job-1")).toBe(second);
  });

  it("stops a cancelled job at its next step and keeps its slot until it exits", async () => {
    const { worker, internals } = makeWorker();
    await startAndWaitForStream(worker);
    await internals.handleJobAssignment(job);
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    await internals.handleEngineMessage({
      payload: { case: "cancel", value: { jobId: "job-1", reason: "test" } },
    });
    expect(internals.activeJobs.get("job-1")?.abortController.signal.aborted).toBe(true);

    gates[0]!();
    await flush();

    expect(sideEffect).not.toHaveBeenCalled();
    expect(cases(0)).not.toContain("jobCompleted");
    expect(cases(0)).not.toContain("jobFailed");
    expect(internals.activeJobs.size).toBe(0);
  });
});
