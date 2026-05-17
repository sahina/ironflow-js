import { describe, it, expect } from "vitest";
import {
  YieldSignal,
  isYieldSignal,
  type SleepYieldInfo,
  type WaitEventYieldInfo,
  type YieldInfo,
} from "./errors.js";

describe("YieldSignal", () => {
  describe("creation", () => {
    it("should create a sleep yield signal", () => {
      const yieldInfo: SleepYieldInfo = {
        step_id: "step-123",
        type: "sleep",
        until: "2024-01-01T12:00:00Z",
      };

      const signal = new YieldSignal(yieldInfo);

      expect(signal.name).toBe("YieldSignal");
      expect(signal.message).toBe("Yield signal");
      expect(signal.yieldInfo).toEqual(yieldInfo);
    });

    it("should create a wait_for_event yield signal", () => {
      const yieldInfo: WaitEventYieldInfo = {
        step_id: "step-456",
        type: "wait_for_event",
        event_filter: {
          event: "order.approved",
          match: "data.orderId == '123'",
          timeout: "7d",
        },
      };

      const signal = new YieldSignal(yieldInfo);

      expect(signal.name).toBe("YieldSignal");
      expect(signal.yieldInfo).toEqual(yieldInfo);
      expect(signal.yieldInfo.type).toBe("wait_for_event");
    });

    it("should extend Error", () => {
      const signal = new YieldSignal({
        step_id: "s1",
        type: "sleep",
        until: "2024-01-01T00:00:00Z",
      });

      expect(signal).toBeInstanceOf(Error);
    });
  });

  describe("sleep yield info", () => {
    it("should contain step_id", () => {
      const info: SleepYieldInfo = {
        step_id: "my-step-id",
        type: "sleep",
        until: "2024-06-15T10:30:00Z",
      };

      const signal = new YieldSignal(info);

      expect(signal.yieldInfo.step_id).toBe("my-step-id");
    });

    it("should contain ISO timestamp for until", () => {
      const info: SleepYieldInfo = {
        step_id: "step-1",
        type: "sleep",
        until: "2024-12-25T00:00:00.000Z",
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "sleep") {
        expect(signal.yieldInfo.until).toBe("2024-12-25T00:00:00.000Z");
      }
    });
  });

  describe("wait_for_event yield info", () => {
    it("should contain event filter with event name", () => {
      const info: WaitEventYieldInfo = {
        step_id: "wait-step-1",
        type: "wait_for_event",
        event_filter: {
          event: "payment.completed",
        },
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "wait_for_event") {
        expect(signal.yieldInfo.event_filter.event).toBe("payment.completed");
      }
    });

    it("should contain optional match expression", () => {
      const info: WaitEventYieldInfo = {
        step_id: "wait-step-2",
        type: "wait_for_event",
        event_filter: {
          event: "order.*",
          match: "data.amount > 100",
        },
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "wait_for_event") {
        expect(signal.yieldInfo.event_filter.match).toBe("data.amount > 100");
      }
    });

    it("should contain optional timeout", () => {
      const info: WaitEventYieldInfo = {
        step_id: "wait-step-3",
        type: "wait_for_event",
        event_filter: {
          event: "approval.received",
          timeout: "24h",
        },
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "wait_for_event") {
        expect(signal.yieldInfo.event_filter.timeout).toBe("24h");
      }
    });
  });

  describe("type narrowing", () => {
    it("should narrow to sleep type", () => {
      const info: YieldInfo = {
        step_id: "s1",
        type: "sleep",
        until: "2024-01-01T00:00:00Z",
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "sleep") {
        // TypeScript should narrow to SleepYieldInfo
        expect(signal.yieldInfo.until).toBeDefined();
      }
    });

    it("should narrow to wait_for_event type", () => {
      const info: YieldInfo = {
        step_id: "s1",
        type: "wait_for_event",
        event_filter: { event: "test" },
      };

      const signal = new YieldSignal(info);

      if (signal.yieldInfo.type === "wait_for_event") {
        // TypeScript should narrow to WaitEventYieldInfo
        expect(signal.yieldInfo.event_filter).toBeDefined();
      }
    });
  });
});

describe("isYieldSignal", () => {
  describe("positive cases", () => {
    it("should return true for sleep YieldSignal", () => {
      const signal = new YieldSignal({
        step_id: "s1",
        type: "sleep",
        until: "2024-01-01T00:00:00Z",
      });

      expect(isYieldSignal(signal)).toBe(true);
    });

    it("should return true for wait_for_event YieldSignal", () => {
      const signal = new YieldSignal({
        step_id: "s1",
        type: "wait_for_event",
        event_filter: { event: "test.event" },
      });

      expect(isYieldSignal(signal)).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("should return false for regular Error", () => {
      expect(isYieldSignal(new Error("test"))).toBe(false);
    });

    it("should return false for TypeError", () => {
      expect(isYieldSignal(new TypeError("test"))).toBe(false);
    });

    it("should return false for custom Error subclass", () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }
      expect(isYieldSignal(new CustomError("test"))).toBe(false);
    });

    it("should return false for null", () => {
      expect(isYieldSignal(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isYieldSignal(undefined)).toBe(false);
    });

    it("should return false for string", () => {
      expect(isYieldSignal("error")).toBe(false);
    });

    it("should return false for number", () => {
      expect(isYieldSignal(123)).toBe(false);
    });

    it("should return false for plain object", () => {
      expect(isYieldSignal({})).toBe(false);
    });

    it("should return false for object that looks like YieldSignal", () => {
      const fake = {
        name: "YieldSignal",
        message: "Yield signal",
        yieldInfo: { step_id: "s1", type: "sleep", until: "2024-01-01T00:00:00Z" },
      };
      expect(isYieldSignal(fake)).toBe(false);
    });

    it("should return false for array", () => {
      expect(isYieldSignal([])).toBe(false);
    });

    it("should return false for function", () => {
      expect(isYieldSignal(() => {})).toBe(false);
    });
  });

  describe("type guard behavior", () => {
    it("should narrow type to YieldSignal", () => {
      const maybeSignal: unknown = new YieldSignal({
        step_id: "s1",
        type: "sleep",
        until: "2024-01-01T00:00:00Z",
      });

      if (isYieldSignal(maybeSignal)) {
        // TypeScript should know this is a YieldSignal
        expect(maybeSignal.yieldInfo.step_id).toBe("s1");
        expect(maybeSignal.yieldInfo.type).toBe("sleep");
      } else {
        throw new Error("Should have been a YieldSignal");
      }
    });
  });
});
