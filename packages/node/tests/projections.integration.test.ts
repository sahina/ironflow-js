/**
 * Integration tests for `client.projections.get` wire envelope peel (#610).
 *
 * Requires a running Ironflow server.
 *   ./build/ironflow serve
 *   IRONFLOW_INTEGRATION=1 pnpm test
 *
 * Verifies the SDK peels the real server REST envelope into a flat
 * `ProjectionStateResult<T>`. Mock-only tests can mask wire-vs-type drift
 * — see CEO/eng review on #610.
 *
 * Approach: register a SQL projection (no worker required), then read it.
 * SQL projections live in the projection registry but write to their own
 * table (not `projection_state`), so `getProjection` exercises the
 * "no inner state row" branch on real wire — partition echo + empty state
 * + populated registry-level fields (mode, version, lastEventSeq, updatedAt).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IronflowClient } from "../src/client.js";

const INTEGRATION = process.env["IRONFLOW_INTEGRATION"] === "1";
const SERVER_URL = process.env["IRONFLOW_SERVER_URL"] ?? "http://localhost:9123";

describe.skipIf(!INTEGRATION)("projections.get — wire envelope peel", () => {
  let client: IronflowClient;
  const projectionsToCleanup: string[] = [];

  beforeAll(async () => {
    const ok = await fetch(`${SERVER_URL}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) {
      throw new Error(
        `Ironflow server not reachable at ${SERVER_URL}. Start with: ./build/ironflow serve`
      );
    }
    client = new IronflowClient({ serverUrl: SERVER_URL });
  });

  afterAll(async () => {
    for (const name of projectionsToCleanup) {
      try {
        await client.projections.delete(name);
      } catch {
        // best effort
      }
    }
  });

  it("returns flat ProjectionStateResult against real server (no state row yet)", async () => {
    const name = `peel-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    projectionsToCleanup.push(name);

    await client.sqlProjections.create({
      name,
      tableSql: `CREATE TABLE proj_${name.replace(/-/g, "_")} (id TEXT PRIMARY KEY, val TEXT)`,
      eventHandlers: {},
      events: ["never.fires.in.this.test"],
    });

    const result = await client.projections.get(name);

    expect(result.name).toBe(name);
    expect(result.partition).toBe("__global__");
    expect(result.state).toEqual({});
    expect(result.lastEventTime).toBeUndefined();
    expect(result.lastEventSeq).toBe(0);
    expect(typeof result.version).toBe("number");
    expect(["managed", "external"]).toContain(result.mode);
    expect(result.updatedAt).toBeInstanceOf(Date);
  }, 15_000);

  it("threads partition option and echoes requested key when no state row", async () => {
    const name = `peel-partition-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    projectionsToCleanup.push(name);

    await client.sqlProjections.create({
      name,
      tableSql: `CREATE TABLE proj_${name.replace(/-/g, "_")} (id TEXT PRIMARY KEY)`,
      eventHandlers: {},
      events: ["never.fires"],
    });

    const result = await client.projections.get(name, {
      partition: "customer-99",
    });

    expect(result.partition).toBe("customer-99");
    expect(result.state).toEqual({});
  }, 15_000);

  it("returns 404-class IronflowError for unknown projection", async () => {
    await expect(
      client.projections.get(`does-not-exist-${Date.now()}`)
    ).rejects.toThrow(/projection not found/);
  }, 5_000);
});
