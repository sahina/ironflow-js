import { describe, it, expect } from "vitest";
import { SubscriptionManager } from "./index.js";

describe("@ironflow/browser public exports", () => {
  it("exports SubscriptionManager as a value (not type-only)", () => {
    expect(SubscriptionManager).toBeDefined();
    expect(typeof SubscriptionManager).toBe("function");
  });
});
