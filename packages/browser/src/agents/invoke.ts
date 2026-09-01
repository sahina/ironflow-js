/**
 * `ironflow.agents.invoke()` — fire-and-wait against an agent function.
 *
 * One `InvokeFunctionSync` call. The server keys on the function id, creates
 * exactly one run, waits for it, and returns its outcome — so there is no
 * Trigger→subscribe→race compose left to get wrong, and no window between the
 * two for an event to slip through.
 *
 * Two behaviours are load-bearing and must not be "tidied":
 *
 * 1. `timeoutMs` is a wait budget, not a transport deadline. The client sends
 *    it as `timeout_ms` and keeps the HTTP deadline longer. Wiring it to a
 *    fetch abort would cancel the run on every timeout (see 2) and make the
 *    "still running" outcome unobservable.
 * 2. Aborting the HTTP request cancels the run server-side (ADR 0067 / Q19),
 *    which is why the abort path no longer calls `cancelRun`. The timeout path
 *    still does: an expired budget deliberately leaves the run alive, and an
 *    agent run left alive is an agent run still spending money.
 */

import {
  AgentInvokeTimeoutError,
  RunWaitTimeoutError,
  ValidationError,
} from "@ironflow/core";

import type {
  AgentClientLike,
  AgentInvokeOptions,
  AgentInvokeResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_NAME_LENGTH = 256;

/**
 * Validate the function name argument. Server validates the rest; we just
 * catch the obviously broken cases client-side to fail fast.
 */
function validateName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError("agents.invoke: name must be a non-empty string");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `agents.invoke: name exceeds ${MAX_NAME_LENGTH} chars`
    );
  }
}

/**
 * Fire-and-wait: invoke the named agent function and resolve with its output.
 *
 * Throws `RunFailedError` / `RunCancelledError` from the client for a failed
 * or cancelled run, `AgentInvokeTimeoutError` when `timeoutMs` expires, and a
 * DOMException `AbortError` when `opts.signal` fires.
 */
export async function invoke<TOutput = unknown>(
  client: AgentClientLike,
  name: string,
  payload: unknown,
  opts: AgentInvokeOptions = {}
): Promise<AgentInvokeResult<TOutput>> {
  validateName(name);

  // Pre-flight abort: throw before any network I/O.
  if (opts.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let result;
  try {
    result = await client.invoke(name, {
      data: payload,
      timeout: timeoutMs,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  } catch (err) {
    // The wait budget expired with the run still active. Translate to the
    // agents-level error the public contract promises, and best-effort cancel:
    // unlike an abort, an expired budget does NOT cancel the run server-side,
    // so skipping this would leave a zombie agent running.
    if (err instanceof RunWaitTimeoutError) {
      // Fire-and-forget: a hanging cancelRun must not delay the timeout error.
      void client.cancelRun(err.runId, "agents.invoke timed out").catch(() => {
        /* swallow — best-effort */
      });
      throw new AgentInvokeTimeoutError(err.runId, timeoutMs);
    }
    throw err;
  }

  // Surface the runId to the caller's hook. It settles after the run rather
  // than before the wait now — see the deprecation note on the option.
  if (opts.onRunStarted) {
    try {
      await opts.onRunStarted(result.runId);
    } catch {
      /* swallow — caller's bug is not ours */
    }
  }

  return {
    runId: result.runId,
    output: result.output as TOutput | undefined,
    // Client wall-clock, unchanged from the compose version. `result.durationMs`
    // measures the run alone and would silently redefine this field.
    durationMs: Date.now() - startedAt,
  };
}
