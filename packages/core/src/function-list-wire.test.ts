import { expect, it } from "vitest";
import { functionListFromWire } from "./function-list-wire.js";

const stamps = { createdAt: "2026-09-06T12:00:00Z", updatedAt: "2026-09-06T12:00:00Z" };

it("decodes engine timestamps and omits unavailable metadata", () => {
  expect(functionListFromWire({ id: "daily", ...stamps, nextRun: "2026-10-07T09:00:00Z" })).toMatchObject({
    created_at: new Date("2026-09-06T12:00:00Z"),
    updated_at: new Date("2026-09-06T12:00:00Z"),
    next_run: new Date("2026-10-07T09:00:00Z"),
  });
  expect(functionListFromWire({ id: "daily", ...stamps })).not.toHaveProperty("next_run");
});

it("throws on an unreadable timestamp", () => {
  expect(() => functionListFromWire({ id: "daily" })).toThrow(/function\.createdAt/);
  expect(() => functionListFromWire({ id: "daily", ...stamps, nextRun: "soon" })).toThrow(/function\.nextRun/);
});

it("keeps the retry cap and recording profile the dashboard overview reads", () => {
  const fn = functionListFromWire({
    id: "orders",
    ...stamps,
    retry: { maxAttempts: 12, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 300000 },
    recordingProfile: "steps",
  });
  expect(fn).toMatchObject({ retry_max_delay_ms: 300000, recording: true, recording_profile: "steps" });
  expect(functionListFromWire({ id: "bare", ...stamps })).toMatchObject({ retry_max_delay_ms: 0, recording: false });
});

it("keeps the resilience settings the REST function list carries", () => {
  const fn = functionListFromWire({
    id: "orders",
    ...stamps,
    retry: { onExhausted: "fail" },
    circuitBreaker: { failureThreshold: 3, openDurationMs: 30000 },
    throttle: { limit: 10, periodMs: 60000, key: "customer.id" },
  });
  expect(fn).toMatchObject({
    retry_on_exhausted: "fail",
    circuit_breaker: { failure_threshold: 3, open_duration_ms: 30000 },
    throttle: { limit: 10, period_ms: 60000, key: "customer.id" },
  });
  expect(fn.circuit_breaker).not.toHaveProperty("max_open_duration_ms");
  const bare = functionListFromWire({ id: "bare", ...stamps });
  expect(bare).not.toHaveProperty("retry_on_exhausted");
  expect(bare).not.toHaveProperty("circuit_breaker");
  expect(bare).not.toHaveProperty("throttle");
});
