// Golden JSON contract tests for peelProjectionEnvelope.
//
// Wire fixtures are copied verbatim from a real Ironflow server response
// (`internal/server/server.go:2531` ProjectionResponse). If these tests
// break in CI, either the server contract drifted or peel logic regressed.
// See issue #610 / CHANGELOG 0.20.0.

import { describe, expect, it } from "vitest";
import { peelProjectionEnvelope } from "./projection-types.js";
import { IronflowError } from "./errors.js";

const HAPPY_WIRE = {
  name: "doc-processor-memory",
  environment_id: "env_default",
  version: 1,
  events: ["doc.uploaded", "doc.published"],
  partition_key: "",
  mode: "managed",
  status: "active",
  error_message: "",
  type: "sdk",
  description: "",
  last_event_seq: 9,
  created_at: "2026-04-26T12:00:00Z",
  updated_at: "2026-04-26T12:05:00Z",
  state: {
    projection_name: "doc-processor-memory",
    environment_id: "env_default",
    partition_key: "__global__",
    state: { "doc-1": { docId: "doc-1", status: "published", category: "tech" } },
    last_event_id: "evt-9",
    last_event_seq: 9,
    last_event_time: "2026-04-26T12:05:00Z",
    version: 1,
    updated_at: "2026-04-26T12:05:00Z",
  },
};

interface DocState {
  docId: string;
  status: string;
  category?: string;
}

describe("peelProjectionEnvelope — golden JSON wire contract", () => {
  it("happy path: peels nested envelope to flat result with typed state", () => {
    const result = peelProjectionEnvelope<Record<string, DocState>>(HAPPY_WIRE);

    expect(result.name).toBe("doc-processor-memory");
    expect(result.partition).toBe("__global__");
    expect(result.state).toEqual({
      "doc-1": { docId: "doc-1", status: "published", category: "tech" },
    });
    expect(result.lastEventId).toBe("evt-9");
    expect(result.lastEventSeq).toBe(9);
    expect(result.lastEventTime).toEqual(new Date("2026-04-26T12:05:00Z"));
    expect(result.version).toBe(1);
    expect(result.mode).toBe("managed");
    expect(result.status).toBe("active");
    expect(result.errorMessage).toBeUndefined();
    expect(result.updatedAt).toEqual(new Date("2026-04-26T12:05:00Z"));
  });

  it("Go zero-time sentinel (year 0001) is treated as undefined", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: {
        ...HAPPY_WIRE.state,
        last_event_time: "0001-01-01T00:00:00Z",
      },
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.lastEventTime).toBeUndefined();
  });

  it("server-emitted empty partition_key falls back to requested partition", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: {
        ...HAPPY_WIRE.state,
        partition_key: "",
      },
    };
    const result = peelProjectionEnvelope(wire, "customer-42");
    expect(result.partition).toBe("customer-42");
  });

  it("error status + error_message surface from registry envelope", () => {
    const wire = {
      ...HAPPY_WIRE,
      status: "error",
      error_message: "handler panicked",
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("handler panicked");
  });

  it("registry-level lastEventSeq + version win over inner state-row values", () => {
    const wire = {
      ...HAPPY_WIRE,
      version: 7,
      last_event_seq: 100,
      state: {
        ...HAPPY_WIRE.state,
        version: 1,
        last_event_seq: 0,
      },
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.version).toBe(7);
    expect(result.lastEventSeq).toBe(100);
  });

  it("outer state absent (registered, no events): returns empty user state", () => {
    const wire = {
      name: "fresh",
      environment_id: "env_default",
      version: 1,
      mode: "managed",
      status: "active",
      type: "sdk",
      last_event_seq: 0,
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:00Z",
    };
    const result = peelProjectionEnvelope(wire);

    expect(result.state).toEqual({});
    expect(result.partition).toBe("__global__");
    expect(result.lastEventTime).toBeUndefined();
    expect(result.lastEventSeq).toBe(0);
    expect(result.version).toBe(1);
    expect(result.mode).toBe("managed");
  });

  it("outer state explicitly null: same as absent", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: null,
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.state).toEqual({});
    expect(result.lastEventTime).toBeUndefined();
  });

  it("outer state present, inner state.state field missing: throws drift error", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: {
        projection_name: "doc-processor-memory",
        partition_key: "__global__",
        last_event_id: "evt-9",
      },
    };
    expect(() => peelProjectionEnvelope(wire)).toThrow(IronflowError);
    expect(() => peelProjectionEnvelope(wire)).toThrow(
      /projection envelope drift/
    );
  });

  it("inner state.state explicitly null: returns empty user state", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: {
        ...HAPPY_WIRE.state,
        state: null,
      },
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.state).toEqual({});
  });

  it("requested partition echoed back when no state row exists for that key", () => {
    const wire = {
      name: "by-customer",
      version: 1,
      mode: "managed",
      last_event_seq: 0,
      updated_at: "2026-04-26T12:00:00Z",
    };
    const result = peelProjectionEnvelope(wire, "customer-99");
    expect(result.partition).toBe("customer-99");
    expect(result.state).toEqual({});
  });

  it("malformed last_event_time throws drift error", () => {
    const wire = {
      ...HAPPY_WIRE,
      state: {
        ...HAPPY_WIRE.state,
        last_event_time: "not-a-timestamp",
      },
    };
    expect(() => peelProjectionEnvelope(wire)).toThrow(
      /projection envelope drift/
    );
  });

  it("non-object response throws drift error", () => {
    expect(() => peelProjectionEnvelope(null)).toThrow(IronflowError);
    expect(() => peelProjectionEnvelope("string")).toThrow(IronflowError);
    expect(() => peelProjectionEnvelope(42)).toThrow(IronflowError);
  });

  it("missing name field throws drift error", () => {
    const wire = { version: 1, mode: "managed" };
    expect(() => peelProjectionEnvelope(wire)).toThrow(/missing name/);
  });

  it("unknown mode value defaults to 'managed' (forward-compat)", () => {
    const wire = {
      ...HAPPY_WIRE,
      mode: "unknown-future-mode",
    };
    const result = peelProjectionEnvelope(wire);
    expect(result.mode).toBe("managed");
  });
});
