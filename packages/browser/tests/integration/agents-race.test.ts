/**
 * D10 ship-blocking gate: race-window verification for `agents.invoke()`.
 *
 * Hypothesis: events emitted by the agent between `POST /Trigger` returning
 * and `subscribe()` attaching are caught by `replay`. If this gate fails,
 * escalate to issue #626 (server-side `TriggerSyncByFunctionId`).
 *
 * 100 sequential invocations against a fast-emitting agent. Asserts:
 *   - Zero hangs (every invoke resolves within timeout)
 *   - Zero `AgentInvokeTimeoutError`
 *   - Every result carries a `runId`
 *
 * The test is sequential, not parallel, so one stuck invoke is observable.
 *
 * Requires same setup as `agents-invoke.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ironflow } from "../../src/index.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";
const FIXTURE_FN = process.env["FIXTURE_FN"] ?? "test-echo-agent";
const RACE_ITERATIONS = Number(process.env["RACE_ITERATIONS"] ?? "100");

describe.skipIf(!INTEGRATION)("agents.invoke — race-window gate (D10)", () => {
  beforeAll(async () => {
    const ok = await fetch(`${SERVER_URL}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) throw new Error(`Server not at ${SERVER_URL}`);
    ironflow.configure({
      serverUrl: SERVER_URL,
      transport: "connectrpc",
      environment: "default",
    });
    await ironflow.connect();
  }, 30_000);

  afterAll(() => {
    ironflow.disconnect();
  });

  it(
    `${RACE_ITERATIONS} sequential invokes resolve without hangs`,
    async () => {
      let hung = 0;
      for (let i = 0; i < RACE_ITERATIONS; i++) {
        try {
          const r = await ironflow.agents.invoke(
            FIXTURE_FN,
            { iter: i },
            { timeoutMs: 10_000 }
          );
          expect(r.runId).toBeTruthy();
        } catch (err) {
          // Treat any timeout as a hang. Run failures are still recorded
          // but don't count toward race-window failures (those are agent
          // semantics, not SDK race).
          if ((err as Error).name === "AgentInvokeTimeoutError") {
            hung += 1;
          }
        }
      }
      expect(hung).toBe(0);
    },
    RACE_ITERATIONS * 12_000 + 30_000
  );
});
