import { describe, it, expect } from "vitest";
import {
  IronflowError,
  ConnectionError,
  SubscriptionError,
  TimeoutError,
  ValidationError,
  SchemaValidationError,
  SignatureError,
  FunctionNotFoundError,
  RunNotFoundError,
  StepError,
  NonRetryableError,
  NotConfiguredError,
  InvokeError,
  InvokeTimeoutError,
  StepTimeoutError,
  isRetryable,
  isIronflowError,
  toError,
} from "./errors.js";

describe("IronflowError", () => {
  it("should create an error with default values", () => {
    const error = new IronflowError("test message");
    expect(error.message).toBe("test message");
    expect(error.name).toBe("IronflowError");
    expect(error.code).toBe("UNKNOWN_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.details).toBeUndefined();
  });

  it("should create an error with custom values", () => {
    const error = new IronflowError("test message", {
      code: "CUSTOM_CODE",
      retryable: true,
      details: { key: "value" },
    });
    expect(error.code).toBe("CUSTOM_CODE");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ key: "value" });
  });

  it("should support error cause", () => {
    const cause = new Error("cause");
    const error = new IronflowError("test", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("ConnectionError", () => {
  it("should be retryable by default", () => {
    const error = new ConnectionError("connection lost");
    expect(error.name).toBe("ConnectionError");
    expect(error.code).toBe("CONNECTION_LOST");
    expect(error.retryable).toBe(true);
  });

  it("should accept cause option", () => {
    const cause = new Error("network error");
    const error = new ConnectionError("connection lost", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("SubscriptionError", () => {
  it("should create with subscription ID", () => {
    const error = new SubscriptionError("subscription failed", {
      subscriptionId: "sub-123",
    });
    expect(error.name).toBe("SubscriptionError");
    expect(error.subscriptionId).toBe("sub-123");
    expect(error.code).toBe("SUBSCRIPTION_ERROR");
    expect(error.retryable).toBe(true);
  });

  it("should allow custom code and retryable", () => {
    const error = new SubscriptionError("test", {
      code: "CUSTOM_SUB_ERROR",
      retryable: false,
    });
    expect(error.code).toBe("CUSTOM_SUB_ERROR");
    expect(error.retryable).toBe(false);
  });
});

describe("TimeoutError", () => {
  it("should store timeout duration", () => {
    const error = new TimeoutError("request timed out", 5000);
    expect(error.name).toBe("TimeoutError");
    expect(error.code).toBe("TIMEOUT");
    expect(error.timeoutMs).toBe(5000);
    expect(error.retryable).toBe(true);
  });
});

describe("ValidationError", () => {
  it("should not be retryable", () => {
    const error = new ValidationError("invalid input");
    expect(error.name).toBe("ValidationError");
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.retryable).toBe(false);
  });

  it("should store validation errors array", () => {
    const error = new ValidationError("validation failed", {
      validationErrors: ["field1: required", "field2: invalid"],
    });
    expect(error.validationErrors).toEqual(["field1: required", "field2: invalid"]);
  });
});

describe("SchemaValidationError", () => {
  it("should extend ValidationError", () => {
    const error = new SchemaValidationError("schema invalid");
    expect(error.name).toBe("SchemaValidationError");
    expect(error instanceof ValidationError).toBe(true);
    expect(error.retryable).toBe(false);
  });
});

describe("SignatureError", () => {
  it("should not be retryable", () => {
    const error = new SignatureError("invalid signature");
    expect(error.name).toBe("SignatureError");
    expect(error.code).toBe("SIGNATURE_INVALID");
    expect(error.retryable).toBe(false);
  });
});

describe("FunctionNotFoundError", () => {
  it("should include function ID", () => {
    const error = new FunctionNotFoundError("my-function");
    expect(error.name).toBe("FunctionNotFoundError");
    expect(error.code).toBe("FUNCTION_NOT_FOUND");
    expect(error.functionId).toBe("my-function");
    expect(error.message).toBe("Function not found: my-function");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ functionId: "my-function" });
  });
});

describe("RunNotFoundError", () => {
  it("should include run ID", () => {
    const error = new RunNotFoundError("run-123");
    expect(error.name).toBe("RunNotFoundError");
    expect(error.code).toBe("RUN_NOT_FOUND");
    expect(error.runId).toBe("run-123");
    expect(error.message).toBe("Run not found: run-123");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ runId: "run-123" });
  });
});

describe("StepError", () => {
  it("should include step info with default retryable true", () => {
    const error = new StepError("step failed", {
      stepId: "step-1",
      stepName: "myStep",
    });
    expect(error.name).toBe("StepError");
    expect(error.code).toBe("STEP_FAILED");
    expect(error.stepId).toBe("step-1");
    expect(error.stepName).toBe("myStep");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ stepId: "step-1", stepName: "myStep" });
  });

  it("should allow non-retryable step error", () => {
    const error = new StepError("permanent failure", {
      stepId: "step-2",
      stepName: "otherStep",
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });

  it("should accept cause option", () => {
    const cause = new Error("original");
    const error = new StepError("step failed", {
      stepId: "s",
      stepName: "n",
      cause,
    });
    expect(error.cause).toBe(cause);
  });
});

describe("NonRetryableError", () => {
  it("should not be retryable", () => {
    const error = new NonRetryableError("permanent failure");
    expect(error.name).toBe("NonRetryableError");
    expect(error.code).toBe("NON_RETRYABLE");
    expect(error.retryable).toBe(false);
  });

  it("should allow custom code", () => {
    const error = new NonRetryableError("test", { code: "CUSTOM" });
    expect(error.code).toBe("CUSTOM");
  });
});

describe("NotConfiguredError", () => {
  it("should use default message", () => {
    const error = new NotConfiguredError();
    expect(error.name).toBe("NotConfiguredError");
    expect(error.message).toBe("Client not configured. Call configure() first.");
    expect(error.code).toBe("NOT_CONFIGURED");
    expect(error.retryable).toBe(false);
  });

  it("should allow custom message", () => {
    const error = new NotConfiguredError("custom message");
    expect(error.message).toBe("custom message");
  });
});

describe("InvokeError", () => {
  it("has correct name and code", () => {
    const err = new InvokeError("charge-card", "run-123", "stripe declined");
    expect(err.name).toBe("InvokeError");
    expect(err.code).toBe("INVOKE_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.functionId).toBe("charge-card");
    expect(err.childRunId).toBe("run-123");
    expect(err.errorCause).toBe("stripe declined");
    expect(err.details).toEqual({ functionId: "charge-card", childRunId: "run-123" });
  });

  it("message without childRunId", () => {
    const err = new InvokeError("charge-card", "", "function not found");
    expect(err.message).toBe("invoke 'charge-card' failed: function not found");
  });

  it("message with childRunId", () => {
    const err = new InvokeError("charge-card", "run-123", "stripe declined");
    expect(err.message).toBe("invoke 'charge-card' failed (run run-123): stripe declined");
  });

  it("instanceof InvokeError and IronflowError", () => {
    const err = new InvokeError("charge-card", "run-123", "error");
    expect(err).toBeInstanceOf(InvokeError);
    expect(err).toBeInstanceOf(IronflowError);
  });
});

describe("InvokeTimeoutError", () => {
  it("has correct name and stores timeoutMs", () => {
    const err = new InvokeTimeoutError("charge-card", "run-123", 30000);
    expect(err.name).toBe("InvokeTimeoutError");
    expect(err.timeoutMs).toBe(30000);
    expect(err.errorCause).toContain("30000ms");
  });

  it("instanceof InvokeTimeoutError, InvokeError, IronflowError", () => {
    const err = new InvokeTimeoutError("charge-card", "run-123", 30000);
    expect(err).toBeInstanceOf(InvokeTimeoutError);
    expect(err).toBeInstanceOf(InvokeError);
    expect(err).toBeInstanceOf(IronflowError);
  });
});

describe("StepTimeoutError", () => {
  it("should create error with step name and timeout", () => {
    const error = new StepTimeoutError("call-api", "30s");
    expect(error.message).toBe('Step "call-api" timed out after 30s');
    expect(error.name).toBe("StepTimeoutError");
    expect(error.code).toBe("STEP_TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(error.stepName).toBe("call-api");
    expect(error.timeout).toBe("30s");
  });

  it("should be instanceof IronflowError", () => {
    const error = new StepTimeoutError("step-a", "5m");
    expect(error).toBeInstanceOf(IronflowError);
  });
});

describe("isRetryable", () => {
  it.each([
    ["ConnectionError", new ConnectionError("test"), true],
    ["TimeoutError", new TimeoutError("test", 1000), true],
    ["SubscriptionError (default)", new SubscriptionError("test"), true],
    ["ValidationError", new ValidationError("test"), false],
    ["SignatureError", new SignatureError("test"), false],
    ["FunctionNotFoundError", new FunctionNotFoundError("fn-1"), false],
    ["RunNotFoundError", new RunNotFoundError("run-1"), false],
    ["StepError (default retryable)", new StepError("test", { stepId: "s", stepName: "n" }), true],
    ["StepError (non-retryable)", new StepError("test", { stepId: "s", stepName: "n", retryable: false }), false],
    ["NonRetryableError", new NonRetryableError("test"), false],
    ["NotConfiguredError", new NotConfiguredError(), false],
    ["IronflowError (default)", new IronflowError("test"), false],
    ["IronflowError (retryable)", new IronflowError("test", { retryable: true }), true],
    ["InvokeError", new InvokeError("charge-card", "run-123", "error"), false],
    ["StepTimeoutError", new StepTimeoutError("step", "30s"), true],
  ])("should return correct value for %s", (_, error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });

  it("should return true for TypeError with fetch in message", () => {
    const error = new TypeError("fetch failed");
    expect(isRetryable(error)).toBe(true);
  });

  it("should return true for TypeError with fetch keyword", () => {
    const error = new TypeError("Failed to fetch");
    expect(isRetryable(error)).toBe(true);
  });

  it("should return false for TypeError without fetch keyword", () => {
    const error = new TypeError("Cannot read property");
    expect(isRetryable(error)).toBe(false);
  });

  it("should return false for generic Error", () => {
    expect(isRetryable(new Error("test"))).toBe(false);
  });

  it("should return false for non-error values", () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable("string")).toBe(false);
    expect(isRetryable(123)).toBe(false);
    expect(isRetryable({})).toBe(false);
  });
});

describe("isIronflowError", () => {
  it("should return true for IronflowError instances", () => {
    expect(isIronflowError(new IronflowError("test"))).toBe(true);
  });

  it("should return true for subclasses", () => {
    expect(isIronflowError(new ConnectionError("test"))).toBe(true);
    expect(isIronflowError(new TimeoutError("test", 1000))).toBe(true);
    expect(isIronflowError(new ValidationError("test"))).toBe(true);
    expect(isIronflowError(new StepError("test", { stepId: "s", stepName: "n" }))).toBe(true);
  });

  it("should return false for non-IronflowError", () => {
    expect(isIronflowError(new Error("test"))).toBe(false);
    expect(isIronflowError(new TypeError("test"))).toBe(false);
    expect(isIronflowError(null)).toBe(false);
    expect(isIronflowError(undefined)).toBe(false);
    expect(isIronflowError("error")).toBe(false);
  });
});

describe("toError", () => {
  it("returns same Error instance for Error input", () => {
    const err = new Error("test");
    expect(toError(err)).toBe(err);
  });

  it("wraps string in Error", () => {
    const result = toError("something failed");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("something failed");
  });

  it("wraps object with message property", () => {
    const result = toError({ message: "obj error" });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("obj error");
  });

  it("wraps number via String()", () => {
    const result = toError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("42");
  });

  it("wraps null via String()", () => {
    const result = toError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("null");
  });

  it("wraps undefined via String()", () => {
    const result = toError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("undefined");
  });
});
