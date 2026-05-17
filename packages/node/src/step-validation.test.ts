import { describe, it, expect } from "vitest";
import { ExecutionContext } from "./internal/context.js";
import { createStepClient } from "./step.js";
import type { PushRequest } from "@ironflow/core";

// Regression tests for bug #9 in issue #464: SDK yield signals were produced
// without validating inputs, letting negative sleep durations and empty event
// names silently become "sleep 0s" or "wait forever" at the server.

function ctx(): ExecutionContext {
  const request: PushRequest = {
    run_id: "run-validation",
    function_id: "fn-validation",
    attempt: 1,
    event: {
      id: "evt-1",
      name: "test.event",
      data: {},
      timestamp: "2024-01-01T00:00:00Z",
    },
    steps: [],
  };
  return new ExecutionContext(request);
}

describe("step input validation", () => {
  describe("step.sleep", () => {
    it("rejects negative duration", async () => {
      const step = createStepClient(ctx());
      await expect(step.sleep("nap", -1000)).rejects.toThrow(
        /duration must be a positive finite value/,
      );
    });

    it("rejects zero duration", async () => {
      const step = createStepClient(ctx());
      await expect(step.sleep("nap", 0)).rejects.toThrow(
        /duration must be a positive finite value/,
      );
    });

    it("accepts positive duration and yields", async () => {
      const step = createStepClient(ctx());
      // Positive durations yield (throw YieldSignal) rather than complete
      // normally — both are "not a validation error".
      await expect(step.sleep("nap", 1000)).rejects.toSatisfy(
        (err: unknown) => (err as Error).name === "YieldSignal",
      );
    });
  });

  describe("step.sleepUntil", () => {
    it("rejects dates in the past", async () => {
      const step = createStepClient(ctx());
      const past = new Date(Date.now() - 10_000);
      await expect(step.sleepUntil("nap", past)).rejects.toThrow(
        /target time must be in the future/,
      );
    });

    it("rejects invalid date strings", async () => {
      const step = createStepClient(ctx());
      await expect(step.sleepUntil("nap", "not-a-date")).rejects.toThrow(
        /Invalid date/,
      );
    });

    it("accepts future dates and yields", async () => {
      const step = createStepClient(ctx());
      const future = new Date(Date.now() + 60_000);
      await expect(step.sleepUntil("nap", future)).rejects.toSatisfy(
        (err: unknown) => (err as Error).name === "YieldSignal",
      );
    });
  });

  describe("step.waitForEvent", () => {
    it("rejects empty event name", async () => {
      const step = createStepClient(ctx());
      await expect(
        step.waitForEvent("wait", { event: "" }),
      ).rejects.toThrow(/filter.event must be a non-empty string/);
    });

    it("rejects whitespace-only event name", async () => {
      const step = createStepClient(ctx());
      await expect(
        step.waitForEvent("wait", { event: "   " }),
      ).rejects.toThrow(/filter.event must be a non-empty string/);
    });

    it("accepts non-empty event name and yields", async () => {
      const step = createStepClient(ctx());
      await expect(
        step.waitForEvent("wait", { event: "order.approved" }),
      ).rejects.toSatisfy((err: unknown) => (err as Error).name === "YieldSignal");
    });

    it("trims surrounding whitespace from the event name before yielding", async () => {
      const step = createStepClient(ctx());
      let yielded: { event_filter?: { event?: string } } | undefined;
      try {
        await step.waitForEvent("wait", { event: "  order.approved  " });
      } catch (err) {
        const y = err as { name: string; yieldInfo?: typeof yielded };
        if (y.name === "YieldSignal") yielded = y.yieldInfo;
      }
      expect(yielded?.event_filter?.event).toBe("order.approved");
    });

    it("rejects zero, negative, NaN, and Infinity numeric timeouts", async () => {
      const step = createStepClient(ctx());
      for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        await expect(
          step.waitForEvent("wait", { event: "e", timeout: bad }),
        ).rejects.toThrow(/filter\.timeout must be a positive finite value/);
      }
    });

    it("rejects empty-string timeout", async () => {
      const step = createStepClient(ctx());
      await expect(
        step.waitForEvent("wait", { event: "e", timeout: "   " }),
      ).rejects.toThrow(/filter\.timeout must be a non-empty string/);
    });
  });
});
