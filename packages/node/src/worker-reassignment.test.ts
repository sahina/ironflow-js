import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";

// Keep the executor and heartbeat implementations real; replace only engine I/O.
type Internals = {
  state: string;
  sendMessage?: (message: { payload: { case?: string; value: { jobs?: { jobId: string }[] } } }) => void;
  startHeartbeat(baseUrl?: string): void;
  processJob(baseUrl: string, job: unknown): void;
  handleJobAssignment(job: unknown): Promise<void>;
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(["rest", "streaming"])("%s reassignment heartbeat", (transport) => {
  it("keeps a newer execution heartbeating after the old one ends and ignores exact redelivery", async () => {
    vi.useFakeTimers();
    const gates: (() => void)[] = [];
    const handler = vi.fn(async () => { await new Promise<void>((r) => gates.push(r)); return {}; });
    const fn = { config: { id: "fn" }, handler } as unknown as Parameters<typeof createWorker>[0]["functions"][number];
    const worker = (transport === "rest" ? createWorker : createStreamingWorker)({ functions: [fn], logger: false, heartbeatInterval: 10, maxConcurrentJobs: 2 });
    const internals = worker as unknown as Internals;
    const heartbeats: string[][] = [];
    const sentCases: string[] = [];
    vi.stubGlobal("fetch", async (url: string, options: { body: string }) => {
      if (url.endsWith("/heartbeat")) heartbeats.push((JSON.parse(options.body).jobs as { job_id: string }[]).map((j) => j.job_id));
      if (transport === "rest" && url.endsWith("/jobs/r") && JSON.parse(options.body).execution_seq === 1) return new Response('{"error":"STALE_EXECUTION"}', { status: 409 });
      return new Response("{}", { status: 200 });
    });
    internals.sendMessage = (m) => { sentCases.push(m.payload.case ?? ""); if (m.payload.case === "heartbeat") heartbeats.push(m.payload.value.jobs!.map((j) => j.jobId)); };
    internals.state = "connected";
    internals.startHeartbeat("http://localhost:9123");
    const assign = async (seq: number) => {
      const event = { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() };
      if (transport === "rest") internals.processJob("http://localhost:9123", { job_id: "r", run_id: "r", function_id: "fn", execution_seq: seq, lease_token: `tok-${seq}`, attempt: 1, event, completed_steps: [] });
      else await internals.handleJobAssignment({ jobId: "r", runId: "r", functionId: "fn", executionSeq: BigInt(seq), leaseToken: `tok-${seq}`, attempt: 1, event: { ...event, version: 1, timestamp: undefined }, completedSteps: [] });
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await assign(1);
      await assign(2);
      expect(gates).toHaveLength(2);
      await assign(2);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(sentCases).not.toContain("jobNack");
      await vi.advanceTimersByTimeAsync(10);
      if (transport === "streaming") expect(heartbeats.at(-1)).toEqual(["r", "r"]);
      gates[0]!();
      await vi.advanceTimersByTimeAsync(10);
      expect(heartbeats.at(-1)).toEqual(["r"]);
      await assign(2);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(sentCases).not.toContain("jobNack");
      gates[1]!();
      await vi.advanceTimersByTimeAsync(10);
      expect(heartbeats.at(-1)).toEqual([]);
    } finally {
      gates.forEach((release) => release());
      worker.stop();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
