import { describe, expect, it } from "vitest";
import {
  capacityQuery,
  definitionHistoryPageFromWire,
  definitionHistoryRequest,
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
        entries: [{ revision: "7", previousDefinition: { eventName: "e", version: 1, schemaJson: '{"description":"José"}' } }],
        hasMore: true,
        nextBeforeRevision: "7",
      },
      schemaDefinitionFromWire,
    );
    expect(page).toMatchObject({ hasMore: true, nextBeforeRevision: 7 });
    expect(page.entries[0]!.previousDefinition).toMatchObject({ version: 1, schemaJson: '{"description":"José"}' });
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

  it("maps enums and defaults absent fields", () => {
    expect(deploymentFromWire({ deploymentId: "v1", mode: "EXECUTION_MODE_PUSH", endpointUrl: "https://x" })).toMatchObject({
      deploymentId: "v1",
      mode: "push",
      endpointUrl: "https://x",
      snapshot: {},
      createdBy: "",
    });
    expect(
      executionRoutingFromWire({ functionId: "f", mode: "FUNCTION_ROUTING_MODE_LEGACY", updatedAt: "2026-10-16T19:08:34Z" }),
    ).toEqual({ functionId: "f", mode: "legacy", activeDeploymentId: "", routingRevision: 0, transitionId: "", updatedAt: "2026-10-16T19:08:34Z" });
    expect(executionRoutingFromWire({ mode: "FUNCTION_ROUTING_MODE_ADOPTING", routingRevision: "3", transitionStartedAt: "t" })).toMatchObject({
      mode: "adopting",
      routingRevision: 3,
      transitionStartedAt: "t",
    });
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
    expect(capacityQuery({ env: "env_default", function: "fn a", limit: 5 })).toBe("?env=env_default&function=fn+a&limit=5");
  });
});
