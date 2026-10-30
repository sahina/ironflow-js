import { describe, expect, it } from "vitest";
import {
  runInspectionFromWire,
  stepInspectionFromWire,
} from "./run-introspection-wire.js";

describe("attempt history on the wire (ADR 0139)", () => {
  it("decodes a step's attempts, keeping the error opaque", () => {
    const step = stepInspectionFromWire({
      id: "s1",
      attempt: 2,
      attempts: [
        {
          attempt: 1,
          startedAt: "2026-10-28T10:00:00Z",
          endedAt: "2026-10-28T10:00:01Z",
          workerId: "w-1",
          nodeId: "node-a",
          error: { message: "declined", details: { code: 42 } },
        },
        { attempt: 2, startedAt: "2026-10-28T10:00:05Z" },
      ],
    });
    expect(step.attempts).toEqual([
      {
        attempt: 1,
        started_at: "2026-10-28T10:00:00Z",
        ended_at: "2026-10-28T10:00:01Z",
        worker_id: "w-1",
        node_id: "node-a",
        error: { message: "declined", details: { code: 42 } },
        run_attempt: undefined,
      },
      {
        attempt: 2,
        started_at: "2026-10-28T10:00:05Z",
        ended_at: undefined,
        worker_id: undefined,
        node_id: undefined,
        error: undefined,
        run_attempt: undefined,
      },
    ]);
  });

  it("decodes run-level retries and defaults to an empty list", () => {
    const run = runInspectionFromWire({
      id: "r1",
      attempts: [{ attempt: 1, runAttempt: 1, error: { message: "boom" } }],
    });
    expect(run.attempts[0]?.run_attempt).toBe(1);
    expect(runInspectionFromWire({ id: "r2" }).attempts).toEqual([]);
    expect(stepInspectionFromWire({ id: "s2" }).attempts).toEqual([]);
  });
});
