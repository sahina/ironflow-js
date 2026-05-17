/**
 * Subscription leak audit for `agents.invoke()`.
 *
 * Asserts: after N concurrent invokes (mixed success/failure), the
 * SubscriptionManager active-sub-count returns to zero. Every exit path
 * of `agents.invoke()` MUST run cleanup in `finally`.
 *
 * Requires same setup as `agents-invoke.test.ts`. Pre-registered fixture
 * function should accept `{ shouldFail: boolean }` and either complete or
 * fail accordingly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ironflow } from "../../src/index.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";
const FIXTURE_FN = process.env["FIXTURE_FN"] ?? "test-echo-agent";
const LEAK_ITERATIONS = Number(process.env["LEAK_ITERATIONS"] ?? "20");

describe.skipIf(!INTEGRATION)("agents.invoke — subscription leak audit", () => {
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
    `${LEAK_ITERATIONS} parallel invokes leave 0 active subs`,
    async () => {
      const before = ironflow.getActiveSubscriptionCount();

      const results = await Promise.allSettled(
        Array.from({ length: LEAK_ITERATIONS }, (_, i) =>
          ironflow.agents.invoke(
            FIXTURE_FN,
            { iter: i, shouldFail: i % 2 === 0 },
            { timeoutMs: 30_000 }
          )
        )
      );

      // Allow async cleanup to drain.
      await new Promise((r) => setTimeout(r, 1_000));
      const after = ironflow.getActiveSubscriptionCount();
      expect(after).toBe(before);
      expect(results.length).toBe(LEAK_ITERATIONS);
    },
    LEAK_ITERATIONS * 35_000
  );
});
