import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, type FunctionContext } from "@ironflow/core";
import { createWorker } from "./worker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("polling worker stale execution", () => {
  it.each(["run", "branch", "return", "fail", "yield"])(
    "abandons a stale checkpoint before %s without reporting",
    async (outcome) => {
      const checkpoint = deferred();
      const release = deferred();
      const handlerDone = deferred();
      const updates: string[] = [];
      const heartbeats: Array<{ jobs: unknown[] }> = [];
      const sideEffect = vi.fn();
      const compensation = vi.fn();
      let served = false;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/heartbeat")) {
          heartbeats.push(JSON.parse(String(init?.body)));
        } else if (init?.method === "GET" && url.includes("/jobs")) {
          if (served) return new Response(null, { status: 204 });
          served = true;
          return Response.json({ jobs: [{
            job_id: "run", run_id: "run", function_id: "fn", attempt: 1,
            event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
            completed_steps: [], execution_seq: 1, lease_token: "token",
          }] });
        } else if (url.endsWith("/jobs/run")) {
          const body = JSON.parse(String(init?.body));
          updates.push(body.status);
          if (body.status === "progress") {
            checkpoint.resolve();
            return Response.json({ error: "STALE_EXECUTION" }, { status: 409 });
          }
        }
        return Response.json({});
      }));
      const worker = createWorker({
        serverUrl: "http://localhost:9123", checkpointInterval: 1, heartbeatInterval: 5,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        functions: [{ config: { id: "fn", triggers: [{ event: "e" }] }, handler: async (ctx: FunctionContext) => {
          try {
            await ctx.step.run("first", async () => 1);
            ctx.step.compensate("first", async () => { compensation(); });
            await release.promise;
            if (outcome === "branch") {
              await ctx.step.parallel("parallel", [async (step) => step.run("next", async () => sideEffect())]);
            } else if (outcome === "run") {
              await ctx.step.run("next", async () => sideEffect());
            } else if (outcome === "fail") {
              throw new NonRetryableError("handler failed after abandonment");
            } else if (outcome === "yield") {
              await ctx.step.sleep("sleep", "1h");
            }
            return "done";
          } finally {
            handlerDone.resolve();
          }
        } }],
      });
      const running = worker.start();
      try {
        await checkpoint.promise;
        await vi.waitFor(() => expect(heartbeats.at(-1)?.jobs).toEqual([]), { timeout: 500 });
        release.resolve();
        await handlerDone.promise;
        await worker.drain();
        expect(sideEffect).not.toHaveBeenCalled();
        expect(compensation).not.toHaveBeenCalled();
        expect(updates).toEqual(["progress"]);
      } finally {
        release.resolve();
        await worker.stop();
        await running;
      }
    }
  );

  it.each([
    [409, '{"error":"STALE_EXECUTION"}', false, "return"],
    [409, '{"error":"STALE_EXECUTION"}', false, "fail"],
    [409, '{"error":"STALE_EXECUTION"}', false, "yield"],
    [409, '{"error":"RUN_NOT_RUNNING"}', true, "return"],
    [409, 'not json', true, "return"],
    [500, '{"error":"STALE_EXECUTION"}', true, "return"],
  ])("handles an in-flight checkpoint returning %s %s", async (status, body, report, outcome) => {
    const checkpoint = deferred();
    const response = deferred();
    const handlerDone = deferred();
    const updates: string[] = [];
    let served = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("/jobs")) {
        if (served) return new Response(null, { status: 204 });
        served = true;
        return Response.json({ job_id: "run", run_id: "run", function_id: "fn", attempt: 1,
          event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() }, completed_steps: [] });
      }
      if (url.endsWith("/jobs/run")) {
        const update = JSON.parse(String(init?.body));
        updates.push(update.status);
        if (update.status === "progress") {
          checkpoint.resolve();
          await response.promise;
          return new Response(body, { status });
        }
      }
      return Response.json({});
    }));
    const worker = createWorker({
      serverUrl: "http://localhost:9123", checkpointInterval: 1,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      functions: [{ config: { id: "fn", triggers: [{ event: "e" }] }, handler: async (ctx: FunctionContext) => {
        await ctx.step.run("first", async () => 1);
        await checkpoint.promise;
        handlerDone.resolve();
        if (outcome === "fail") throw new NonRetryableError("failure");
        if (outcome === "yield") await ctx.step.sleep("sleep", "1h");
        return "done";
      } }],
    });
    const running = worker.start();
    try {
      await handlerDone.promise;
      // drain waits for the handler's terminal path while the checkpoint is held.
      const drained = worker.drain();
      response.resolve();
      await drained;
      expect(updates).toEqual(report ? ["progress", "completed"] : ["progress"]);
    } finally {
      response.resolve();
      await worker.stop();
      await running;
    }
  });
});
