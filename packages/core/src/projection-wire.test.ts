import { describe, expect, it } from "vitest";
import { projectionStatusFromWire } from "./projection-wire.js";

describe("projectionStatusFromWire", () => {
  it("decodes updatedAt", () => {
    expect(projectionStatusFromWire({ name: "p", updatedAt: "2026-09-06T12:00:00Z" }).updatedAt).toEqual(
      new Date("2026-09-06T12:00:00Z"),
    );
  });

  it("throws when updatedAt is absent, rather than reporting the current time", () => {
    expect(() => projectionStatusFromWire({ name: "p" })).toThrow(/projectionStatus\.updatedAt/);
    expect(() => projectionStatusFromWire({ name: "p", updatedAt: "soon" })).toThrow(/projectionStatus\.updatedAt/);
  });
});
