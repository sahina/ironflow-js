import { describe, it, expect } from "vitest";
import { patterns } from "./protocol.js";

describe("patterns", () => {
  describe("allRuns", () => {
    it("should return pattern for all run events", () => {
      expect(patterns.allRuns()).toBe("system.run.>");
    });
  });

  describe("run", () => {
    it("should return pattern for a specific run", () => {
      expect(patterns.run("run-123")).toBe("system.run.run-123.>");
    });

    it("should handle run IDs with special characters", () => {
      expect(patterns.run("run-abc-def-123")).toBe("system.run.run-abc-def-123.>");
    });
  });

  describe("runLifecycle", () => {
    it("should return pattern for run lifecycle events only", () => {
      expect(patterns.runLifecycle("run-123")).toBe("system.run.run-123.*");
    });

    it("should use single-token wildcard for lifecycle events", () => {
      const pattern = patterns.runLifecycle("my-run");
      expect(pattern).toContain("*");
      expect(pattern).not.toContain(">");
    });
  });

  describe("runSteps", () => {
    it("should return pattern for run step events", () => {
      expect(patterns.runSteps("run-123")).toBe("system.run.run-123.step.>");
    });
  });

  describe("allFunctions", () => {
    it("should return pattern for all function events", () => {
      expect(patterns.allFunctions()).toBe("system.function.>");
    });
  });

  describe("function", () => {
    it("should return pattern for a specific function", () => {
      expect(patterns.function("process-order")).toBe(
        "system.function.process-order.>"
      );
    });

    it("should handle function IDs with dashes and numbers", () => {
      expect(patterns.function("my-function-v2")).toBe(
        "system.function.my-function-v2.>"
      );
    });
  });

  describe("userEvent", () => {
    it("should return pattern for user events", () => {
      expect(patterns.userEvent("order.created")).toBe("events:order.created");
    });

    it("should handle wildcard in event name", () => {
      expect(patterns.userEvent("order.*")).toBe("events:order.*");
    });

    it("should handle nested event names", () => {
      expect(patterns.userEvent("payment.stripe.succeeded")).toBe(
        "events:payment.stripe.succeeded"
      );
    });
  });

  describe("allUserEvents", () => {
    it("should return pattern for all user events", () => {
      expect(patterns.allUserEvents()).toBe("events:>");
    });
  });

  describe("Pattern format consistency", () => {
    it("system patterns should start with system.", () => {
      expect(patterns.allRuns()).toMatch(/^system\./);
      expect(patterns.run("run-1")).toMatch(/^system\./);
      expect(patterns.runLifecycle("run-1")).toMatch(/^system\./);
      expect(patterns.runSteps("run-1")).toMatch(/^system\./);
      expect(patterns.allFunctions()).toMatch(/^system\./);
      expect(patterns.function("fn-1")).toMatch(/^system\./);
    });

    it("user event patterns should start with events:", () => {
      expect(patterns.userEvent("test")).toMatch(/^events:/);
      expect(patterns.allUserEvents()).toMatch(/^events:/);
    });

    it("multi-segment wildcards should use >", () => {
      expect(patterns.allRuns()).toContain(">");
      expect(patterns.run("run-1")).toContain(">");
      expect(patterns.runSteps("run-1")).toContain(">");
      expect(patterns.allFunctions()).toContain(">");
      expect(patterns.function("fn-1")).toContain(">");
      expect(patterns.allUserEvents()).toContain(">");
    });

    it("single-segment wildcards should use *", () => {
      expect(patterns.runLifecycle("run-1")).toContain("*");
      expect(patterns.runLifecycle("run-1")).not.toContain(">");
    });
  });

  describe("Use cases", () => {
    it("should generate correct pattern for monitoring a specific run", () => {
      const runId = "run-abc123";
      const pattern = patterns.run(runId);
      // This pattern should match: system.run.run-abc123.started, system.run.run-abc123.completed, etc.
      expect(pattern).toBe("system.run.run-abc123.>");
    });

    it("should generate correct pattern for watching all order events", () => {
      const pattern = patterns.userEvent("order.*");
      // This pattern should match: events:order.created, events:order.updated, events:order.deleted
      expect(pattern).toBe("events:order.*");
    });

    it("should generate correct pattern for subscribing to specific function activity", () => {
      const pattern = patterns.function("send-email");
      // This pattern should match all events related to the send-email function
      expect(pattern).toBe("system.function.send-email.>");
    });
  });
});
