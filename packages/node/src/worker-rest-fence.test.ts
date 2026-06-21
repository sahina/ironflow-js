import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FunctionContext } from "@ironflow/core";
import { JobAssignmentSchema } from "@ironflow/core";
import { createWorker } from "./worker.js";

// Chunk 2 (#1206 T9): the REAL REST worker (not the worker.test.ts reimpl) must
// poll with ?available=N, parse the capacity batched response, ack a fenced
// assignment before executing, and echo the fence on the completion.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function bodyOf(call: unknown): Record<string, unknown> {
  const opts = (call as [string, { body?: string }])[1];
  return opts?.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {};
}

describe("schema: fence fields", () => {
  it("accepts execution_seq + lease_token, and tolerates their absence", () => {
    const withFence = JobAssignmentSchema.safeParse({
      job_id: "r", run_id: "r", function_id: "fn", attempt: 1,
      event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
      completed_steps: [], execution_seq: 7, lease_token: "tok",
    });
    expect(withFence.success).toBe(true);
    if (withFence.success) {
      expect(withFence.data.execution_seq).toBe(7);
      expect(withFence.data.lease_token).toBe("tok");
    }
    const legacy = JobAssignmentSchema.safeParse({
      job_id: "r", run_id: "r", function_id: "fn", attempt: 1,
      event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
      completed_steps: [],
    });
    expect(legacy.success).toBe(true);
  });
});

describe("real REST worker fence echo (#1206 T9)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("polls available=N, acks the fenced assignment, then completes with the fence echoed", async () => {
    let firstPollURL = "";
    let ackBody: Record<string, unknown> = {};
    let completed: Record<string, unknown> | null = null;
    let served = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    mockFetch.mockImplementation(
      async (url: string, opts?: { method?: string; body?: string }) => {
        const method = opts?.method ?? "GET";
        if (url.includes("/register") || url.includes("/heartbeat")) {
          return { ok: true, status: 200 };
        }
        if (method === "GET" && url.includes("/jobs")) {
          // One fenced assignment on the first poll, then 204 forever.
          if (served) return { status: 204, ok: false };
          firstPollURL = url;
          served = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              jobs: [
                {
                  job_id: "run-1", run_id: "run-1", function_id: "fn", attempt: 1,
                  event: { id: "e1", name: "e", data: {}, timestamp: new Date().toISOString() },
                  completed_steps: [], execution_seq: 5, lease_token: "tok-1",
                },
              ],
            }),
          };
        }
        if (method === "PUT" && url.endsWith("/ack")) {
          ackBody = bodyOf([url, opts]);
          return { ok: true, status: 200 };
        }
        if (method === "PUT" && url.includes("/jobs/run-1")) {
          completed = bodyOf([url, opts]);
          resolveDone();
          return { ok: true, status: 200 };
        }
        return { ok: true, status: 200 };
      }
    );

    const fn = {
      config: { id: "fn" },
      handler: async (_ctx: FunctionContext) => ({ ok: true }),
    } as unknown as Parameters<typeof createWorker>[0]["functions"][number];

    const worker = createWorker({
      serverUrl: "http://localhost:9123",
      functions: [fn],
      maxConcurrentJobs: 4,
      logger: noopLogger,
    });

    void worker.start();
    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for completion")), 5000)),
    ]);
    await worker.stop();

    // Polled with the advertised free-slot count.
    expect(firstPollURL).toContain("available=4");
    // Acked the fenced assignment with the fence before executing.
    expect(ackBody.run_id).toBe("run-1");
    expect(ackBody.lease_token).toBe("tok-1");
    expect(ackBody.execution_seq).toBe(5);
    // Completion echoes the fence.
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
    expect(completed!.lease_token).toBe("tok-1");
    expect(completed!.execution_seq).toBe(5);
  });

  it("drops a job on a stale (409) ack: handler not run, no terminal update", async () => {
    let handlerRan = false;
    let terminalSent = false;
    let served = false;
    let resolveAcked: () => void = () => {};
    const acked = new Promise<void>((r) => {
      resolveAcked = r;
    });

    mockFetch.mockImplementation(
      async (url: string, opts?: { method?: string }) => {
        const method = opts?.method ?? "GET";
        if (url.includes("/register") || url.includes("/heartbeat")) {
          return { ok: true, status: 200 };
        }
        if (method === "GET" && url.includes("/jobs")) {
          if (served) return { status: 204, ok: false };
          served = true;
          return {
            ok: true, status: 200,
            json: async () => ({
              jobs: [{
                job_id: "r", run_id: "r", function_id: "fn", attempt: 1,
                event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
                completed_steps: [], execution_seq: 1, lease_token: "tok",
              }],
            }),
          };
        }
        if (method === "PUT" && url.endsWith("/ack")) {
          resolveAcked();
          return { ok: false, status: 409 }; // stale fence
        }
        if (method === "PUT") {
          terminalSent = true; // a terminal update — must NOT happen
          return { ok: true, status: 200 };
        }
        return { ok: true, status: 200 };
      }
    );

    const fn = {
      config: { id: "fn" },
      handler: async (_ctx: FunctionContext) => {
        handlerRan = true;
        return { ok: true };
      },
    } as unknown as Parameters<typeof createWorker>[0]["functions"][number];

    const worker = createWorker({
      serverUrl: "http://localhost:9123",
      functions: [fn],
      maxConcurrentJobs: 4,
      logger: noopLogger,
    });

    void worker.start();
    await acked;
    await new Promise((r) => setTimeout(r, 100)); // let the drop settle
    await worker.stop();

    expect(handlerRan).toBe(false);
    expect(terminalSent).toBe(false);
  });
});
