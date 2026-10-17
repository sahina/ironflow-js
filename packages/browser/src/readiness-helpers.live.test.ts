// @vitest-environment node
/**
 * Live test: drives the #2948 browser helpers against a seeded server.
 * Skips unless IRONFLOW_READINESS_HELPERS_SEED is set; `make test-readiness-helpers-live` sets it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_HELPERS_SEED"];

interface Seed {
  projection: string;
  projectionEvents: string[][];
  schemaEvent: string;
  schemaVersion: number;
  schemaDocs: string[];
}

describe.skipIf(!SEED_PATH)("readiness helpers — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const client = ironflow;
  client.configure({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
  });

  it("sql-execute", async () => {
    const res = await client.executeSQL("SELECT 1 AS n, 'José' AS who, NULL AS missing", { maxRows: 5 });
    expect(res).toEqual({ columns: ["n", "who", "missing"], rows: [{ n: "1", who: "José", missing: "" }], totalRows: 1 });
  });

  it("proj-history and proj-revision", async () => {
    const first = await client.listProjectionHistory(seed.projection, { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const newest = first.entries[0]!;
    expect(first.nextBeforeRevision).toBe(newest.revision);
    expect(newest.previousDefinition.events).toEqual(seed.projectionEvents[1]);
    expect(newest).toMatchObject({ changeType: "updated", changeReason: "change 2" });
    expect(newest.recordedAt).toMatch(/^\d{4}-/);

    const second = await client.listProjectionHistory(seed.projection, { limit: 1, beforeRevision: first.nextBeforeRevision });
    expect(second.entries).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextBeforeRevision).toBe(0);
    expect(second.entries[0]!.previousDefinition.events).toEqual(seed.projectionEvents[0]);

    expect(await client.getProjectionRevision(seed.projection, second.entries[0]!.revision)).toEqual(second.entries[0]);
  });

  it("schema-history and schema-revision", async () => {
    const page = await client.schemas.listHistory(seed.schemaEvent, seed.schemaVersion);
    expect(page.hasMore).toBe(false);
    expect(page.entries.map((e) => e.previousDefinition.schemaJson)).toEqual([seed.schemaDocs[1], seed.schemaDocs[0]]);
    const oldest = page.entries[1]!;
    const got = await client.schemas.getRevision(seed.schemaEvent, seed.schemaVersion, oldest.revision);
    expect(got).toEqual(oldest);
    expect(got.previousDefinition.version).toBe(seed.schemaVersion);
    expect(got.changeType).toBe("updated");
  });
});
