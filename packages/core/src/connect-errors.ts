import {
  IronflowError,
  EnterpriseRequiredError,
  UnauthenticatedError,
  UnauthorizedError,
  ConflictError,
  ContendedError,
  InjectionUnverifiedError,
} from "./errors.js";

/**
 * Response-metadata key the server uses to refine an ambiguous Connect code.
 * ADR 0079 section 3 keeps the `connect.Code` as the contract; this header
 * refines the one code that carries two opposite meanings, the way
 * `Retry-After` refines `resource_exhausted`.
 */
export const ERROR_REASON_HEADER = "Ironflow-Error-Reason";

/** Values for {@link ERROR_REASON_HEADER}. */
export const ERROR_REASON = {
  contended: "contended",
  injectionUnverified: "injection_unverified",
} as const;

/** Map a Connect JSON error to the SDK error contract, including retry advice. */
export function connectHTTPError(status: number, message: string, code?: string, options: { retryable?: boolean; authHelp?: string; reason?: string } = {}): IronflowError {
  const authMessage = options.authHelp ? `${message} — ${options.authHelp}` : message;
  if (status === 402) return new EnterpriseRequiredError(message);
  switch (code) {
    case "unauthenticated": return new UnauthenticatedError(authMessage);
    case "permission_denied": return new UnauthorizedError(authMessage);
    case "already_exists": return new ConflictError(message);
    // Two opposite outcomes share this code, so the code alone is not the
    // answer: injectStepOutput answers `aborted` BOTH when the CAS lost and
    // nothing was written and when the step write landed but the run moved
    // under it. Reading only the code told a caller "nothing was applied"
    // about a durable write (#2093). The server names which one in
    // Ironflow-Error-Reason; an `aborted` with no reason is a pre-#2093 server
    // or a non-inject RPC, and contention is the right default for both — it
    // is what every other producer of this code means.
    case "aborted":
      return options.reason === ERROR_REASON.injectionUnverified
        ? new InjectionUnverifiedError(message)
        : new ContendedError(message);
    default:
      if (status === 401) return new UnauthenticatedError(authMessage);
      if (status === 403) return new UnauthorizedError(authMessage);
      return new IronflowError(message, {
        code: code ?? `HTTP_${status}`,
        status,
        // `status >= 500` alone gets the write throttle backwards. Its rate cap
        // answers resource_exhausted (429) with a Retry-After — transient, and
        // the one case worth resending unchanged — while its disk cap answers
        // failed_precondition (400), permanent until an operator frees space.
        // Reading only the status made the transient one fatal (#1972 step 10).
        retryable: options.retryable ?? (status >= 500 || code === "resource_exhausted"),
      });
  }
}
