// @vitest-environment node
/**
 * Live test: the execution-modes group (#3003) through the browser client. Push
 * serve is excluded for the browser, so only the workers list applies.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { ironflow as client } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];
const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;
const API_KEY = process.env["IRONFLOW_TEST_API_KEY"];

describe.skipIf(!SEED_PATH)("readiness execution modes — live server", () => {
  client.configure({ serverUrl: SERVER, auth: { apiKey: API_KEY } });

  it("exec-workers-list", async () => {
    const workerId = `readiness-worker-browser-${Date.now()}`;
    const res = await fetch(`${SERVER}/api/v1/workers/${workerId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        hostname: "readiness-host",
        function_ids: [`readiness-worker-fn-${workerId}`],
        max_concurrent_jobs: 3,
        labels: { pool: "readiness" },
        version: { sdk: "browser", runtime: "vitest" },
      }),
    });
    expect(res.status).toBe(200);

    const workers = (await client.listWorkers()) as Array<Record<string, unknown>>;
    expect(workers.find((w) => w["id"] === workerId)).toMatchObject({
      hostname: "readiness-host",
      function_ids: [`readiness-worker-fn-${workerId}`],
      max_concurrent: 3,
      labels: { pool: "readiness" },
      version: { sdk: "browser", runtime: "vitest" },
      active_jobs: 0,
      transport: "rest-polling",
      registered_at: expect.stringMatching(/^\d{4}-/),
      last_heartbeat: expect.stringMatching(/^\d{4}-/),
    });
  });
});
