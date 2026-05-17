import { describe, expect, it } from "vitest";
import { assertDefined } from "./assert-defined.js";

describe("assertDefined", () => {
  it("returns the value when defined", () => {
    expect(assertDefined("a")).toBe("a");
    expect(assertDefined(0)).toBe(0);
    expect(assertDefined(false)).toBe(false);
  });

  it("throws with default label when undefined", () => {
    expect(() => assertDefined(undefined)).toThrow(
      "assertDefined: expected value to be defined"
    );
  });

  it("throws when null", () => {
    expect(() => assertDefined<string>(null)).toThrow(
      "assertDefined: expected value to be defined"
    );
  });

  it("includes custom label in the error message", () => {
    expect(() => assertDefined(undefined, "run.steps[2]")).toThrow(
      "assertDefined: expected run.steps[2] to be defined"
    );
  });

  it("narrows the type so callers do not need non-null assertions", () => {
    const arr: ReadonlyArray<{ name: string }> = [{ name: "a" }];
    const first = assertDefined(arr[0]);
    expect(first.name).toBe("a");
  });
});
