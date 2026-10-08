import { expect, it } from "vitest";
import { functionListFromWire } from "./function-list-wire.js";

it("preserves an engine timestamp and omits unavailable metadata", () => {
  expect(functionListFromWire({ id: "daily", nextRun: "2026-10-07T09:00:00Z" }))
    .toMatchObject({ next_run: "2026-10-07T09:00:00Z" });
  expect(functionListFromWire({ id: "daily" })).not.toHaveProperty("next_run");
});
