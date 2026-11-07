import { afterEach, describe, expect, it, vi } from "vitest";
import { IronflowClient } from "./client.js";

function stubFetch(...bodies: Array<{ status?: number; body?: unknown }>) {
  const fetchMock = vi.fn();
  for (const { status = 200, body } of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => {
    const u = new URL(url as string);
    const body = (init as RequestInit).body;
    return { method: (init as RequestInit).method, path: u.pathname + u.search, ...(body ? { body: JSON.parse(body as string) } : {}) };
  });
}

const client = () => new IronflowClient({ serverUrl: "http://localhost:9123", apiKey: "ifkey_test" });

afterEach(() => vi.unstubAllGlobals());

describe("deployments", () => {
  it("reads created=false when the wire omits it", async () => {
    const f = stubFetch(
      { body: { deployment: { deploymentId: "v1", mode: "EXECUTION_MODE_PULL", createdAt: "2026-09-06T12:00:00Z" } } },
      { body: { functionId: "f", mode: "FUNCTION_ROUTING_MODE_VERSIONED", activeDeploymentId: "v1", routingRevision: "4" } },
    );
    const c = client();
    const res = await c.deployments.register({ functionId: "f", deploymentId: "v1", artifactDigest: "sha256:x", mode: "pull" });
    expect(res).toMatchObject({ created: false, deployment: { deploymentId: "v1", mode: "pull" } });
    expect(await c.deployments.getExecutionRouting("f")).toMatchObject({ mode: "versioned", activeDeploymentId: "v1", routingRevision: 4 });
    expect(calls(f)[0]).toMatchObject({ path: "/ironflow.v1.DeploymentService/RegisterDeployment", body: { mode: "EXECUTION_MODE_PULL", snapshotSchemaVersion: 1 } });
  });
});

describe("deployments reads", () => {
  it("decodes get and list", async () => {
    const d = { deploymentId: "v1", mode: "EXECUTION_MODE_PUSH", endpointUrl: "https://x", createdAt: "2026-09-06T12:00:00Z" };
    const f = stubFetch({ body: { deployment: d } }, { body: { deployments: [d] } }, { body: {} });
    const c = client();
    expect(await c.deployments.get("f", "v1")).toMatchObject({ deploymentId: "v1", mode: "push" });
    expect((await c.deployments.list("f", { limit: 5 })).map((x) => x.endpointUrl)).toEqual(["https://x"]);
    // No deployments: protobuf JSON sends `{}`.
    expect(await c.deployments.list("f")).toEqual([]);
    expect(calls(f).map((x) => x.body)).toEqual([
      { functionId: "f", deploymentId: "v1" },
      { functionId: "f", limit: 5 },
      { functionId: "f" },
    ]);
  });
});

describe("capacity", () => {
  it("passes the filters as a query string", async () => {
    const f = stubFetch(...Array.from({ length: 7 }, () => ({ body: [] })));
    const c = client();
    await c.capacity.listQueue({ function: "fn-1", limit: 10 });
    await c.capacity.listLanes({ env: "env_default" });
    await c.capacity.listLeases();
    await c.capacity.listBuckets();
    await c.capacity.listSessions();
    await c.capacity.listCredits();
    await c.capacity.stats();
    expect(calls(f).map((x) => x.path)).toEqual([
      "/api/v1/capacity/queue?function=fn-1&limit=10",
      "/api/v1/capacity/lanes?env_id=env_default",
      "/api/v1/capacity/leases",
      "/api/v1/capacity/buckets",
      "/api/v1/capacity/sessions",
      "/api/v1/capacity/credits",
      "/api/v1/capacity/stats",
    ]);
  });

  it("decodes each view's timestamps and tolerates a null body", async () => {
    const at = "2026-09-06T12:00:00Z";
    stubFetch(
      { body: [{ created_at: at, last_used_at: at }] },
      { body: [{ first_enqueued_at: at, eligible_at: at, reservation_expires_at: null, created_at: at }] },
      { body: [{ activated_at: at, expires_at: at }] },
      { body: [{ last_dispatched_at: null, created_at: at }] },
      { body: [{ heartbeat_expiry: at, created_at: at }] },
      { body: [{ expires_at: at, created_at: at }] },
      { body: null },
    );
    const c = client();
    const date = new Date(at);
    expect((await c.capacity.listLanes())[0]!.last_used_at).toEqual(date);
    const [queued] = await c.capacity.listQueue();
    expect(queued!.eligible_at).toEqual(date);
    expect(queued!.reservation_expires_at).toBeUndefined();
    expect((await c.capacity.listLeases())[0]!.expires_at).toEqual(date);
    expect((await c.capacity.listBuckets())[0]!.last_dispatched_at).toBeUndefined();
    expect((await c.capacity.listSessions())[0]!.heartbeat_expiry).toEqual(date);
    expect((await c.capacity.listCredits())[0]!.expires_at).toEqual(date);
    expect(await c.capacity.listLanes()).toEqual([]);
  });

  it("rejects a row with an unreadable timestamp", async () => {
    stubFetch({ body: [{ created_at: "nope", last_used_at: "2026-09-06T12:00:00Z" }] });
    await expect(client().capacity.listLanes()).rejects.toThrow("CapacityLane.created_at");
  });
});

describe("debounce list", () => {
  it("returns the entries with their times as Date", async () => {
    const entry = { environment_id: "env_default", function_id: "fn", debounce_key: "k", period_ms: 500 };
    stubFetch({ body: [{ ...entry, armed_at: "2026-09-06T12:00:00.000Z", fires_at: "2026-09-06T12:00:00.500Z" }] });
    expect(await client().debounce.list()).toEqual([
      { ...entry, armed_at: new Date("2026-09-06T12:00:00.000Z"), fires_at: new Date("2026-09-06T12:00:00.500Z") },
    ]);
  });
});

describe("debounce", () => {
  it("base64url-encodes the raw key for the cancel path", async () => {
    const f = stubFetch({ status: 204 }, { status: 204 });
    const c = client();
    await c.debounce.cancel("env_default", "fn/1", "seed key/é");
    // Valid base64url by accident: sent raw it decodes to other bytes and cancels nothing.
    await c.debounce.cancel("env_default", "fn-1", "user123");
    expect(calls(f)).toEqual([
      { method: "DELETE", path: "/api/v1/debounce/entries/env_default/fn%2F1/c2VlZCBrZXkvw6k" },
      { method: "DELETE", path: "/api/v1/debounce/entries/env_default/fn-1/dXNlcjEyMw" },
    ]);
  });
});

describe("definition history", () => {
  it("sends int64 cursors and revisions as strings", async () => {
    const f = stubFetch({ body: {} }, { body: { entry: { revision: "2", recordedAt: "2026-09-06T12:00:00Z" } } }, { body: {} }, { body: { entry: { revision: "5", recordedAt: "2026-09-06T12:00:00Z" } } });
    const c = client();
    expect(await c.projections.listHistory("p", { limit: 1, beforeRevision: 3 })).toEqual({ entries: [], hasMore: false, nextBeforeRevision: 0 });
    expect((await c.projections.getRevision("p", 2)).revision).toBe(2);
    await c.schemas.listHistory("e", 1);
    expect((await c.schemas.getRevision("e", 1, 5)).revision).toBe(5);
    expect(calls(f).map((x) => x.body)).toEqual([
      { name: "p", limit: 1, beforeRevision: "3" },
      { name: "p", revision: "2" },
      { eventName: "e", version: 1 },
      { eventName: "e", version: 1, revision: "5" },
    ]);
  });
});
