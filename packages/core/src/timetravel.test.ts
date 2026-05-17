import { describe, it, expect } from "vitest";
import {
  TimeTravelRunStateSnapshotSchema,
  TimeTravelTimelineEventSchema,
  TimeTravelStepSnapshotSchema,
} from "./schemas.js";

describe("time-travel schemas", () => {
  it("validates run state snapshot", () => {
    const snapshot = {
      runId: "run-1",
      functionId: "fn-1",
      status: "completed",
      steps: [
        {
          stepId: "step-a",
          name: "step-a",
          type: "invoke",
          sequence: 1,
          status: "completed",
          injected: false,
          patched: false,
        },
      ],
      timestamp: "2026-01-15T10:30:00Z",
    };
    expect(TimeTravelRunStateSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("validates timeline event", () => {
    const event = {
      id: "e1",
      eventType: "step.completed",
      summary: "Step completed",
      significant: true,
      timestamp: "2026-01-15T10:30:00Z",
    };
    expect(TimeTravelTimelineEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects invalid snapshot", () => {
    expect(TimeTravelRunStateSnapshotSchema.safeParse({}).success).toBe(false);
  });

  it("validates step snapshot with optional fields", () => {
    const step = {
      stepId: "step-1",
      name: "fetch-data",
      type: "run",
      sequence: 2,
      status: "completed",
      output: '{"result":"ok"}',
      originalOutput: null,
      startedAt: "2026-01-15T10:30:00Z",
      completedAt: "2026-01-15T10:30:01Z",
      durationMs: 1000,
      injected: true,
      patched: true,
    };
    expect(TimeTravelStepSnapshotSchema.safeParse(step).success).toBe(true);
  });

  it("validates timeline event with default stepId and stepName", () => {
    const event = {
      id: "e2",
      eventType: "run.started",
      summary: "Run started",
      significant: true,
      timestamp: "2026-01-15T10:30:00Z",
    };
    const result = TimeTravelTimelineEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stepId).toBe("");
      expect(result.data.stepName).toBe("");
    }
  });

  it("rejects step snapshot missing required fields", () => {
    const step = {
      stepId: "step-1",
      name: "fetch-data",
      // missing type, sequence, status, injected, patched
    };
    expect(TimeTravelStepSnapshotSchema.safeParse(step).success).toBe(false);
  });
});
