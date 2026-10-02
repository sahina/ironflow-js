import { describe, it, expect, vi, afterEach } from "vitest";
import { JobNackReason, type JobNack, type WorkerMessage } from "@ironflow/core/gen";
import { createStreamingWorker } from "./worker-streaming.js";

// Shutdown parity with the polling worker (#2446). Drives the real
// StreamingWorker; only the engine side of the stream is replaced.

const streams = vi.hoisted(
  () => [] as { drop: () => void; sent: unknown[]; halfClosed: boolean }[]
);

vi.mock("@connectrpc/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@connectrpc/connect")>()),
  createClient: () => ({
    // As the engine does, hold the stream open until the worker half-closes or
    // aborts it, or the test drops it.
    connect: (messages: AsyncIterable<unknown>, opts?: { signal?: AbortSignal }) => {
      let end = () => {};
      let drop = () => {};
      const ended = new Promise<void>((resolve, reject) => {
        end = resolve;
        drop = () => reject(new Error("dropped"));
        opts?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
      });
      const stream = { drop, sent: [] as unknown[], halfClosed: false };
      streams.push(stream);
      // Take the outgoing messages, as the transport does. The end of the
      // messages is the half-close.
      void (async () => {
        for await (const message of messages) stream.sent.push(message);
        stream.halfClosed = true;
        end();
      })();
      return (async function* () {
        await ended;
      })();
    },
  }),
}));

type Internals = {
  state: string;
  handleEngineMessage(message: unknown): Promise<void>;
  activeJobs: Map<string, { jobId: string; abortController: AbortController }>;
  sendMessage: (m: WorkerMessage) => void;
  handleJobAssignment(job: unknown): Promise<void>;
};

const handler = vi.fn(async () => ({ ok: true }));
const workers: ReturnType<typeof createStreamingWorker>[] = [];

function makeWorker(extra: { drainTimeout?: number } = {}) {
  const fn = { config: { id: "fn" }, handler } as unknown as Parameters<
    typeof createStreamingWorker
  >[0]["functions"][number];
  const worker = createStreamingWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    maxConcurrentJobs: 1,
    logger: false,
    ...extra,
  });
  workers.push(worker);
  return { worker, internals: worker as unknown as Internals };
}

function holdJob(internals: Internals): AbortController {
  const abortController = new AbortController();
  internals.activeJobs.set("held", { jobId: "held", abortController });
  return abortController;
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
  const start = worker.start();
  await vi.waitFor(() => expect(streams).toHaveLength(open + 1));
  // Wrapped: an async function that returns the promise itself waits for it.
  return { start };
}

const settlesSoon = (p: Promise<unknown>) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);

// The test runner has its own signal listeners. Remove them for the test, so
// that the listener count shows only what the test adds.
function isolateSignal(signal: NodeJS.Signals): () => void {
  const saved = process.rawListeners(signal) as NodeJS.SignalsListener[];
  process.removeAllListeners(signal);
  return () => {
    process.removeAllListeners(signal);
    for (const listener of saved) process.on(signal, listener);
  };
}

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

