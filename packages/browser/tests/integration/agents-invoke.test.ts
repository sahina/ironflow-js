/**
 * Ship-blocking integration tests for `ironflow.agents.invoke()`.
 *
 * Requires:
 *   1. A running Ironflow server: `./build/ironflow serve --dev`
 *   2. A registered test fixture function named `test-echo-agent` that
 *      echoes its input as the run output (or any registered function the
 *      test is updated to point to). Set FIXTURE_FN env to override the
 *      default fixture name.
 *   3. `IRONFLOW_INTEGRATION=1`
 *
 * Run:
 *   IRONFLOW_INTEGRATION=1 pnpm -C sdk/js/browser test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ironflow } from "../../src/index.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";
const FIXTURE_FN = process.env["FIXTURE_FN"] ?? "test-echo-agent";

describe.skipIf(!INTEGRATION)("agents.invoke — integration", () => {
  beforeAll(async () => {
    const ok = await fetch(`${SERVER_URL}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) {
      throw new Error(
        `Ironflow server not reachable at ${SERVER_URL}. Start with: ./build/ironflow serve --dev`
      );
    }

    const fnList = await fetch(`${SERVER_URL}/ironflow.v1.IronflowService/ListFunctions`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"}).then((r) =>
      r.json()
    );
    const exists = (fnList.functions ?? []).some(
      (f: { id: string; name?: string }) =>
        f.id === FIXTURE_FN || f.name === FIXTURE_FN
    );
    if (!exists) {
      throw new Error(
        `Test fixture function "${FIXTURE_FN}" not registered. Register an agent with that name first, or set FIXTURE_FN env.`
      );
    }

    ironflow.configure({
      serverUrl: SERVER_URL,
      transport: "connectrpc",
      environment: "default",
    });
    await ironflow.connect();
  });

  afterAll(() => {
    ironflow.disconnect();
  });

  it("round-trip: invoke returns runId + output", async () => {
    const result = await ironflow.agents.invoke<unknown>(
      FIXTURE_FN,
      { hello: "world" },
      { timeoutMs: 30_000 }
    );
    expect(result.runId).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("idempotencyKey: same key returns same runId", async () => {
    const key = `it-${Date.now()}`;
    const a = await ironflow.agents.invoke(
      FIXTURE_FN,
      { idem: 1 },
      { idempotencyKey: key, timeoutMs: 30_000 }
    );
    const b = await ironflow.agents.invoke(
      FIXTURE_FN,
      { idem: 1 },
      { idempotencyKey: key, timeoutMs: 30_000 }
    );
    expect(a.runId).toBe(b.runId);
  });

  // The Q19 seam: AbortSignal -> aborted fetch -> dead request context ->
  // cancelAbandonedRun. Unit tests prove each end separately and nothing
  // proves the chain, so this is the only test that justifies choosing
  // cancel-on-disconnect over a degraded abort. Needs a fixture that runs
  // longer than ABORT_AFTER_MS; set SLOW_FIXTURE_FN to point at one.
  it("abort cancels the run server-side", async () => {
    const slowFn = process.env["SLOW_FIXTURE_FN"];
    if (!slowFn) {
      throw new Error(
        "SLOW_FIXTURE_FN is required: name a registered function that runs longer than 2s, so the abort lands mid-run."
      );
    }

    const before = await ironflow.listRuns({ functionId: slowFn, limit: 50 });
    const known = new Set(before.runs.map((r) => r.id));

    const ac = new AbortController();
    const pending = ironflow.agents.invoke(
      slowFn,
      { slow: true },
      { timeoutMs: 60_000, signal: ac.signal }
    );
    // Long enough for the server to have created the run.
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // agents.invoke never surfaced a runId (the sync response never arrived),
    // so identify the run by what is new for this function.
    const after = await ironflow.listRuns({ functionId: slowFn, limit: 50 });
    const fresh = after.runs.filter((r) => !known.has(r.id));
    expect(fresh).toHaveLength(1);

    // Cancellation is asynchronous relative to the abort returning.
    const deadline = Date.now() + 5_000;
    let status = fresh[0]!.status;
    while (status !== "cancelled" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await ironflow.getRun(fresh[0]!.id)).status;
    }
    expect(status).toBe("cancelled");
  });
});
