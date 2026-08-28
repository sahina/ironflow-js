import { describe, expect, it } from "vitest";
import {
  functionHistoryEntryFromWire,
  registeredFunctionFromWire,
} from "./types.js";

describe("registeredFunctionFromWire", () => {
  it("normalizes proto enums and numeric fields", () => {
    const fn = registeredFunctionFromWire({
      id: "process-order",
      status: "FUNCTION_STATUS_PAUSED",
      preferredMode: "EXECUTION_MODE_PULL",
      version: 7,
      timeoutMs: 30_000,
      retry: {
        maxAttempts: 4,
        initialDelayMs: 250,
        backoffFactor: 2,
        maxDelayMs: 5_000,
      },
      concurrency: { limit: 3, key: "customerId" },
    });

    expect(fn).toMatchObject({
      id: "process-order",
      status: "paused",
      preferredMode: "pull",
      version: 7,
      timeoutMs: 30_000,
      retry: { maxAttempts: 4, initialDelayMs: 250 },
      concurrency: { limit: 3, key: "customerId" },
    });
  });
});

describe("functionHistoryEntryFromWire", () => {
  it("converts protobuf int64 strings and nested snapshots", () => {
    const entry = functionHistoryEntryFromWire({
      eventId: "evt_1",
      entityVersion: "9007199254740991",
      functionId: "process-order",
      changeType: "rollback",
      functionSnapshot: {
        id: "process-order",
        status: "FUNCTION_STATUS_ACTIVE",
      },
    });

    expect(entry.entityVersion).toBe(9_007_199_254_740_991);
    expect(entry.changeType).toBe("rollback");
    expect(entry.functionSnapshot?.status).toBe("active");
  });
});
