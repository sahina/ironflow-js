import { describe, it, expect } from "vitest";
import { createFunction } from "./function.js";

// Validation tests for declarative cancelOn (issue #546 P3 / #572).
describe("createFunction cancelOn validation", () => {
  it("accepts valid specs", () => {
    expect(() =>
      createFunction(
        {
          id: "fn-ok",
          triggers: [{ event: "order.placed" }],
          cancelOn: [
            { event: "order.cancelled", match: "data.orderId" },
            { event: "order.refunded", match: "data.orderId" },
          ],
        },
        async () => "ok"
      )
    ).not.toThrow();
  });

  it("rejects empty event", () => {
    expect(() =>
      createFunction(
        {
          id: "fn-empty-event",
          triggers: [{ event: "x" }],
          cancelOn: [{ event: "", match: "data.id" }],
        },
        async () => "ok"
      )
    ).toThrow(/cancelOn\[0\]\.event must be non-empty/);
  });

  it("rejects empty match", () => {
    expect(() =>
      createFunction(
        {
          id: "fn-empty-match",
          triggers: [{ event: "x" }],
          cancelOn: [{ event: "x", match: "" }],
        },
        async () => "ok"
      )
    ).toThrow(/cancelOn\[0\]\.match must be non-empty/);
  });

  it("rejects duplicate spec", () => {
    expect(() =>
      createFunction(
        {
          id: "fn-dup",
          triggers: [{ event: "x" }],
          cancelOn: [
            { event: "x", match: "data.id" },
            { event: "x", match: "data.id" },
          ],
        },
        async () => "ok"
      )
    ).toThrow(/duplicate spec/);
  });
});
