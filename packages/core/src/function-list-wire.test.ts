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
