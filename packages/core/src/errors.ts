/**
 * Ironflow SDK Error Classes
 *
 * Provides a hierarchy of error types for different failure scenarios.
 */

import type { RunStatus } from "./types.js";

/**
 * Base error class for all Ironflow errors
 */
export class IronflowError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /**
   * HTTP status, when the error came from a response.
   *
   * Classification must key off this rather than `code`: `code` is built as
   * `errorBody?.code ?? \`HTTP_${status}\``, so any proxy or Connect handler that
   * puts its own `code` in the body silently replaces it. A 401 arriving as
   * `{"code":"unauthenticated"}` would otherwise miss every string comparison.
   */
  readonly status?: number;
  /** Whether this error is retryable */
  readonly retryable: boolean;
  /** Additional error details */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = "IronflowError";
    this.code = options?.code ?? "UNKNOWN_ERROR";
    this.status = options?.status;
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
 * Thrown when emitSync stops waiting before its selected run reaches a
 * terminal state. The durable run continues and can be inspected by runId.
 */
export class RunWaitTimeoutError extends IronflowError {
  public readonly runId: string;
  public readonly functionId: string;
  public readonly runStatus: RunStatus;
  public readonly timeoutMs: number;

  constructor(
    runId: string,
    functionId: string,
    runStatus: RunStatus,
    timeoutMs: number
  ) {
    super(
      `Run ${runId} did not reach a terminal state within ${timeoutMs}ms`,
      {
        code: "RUN_WAIT_TIMEOUT",
        retryable: false,
      }
    );
    this.name = "RunWaitTimeoutError";
    this.runId = runId;
    this.functionId = functionId;
    this.runStatus = runStatus;
    this.timeoutMs = timeoutMs;
  }
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

/**
 * Thrown when the request conflicts with state already in flight (HTTP 409 /
 * Connect `already_exists`).
 *
 * `resumeRun` throws it when an identical resume is already inside the
 * server's dedupe window (#1963): the run is left exactly as it was found, so
 * the caller should wait for the first resume to land. Deliberately not
 * retryable — retrying is the thing this error reports against.
 *
 * Two Connect codes serialize to 409 with opposite retry advice, so the status
 * alone cannot pick between them (#2074). `already_exists` lands here;
 * `aborted` lands in {@link ContendedError}. A 409 carrying no Connect code —
 * every REST route — still lands here, which is the pre-#2074 behavior.
 */
export class ConflictError extends IronflowError {
  constructor(message = "Conflicts with an operation already in flight") {
    super(message, {
      code: "CONFLICT",
      retryable: false,
    });
    this.name = "ConflictError";
  }
}

/**
 * Thrown when a concurrent write won and the server abandoned this one
 * (HTTP 409 / Connect `aborted`).
 *
 * The sibling of {@link ConflictError} at the same status, and its opposite:
 * nothing was applied, so the call can be made again — but **re-read first**.
 * gRPC defines `aborted` as "retry at a higher level", meaning restart the
 * read-modify-write. `retryable` is false because it advertises something
 * narrower — a blind reissue of the identical body — and that is wrong for
 * both halves of `aborted`. Where the caller supplied the version
 * (`streams.append`, the webhook mutators) the reissue fails identically;
 * where the server read the version itself (`updateFunction`,
 * `updateFunctionStatus`, `rollbackFunction`, `cancelRun`) it could land,
 * silently re-applying a write the caller never re-read. `resumeRun` is in
 * that second group and #1972 does not move it: the RPC takes no version from
 * the caller, and the engine reads it server-side for the CAS.
 *
 * A separate class rather than a flag on `ConflictError` because callers
 * already key on `ConflictError` to mean "wait, do not retry" — folding
 * contention into it would make that check wrong for half its instances. The
 * two carry identical flags on purpose: the discriminator is the type.
 */
export class ContendedError extends IronflowError {
  constructor(message = "Lost a race with a concurrent write; re-read and reissue") {
    super(message, {
      code: "CONTENDED",
      retryable: false,
    });
    this.name = "ContendedError";
  }
}

/**
 * Thrown when `injectStepOutput` wrote the step but could not confirm the run
 * stood still around the write (Connect `aborted` +
 * `Ironflow-Error-Reason: injection_unverified`).
 *
 * The opposite of {@link ContendedError} at the SAME Connect code, which is
 * why the header exists. Contention means nothing was applied and the call can
 * be reissued; this means the step **did** change and a blind reissue writes
 * over state the caller has not looked at. Read the step — `output` carries
 * the injected value and `originalOutput` the pre-injection one — and decide,
 * rather than retrying.
 *
 * Before #2093's review every `aborted` became a `ContendedError`, whose doc
 * promises "nothing was applied": true for the other producers of that code
 * and a lie for this one, in the dangerous direction. `retryable` is false for
 * the same reason it is false on its sibling, and more so.
 */
export class InjectionUnverifiedError extends IronflowError {
  constructor(message = "The injection was written but the run moved during the write; inspect the step before retrying") {
    super(message, {
      code: "INJECTION_UNVERIFIED",
      retryable: false,
    });
    this.name = "InjectionUnverifiedError";
  }
}

/**
 * Thrown when the browser offline write queue is at its item or byte cap, or
 * the origin is out of storage quota.
 *
 * The queue rejects rather than evicting. Every telemetry SDK drops the oldest
 * entry instead, which is right for telemetry and wrong here: dropping
 * `order.placed` while keeping `order.shipped` manufactures exactly the
 * corrupted projection that strict FIFO exists to prevent. Rejecting is louder
 * and safer, because the application finds out and can stop generating writes
 * that depend on the one that never landed. See ADR 0053, Alternative G.
 */
export class QueueFullError extends IronflowError {
  constructor(message = "Offline write queue is full") {
    super(message, {
      code: "QUEUE_FULL",
      retryable: false,
    });
    this.name = "QueueFullError";
  }
}

/**
 * Guidance appended to 401/403 errors (#1673). A worker started without a key
 * used to log `401` and reconnect forever, never naming the env var or the key
 * file. The path is a default, not a fact: `serve` resolves it three ways
 * (--bootstrap-key-file, <db-dir>/, os.TempDir()) — so point at the banner.
 */
export const AUTH_HELP =
  "Set IRONFLOW_API_KEY (or pass `apiKey` in the config). " +
  "The server writes a first-boot admin key to <db-dir>/.ironflow_bootstrap_key.json " +
  "(dev default: .ironflow/.ironflow_bootstrap_key.json) and prints the exact path in its " +
  "startup banner. Read it with: cat <path> | jq -r .key";

/**
 * Throw a typed, actionable error for 401/403; no-op for every other status.
 * Both thrown types are non-retryable — callers with a reconnect loop should
 * break out rather than retry an auth failure on the network cadence.
 */
export function throwIfAuthError(status: number, context: string): void {
  if (status === 401) {
    throw new UnauthenticatedError(`${context}: 401 unauthenticated. ${AUTH_HELP}`);
  }
  if (status === 403) {
    throw new UnauthorizedError(`${context}: 403 forbidden. ${AUTH_HELP}`);
  }
}
