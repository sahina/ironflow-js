import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import {
  capacityBucketFromWire,
  capacityLaneFromWire,
  capacityLeaseFromWire,
  capacityQuery,
  capacityQueueEntryFromWire,
  capacityWorkerCreditFromWire,
  capacityWorkerSessionFromWire,
  debounceEntryFromWire,
  definitionHistoryEntryFromWire,
  definitionHistoryPageFromWire,
  definitionHistoryRequest,
  DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION,
  deploymentFromWire,
  executeSQLResultFromWire,
  executionRoutingFromWire,
  projectionDefinitionFromWire,
  registerDeploymentRequest,
  schemaDefinitionFromWire,
} from "./admin-helpers.js";

// Wire bodies below are copied from a live server (#2948). Protobuf JSON drops
// zero values and sends int64 as a string, which is what these cover.
describe("definition history wire", () => {
  it("reads string revisions and defaults the dropped zero values", () => {
    const page = definitionHistoryPageFromWire(
      {
        entries: [
          {
            eventId: "f09a",
            revision: "1",
            previousDefinition: { name: "p", environmentId: "env_default", events: ["a.one"], mode: "external", type: "sdk" },
            actorId: "ak_admin_bootstrap",
            changeReason: "add two",
            changeType: "updated",
            recordedAt: "2026-10-16T19:09:24.729881Z",
          },
        ],
      },
      projectionDefinitionFromWire,
    );
    expect(page.hasMore).toBe(false);
    expect(page.nextBeforeRevision).toBe(0);
    expect(page.entries[0]).toMatchObject({ revision: 1, changeType: "updated" });
    expect(page.entries[0]!.previousDefinition).toMatchObject({ version: 0, events: ["a.one"], eventHandlers: {}, sqlDefinition: "" });
  });

  it("reads a cursor and a schema document", () => {
    const page = definitionHistoryPageFromWire(
      {
        entries: [{ revision: "7", recordedAt: "2026-09-06T12:00:00Z", previousDefinition: { eventName: "e", version: 1, schemaJson: '{"description":"José"}' } }],
        hasMore: true,
        nextBeforeRevision: "7",
      },
      schemaDefinitionFromWire,
    );
    expect(page).toMatchObject({ hasMore: true, nextBeforeRevision: 7 });
    expect(page.entries[0]!.previousDefinition).toMatchObject({ version: 1, schemaJson: '{"description":"José"}' });
    expect(page.entries[0]!.recordedAt).toEqual(new Date("2026-09-06T12:00:00Z"));
  });

  it("throws when recordedAt is absent", () => {
    expect(() => definitionHistoryEntryFromWire({ revision: "7" }, schemaDefinitionFromWire)).toThrow(/definitionHistoryEntry\.recordedAt/);
  });

  it("sends the cursor as a string and omits unset options", () => {
    expect(definitionHistoryRequest()).toEqual({});
    expect(definitionHistoryRequest({ limit: 1, beforeRevision: 9 })).toEqual({ limit: 1, beforeRevision: "9" });
  });
});

describe("deployment wire", () => {
  it("builds the register request with the snapshot schema version", () => {
    expect(
      registerDeploymentRequest({ functionId: "f", deploymentId: "v1", artifactDigest: "sha256:x", mode: "pull" }),
    ).toEqual({ functionId: "f", deploymentId: "v1", artifactDigest: "sha256:x", mode: "EXECUTION_MODE_PULL", snapshotSchemaVersion: 1 });
  });

  it("declares schema 1 for a snapshot without schema-2 fields", () => {
    const base = { functionId: "f", deploymentId: "v1", artifactDigest: "sha256:x", mode: "pull" as const };
    expect(registerDeploymentRequest({ ...base, snapshot: { timeoutMs: 1000, retry: { maxAttempts: 3 } } }).snapshotSchemaVersion).toBe(1);
  });

  it.each([
    ["circuitBreaker", { circuitBreaker: { failureThreshold: 5 } }],
    ["circuit_breaker", { circuit_breaker: { failure_threshold: 5 } }],
    ["throttle", { throttle: { limit: 10 } }],
    ["retry.onExhausted", { retry: { maxAttempts: 3, onExhausted: "fail" } }],
    ["retry.on_exhausted", { retry: { max_attempts: 3, on_exhausted: "fail" } }],
  ])("declares schema 2 when the snapshot uses %s", (_name, snapshot) => {
    const req = registerDeploymentRequest({ functionId: "f", deploymentId: "v1", artifactDigest: "sha256:x", mode: "pull", snapshot });
    expect(req.snapshotSchemaVersion).toBe(DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION);
    expect(DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION).toBe(2);
  });

  it("maps enums and defaults absent fields", () => {
    expect(deploymentFromWire({ deploymentId: "v1", mode: "EXECUTION_MODE_PUSH", endpointUrl: "https://x", createdAt: "2026-09-06T12:00:00Z" })).toMatchObject({
      createdAt: new Date("2026-09-06T12:00:00Z"),
      deploymentId: "v1",
      mode: "push",
      endpointUrl: "https://x",
      snapshot: {},
      createdBy: "",
    });
    expect(
      executionRoutingFromWire({ functionId: "f", mode: "FUNCTION_ROUTING_MODE_LEGACY", updatedAt: "2026-10-16T19:08:34Z" }),
    ).toEqual({ functionId: "f", mode: "legacy", activeDeploymentId: "", routingRevision: 0, transitionId: "", updatedAt: new Date("2026-10-16T19:08:34Z") });
    expect(executionRoutingFromWire({ mode: "FUNCTION_ROUTING_MODE_ADOPTING", routingRevision: "3", transitionStartedAt: "2026-09-06T12:00:00Z" })).toMatchObject({
      mode: "adopting",
      routingRevision: 3,
      transitionStartedAt: new Date("2026-09-06T12:00:00Z"),
    });
  });

  it("leaves routing timestamps the server omits absent", () => {
    const routing = executionRoutingFromWire({ functionId: "f", mode: "FUNCTION_ROUTING_MODE_LEGACY" });
    expect(routing.updatedAt).toBeUndefined();
    expect(routing.transitionStartedAt).toBeUndefined();
  });

  it("throws on an unreadable deployment or routing timestamp", () => {
    expect(() => deploymentFromWire({ deploymentId: "v1" })).toThrow(/deployment\.createdAt/);
    expect(() => executionRoutingFromWire({ updatedAt: "soon" })).toThrow(/executionRouting\.updatedAt/);
    expect(() => executionRoutingFromWire({ transitionStartedAt: "soon" })).toThrow(/executionRouting\.transitionStartedAt/);
  });
});

