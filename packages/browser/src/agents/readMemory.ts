/**
 * `ironflow.agents.readMemory()` — typed read of an agent memory
 * projection with optional read-your-writes catchup.
 *
 * Composes `client.waitForProjectionCatchup` (when `opts.minSeq` is set)
 * + `client.getProjection`. See ./spec.md.
 */

import {
  MemoryCatchupTimeoutError,
  ValidationError,
} from "@ironflow/core";

import type {
  AgentClientLike,
  AgentMemoryResult,
  AgentReadMemoryOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_NAME_LENGTH = 256;

function validateProjection(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError(
      "agents.readMemory: projection must be a non-empty string"
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `agents.readMemory: projection exceeds ${MAX_NAME_LENGTH} chars`
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Race a Promise against a caller-supplied AbortSignal. Resolves with
 * the original promise unless the signal aborts first, in which case
 * an AbortError is thrown. The original promise is left to settle in
 * the background — its result is discarded.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * Read materialized projection state for an agent memory.
 *
 * When `opts.minSeq` is provided, waits for the projection to catch up
 * before reading. This delivers read-your-writes semantics for callers
 * that just appended an event (use the seq returned from
 * `streams.append`).
 */
export async function readMemory<TState = unknown>(
  client: AgentClientLike,
  projection: string,
  opts: AgentReadMemoryOptions = {}
): Promise<AgentMemoryResult<TState>> {
  validateProjection(projection);
  throwIfAborted(opts.signal);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Treat `minSeq=0` / `0n` as "no catchup required" per the spec —
  // saves a no-op round trip when callers default the param.
  const minSeqProvided =
    opts.minSeq !== undefined && opts.minSeq !== 0 && opts.minSeq !== 0n;

  if (minSeqProvided) {
    const waitResult = await raceAbort(
      client.waitForProjectionCatchup(projection, {
        minSeq: opts.minSeq!,
        timeoutMs,
        partition: opts.partition,
      }),
      opts.signal
    );
    if (waitResult.timedOut) {
      throw new MemoryCatchupTimeoutError(
        projection,
        BigInt(opts.minSeq!),
        timeoutMs
      );
    }
  }

  throwIfAborted(opts.signal);

  const stateResult = await raceAbort(
    client.getProjection<TState>(projection, {
      partition: opts.partition,
    }),
    opts.signal
  );

  return {
    state: stateResult.state,
    version: stateResult.version,
    lastEventId: stateResult.lastEventId || undefined,
    caughtUp: true,
  };
}
