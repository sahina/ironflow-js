import { describe, it, expect } from "vitest";

import { RunStatusSchema as RunStatusEnumDesc } from "./gen/ironflow/v1/types_pb.js";
import { runStatusFromWire, runStatusToWire } from "./schemas.js";

/**
 * runStatusFromWire and runStatusToWire are hand-maintained lists mirroring the
 * RunStatus enum in api/proto/ironflow/v1/types.proto. Nothing about adding a
 * value to that enum breaks the TypeScript build, and the strict decode means a
 * new server-side status turns every getRun/listRuns/cancelRun call into a
 * thrown SchemaValidationError at runtime.
 *
 * This is the drift gate: it walks the GENERATED enum descriptor — the same
 * source protojson encodes from — and fails the moment the proto gains a value
 * the SDK cannot name (#1919). Mirrors sdk/go/ironflow/run_status_drift_test.go.
 *
 * If this fails: add the status to RUN_STATUS_TO_WIRE and RunStatusWireSchema
 * in schemas.ts, and to RunStatusSchema if it is a new public value.
 */

// Statuses with no SDK mapping, and why. Everything else must map.
const EXEMPT: Record<string, string> = {
  // Zero value, meaning "unset". EmitUnpopulated:false means it reaches the
  // client as an ABSENT key, never as this string.
  RUN_STATUS_UNSPECIFIED: "zero value, never emitted for a real run",
};

// The generated descriptor carries the full proto names; the generated TS enum
// members have the RUN_STATUS_ prefix stripped, so read the descriptor.
const protoStatusNames = RunStatusEnumDesc.values.map((value) => value.name);

describe("run status drift against the generated protobuf enum", () => {
  it("finds the generated enum values", () => {
    expect(protoStatusNames.length).toBeGreaterThan(1);
    for (const name of protoStatusNames) {
      expect(name).toMatch(/^RUN_STATUS_/);
    }
  });

  for (const name of protoStatusNames) {
    const reason = EXEMPT[name];

    if (reason) {
      it(`skips ${name} (${reason})`, () => {
        expect(() => runStatusFromWire(name)).toThrow();
      });
      continue;
    }

    it(`maps ${name} in both directions`, () => {
      const status = runStatusFromWire(name);
      // Round-trip: the two lists cannot drift apart without failing here.
      expect(runStatusToWire(status)).toBe(name);
    });
  }

  // The proto RESERVES RUN_STATUS_PENDING. If that ever changes, the SDK's
  // deprecation of the public "pending" constant needs revisiting.
  it("keeps RUN_STATUS_PENDING out of the enum", () => {
    expect(protoStatusNames).not.toContain("RUN_STATUS_PENDING");
    expect(() => runStatusToWire("pending")).toThrow();
  });
});
