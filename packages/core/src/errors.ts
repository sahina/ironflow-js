/**
 * Ironflow SDK Error Classes
 *
 * Provides a hierarchy of error types for different failure scenarios.
 */

/**
 * Base error class for all Ironflow errors
 */
export class IronflowError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /** Whether this error is retryable */
  readonly retryable: boolean;
  /** Additional error details */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      code?: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "IronflowError";
    this.code = options?.code ?? "UNKNOWN_ERROR";
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

/**
 * Error thrown when a connection is lost
 */
export class ConnectionError extends IronflowError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, {
      code: "CONNECTION_LOST",
      retryable: true,
      cause: options?.cause,
    });
    this.name = "ConnectionError";
  }
}

/**
 * Error thrown when a subscription fails
 */
export class SubscriptionError extends IronflowError {
  /** The subscription ID that failed */
  readonly subscriptionId?: string;

  constructor(
    message: string,
    options?: {
      subscriptionId?: string;
      code?: string;
      retryable?: boolean;
      cause?: Error;
    }
  ) {
    super(message, {
      code: options?.code ?? "SUBSCRIPTION_ERROR",
      retryable: options?.retryable ?? true,
      cause: options?.cause,
    });
    this.name = "SubscriptionError";
    this.subscriptionId = options?.subscriptionId;
  }
}

/**
 * Error thrown when a request times out
 */
export class TimeoutError extends IronflowError {
  /** The timeout duration in milliseconds */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: { cause?: Error }) {
    super(message, {
      code: "TIMEOUT",
      retryable: true,
      cause: options?.cause,
    });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends IronflowError {
  /** The validation errors */
  readonly validationErrors?: string[];

  constructor(message: string, options?: { validationErrors?: string[]; cause?: Error }) {
    super(message, {
      code: "VALIDATION_ERROR",
      retryable: false,
      cause: options?.cause,
    });
    this.name = "ValidationError";
    this.validationErrors = options?.validationErrors;
  }
}

/**
 * Error thrown when schema validation fails
 */
export class SchemaValidationError extends ValidationError {
  constructor(message: string, options?: { validationErrors?: string[]; cause?: Error }) {
    super(message, options);
    this.name = "SchemaValidationError";
  }
}

/**
 * Error thrown when a signature is invalid
 */
export class SignatureError extends IronflowError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, {
      code: "SIGNATURE_INVALID",
      retryable: false,
      cause: options?.cause,
    });
    this.name = "SignatureError";
  }
}

/**
 * Error thrown when a function is not found
 */
export class FunctionNotFoundError extends IronflowError {
  /** The function ID that was not found */
  readonly functionId: string;

  constructor(functionId: string, options?: { cause?: Error }) {
    super(`Function not found: ${functionId}`, {
      code: "FUNCTION_NOT_FOUND",
      retryable: false,
      details: { functionId },
      cause: options?.cause,
    });
    this.name = "FunctionNotFoundError";
    this.functionId = functionId;
  }
}

/**
 * Error thrown when a run is not found
 */
export class RunNotFoundError extends IronflowError {
  /** The run ID that was not found */
  readonly runId: string;