describe("ExecuteSQL wire", () => {
  it("zips positional values into rows", () => {
    expect(executeSQLResultFromWire({ columns: ["n", "who", "missing"], rows: [{ values: ["1", "José", ""] }], totalRows: 1 })).toEqual({
      columns: ["n", "who", "missing"],
      rows: [{ n: "1", who: "José", missing: "" }],
      totalRows: 1,
    });
    expect(executeSQLResultFromWire({ columns: ["n"] })).toEqual({ columns: ["n"], rows: [], totalRows: 0 });
  });
});

describe("capacityQuery", () => {
  it("encodes only the set filters", () => {
    expect(capacityQuery()).toBe("");
    expect(capacityQuery({ env: "env_default", function: "fn a", limit: 5 })).toBe("?env_id=env_default&function=fn+a&limit=5");
  });
});

describe("capacity and debounce rows", () => {
  const at = "2026-09-06T12:00:00.123456Z";
  const date = new Date(at);

  it("decodes every timestamp and keeps the other fields", () => {
    expect(capacityLaneFromWire({ lane_id: "l", limit: 1, created_at: at, last_used_at: at })).toEqual({
      lane_id: "l",
      limit: 1,
      created_at: date,
      last_used_at: date,
    });
    expect(capacityLeaseFromWire({ lease_id: "x", lane_id: null, activated_at: at, expires_at: at })).toEqual({
      lease_id: "x",
      lane_id: null,
      activated_at: date,
      expires_at: date,
    });
    expect(capacityWorkerSessionFromWire({ session_id: "s", heartbeat_expiry: at, created_at: at })).toEqual({
      session_id: "s",
      heartbeat_expiry: date,
      created_at: date,
    });
    expect(capacityWorkerCreditFromWire({ credit_id: "c", expires_at: at, created_at: at })).toEqual({
      credit_id: "c",
      expires_at: date,
      created_at: date,
    });
    expect(debounceEntryFromWire({ debounce_key: "k", armed_at: at, fires_at: at })).toEqual({
      debounce_key: "k",
      armed_at: date,
      fires_at: date,
    });
  });

  it("treats a null reservation or dispatch time as absent", () => {
    const queued = { run_id: "r", first_enqueued_at: at, eligible_at: at, created_at: at };
    const entry = capacityQueueEntryFromWire({ ...queued, reservation_owner: null, reservation_expires_at: null });
    expect(entry.reservation_expires_at).toBeUndefined();
    expect(entry.reservation_owner).toBeNull();
    expect(entry.eligible_at).toEqual(date);
    expect(capacityQueueEntryFromWire({ ...queued, reservation_expires_at: at }).reservation_expires_at).toEqual(date);

    expect(capacityBucketFromWire({ last_dispatched_at: null, created_at: at }).last_dispatched_at).toBeUndefined();
    expect(capacityBucketFromWire({ last_dispatched_at: at, created_at: at }).last_dispatched_at).toEqual(date);
  });

  it("throws on an absent required value and an unreadable optional one", () => {
    expect(() => debounceEntryFromWire({ armed_at: at })).toThrow(SchemaValidationError);
    expect(() => debounceEntryFromWire({ armed_at: at })).toThrow("DebounceEntry.fires_at");
    expect(() => capacityBucketFromWire({ last_dispatched_at: "soon", created_at: at })).toThrow(SchemaValidationError);
  });
});
