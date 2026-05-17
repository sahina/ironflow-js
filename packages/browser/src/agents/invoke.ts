/**
 * `ironflow.agents.invoke()` — fire-and-wait against an agent function.
 *
 * Composes the existing async `client.invoke()` + `client.subscribe()` to
 * deliver a single Promise<{runId, output, durationMs}>.
 *
 * Race window between Trigger return and subscribe attach is covered by
 * `subscribe({replay})` — see ./spec.md.
 */

import {
  AgentInvokeTimeoutError,
  NoRunCreatedError,
  RunCancelledError,
  RunFailedError,
  ValidationError,
  type SubscriptionEvent,
} from "@ironflow/core";

import type {
  AgentClientLike,
  AgentInvokeOptions,
  AgentInvokeResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// Match the server-side `ReplayMaxEvents` default (1000). Replay-from-zero
// against a per-run subject is bounded by the run's own emission rate, so
// 1000 covers ~500 steps (each emits `created`+`completed`) plus run
// lifecycle events. Step-heavier agents should raise both this option and
// the server's `ReplayMaxEvents` config.
const DEFAULT_REPLAY = 1000;
const MAX_NAME_LENGTH = 256;
// Defense-in-depth: even though the server is the source of `runId`, we
// guard against a misbehaving server or mock returning NATS metacharacters
// (`*`, `>`, `.`) that would widen the subscribe pattern.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
 * Extract terminal-event verdict from a topic suffix. Returns null for
 * non-terminal events.
 *
 * Topics: `system.run.{runId}.{event}` where event ∈
 *   { created, updated, resumed, completed, failed, cancelled }.
 * Step events live under `.step.{stepId}.{type}`.
 */
function classifyTerminal(
  topic: string
): "completed" | "failed" | "cancelled" | null {
  if (topic.includes(".step.")) return null;
  if (topic.endsWith(".completed")) return "completed";
  if (topic.endsWith(".failed")) return "failed";
  if (topic.endsWith(".cancelled")) return "cancelled";
  return null;
}

interface RunEventPayload {
  status?: string;
  output?: unknown;
  error?: { message?: string; code?: string } | string;
}

function extractError(data: unknown): { message: string; code?: string } {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as RunEventPayload).error;
    if (typeof err === "string") {
      return { message: err };
    }
    if (err && typeof err === "object") {
      return {
        message: err.message ?? "Run failed",
        code: err.code,
      };
    }
  }
  return { message: "Run failed" };
}

/**
 * Fire-and-wait: trigger the named agent function, subscribe to its run
 * events, and resolve when a terminal event arrives.
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
  const replay = opts.replay ?? DEFAULT_REPLAY;
  const startedAt = Date.now();

  // 1) Trigger the agent. Server returns runId.
  const triggerResult = await client.invoke(name, {
    data: payload,
    idempotencyKey: opts.idempotencyKey,
  });

  const runId = triggerResult.runIds?.[0];
  if (!runId) {
    throw new NoRunCreatedError(name);
  }
  // Defense-in-depth: server is the source of truth, but reject obviously
  // malformed runIds before interpolating them into a NATS subject.
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ValidationError(
      `agents.invoke: server returned invalid runId "${runId}" (must match ${RUN_ID_PATTERN})`
    );
  }

  // Single deferred. resolve/reject from subscribe callback, timeout, or abort.
  let settled = false;
  let resolveOuter: (v: AgentInvokeResult<TOutput>) => void = () => {};
  let rejectOuter: (e: Error) => void = () => {};
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };
  const outer = new Promise<AgentInvokeResult<TOutput>>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });
  // Attach a no-op handler eagerly so a fast settle() (e.g., synchronous
  // timer or pre-subscribe abort) does not surface as an unhandled
  // rejection before the awaiter below attaches. The original `outer`
  // promise is unchanged and will still reject through `await outer`.
  outer.catch(() => {
    /* observed; real consumer is `await outer` below */
  });

  // Arm timeout + abort BEFORE running the user-provided onRunStarted hook
  // so a hanging hook cannot bypass `timeoutMs` / `signal`.
  const timeoutHandle = setTimeout(() => {
    settle(() =>
      rejectOuter(new AgentInvokeTimeoutError(runId, timeoutMs))
    );
  }, timeoutMs);
  const abortHandler = (): void => {
    settle(() => rejectOuter(new DOMException("Aborted", "AbortError")));
  };
  opts.signal?.addEventListener("abort", abortHandler, { once: true });

  // Surface runId immediately so callers can attach a separate progress
  // subscription via agents.subscribe(runId) without waiting for terminal.
  // We await onRunStarted so the caller's async hook (e.g., attaching a
  // watcher) completes before the SDK starts dispatching terminal events,
  // preventing late events from leaking into a subsequent run's UI. The
  // hook is bounded by the timeout/abort armed above.
  if (opts.onRunStarted && !settled) {
    try {
      await opts.onRunStarted(runId);
    } catch {
      /* swallow — caller's bug is not ours */
    }
  }

  // Subscribe and wire dispatch. Race the attach against the deferred so
  // a hung subscribe call cannot wedge the invoke past `timeoutMs`/abort.
  let unsubscribe: (() => void) | undefined;
  const subscribePromise = client
    .subscribe<RunEventPayload>(`system.run.${runId}.>`, {
      replay,
      onEvent: (event: SubscriptionEvent<RunEventPayload>) => {
        if (settled) return;
        const verdict = classifyTerminal(event.topic);
        if (!verdict) return;
        if (verdict === "completed") {
          const output = event.data?.output as TOutput | undefined;
          settle(() =>
            resolveOuter({
              runId,
              output,
              durationMs: Date.now() - startedAt,
            })
          );
          return;
        }
        if (verdict === "failed") {
          const err = extractError(event.data);
          settle(() =>
            rejectOuter(new RunFailedError(runId, event.data, err.message))
          );
          return;
        }
        settle(() => rejectOuter(new RunCancelledError(runId)));
      },
      onError: (subErr) => {
        settle(() =>
          rejectOuter(
            new Error(`agents.invoke subscription error: ${subErr.message}`)
          )
        );
      },
    })
    .then((sub) => {
      unsubscribe = () => {
        try {
          sub.unsubscribe();
        } catch {
          /* idempotent */
        }
      };
      // Race already settled before subscribe attached: clean up now.
      if (settled) unsubscribe();
    })
    .catch((err: Error) => {
      settle(() => rejectOuter(err));
    });
  // Don't block on subscribePromise; the outer race continues to fire on
  // timeout/abort even if the attach never resolves.
  void subscribePromise;

  try {
    return await outer;
  } catch (err) {
    // Property check on `name` instead of `instanceof DOMException` for
    // cross-runtime compatibility (some test runners and older Node
    // builds don't share a DOMException prototype).
    const isAbort =
      typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name: unknown }).name === "AbortError";
    if (err instanceof AgentInvokeTimeoutError || isAbort) {
      // Fire-and-forget: do NOT await the cancel. A hanging cancelRun
      // would block propagation of the original timeout/abort error to
      // the caller. The unhandled-rejection guard preserves error
      // observability without blocking.
      void client
        .cancelRun(runId, "agents.invoke aborted")
        .catch(() => {
          /* swallow — best-effort */
        });
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener("abort", abortHandler);
    if (unsubscribe) unsubscribe();
  }
}
