import { describe, it, expect } from "vitest";
import {
  AgentInvokeTimeoutError,
  NoRunCreatedError,
  IronflowError,
} from "@ironflow/core";

describe("agents error classes", () => {
  it("AgentInvokeTimeoutError carries runId + timeoutMs and is retryable", () => {
    const err = new AgentInvokeTimeoutError("run-123", 5000);
    expect(err).toBeInstanceOf(IronflowError);
    expect(err.name).toBe("AgentInvokeTimeoutError");
    expect(err.runId).toBe("run-123");
    expect(err.timeoutMs).toBe(5000);
    expect(err.code).toBe("AGENT_INVOKE_TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("run-123");
  });

  it("NoRunCreatedError carries function name and is non-retryable", () => {
    const err = new NoRunCreatedError("my-agent");
    expect(err).toBeInstanceOf(IronflowError);
    expect(err.name).toBe("NoRunCreatedError");
    expect(err.functionName).toBe("my-agent");
    expect(err.code).toBe("NO_RUN_CREATED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("my-agent");
  });

  it("error classes survive instanceof across throw", () => {
    try {
      throw new AgentInvokeTimeoutError("r1", 100);
    } catch (e) {
      expect(e).toBeInstanceOf(AgentInvokeTimeoutError);
      expect(e).toBeInstanceOf(IronflowError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
