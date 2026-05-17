import { describe, it, expect } from "vitest";
import { IronflowClient, ProjectionRunner } from "./index.js";

describe("@ironflow/node public exports", () => {
  it("exports IronflowClient as a value (not type-only)", () => {
    expect(IronflowClient).toBeDefined();
    expect(typeof IronflowClient).toBe("function");
  });

  it("exports ProjectionRunner as a value (not type-only)", () => {
    expect(ProjectionRunner).toBeDefined();
    expect(typeof ProjectionRunner).toBe("function");
  });
});
