/**
 * Live test: the operational-controls group (#3003) through the Node client:
 * only the environment-wide audit query. The circuit-breaker, flow-edge and
 * outbox dead-letter calls exist in Python alone (ADR 0092). Skips unless
 * IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

interface Seed {
  functionId: string;
  runId: string;
  beforeRun: string;
}

describe.skipIf(!SEED_PATH)("readiness operational controls — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });

  it("audit-env-wide", async () => {
    // Newest first, the reverse of the per-run trail.
    const want = ["run.status_changed", "step.completed", "step.started", "run.created"];
    const types = (events: { eventType: string }[]) => events.map((e) => e.eventType);

    const byRun = await client.listAuditEvents({ runId: seed.runId });
    expect(types(byRun.events)).toEqual(want);
    expect(byRun.totalCount).toBe(4);
    for (const e of byRun.events) {
      expect(e).toMatchObject({ runId: seed.runId, functionId: seed.functionId });
      expect(e.id).toBeTruthy();
      expect(e.createdAt).toBeTruthy();
    }

    const only = await client.listAuditEvents({ functionId: seed.functionId, eventType: "step.completed" });
    expect(only.events.map((e) => [e.eventType, e.runId])).toEqual([["step.completed", seed.runId]]);

    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 2; page++) {
      const p = await client.listAuditEvents({ runId: seed.runId, limit: 2, cursor });
      expect(p.events).toHaveLength(2);
      expect(p.totalCount).toBe(4);
      paged.push(...types(p.events));
      cursor = p.nextCursor;
    }
    expect(paged).toEqual(want);

    // The seed took beforeRun before it triggered the run, so the window decides.
    expect((await client.listAuditEvents({ runId: seed.runId, fromTimestamp: seed.beforeRun })).totalCount).toBe(4);
    expect((await client.listAuditEvents({ runId: seed.runId, toTimestamp: seed.beforeRun })).events).toEqual([]);
  });
});
