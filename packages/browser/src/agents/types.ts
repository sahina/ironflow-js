/**
 * Public types for `ironflow.agents.{invoke, subscribe, readMemory}`.
 *
 * Spec: see ./spec.md
 */

import type {
  InvokeResult,
  ProjectionStateResult,
  Run,
  Subscription,
  SubscriptionCallbacks,
  SubscriptionErrorInfo,
  WaitResult,
} from "@ironflow/core";

/**
 * Options for `ironflow.agents.invoke()`.
 */
export interface AgentInvokeOptions {
  /**
   * Local timeout in milliseconds. When elapsed, throws
   * `AgentInvokeTimeoutError` and best-effort calls
   * `cancelRun(runId)` server-side. Default: 30000.
   */
  timeoutMs?: number;

  /**
   * Caller cancellation. When the signal aborts, throws an `AbortError`
   * (DOMException) and best-effort calls `cancelRun(runId)`.
   */
  signal?: AbortSignal;

  /**
   * Server-side dedup. Same key → same `runId` returned across retries.
   * Wires to existing event-idempotency path.
   */
  idempotencyKey?: string;

  /**
   * Number of historical events to replay on subscribe. Default: 100.
   * Replay covers the race window between Trigger return and subscribe attach.
   */
  replay?: number;

  /**
   * Called once with the runId as soon as `Trigger` returns and before
   * the wait begins. Lets callers attach a separate progress subscription
   * (e.g., `agents.subscribe(runId)`) without waiting for the terminal
   * event. May return a Promise; the SDK awaits it so any async setup
   * (subscription attach) completes before terminal events dispatch.
   */
  onRunStarted?: (runId: string) => void | Promise<void>;
}

/**
 * Result returned from a successful `ironflow.agents.invoke()`.
 */
export interface AgentInvokeResult<TOutput = unknown> {
  runId: string;
  output: TOutput | undefined;
  durationMs: number;
}

/**
 * Callbacks for `ironflow.agents.subscribe()`.
 */
export interface AgentSubscribeCallbacks {
  /** Non-terminal run lifecycle events (created, updated, resumed). */
  onProgress?: (event: AgentProgressEvent) => void;
  /** Step lifecycle events (created, completed, etc.). */
  onStep?: (event: AgentStepEvent) => void;
  /** Terminal `run.completed`. */
  onComplete?: (result: { output: unknown }) => void;
  /** Terminal `run.failed`. */
  onFailed?: (error: { message: string; code?: string }) => void;
  /** Terminal `run.cancelled`. */
  onCancelled?: () => void;
  /** Transport / parse error. */
  onError?: (err: SubscriptionErrorInfo) => void;
}

export interface AgentProgressEvent {
  topic: string;
  status?: string;
  data?: unknown;
}

export interface AgentStepEvent {
  topic: string;
  stepId: string;
  type: string;
  data?: unknown;
}

/**
 * Options for `ironflow.agents.readMemory()`.
 */
export interface AgentReadMemoryOptions {
  /**
   * Sequence number returned by an earlier `streams.append`. When set,
   * `readMemory` calls `waitForProjectionCatchup` before reading state
   * so the result reflects events up to and including `minSeq`
   * (read-your-writes).
   *
   * If `minSeq` exceeds the projection's eventual `last_event_seq`, the
   * catchup blocks until `timeoutMs` and throws
   * `MemoryCatchupTimeoutError`.
   */
  minSeq?: number | bigint;

  /**
   * Catchup timeout in milliseconds. Default 30000. Ignored when
   * `minSeq` is not provided.
   */
  timeoutMs?: number;

  /**
   * Caller cancellation. Throws an `AbortError` (DOMException) if the
   * signal aborts before the call completes.
   */
  signal?: AbortSignal;

  /**
   * Partition key for partitioned projections. Passed through to both
   * the catchup wait and the state read.
   */
  partition?: string;
}

/**
 * Result returned from a successful `ironflow.agents.readMemory()`.
 */
export interface AgentMemoryResult<TState = unknown> {
  /** Materialized projection state. */
  state: TState;
  /** Projection version. */
  version: number;
  /** Last event id applied to the state, if any. */
  lastEventId?: string;
  /**
   * `true` when `minSeq` was honored or skipped (no `minSeq` provided).
   * Always `true` on a successful return — the catchup throws on timeout.
   */
  caughtUp: boolean;
}

/**
 * Minimum surface that `ironflow.agents.{invoke, subscribe, readMemory}`
 * need from the client. Defining it as an interface lets the helpers be
 * unit-tested with a mock client and keeps the public client surface
 * tight.
 */
export interface AgentClientLike {
  invoke<T = unknown>(
    functionId: string,
    options: { data: T; idempotencyKey?: string }
  ): Promise<InvokeResult>;

  subscribe<T = unknown>(
    pattern: string | string[],
    callbacks: SubscriptionCallbacks<T> & { replay?: number; includeMetadata?: boolean }
  ): Promise<Subscription | { unsubscribe(): void }>;

  cancelRun(runId: string, reason?: string): Promise<Run>;

  getProjection<TState = unknown>(
    name: string,
    options?: { partition?: string }
  ): Promise<ProjectionStateResult<TState>>;

  waitForProjectionCatchup(
    name: string,
    opts: { minSeq: number | bigint; timeoutMs?: number; partition?: string }
  ): Promise<WaitResult>;
}
