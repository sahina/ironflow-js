/**
 * Live test: drives the #2948 Node helpers against a seeded server.
 * Skips unless IRONFLOW_READINESS_HELPERS_SEED is set; `make test-readiness-helpers-live` sets it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_HELPERS_SEED"];

interface Seed {
  platformKey: string;
  capacityFunctionId: string;
  leasedRunId: string;
  queuedRunId: string;
  debounceFunctionId: string;
  projection: string;
  projectionEvents: string[][];
  schemaEvent: string;
  schemaVersion: number;
  schemaDocs: string[];
}

describe.skipIf(!SEED_PATH)("readiness helpers — live server", () => {
  const seed = SEED_PATH ? (JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed) : ({} as Seed);
  const serverUrl = process.env["IRONFLOW_TEST_SERVER"]!;
  const client = new IronflowClient({ serverUrl, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
  const platform = new IronflowClient({ serverUrl, apiKey: seed.platformKey });

  it("deployment-register and deployment-read", async () => {
    const input = {
      functionId: seed.debounceFunctionId,
      deploymentId: "nodesdk-v1",
      artifactDigest: `sha256:${"2".repeat(64)}`,
      snapshot: { triggers: [{ event: "orders.placed" }], timeoutMs: 30000, metadata: { who: "José" } },
      mode: "pull" as const,
    };
    const first = await client.deployments.register(input);
    expect(first.created).toBe(true);
    expect(first.deployment).toMatchObject({ deploymentId: "nodesdk-v1", mode: "pull", artifactDigest: input.artifactDigest });
    expect(first.deployment.snapshot).toMatchObject({ timeoutMs: 30000, metadata: { who: "José" } });
    expect(first.deployment.createdAt).toMatch(/^\d{4}-/);
    // An identical registration answers with `created` absent on the wire.
    expect((await client.deployments.register(input)).created).toBe(false);

    const got = await client.deployments.get(seed.debounceFunctionId, "nodesdk-v1");
    expect(got).toEqual(first.deployment);
    expect(got.environmentId).not.toBe("");
    expect(got.createdBy).not.toBe("");

    const list = await client.deployments.list(seed.debounceFunctionId);
    expect(list.map((d) => d.deploymentId)).toContain("nodesdk-v1");

    const routing = await client.deployments.getExecutionRouting(seed.debounceFunctionId);
    // Registering never activates: the function stays on legacy routing.
    expect(routing).toMatchObject({ functionId: seed.debounceFunctionId, mode: "legacy", activeDeploymentId: "" });
    expect(routing.updatedAt).toMatch(/^\d{4}-/);
  });

  it("capacity-views", async () => {
    const fn = { function: seed.capacityFunctionId };
    const lanes = await platform.capacity.listLanes(fn);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ function_id: seed.capacityFunctionId, limit: 1, active_reserved: 1 });
    const lane = lanes[0]!.lane_id;
    expect(lane).not.toBe("");

    const queue = await platform.capacity.listQueue(fn);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ run_id: seed.queuedRunId, lane_id: lane, reservation_owner: null });

    const leases = await platform.capacity.listLeases();
    const lease = leases.find((l) => l.run_id === seed.leasedRunId);
    expect(lease?.lane_id).toBe(lane);
    expect(Date.parse(lease!.expires_at)).toBeGreaterThan(Date.parse(lease!.activated_at));

    const buckets = await platform.capacity.listBuckets(fn);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.lane_id).toBe(lane);

    const stat = (await platform.capacity.stats()).find((s) => s.function_id === seed.capacityFunctionId);
    expect(stat).toMatchObject({ active_leases: 1, queued: 1, lane_limit: 1 });

    const sessions = await platform.capacity.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions[0]!;
    expect(session.draining).toBe(false);
    const credits = (await platform.capacity.listCredits()).filter((c) => c.session_id === session.session_id);
    expect(credits.length).toBeGreaterThan(0);
    for (const c of credits) expect(c.worker_id).toBe(session.worker_id);
  });

  it("debounce-manage", async () => {
    const key = "nodesdk key/é";
    await client.emit(seed.debounceFunctionId, { k: key });
    const find = async () =>
      (await client.debounce.list()).find((e) => e.function_id === seed.debounceFunctionId && e.debounce_key === key);
    const entry = await find();
    expect(entry).toMatchObject({ period_ms: 600000 });
    expect(Date.parse(entry!.fires_at)).toBeGreaterThan(Date.parse(entry!.armed_at));

    await client.debounce.cancel(entry!.environment_id, seed.debounceFunctionId, key);
    expect(await find()).toBeUndefined();
  });

  it("proj-history and proj-revision", async () => {
    const first = await client.projections.listHistory(seed.projection, { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const newest = first.entries[0]!;
    expect(first.nextBeforeRevision).toBe(newest.revision);
    expect(newest.previousDefinition.events).toEqual(seed.projectionEvents[1]);
    expect(newest).toMatchObject({ changeType: "updated", changeReason: "change 2" });
    expect(newest.recordedAt).toMatch(/^\d{4}-/);

    const second = await client.projections.listHistory(seed.projection, { limit: 1, beforeRevision: first.nextBeforeRevision });
    expect(second.entries).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextBeforeRevision).toBe(0);
    expect(second.entries[0]!.previousDefinition.events).toEqual(seed.projectionEvents[0]);

    expect(await client.projections.getRevision(seed.projection, second.entries[0]!.revision)).toEqual(second.entries[0]);
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
