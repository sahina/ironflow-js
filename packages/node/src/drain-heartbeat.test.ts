import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "./worker.js";
import { createStreamingWorker } from "./worker-streaming.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Heartbeats continue while draining: they refresh the leases of the jobs
// still running, and a drain longer than the lease let another worker take
// the run (#2874).
describe("heartbeat during drain", () => {
  it("REST worker keeps listing the in-flight job in heartbeats while draining", async () => {
    const release = deferred();
    const started = deferred();
    const hb: Array<{ phase: string; jobs: number }> = [];
    let phase = "running";
    let served = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/heartbeat")) {
        const b = JSON.parse(String(init?.body));
        hb.push({ phase, jobs: b.jobs.length });
      } else if (init?.method === "GET" && url.includes("/jobs")) {
        if (served) { await new Promise((r) => setTimeout(r, 20)); return new Response(null, { status: 204 }); }
        served = true;
        return Response.json({ jobs: [{
          job_id: "run", run_id: "run", function_id: "fn", attempt: 1,
          event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
          completed_steps: [], execution_seq: 1, lease_token: "token",
        }] });
      }
      return Response.json({});
    }));
    const worker = createWorker({
      serverUrl: "http://localhost:9123", heartbeatInterval: 20, drainTimeout: 1500,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      functions: [{ config: { id: "fn", triggers: [{ event: "e" }] }, handler: async () => {
        started.resolve(); await release.promise; return "done";
      } }],
    });
    const running = worker.start();
    await started.promise;
    await new Promise((r) => setTimeout(r, 150));
    const before = hb.filter((h) => h.phase === "running" && h.jobs === 1).length;
    expect(before).toBeGreaterThan(0);
    phase = "draining";
    const drained = worker.drain();
    await new Promise((r) => setTimeout(r, 400)); // job still in flight, drain window open
    // Heartbeats while draining still list the in-flight job.
    const during = hb.filter((h) => h.phase === "draining" && h.jobs === 1).length;
    release.resolve();
    await drained; worker.stop(); await running;
    expect(during).toBeGreaterThan(0); // fails if heartbeats stop during drain
  });

  it("streaming worker keeps sending heartbeats while draining", async () => {
    vi.useFakeTimers();
    const worker = createStreamingWorker({
      serverUrl: "http://localhost:9123", functions: [], maxConcurrentJobs: 1,
      heartbeatInterval: 1000, drainTimeout: 300_000, logger: false,
    });
    const w = worker as unknown as {
      state: string; sendMessage: (m: unknown) => void; startHeartbeat(): void;
      activeJobs: Map<string, unknown>;
    };
    const sent: string[] = [];
    w.state = "connected";
    w.sendMessage = (m: unknown) => sent.push((m as { payload: { case: string } }).payload.case);
    w.activeJobs.set("held", { jobId: "held", startedAt: new Date(), abortController: new AbortController() });
    w.startHeartbeat();
    await vi.advanceTimersByTimeAsync(5000);
    const before = sent.filter((c) => c === "heartbeat").length;
    void worker.drain();
    expect(w.state).toBe("draining");
    await vi.advanceTimersByTimeAsync(120_000); // beyond 90s lease expiry, job still in flight
    const total = sent.filter((c) => c === "heartbeat").length;
    expect(total - before).toBeGreaterThan(0);
    worker.stop();
  });
});
