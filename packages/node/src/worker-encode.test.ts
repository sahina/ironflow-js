import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "./worker.js";

afterEach(() => { vi.unstubAllGlobals(); });

// Runs one job through the polling worker and returns the terminal update body.
async function terminalUpdate(handler: (ctx: any) => Promise<unknown>): Promise<Record<string, any>> {
  let terminal: Record<string, any> | undefined;
  let served = false;
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "GET" && url.includes("/jobs")) {
      if (served) { await new Promise((r) => setTimeout(r, 20)); return new Response(null, { status: 204 }); }
      served = true;
      return Response.json({ jobs: [{
        job_id: "run", run_id: "run", function_id: "fn", attempt: 1,
        event: { id: "e", name: "e", data: {}, timestamp: new Date().toISOString() },
        completed_steps: [], execution_seq: 1, lease_token: "token",
      }] });
    }
    if (init?.method === "PUT" && url.endsWith("/jobs/run")) {
      const body = JSON.parse(String(init.body));
      if (body.status !== "progress") { terminal = body; done(); }
    }
    return Response.json({});
  }));
  const worker = createWorker({
    serverUrl: "http://localhost:9123", heartbeatInterval: 1000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    functions: [{ config: { id: "fn", triggers: [{ event: "e" }] }, handler } as any],
  });
  const running = worker.start();
  await Promise.race([finished, new Promise((r) => setTimeout(r, 3000))]);
  worker.stop();
  await running;
  if (!terminal) throw new Error("no terminal update reached the server");
  return terminal;
}

// A result or step output JSON cannot encode (a BigInt) is reported as a
// non-retryable failure that keeps the earlier steps; the update used to throw
// before sending and the lease expired into a full re-run (#2874).
describe("polling worker: unencodable output", () => {
  it("fails the job non-retryably, keeping the encodable steps", async () => {
    const body = await terminalUpdate(async ({ step }) => {
      await step.run("charge", async () => 1);
      await step.run("calc", async () => ({ id: 1n }));
      return { ok: true };
    });
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("SERIALIZATION_ERROR");
    expect(body.error.retryable).toBe(false);
    expect(body.steps.map((s: { name: string }) => s.name)).toEqual(["charge"]);
  });
});