describe("streaming worker shutdown (#2446)", () => {
  afterEach(() => {
    for (const worker of workers.splice(0)) worker.stop();
    streams.length = 0;
    handler.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops the drain at the deadline and cancels the active job", async () => {
    vi.useFakeTimers();
    const { worker, internals } = makeWorker();
    internals.state = "connected";
    const abortController = holdJob(internals);

    let drained = false;
    void worker.drain().then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(drained).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(internals.state).toBe("stopped");
  });

  // The engine stops waiting after drainTimeoutMs, so the worker must not drain
  // for its own longer default (#2458).
  it.each([
    { name: "the shutdown drain timeout", config: {}, messageMs: 5_000 },
    { name: "the configured drain timeout", config: { drainTimeout: 5_000 }, messageMs: undefined },
    { name: "the configured drain timeout when the shutdown has none", config: { drainTimeout: 5_000 }, messageMs: 0 },
  ])("stops the drain at $name", async ({ config, messageMs }) => {
    vi.useFakeTimers();
    const { worker, internals } = makeWorker(config);
    internals.state = "connected";
    const abortController = holdJob(internals);

    const drain =
      messageMs === undefined
        ? worker.drain()
        : (void internals.handleEngineMessage({
            payload: { case: "shutdown", value: { reason: "deploy", drainTimeoutMs: messageMs } },
          }),
          (worker as unknown as { drainPromise: Promise<void> }).drainPromise);
    let drained = false;
    void drain.then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(drained).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  // stop() aborts the stream, and the engine can then miss the last results.
  it("sends the queued results and half-closes the stream when the jobs are done", async () => {
    const { worker, internals } = makeWorker();
    const { start } = await startAndWaitForStream(worker);
    const result = { payload: { case: "jobCompleted" } } as unknown as WorkerMessage;
    internals.sendMessage(result);

    await worker.drain();

    expect(await settlesSoon(start)).toBe(true);
    expect(streams[0]!.halfClosed).toBe(true);
    expect(streams[0]!.sent).toContain(result);
    expect(internals.state).toBe("stopped");
  });

  it("stops at the deadline when the engine does not end the stream", async () => {
    vi.useFakeTimers();
    // No connection: nothing ends the stream after the jobs are done.
    const { worker, internals } = makeWorker();
    internals.state = "connected";

    let drained = false;
    void worker.drain().then(() => {
      drained = true;
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(drained).toBe(true);
    expect(internals.state).toBe("stopped");
  });

  // "connected" after the registration would put the worker back into service.
  it("opens no stream when drain() runs during the registration", async () => {
    const { worker, internals } = makeWorker();
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(new Response("{}", { status: 200 }));
          })
      )
    );
    const start = worker.start();
    await vi.waitFor(() => expect(release).toBeDefined());

    void worker.drain();
    release!();

    expect(await settlesSoon(start)).toBe(true);
    expect(streams).toHaveLength(0);
    expect(internals.state).toBe("stopped");
  });

  // A worker that cannot run a job refuses it with a nack (#2456). A nack uses
  // no run attempt, and the engine re-queues the job at once.
  it.each([
    ["at capacity", true, "connected", JobNackReason.AT_CAPACITY],
    ["draining", false, "draining", JobNackReason.DRAINING],
    ["draining at capacity", true, "draining", JobNackReason.DRAINING],
  ] as const)("nacks a job it cannot run: %s", async (_name, full, state, reason) => {
    const { internals } = makeWorker();
    internals.state = state;
    if (full) holdJob(internals);
    const out: WorkerMessage[] = [];
    internals.sendMessage = (m) => out.push(m);

    await internals.handleJobAssignment(job);

    expect(out).toHaveLength(1);
    expect(out[0]!.payload.case).toBe("jobNack");
    expect(out[0]!.payload.value as JobNack).toMatchObject({
      jobId: "job-1",
      runId: "run-1",
      executionSeq: 7n,
      leaseToken: "tok",
      reason,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("closes the stream on stop()", async () => {
    const { worker } = makeWorker();
    const { start } = await startAndWaitForStream(worker);

    worker.stop();

    expect(await settlesSoon(start)).toBe(true);
  });

  // Without a stream no result can reach the engine, so a reconnect would only
  // open the worker to new jobs that the deadline then cancels.
  it("stops when the stream drops during a drain, with no reconnect", async () => {
    const { worker, internals } = makeWorker();
    const { start } = await startAndWaitForStream(worker);
    holdJob(internals);

    void worker.drain();
    streams[0]!.drop();

    expect(await settlesSoon(start)).toBe(true);
    expect(internals.state).toBe("stopped");
    expect(streams).toHaveLength(1);
  });

  describe("process signals", () => {
    it.each(["SIGINT", "SIGTERM"] as const)("drains, stops and exits on %s", async (signal) => {
      const restore = isolateSignal(signal);
      const exit = mockExit();
      try {
        const { worker } = makeWorker();
        const { start } = await startAndWaitForStream(worker);

        process.emit(signal, signal);

        expect(await settlesSoon(start)).toBe(true);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
        expect(process.listenerCount(signal)).toBe(0);
      } finally {
        restore();
      }
    });

    it("does not exit while another worker still drains", async () => {
      const restore = isolateSignal("SIGTERM");
      const exit = mockExit();
      try {
        const idle = makeWorker();
        const busy = makeWorker();
        const idleRun = await startAndWaitForStream(idle.worker);
        await startAndWaitForStream(busy.worker);
        holdJob(busy.internals);

        process.emit("SIGTERM", "SIGTERM");

        expect(await settlesSoon(idleRun.start)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(exit).not.toHaveBeenCalled();

        busy.worker.stop();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      } finally {
        restore();
      }
    });

    // The published package bundles each entry point separately, so
    // createWorker and createStreamingWorker each load their own copy of the
    // signal module. The copies must share one listener.
    it("shares one listener between separately bundled copies of the module", async () => {
      const restore = isolateSignal("SIGTERM");
      const exit = mockExit();
      try {
        const first = await import("./internal/drain-on-signal.js");
        vi.resetModules();
        const second = await import("./internal/drain-on-signal.js");
        expect(second.drainOnSignal).not.toBe(first.drainOnSignal);

        let finish = () => {};
        const slow = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const removeFast = first.drainOnSignal(() => Promise.resolve());
        const removeSlow = second.drainOnSignal(() => slow);

        process.emit("SIGTERM", "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(exit).not.toHaveBeenCalled();

        finish();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
        removeFast();
        removeSlow();
      } finally {
        restore();
      }
    });

    // Node removes a once-listener before it calls it, so a count read after
    // the drain cannot show an app handler that is still running.
    it("leaves the exit to an app that listens with once", async () => {
      const restore = isolateSignal("SIGTERM");
      const exit = mockExit();
      try {
        const appCleanup = vi.fn();
        process.once("SIGTERM", appCleanup);
        const { worker } = makeWorker();
        const { start } = await startAndWaitForStream(worker);

        process.emit("SIGTERM", "SIGTERM");

        expect(await settlesSoon(start)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(appCleanup).toHaveBeenCalledTimes(1);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });
});