  constructor(runId: string, options?: { cause?: Error }) {
    super(`Run not found: ${runId}`, {
      code: "RUN_NOT_FOUND",
      retryable: false,
      details: { runId },
      cause: options?.cause,
    });
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Error thrown when a step fails
 */
export class StepError extends IronflowError {
  /** The step ID that failed */
  readonly stepId: string;
  /** The step name that failed */
  readonly stepName: string;

  constructor(
    message: string,
    options: {
      stepId: string;
      stepName: string;
      retryable?: boolean;
      cause?: Error;
    }
  ) {
    super(message, {
      code: "STEP_FAILED",
      retryable: options.retryable ?? true,
      details: { stepId: options.stepId, stepName: options.stepName },
      cause: options.cause,
    });
    this.name = "StepError";
    this.stepId = options.stepId;
    this.stepName = options.stepName;
  }
}

/**
 * Error thrown for non-retryable failures
 */
export class NonRetryableError extends IronflowError {
  constructor(message: string, options?: { code?: string; cause?: Error }) {
    super(message, {
      code: options?.code ?? "NON_RETRYABLE",
      retryable: false,
      cause: options?.cause,
    });
    this.name = "NonRetryableError";
  }
}

/**
 * Error thrown when the client is not configured
 */
export class NotConfiguredError extends IronflowError {
  constructor(message: string = "Client not configured. Call configure() first.") {
    super(message, {
      code: "NOT_CONFIGURED",
      retryable: false,
    });
    this.name = "NotConfiguredError";
  }
}

/**
 * Thrown when step.invoke() fails because the invoked function failed or validation failed.
 */
export class InvokeError extends IronflowError {
  readonly functionId: string;
  readonly childRunId: string | undefined;
  readonly errorCause: string;

  constructor(functionId: string, childRunId: string | undefined, errorCause: string) {
    super(`invoke '${functionId}' failed${childRunId ? ` (run ${childRunId})` : ''}: ${errorCause}`, {
      code: "INVOKE_FAILED",
      retryable: false,
      details: { functionId, childRunId },
    });
    this.name = "InvokeError";
    this.functionId = functionId;
    this.childRunId = childRunId;
    this.errorCause = errorCause;
  }
}

/**
 * Thrown when step.invoke() times out waiting for the child function to complete.
 */
export class InvokeTimeoutError extends InvokeError {
  readonly timeoutMs: number;

  constructor(functionId: string, childRunId: string | undefined, timeoutMs: number) {
    super(functionId, childRunId, `invoke timed out after ${timeoutMs}ms`);
    this.name = "InvokeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when step.run() exceeds its configured timeout.
 */
export class StepTimeoutError extends IronflowError {
  readonly stepName: string;
  readonly timeout: string;

  constructor(stepName: string, timeout: string) {
    super(`Step "${stepName}" timed out after ${timeout}`, {
      code: "STEP_TIMEOUT",
      retryable: true,
    });
    this.name = "StepTimeoutError";
    this.stepName = stepName;
    this.timeout = timeout;
  }
}

/**
 * Check if an error is retryable
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof IronflowError) {
    return error.retryable;
  }
  // Network errors are generally retryable
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  return false;
}

/**
 * Type guard to check if an error is an IronflowError
 */
export function isIronflowError(error: unknown): error is IronflowError {
  return error instanceof IronflowError;
}

/**
 * Normalize any thrown value to an Error instance.
 *
 * Useful for catch blocks where the caught value might not be an Error
 * (e.g., thrown strings, numbers, or objects).
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(String(error));
}

/**
 * Thrown when a run fails (emitSync / TriggerSync)
 */
export class RunFailedError extends IronflowError {
  public readonly runId: string;
  public readonly output: unknown;

  constructor(runId: string, output: unknown, message?: string) {
    super(message || `Run ${runId} failed`, {
      code: "RUN_FAILED",
      retryable: false,
    });
    this.name = "RunFailedError";
    this.runId = runId;
    this.output = output;
  }
}

/**
 * Thrown when a run is cancelled (emitSync / TriggerSync)
 */
export class RunCancelledError extends IronflowError {
  public readonly runId: string;

  constructor(runId: string) {
    super(`Run ${runId} was cancelled`, {
      code: "RUN_CANCELLED",
      retryable: false,
    });
    this.name = "RunCancelledError";
    this.runId = runId;
  }
}

/**
 * Thrown when ironflow.agents.invoke() exceeds opts.timeoutMs before a
 * terminal run event is observed. SDK best-effort calls cancelRun(runId).
 */
export class AgentInvokeTimeoutError extends IronflowError {
  public readonly runId: string;
  public readonly timeoutMs: number;

  constructor(runId: string, timeoutMs: number) {
    super(`agents.invoke timed out after ${timeoutMs}ms (runId=${runId})`, {
      code: "AGENT_INVOKE_TIMEOUT",
      retryable: true,
    });
    this.name = "AgentInvokeTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a Trigger response carries no runIds. Indicates server
 * misconfiguration or a function not registered for the supplied name.
 */
export class NoRunCreatedError extends IronflowError {
  public readonly functionName: string;

  constructor(functionName: string) {
    super(`No run created for "${functionName}" (empty runIds)`, {
      code: "NO_RUN_CREATED",
      retryable: false,
    });
    this.name = "NoRunCreatedError";
    this.functionName = functionName;
  }
}

/**
 * Thrown when ironflow.agents.readMemory() exceeds opts.timeoutMs while
 * waiting for the projection to catch up to opts.minSeq.
 */
export class MemoryCatchupTimeoutError extends IronflowError {
  public readonly projection: string;
  public readonly minSeq: bigint;
  public readonly timeoutMs: number;

  constructor(projection: string, minSeq: bigint, timeoutMs: number) {
    super(
      `agents.readMemory timed out after ${timeoutMs}ms waiting for projection "${projection}" to reach minSeq=${minSeq}`,
      {
        code: "MEMORY_CATCHUP_TIMEOUT",
        retryable: true,
      }
    );
    this.name = "MemoryCatchupTimeoutError";
    this.projection = projection;
    this.minSeq = minSeq;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when no/invalid API key is provided (HTTP 401)
 */
export class UnauthenticatedError extends IronflowError {
  constructor(message = "Authentication required") {
    super(message, {
      code: "UNAUTHENTICATED",
      retryable: false,
    });
    this.name = "UnauthenticatedError";
  }
}

/**
 * Thrown when enterprise license is required (HTTP 402)
 */
export class EnterpriseRequiredError extends IronflowError {
  constructor(message = "Enterprise license required") {
    super(message, {
      code: "ENTERPRISE_REQUIRED",
      retryable: false,
    });
    this.name = "EnterpriseRequiredError";
  }
}

/**
 * Thrown when the API key lacks required permissions (HTTP 403)
 */
export class UnauthorizedError extends IronflowError {
  constructor(message = "Insufficient permissions") {
    super(message, {
      code: "UNAUTHORIZED",
      retryable: false,
    });
    this.name = "UnauthorizedError";
  }
}
