import { expect, it } from "vitest";
import { functionListFromWire } from "./function-list-wire.js";

it("preserves an engine timestamp and omits unavailable metadata", () => {
  expect(functionListFromWire({ id: "daily", nextRun: "2026-10-07T09:00:00Z" }))
    .toMatchObject({ next_run: "2026-10-07T09:00:00Z" });
  expect(functionListFromWire({ id: "daily" })).not.toHaveProperty("next_run");
});

it("keeps the retry cap and recording profile the dashboard overview reads", () => {
  const fn = functionListFromWire({
    id: "orders",
    retry: { maxAttempts: 12, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 300000 },
    recordingProfile: "steps",
  });
  expect(fn).toMatchObject({ retry_max_delay_ms: 300000, recording: true, recording_profile: "steps" });
  expect(functionListFromWire({ id: "bare" })).toMatchObject({ retry_max_delay_ms: 0, recording: false });
});

it("keeps the resilience settings the REST function list carries", () => {
  const fn = functionListFromWire({
    id: "orders",
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
  const bare = functionListFromWire({ id: "bare" });
  expect(bare).not.toHaveProperty("retry_on_exhausted");
  expect(bare).not.toHaveProperty("circuit_breaker");
  expect(bare).not.toHaveProperty("throttle");
});
