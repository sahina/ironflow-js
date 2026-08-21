import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FunctionContext } from "@ironflow/core";
import { createWorker } from "./worker.js";

// Mid-run step checkpointing (#1670). Without it a pull worker's step results
// exist only in the terminal update body, so a kill mid-run loses all progress
// and the reclaimed run re-executes every step.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Update = { status: string; steps?: Array<{ id: string }>; step_offset?: number };

/**
 * Drive the real REST worker through one fenced assignment whose handler runs
 * three steps, returning every PUT body the worker sent to the job endpoint.
 */
async function runOneJob(opts: {
  checkpointInterval?: number;
  progressStatus?: number;
  /** Steps memoized from a prior execution, echoed in completed_steps. */
  memoized?: number;
  /** Sequence base the server reports for this execution. */
  sequenceBase?: number;
  /** Make the handler throw after the second step. */
  throwAfterTwo?: boolean;
}): Promise<Update[]> {
  const updates: Update[] = [];
  let served = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  mockFetch.mockImplementation(
    async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/register") || url.includes("/heartbeat")) {
        return { ok: true, status: 200 };
      }
      if (method === "GET" && url.includes("/jobs")) {
        if (served) return { status: 204, ok: false };
        served = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [
              {
                job_id: "run-1", run_id: "run-1", function_id: "fn", attempt: 1,
                event: { id: "e1", name: "e", data: {}, timestamp: new Date().toISOString() },
                completed_steps: Array.from({ length: opts.memoized ?? 0 }, (_, i) => ({
                  step_id: `memo-${i}`, name: `memo-${i}`, output: {},
                })),
                step_sequence_base: opts.sequenceBase,
                execution_seq: 5, lease_token: "tok-1",
              },
            ],
          }),
        };
      }
      if (method === "PUT" && url.endsWith("/ack")) {
        return { ok: true, status: 200 };
      }
      if (method === "PUT" && url.includes("/jobs/run-1")) {
        const body = JSON.parse(init?.body ?? "{}") as Update;
        updates.push(body);
        if (body.status === "progress") {
          const status = opts.progressStatus ?? 200;
          return { ok: status < 400, status };
        }
        resolveDone();
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    }
  );

  const fn = {
    config: { id: "fn" },
    handler: async (ctx: FunctionContext) => {
      let done = 0;
      for (const name of ["one", "two", "three"]) {
        await ctx.step.run(name, async () => ({ name }));
        done++;
        // Yield long enough for the debounce timer to fire between steps.
        await new Promise((r) => setTimeout(r, 30));
        if (opts.throwAfterTwo && done === 2) {
          throw new Error("boom");
        }
      }
      return { ok: true };
    },
  } as unknown as Parameters<typeof createWorker>[0]["functions"][number];

  const worker = createWorker({
    serverUrl: "http://localhost:9123",
    functions: [fn],
    maxConcurrentJobs: 4,
    logger: noopLogger,
    checkpointInterval: opts.checkpointInterval,
  });

  void worker.start();
  await Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for completion")), 5000)),
  ]);
  await worker.stop();
  return updates;
}

describe("pull worker step checkpointing (#1670)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("checkpoints steps mid-run and reports each step exactly once", async () => {
    const updates = await runOneJob({ checkpointInterval: 5 });

    const progress = updates.filter((u) => u.status === "progress");
    expect(progress.length).toBeGreaterThan(0);
    // The checkpoint is not a terminal update: no output, no status transition.
    for (const p of progress) {
      expect(p.steps?.length).toBeGreaterThan(0);
    }

    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.status).toBe("completed");

    // Every step reported once and only once across all updates: re-reporting a
    // flushed step would double its audit record and step event.
    const ids = updates.flatMap((u) => (u.steps ?? []).map((s) => s.id));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    // step_offset makes the batches numberable end to end: batch N starts where
    // batch N-1 ended, so the run's steps keep their order on the server.
    let expected = 0;
    for (const u of updates) {
      if (!u.steps?.length) continue;
      expect(u.step_offset).toBe(expected);
      expected += u.steps.length;
    }
  });

  it("carries all steps in the terminal body when checkpointing is disabled", async () => {
    const updates = await runOneJob({ checkpointInterval: 0 });

    expect(updates.filter((u) => u.status === "progress")).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.steps).toHaveLength(3);
  });

  it("keeps rejected steps in the tail so a failed checkpoint self-heals", async () => {
    const updates = await runOneJob({ checkpointInterval: 5, progressStatus: 500 });

    // The server never accepted a checkpoint, so nothing was flushed and the
    // terminal body still carries all three steps.
    expect(updates.filter((u) => u.status === "progress").length).toBeGreaterThan(0);
    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.steps).toHaveLength(3);
  });

  it("stops checkpointing once the fence is rejected (409)", async () => {
    const updates = await runOneJob({ checkpointInterval: 5, progressStatus: 409 });

    // One rejection is enough: the execution is superseded, so no further
    // checkpoints are attempted. The handler still runs to completion.
    expect(updates.filter((u) => u.status === "progress")).toHaveLength(1);
    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.steps).toHaveLength(3);
  });
});

describe("checkpoint offsets and failure handling (#1670)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("starts the offset at the server's sequence base, not the memoized count", async () => {
    // The server reports base 7 while only 2 steps come back in completed_steps
    // — the gap is rows this execution must not renumber over (a sleeping step
    // from a yield, failed steps from earlier attempts).
    const updates = await runOneJob({ checkpointInterval: 5, memoized: 2, sequenceBase: 7 });

    let expected = 7;
    for (const u of updates) {
      if (!u.steps?.length) continue;
      expect(u.step_offset).toBe(expected);
      expected += u.steps.length;
    }
    expect(expected).toBe(10);
  });

  it("falls back to offset 0 when the server reports no sequence base", async () => {
    // An older server omits step_sequence_base; the worker must not crash or
    // guess from completed_steps.
    const updates = await runOneJob({ checkpointInterval: 5, memoized: 2 });
    const first = updates.find((u) => u.steps?.length);
    expect(first?.step_offset).toBe(0);
  });

  it("carries the offset on the failure tail too", async () => {
    const updates = await runOneJob({ checkpointInterval: 5, throwAfterTwo: true, sequenceBase: 3 });

    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.status).toBe("failed");

    let expected = 3;
    for (const u of updates) {
      if (!u.steps?.length) continue;
      expect(u.step_offset).toBe(expected);
      expected += u.steps.length;
    }
    // Two steps ran before the throw.
    expect(expected).toBe(5);
  });

  it("stops checkpointing against a server that rejects the status (400)", async () => {
    // A pre-#1670 server answers `status: "progress"` with 400 invalid status.
    // Retrying every window for the life of the job is pure noise, so the
    // worker latches off after one rejection and still completes the job.
    const updates = await runOneJob({ checkpointInterval: 5, progressStatus: 400 });

    expect(updates.filter((u) => u.status === "progress")).toHaveLength(1);
    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.status).toBe("completed");
    expect(terminal[0]!.steps).toHaveLength(3);
  });

  it("keeps retrying after a 5xx and still delivers every step exactly once", async () => {
    const updates = await runOneJob({ checkpointInterval: 5, progressStatus: 503 });

    // 5xx is transient: it does NOT latch off (unlike a 4xx).
    expect(updates.filter((u) => u.status === "progress").length).toBeGreaterThan(1);
    const terminal = updates.filter((u) => u.status !== "progress");
    expect(terminal[0]!.steps).toHaveLength(3);
  });
});
