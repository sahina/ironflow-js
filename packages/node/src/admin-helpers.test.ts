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
      { body: { deployment: { deploymentId: "v1", mode: "EXECUTION_MODE_PULL" } } },
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
    const d = { deploymentId: "v1", mode: "EXECUTION_MODE_PUSH", endpointUrl: "https://x" };
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
      "/api/v1/capacity/lanes?env=env_default",
      "/api/v1/capacity/leases",
      "/api/v1/capacity/buckets",
      "/api/v1/capacity/sessions",
      "/api/v1/capacity/credits",
      "/api/v1/capacity/stats",
    ]);
  });
});

describe("debounce list", () => {
  it("returns the entries as sent", async () => {
    const entry = { environment_id: "env_default", function_id: "fn", debounce_key: "k", period_ms: 500 };
    stubFetch({ body: [entry] });
    expect(await client().debounce.list()).toEqual([entry]);
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
    const f = stubFetch({ body: {} }, { body: { entry: { revision: "2" } } }, { body: {} }, { body: { entry: { revision: "5" } } });
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
