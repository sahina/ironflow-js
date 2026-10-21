/**
 * Live test: the execution-modes group (#3003) through the Node client.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createFunction } from "./function.js";
import { serve } from "./serve.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];
const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;
const API_KEY = process.env["IRONFLOW_TEST_API_KEY"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SEED_PATH)("readiness execution modes — live server", () => {
  const client = new IronflowClient({ serverUrl: SERVER, apiKey: API_KEY });
  const suffix = Date.now();

  // The engine calls the handler serve() returns, signs nothing (the server has no
  // signing key) and resumes after the sleep by calling it again, so a step that
  // runs once across both calls shows the memoized resume.
  it("exec-push-serve", async () => {
    const id = `readiness-push-node-${suffix}`;
    const event = `readiness.push.${id}`;
    const ran = { pushes: 0, a: 0, b: 0 };
    const fn = createFunction({ id, triggers: [{ event }] }, async ({ step }) => {
      ran.pushes++;
      const a = await step.run("a", async () => (ran.a++, 1));
      await step.sleep("nap", "1s");
      const b = await step.run("b", async () => (ran.b++, 2));
      return { a, b };
    });
    const handler = serve({ functions: [fn], logger: false });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      await client.registerFunction({ id, triggers: [{ event }], preferredMode: "push", endpointUrl });

      // push-protocol.md: any method but POST gets 405.
      expect((await fetch(endpointUrl)).status).toBe(405);

      const { runIds } = await client.emit(event, {});
      expect(runIds).toHaveLength(1);
      const deadline = Date.now() + 25_000;
      let run = await client.getRun(runIds[0]!);
      while (run.status !== "completed" && run.status !== "failed" && Date.now() < deadline) {
        await sleep(200);
        run = await client.getRun(runIds[0]!);
      }
      expect(run).toMatchObject({ status: "completed", output: { a: 1, b: 2 } });
      expect(ran.pushes).toBeGreaterThanOrEqual(2);
      expect([ran.a, ran.b]).toEqual([1, 1]);
    } finally {
      server.close();
      await client.deleteFunction(id).catch(() => undefined);
    }
  }, 40_000);

  it("exec-workers-list", async () => {
    const workerId = `readiness-worker-node-${suffix}`;
    const res = await fetch(`${SERVER}/api/v1/workers/${workerId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        hostname: "readiness-host",
        function_ids: [`readiness-worker-fn-${workerId}`],
        max_concurrent_jobs: 3,
        labels: { pool: "readiness" },
        version: { sdk: "node", runtime: "vitest" },
      }),
    });
    expect(res.status).toBe(200);

    const workers = (await client.listWorkers()) as Array<Record<string, unknown>>;
    expect(workers.find((w) => w["id"] === workerId)).toMatchObject({
      hostname: "readiness-host",
      function_ids: [`readiness-worker-fn-${workerId}`],
      max_concurrent: 3,
      labels: { pool: "readiness" },
      version: { sdk: "node", runtime: "vitest" },
      active_jobs: 0,
      transport: "rest-polling",
      registered_at: expect.stringMatching(/^\d{4}-/),
      last_heartbeat: expect.stringMatching(/^\d{4}-/),
    });
  });
});
