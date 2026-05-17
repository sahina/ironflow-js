/**
 * Ironflow SDK Core Type Definitions
 *
 * This module contains all shared TypeScript interfaces, branded types,
 * and type utilities used across @ironflow/browser and @ironflow/node packages.
 */

import type { z } from "zod";

// ============================================================================
// Event Source Constants
// ============================================================================

/**
 * Event source constants - identifies how an event was triggered
 */
export const EventSource = {
  /** Events triggered via REST/gRPC API */
  API: "api",
  /** Events triggered by cron scheduler */
  CRON: "cron",
  /** Events from external webhooks */
  WEBHOOK: "webhook",
} as const;

/**
 * Event source type
 */
export type EventSourceType = (typeof EventSource)[keyof typeof EventSource];

// ============================================================================
// Branded Types for Type-Safe IDs
// ============================================================================

/**
 * Brand symbol for creating nominal types
 */
declare const Brand: unique symbol;

/**
 * Branded type helper - creates nominal types from primitives
 */
export type Branded<T, B> = T & { readonly [Brand]: B };

/** Unique identifier for a run */
export type RunId = Branded<string, "RunId">;

/** Unique identifier for a function */
export type FunctionId = Branded<string, "FunctionId">;

/** Unique identifier for a step */
export type StepId = Branded<string, "StepId">;

/** Unique identifier for an event */
export type EventId = Branded<string, "EventId">;

/** Unique identifier for a job */
export type JobId = Branded<string, "JobId">;

/** Unique identifier for a worker */
export type WorkerId = Branded<string, "WorkerId">;

/** Unique identifier for a subscription */
export type SubscriptionId = Branded<string, "SubscriptionId">;

/**
 * Create a branded RunId from a raw string
 */
export function createRunId(id: string): RunId {
  return id as RunId;
}

/**
 * Create a branded FunctionId from a raw string
 */
export function createFunctionId(id: string): FunctionId {
  return id as FunctionId;
}

/**
 * Create a branded StepId from a raw string
 */
export function createStepId(id: string): StepId {
  return id as StepId;
}

/**
 * Create a branded EventId from a raw string
 */
export function createEventId(id: string): EventId {
  return id as EventId;
}

/**
 * Create a branded JobId from a raw string
 */
export function createJobId(id: string): JobId {
  return id as JobId;
}

/**
 * Create a branded WorkerId from a raw string
 */
export function createWorkerId(id: string): WorkerId {
  return id as WorkerId;
}

/**
 * Create a branded SubscriptionId from a raw string
 */
export function createSubscriptionId(id: string): SubscriptionId {
  return id as SubscriptionId;
}

// ============================================================================
// Function Configuration
// ============================================================================

/**
 * Configuration for a workflow function
 */
export interface FunctionConfig<TEventSchema extends z.ZodType = z.ZodType> {
  /** Unique function identifier */
  id: string;
  /** Display name for the function */
  name?: string;
  /** Human-readable description shown in the dashboard */
  description?: string;
  /** Event triggers that invoke this function */
  triggers: Trigger[];
  /** Retry configuration for failed steps */
  retry?: RetryConfig;
  /** Function timeout in milliseconds (default: 600000 = 10 minutes) */
  timeout?: number;
  /** Concurrency control configuration */
  concurrency?: ConcurrencyConfig;
  /** Execution mode: "push" for serverless, "pull" for workers */
  mode?: ExecutionMode;
  /** JSON path for actor-based sticky routing */
  actorKey?: string;
  /** Zod schema for type-safe event validation */
  schema?: TEventSchema;
  /** Secret names this function requires (resolved by engine at execution time) */
  secrets?: string[];
  /** Default timeout for all step.run() calls ("30s", "5m", "1h") */
  stepTimeout?: string;
  /** Enable audit recording for this function */
  recording?: boolean;
  /** Retention period for audit events ("7d", "30d", "90d", "forever") */
  recordingRetention?: string;
  /** Pause behavior for scoped injection ("hold" or "release") */
  pauseBehavior?: PauseBehavior;
  /** Custom metadata (e.g., service, team, owner) */
  metadata?: Record<string, unknown>;
  /** Debounce configuration — collapse rapid-fire events into a single invocation */
  debounce?: DebounceConfig;
  /**
   * Run registered `step.compensate()` handlers in reverse order when a
   * pull-mode run is cancelled mid-saga. Ignored for push-mode functions —
   * compensation closures only exist in a live SDK process, so push mode
   * has no point of re-entry after the cancel signal arrives. Issue #546 P2.
   */
  compensateOnCancel?: boolean;
  /**
   * Cancel-on-event specs. When any spec matches an incoming event whose
   * match-path value equals the corresponding field on the running run,
   * the run is auto-cancelled with cause "cancel-on-event". OR semantic
   * across multiple specs. Issue #546 P3 / #572.
   */
  cancelOn?: CancelOnConfig[];
}

/**
 * Options for step.run() execution
 */
export interface StepRunOptions {
  /** Timeout for this step ("30s", "5m", "1h"). Overrides function-level stepTimeout. */
  timeout?: string;
}

/**
 * Event trigger configuration
 */
export interface Trigger {
  /** Event name pattern to match (e.g., "order.placed") */
  event: string;
  /** Optional CEL expression for filtering */
  expression?: string;
  /** Cron schedule expression (e.g., "0 9 * * *" for 9am daily) */
  cron?: string;
}

/**
 * Retry configuration for step failures
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms (default: 1000) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2.0) */
  backoffFactor?: number;
  /** Maximum delay between retries in ms (default: 300000) */
  maxDelayMs?: number;
}

/**
 * Concurrency control configuration
 */
export interface ConcurrencyConfig {
  /** Maximum concurrent executions */
  limit: number;
  /** JSON path for grouping (e.g., "event.data.customerId") */
  key?: string;
}

/**
 * Debounce configuration — collapses rapid-fire events into a single
 * invocation after a quiet period. The first event in a window arms a
 * timer; subsequent events in the same window (same key) reset it. When
 * the quiet period elapses with no new events, the handler fires once
 * with the most recent event payload.
 *
 * Use cases: webhook storms, search-as-you-type, noisy IoT sensors.
 *
 * Debounce is async-only. Calling TriggerSync on a debounced function
 * returns FailedPrecondition — the synchronous caller cannot wait
 * indefinitely for a window to expire.
 */
export interface DebounceConfig {
  /** Quiet period in milliseconds. Floor: 1000 (1 second). */
  periodMs: number;
  /**
   * JSON path for per-key debouncing (e.g., "userId", "data.customerId").
   * Same extraction rules as ConcurrencyConfig.key. When omitted, all
   * events for the function share a single debounce lane (global key).
   */
  key?: string;
  /**
   * Starvation cap in milliseconds. The handler fires at least once
   * every maxWaitMs even if quiet-period resets never stop arriving —
   * useful for search-as-you-type or IoT streams that may never go
   * quiet. When set, must be >= periodMs. Omit for no cap. Issue #551.
   */
  maxWaitMs?: number;
}

/**
 * Cancel-on-event spec — auto-cancel a running workflow when a matching
 * event arrives. Issue #546 P3 / #572.
 */
export interface CancelOnConfig {
  /** Event name to match (e.g., "order.cancelled"). */
  event: string;
  /**
   * JSON-path expression that must equal the running run's corresponding
   * field. Same extraction rules as ConcurrencyConfig.key. See
   * internal/eventpath for path syntax.
   */
  match: string;
}

/**
 * Execution mode for the function
 */
export type ExecutionMode = "push" | "pull";

/**
 * Pause behavior when a function is configured for scoped injection.
 * - "hold": Hold the run in paused state until explicitly resumed (default).
 * - "release": Automatically resume the run after injection.
 */
export type PauseBehavior = "hold" | "release";

// ============================================================================
// Secrets Client
// ============================================================================

/** Read-only secrets accessor provided to function handlers. */
export interface SecretsClient {
  /** Get a secret value by name. Throws if not found. */
  get(name: string): string;
  /** Check if a secret exists. */
  has(name: string): boolean;
}

// ============================================================================
// Function Context
// ============================================================================

/**
 * Context passed to function handlers
 */
export interface FunctionContext<TEvent = unknown> {
  /** The triggering event */
  event: IronflowEvent<TEvent>;
  /** Step execution client */
  step: StepClient;
  /** Run information */
  run: RunInfo;
  /** Logger instance */
  logger: Logger;
  /** Resolved environment secrets (read-only) */
  secrets: SecretsClient;
}

/**
 * An Ironflow event
 */
export interface IronflowEvent<T = unknown> {
  /** Unique event ID */
  id: string;
  /** Event name (e.g., "order.placed") */
  name: string;
  /** Event schema version */
  version: number;
  /** Event payload data */
  data: T;
  /** Event timestamp */
  timestamp: Date;
  /** Optional idempotency key for deduplication */
  idempotencyKey?: string;
  /** Event source (e.g., "webhook", "sdk", "api") */
  source?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Information about the current run
 */
export interface RunInfo {
  /** Unique run ID */
  id: string;
  /** Function ID being executed */
  functionId: string;
  /** Current attempt number */
  attempt: number;
  /** When the run started */
  startedAt: Date;
}

/**
 * Simple logger interface
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Step Client
// ============================================================================

/**
 * Client for executing durable steps
 */
export interface StepClient {
  /**
   * Execute a step with memoization.
   *
   * WHY: Use step.run() for any non-idempotent operation (e.g., sending an email,
   * charging a card, calling an external API). Ironflow memoizes the result
   * of the first successful execution. If the workflow retries, this step will
   * be skipped and the previously stored result will be returned.
   *
   * @param name Unique step name within the function
   * @param fn Step function to execute
   * @returns The step result (memoized on retry)
   */
  run<T>(name: string, fn: () => Promise<T>, options?: StepRunOptions): Promise<T>;

  /**
   * Sleep for a duration (durable).
   *
   * WHY: Use step.sleep() for long-running pauses (minutes, hours, or days).
   * Unlike setTimeout, this is durable—the worker can restart or the server
   * can be upgraded, and the workflow will resume exactly where it left off
   * once the duration has elapsed.
   *
   * @param name Unique step name within the function
   * @param duration Duration to sleep ("1h", "30m", "7d" or ms)
   */
  sleep(name: string, duration: Duration): Promise<void>;

  /**
   * Sleep until a specific time (durable).
   *
   * @param name Unique step name within the function
   * @param until Target wake time (Date object or ISO 8601 string)
   */
  sleepUntil(name: string, until: Date | string): Promise<void>;

  /**
   * Wait for an external event (durable).
   *
   * WHY: Use step.waitForEvent() to implement choreography-based orchestration.
   * The workflow pauses durably until an external event arrives that matches
   * the provided filter. This is the primary way to handle human-in-the-loop
   * or asynchronous external callbacks.
   *
   * @param name Unique step name within the function
   * @param filter Event filter configuration
   * @returns The matching event
   */
  waitForEvent<T = unknown>(
    name: string,
    filter: EventFilter
  ): Promise<IronflowEvent<T>>;

  /**
   * Execute multiple branches in parallel (allSettled mode)
   */
  parallel<T extends unknown[]>(
    name: string,
    branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
    options: ParallelOptions & { onError: "allSettled" }
  ): Promise<{ [K in keyof T]: T[K] | Error }>;

  /**
   * Execute multiple branches in parallel
   */
  parallel<T extends unknown[]>(
    name: string,
    branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
    options?: ParallelOptions
  ): Promise<T>;

  /**
   * Map over a collection executing steps in parallel (allSettled mode)
   */
  map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, step: StepClient, index: number) => Promise<R>,
    options: ParallelOptions & { onError: "allSettled" }
  ): Promise<(R | Error)[]>;

  /**
   * Map over a collection executing steps in parallel
   */
  map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, step: StepClient, index: number) => Promise<R>,
    options?: ParallelOptions
  ): Promise<R[]>;

  /**
   * Register a compensation handler for a previously completed step.
   *
   * WHY: Use step.compensate() to implement the Saga pattern. If a workflow fails later,
   * Ironflow automatically executes all registered compensations in reverse order.
   * This ensures that previous side effects (e.g., a payment) are rolled back
   * (e.g., a refund) when a subsequent step (e.g., shipping) fails.
   *
   * @param stepName Name of the step to compensate (must have been run already)
   * @param fn Compensation function to execute on failure
   */
  compensate(stepName: string, fn: () => Promise<void>): void;

  /**
   * Call another Ironflow function and wait for its result (durable).
   * Target function must have no event triggers.
   * @param functionId ID of the function to invoke
   * @param input Data to pass to the function (becomes event.data)
   * @param options Optional configuration (timeout override)
   */
  invoke<T = unknown>(
    functionId: string,
    input?: unknown,
    options?: { timeout?: string }
  ): Promise<T>;

  /**
   * Call another Ironflow function without waiting for the result (fire-and-forget).
   * Returns the child run ID immediately.
   * @param functionId ID of the function to invoke
   * @param input Data to pass to the function
   */
  invokeAsync(
    functionId: string,
    input?: unknown
  ): Promise<{ runId: string }>;

  /**
   * Publish a message to a developer pub/sub topic. Durable — memoized and retried.
   * Unlike emit(), this does NOT trigger workflow functions.
   *
   * @param topic Topic name to publish to
   * @param data Message payload
   * @returns The publish result with eventId and sequence number
   */
  publish(topic: string, data: unknown): Promise<PublishResult>;
}

/**
 * Options for parallel step execution
 */
export interface ParallelOptions {
  /**
   * Maximum concurrent branches (default: unlimited)
   */
  concurrency?: number;
  /**
   * Error handling mode (default: "failFast")
   * - "failFast": First failure cancels pending branches and throws immediately
   * - "allSettled": All branches complete, errors collected in results
   */
  onError?: "failFast" | "allSettled";
}

/**
 * Duration specification: string like "1h", "30m", "7d" or milliseconds
 */
export type Duration = string | number;

/**
 * Event filter for waitForEvent
 */
export interface EventFilter {
  /** Event name to wait for */
  event: string;
  /** JSON path for matching (e.g., "data.orderId") */
  match?: string;
  /** Timeout duration (default: "7d") */
  timeout?: Duration;
}

// ============================================================================
// Function Definition
// ============================================================================

/**
 * A defined Ironflow function
 */
export interface IronflowFunction<TEvent = unknown, TResult = unknown> {
  /** Function configuration */
  config: FunctionConfig;
  /** Function handler */
  handler: FunctionHandler<TEvent, TResult>;
}

/**
 * Erased generic alias for arrays/registries holding functions of mixed
 * narrow event/result types. Use in container positions (e.g. ServeConfig
 * .functions) where TS array invariance otherwise rejects narrow subtypes.
 */
export type AnyIronflowFunction = IronflowFunction<any, any>;

/**
 * Function handler type
 */
export type FunctionHandler<TEvent = unknown, TResult = unknown> = (
  ctx: FunctionContext<TEvent>
) => Promise<TResult>;

// ============================================================================
// Run Status
// ============================================================================

/**
 * Run status
 */
export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

/**
 * Run details
 */
export interface Run {
  id: string;
  functionId: string;
  eventId: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  input?: unknown;
  output?: unknown;
  error?: {
    message: string;
    code?: string;
  };
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List runs options
 */
export interface ListRunsOptions {
  /** Filter by function ID */
  functionId?: string;
  /** Filter by status */
  status?: RunStatus;
  /** Maximum results */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

/**
 * List runs result
 */
export interface ListRunsResult {
  runs: Run[];
  nextCursor?: string;
  totalCount: number;
}

// ============================================================================
// Invoke Types
// ============================================================================

/**
 * Invoke response (returned from browser client invoke())
 */
export interface InvokeResult {
  /** IDs of created runs */
  runIds: string[];
  /** ID of the stored event */
  eventId: string;
}

/**
 * @deprecated Use InvokeResult instead.
 */
export type TriggerResult = InvokeResult;

/**
 * Sync trigger options
 */
export interface TriggerSyncOptions {
  /** Maximum wait time in ms (default: 30000) */
  timeout?: number;
}

/**
 * Sync trigger result
 */
export interface TriggerSyncResult {
  /** Run ID */
  runId: string;
  /** Function ID */
  functionId: string;
  /** Run status */
  status: RunStatus;
  /** Function output */
  output?: unknown;
  /** Error if failed */
  error?: {
    message: string;
    code?: string;
  };
  /** Duration in ms */
  durationMs: number;
}

/**
 * Result of an emitSync() call
 */
export interface EmitSyncResult {
  /** Run ID */
  runId: string;
  /** Function ID */
  functionId: string;
  /** Run status */
  status: string;
  /** Function output */
  output: unknown;
  /** Duration in ms */
  durationMs: number;
}

// ============================================================================
// Emit/Event Types
// ============================================================================

/**
 * Options for emitting events
 */
export interface EmitOptions {
  /** Event schema version (default 1) */
  version?: number;
  /** Optional deduplication key */
  idempotencyKey?: string;
  /** Optional metadata (headers, etc.) */
  metadata?: Record<string, unknown>;
  /** Namespace (default: "default") */
  namespace?: string;
}

/**
 * Result of emitting an event
 */
export interface EmitResult {
  /** IDs of runs created by this event */
  runIds: string[];
  /** ID of the stored event */
  eventId: string;
}

// ============================================================================
// Subscription Types (Pub/Sub)
// ============================================================================

/**
 * Acknowledgment mode for consumer groups
 */
export type AckMode = "auto" | "manual";

/**
 * Backpressure handling mode
 */
export type BackpressureMode = "drop" | "block" | "buffer";

/**
 * Acknowledgment type
 */
export type AckType = "ack" | "nak" | "term";

/**
 * Options for creating a subscription
 */
export interface SubscribeOptions {
  /** Number of historical events to replay (0 = no replay) */
  replay?: number;
  /** Include event metadata (timestamp, sequence) */
  includeMetadata?: boolean;
  /** CEL expression for content-based filtering */
  filter?: string;
  /** Namespace for the subscription (default: "default") */
  namespace?: string;
  /** Consumer group to join for load-balanced delivery */
  consumerGroup?: string;
  /** Acknowledgment mode for consumer group (default: "auto") */
  ackMode?: AckMode;
  /** Backpressure handling mode (default: "buffer") */
  backpressure?: BackpressureMode;
}

/**
 * Buffer configuration for subscriptions
 */
export interface BufferConfig {
  /** Maximum buffer size */
  size: number;
  /** Strategy when buffer is full */
  strategy: "drop-oldest" | "drop-newest" | "block";
}

/**
 * Event received from a subscription
 */
export interface SubscriptionEvent<T = unknown> {
  /** The event topic (e.g., "system.run.abc123.updated") */
  topic: string;
  /** Event payload data */
  data: T;
  /** Event metadata (if includeMetadata was true) */
  meta?: EventMetadata;
  /** Event ID (for consumer group ack/nak/term) */
  eventId?: string;
}

/**
 * Event metadata from the subscription
 */
export interface EventMetadata {
  /** Event timestamp in ISO 8601 format */
  timestamp: string;
  /** Event sequence number within the stream */
  sequence?: number;
}

/**
 * Subscription error information
 */
export interface SubscriptionErrorInfo {
  /** The subscription ID that had an error */
  subscriptionId?: string;
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether the system is automatically retrying */
  retrying?: boolean;
}

/**
 * Connection state for subscriptions
 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

/**
 * Callbacks for subscription events
 */
export interface SubscriptionCallbacks<T = unknown> {
  /** Called when an event is received */
  onEvent?: (event: SubscriptionEvent<T>) => void;
  /** Called when a subscription error occurs */
  onError?: (error: SubscriptionErrorInfo) => void;
  /** Called when the connection state changes */
  onStateChange?: (state: ConnectionState) => void;
}

/**
 * An active subscription that can be unsubscribed
 */
export interface Subscription {
  /** The subscription ID */
  id: string;
  /** The pattern this subscription is for */
  pattern: string;
  /** Connection state */
  connectionState: ConnectionState;
  /** Most recent event (if trackState enabled) */
  lastEvent?: SubscriptionEvent<unknown>;
  /** Unsubscribe from this subscription */
  unsubscribe(): void;
}

/**
 * Acknowledgment handle for manual ack mode
 */
export interface AckHandle {
  /** Acknowledge successful processing */
  ack(): void;
  /** Negative acknowledge - request redelivery */
  nak(): void;
}

/**
 * An ackable subscription that supports manual acknowledgments
 */
export interface AckableSubscription extends Subscription {
  /** Acknowledge successful processing of an event */
  ack(eventId: string): Promise<void>;
  /** Negative acknowledge - request redelivery */
  nak(eventId: string, delay?: number): Promise<void>;
  /** Terminate - permanent failure, do not redeliver */
  term(eventId: string): Promise<void>;
}

// ============================================================================
// Consumer Group Types
// ============================================================================

/**
 * Consumer group status
 */
export type ConsumerGroupStatus = "active" | "paused" | "deleted";

/**
 * Configuration for creating a consumer group
 */
export interface ConsumerGroupConfig {
  /** Unique name within namespace */
  name: string;
  /** Event pattern to subscribe to */
  pattern: string;
  /** Namespace (default: "default") */
  namespace?: string;
  /** Optional CEL filter expression */
  filterExpr?: string;
  /** Acknowledgment mode (default: "auto") */
  ackMode?: AckMode;
  /** Backpressure handling (default: "buffer") */
  backpressure?: BackpressureMode;
  /** Max unacknowledged messages per consumer (default: 100) */
  maxInflight?: number;
  /** Max redelivery attempts (default: 3) */
  maxRedeliveries?: number;
  /** Delay between redeliveries in ms (default: 5000) */
  redeliverDelayMs?: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Consumer group information
 */
export interface ConsumerGroup {
  /** Consumer group ID */
  id: string;
  /** Namespace */
  namespace: string;
  /** Human-readable name */
  name: string;
  /** Event pattern */
  pattern: string;
  /** CEL filter expression */
  filterExpr?: string;
  /** Acknowledgment mode */
  ackMode: AckMode;
  /** Backpressure handling */
  backpressure: BackpressureMode;
  /** Max unacknowledged messages per consumer */
  maxInflight: number;
  /** Max redelivery attempts */
  maxRedeliveries: number;
  /** Delay between redeliveries in ms */
  redeliverDelayMs: number;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Current status */
  status: ConsumerGroupStatus;
  /** Number of active members */
  memberCount: number;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

// ============================================================================
// Entity Stream Types
// ============================================================================

/**
 * Input for appending an event to an entity stream
 */
export interface AppendEventInput {
  /** Event name (e.g., "order.created") */
  name: string;
  /** Event payload data */
  data: Record<string, unknown>;
  /** Entity type (e.g., "order", "user") */
  entityType: string;
}

/**
 * Options for appending an event to an entity stream
 */
export interface AppendOptions {
  /** Expected entity version for optimistic concurrency control (-1 to skip) */
  expectedVersion?: number;
  /** Idempotency key to prevent duplicate appends */
  idempotencyKey?: string;
  /** Event schema version (default: 1) */
  version?: number;
  /**
   * Cross-cutting metadata (causation, correlation, tenant, trace) to attach
   * to the event. Persisted alongside the event and delivered to push-mode
   * handlers, pull-mode workers, and projection reducers.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Result from appending an event to an entity stream
 */
export interface AppendResult {
  /** Updated entity version after the append */
  entityVersion: number;
  /** ID of the appended event */
  eventId: string;
  /**
   * NATS JetStream sequence of this event on the PUBSUB stream
   * (the `events:` namespace projections consume). Pass to
   * `projections.waitForCatchup({ minSeq })` for read-your-writes.
   * 0 means publish failed or unavailable. Issue #473.
   */
  sequence?: number;
}

/**
 * Options for reading events from an entity stream
 */
export interface ReadStreamOptions {
  /** Start reading from this version (inclusive, default: 0) */
  fromVersion?: number;
  /** Maximum number of events to return (0 = all) */
  limit?: number;
  /** Read direction (default: "forward") */
  direction?: "forward" | "backward";
}

/**
 * An event from an entity stream
 */
export interface StreamEvent {
  /** Unique event ID */
  id: string;
  /** Event name */
  name: string;
  /** Event payload data */
  data: Record<string, unknown>;
  /** Entity version at which this event was recorded */
  entityVersion: number;
  /** Event schema version */
  version: number;
  /** Event timestamp in ISO 8601 format */
  timestamp: string;
  /** Event source */
  source?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Information about an entity stream
 */
export interface StreamInfo {
  /** Entity ID */
  entityId: string;
  /** Entity type */
  entityType: string;
  /** Current entity version */
  version: number;
  /** Total number of events in the stream */
  eventCount: number;
  /** When the stream was created */
  createdAt: string;
  /** When the stream was last updated */
  updatedAt: string;
}

/**
 * A snapshot of the materialized state at a specific entity stream version.
 * Used to speed up state reconstruction by avoiding replaying all events from the beginning.
 */
export interface StreamSnapshot {
  /** Snapshot ID */
  snapshotId: string;
  /** Entity ID */
  entityId: string;
  /** Entity type */
  entityType: string;
  /** The entity version this snapshot represents */
  entityVersion: number;
  /** Materialized state at this version */
  state: Record<string, unknown>;
  /** When the snapshot was created */
  createdAt: string;
}

/**
 * Options for subscribing to an entity's event stream
 */
export interface EntitySubscribeOptions {
  /** Entity type (e.g., "order") — required to construct NATS subject pattern */
  entityType: string;
  /** Callback invoked for each event */
  onEvent: (event: StreamEvent) => void;
  /** Callback invoked on subscription errors */
  onError?: (error: Error) => void;
  /** Number of historical events to replay from NATS stream (0 = live only) */
  replay?: number;
}

// ============================================================================
// Webhook Types
// ============================================================================

/** Raw webhook HTTP request data */
export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

/** Transformed webhook event to emit */
export interface WebhookEvent {
  name: string;
  data: unknown;
  idempotencyKey?: string;
}

/** Configuration for a webhook source */
export interface WebhookConfig {
  id: string;
  verify: (req: WebhookRequest) => unknown | Promise<unknown>;
  transform: (payload: unknown) => WebhookEvent | Promise<WebhookEvent>;
}

/** A webhook source definition */
export interface IronflowWebhook {
  config: WebhookConfig;
}

// ============================================================================
// Developer Pub/Sub Types
// ============================================================================

/** Options for publishing to a developer pub/sub topic. */
export interface PublishOptions {
  /** Idempotency key for deduplication. */
  idempotencyKey?: string;
}

/** Result of a publish operation. */
export interface PublishResult {
  /** Unique ID for this published message. */
  eventId: string;
  /** JetStream sequence number. */
  sequence: number;
}

/** Information about a developer pub/sub topic. */
export interface TopicInfo {
  /** Topic name. */
  name: string;
  /** Number of messages in the topic. */
  messageCount: number;
  /** Number of active consumers. */
  consumerCount: number;
  /** Timestamp of first message. */
  firstMessageAt?: string;
  /** Timestamp of last message. */
  lastMessageAt?: string;
}

/** Detailed statistics for a topic. */
export interface TopicStats {
  /** Topic name. */
  name: string;
  /** Number of messages. */
  messageCount: number;
  /** Number of active consumers. */
  consumerCount: number;
  /** Consumer lag (messages pending delivery). */
  lag: number;
  /** First sequence number. */
  firstSeq: number;
  /** Last sequence number. */
  lastSeq: number;
}

// ============================================================================
// Paused State (Scoped Injection)
// ============================================================================

/**
 * Information about a completed step in a paused run
 */
export interface PausedStepInfo {
  /** Step ID */
  id: string;
  /** Step name */
  name: string;
  /** Step output */
  output: unknown;
  /** Whether this step's output was injected */
  injected: boolean;
  /** When the step completed (ISO 8601) */
  completedAt: string;
}

/**
 * State of a paused run, including completed steps and next step hint
 */
export interface PausedState {
  /** Completed steps in this run */
  steps: PausedStepInfo[];
  /** Hint for the next step that will execute on resume */
  nextStepHint: string;
  /** Reason the run was paused */
  pauseReason: string;
}

// ============================================================================
// Time-Travel Debugging Types
// ============================================================================

/**
 * A step's state at a point in time.
 */
export interface TimeTravelStepSnapshot {
  stepId: string;
  name: string;
  type: string;
  sequence: number;
  status: string;
  output: unknown;
  error: unknown;
  originalOutput: unknown | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  injected: boolean;
  patched: boolean;
}

/**
 * The reconstructed state of a run at a point in time.
 */
export interface TimeTravelRunStateSnapshot {
  runId: string;
  functionId: string;
  status: string;
  input: unknown;
  steps: TimeTravelStepSnapshot[];
  timestamp: Date;
  createdAt: Date | null;
}

/**
 * An event in the run's timeline.
 */
export interface TimeTravelTimelineEvent {
  id: string;
  eventType: string;
  stepId: string;
  stepName: string;
  summary: string;
  significant: boolean;
  timestamp: Date;
}

/**
 * A step's output at a point in time.
 */
export interface TimeTravelStepOutputSnapshot {
  stepId: string;
  status: string;
  output: unknown;
  originalOutput: unknown | null;
  patched: boolean;
  injected: boolean;
}

// ============================================================================
// Projection Management Types
// ============================================================================

// `ProjectionState` (a lossy flat shape that lied about the runtime envelope)
// was removed in v0.20.0. Use `ProjectionStateResult<TState>` from
// `@ironflow/core/projection-types` instead. See CHANGELOG and issue #610.

/**
 * Operational status information for a projection.
 */
export interface ProjectionStatusInfo {
  name: string;
  status: string;
  eventCount: number;
  lastEventAt: string;
  errorCount: number;
  lastError: string;
  consumerName: string;
}

/**
 * Status of an in-progress or completed projection rebuild job.
 */
export interface RebuildJob {
  name: string;
  status: string;
  progress: number;
  startedAt: string;
}

/**
 * Reconstructed run state returned by the time-travel API.
 */
export interface TimeTravelRunState {
  runId: string;
  status: string;
  steps: Array<{ id: string; name: string; status: string; output: unknown }>;
  timestamp: string;
}

/**
 * A single step output snapshot returned by the time-travel API.
 */
export interface TimeTravelStepOutput {
  stepId: string;
  output: unknown;
  timestamp: string;
}

/**
 * A single entry in the audit trail.
 */
export interface AuditTrailEntry {
  id: string;
  type: string;
  timestamp: string;
  data: unknown;
}

// ============================================================================
// Server Capabilities
// ============================================================================

/**
 * Server capabilities returned by the capabilities endpoint
 */
export interface ServerCapabilities {
  /** Supported transports */
  transports: string[];
  /** Supported features */
  features: string[];
  /** Server version */
  version: string;
}

// ============================================================================
// Audit Types
// ============================================================================

/**
 * An audit event from the dedicated audit stream.
 */
export interface AuditEvent {
  id: string;
  runId: string;
  functionId: string;
  stepId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, string>;
  createdAt: string;
}

/**
 * Options for querying the audit trail.
 */
export interface GetAuditTrailOptions {
  eventType?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Result of an audit trail query.
 */
export interface AuditTrailResult {
  events: AuditEvent[];
  totalCount: number;
  nextCursor?: string;
}

// ============================================================================
// Secrets Management Types
// ============================================================================

/**
 * A secret with its value (returned on get/set/update).
 */
export interface Secret {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/**
 * A secret list entry (no value, returned on list).
 */
export interface SecretListEntry {
  name: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Entity Stream Extension Types
// ============================================================================

/**
 * A summary entry for an entity stream (returned by listStreams).
 */
export interface StreamListEntry {
  entityId: string;
  entityType: string;
  version: number;
  eventCount: number;
  lastEventAt: string;
}

/**
 * A single event in an entity's history (returned by getEntityHistory).
 */
export interface EntityHistoryEntry {
  eventName: string;
  data: unknown;
  version: number;
  timestamp: string;
}

// ============================================================================
// Project / Environment Types
// ============================================================================

/**
 * An Ironflow project (groups related environments).
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  org_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * An Ironflow environment (scopes resources within a project).
 */
export interface Environment {
  id: string;
  name: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Event Schema Registry Types
// ============================================================================

/**
 * A registered event schema with version information.
 */
export interface EventSchema {
  /** The event name (server field: event_name) */
  event_name: string;
  version: number;
  schema: Record<string, unknown>;
  created_at: string;
}

/**
 * Input for registering an event schema.
 */
export interface RegisterSchemaInput {
  name: string;
  version: number;
  schema: Record<string, unknown>;
}

/**
 * Input for testing an upcast transformation.
 */
export interface TestUpcastInput {
  eventName: string;
  fromVersion: number;
  toVersion: number;
  data: unknown;
}

/**
 * Result of a test upcast transformation.
 */
export interface UpcastResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ============================================================================
// Webhook Management Types
// ============================================================================

/**
 * A registered webhook source.
 */
export interface WebhookSource {
  id: string;
  eventPrefix: string;
  verifyHeader?: string;
  verifyAlgorithm?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Input for creating a webhook source.
 */
export interface CreateWebhookSourceInput {
  id: string;
  eventPrefix: string;
  verifyHeader?: string;
  verifyAlgorithm?: string;
  verifySecret?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A single webhook delivery record.
 */
export interface WebhookDelivery {
  id: string;
  sourceId: string;
  externalId?: string;
  status: string;
  eventId?: string;
  error?: string;
  createdAt?: string;
}

/**
 * Options for listing webhook deliveries.
 */
export interface ListWebhookDeliveriesOptions {
  sourceId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// User Management Types
// ============================================================================

/**
 * A dashboard user account.
 */
export interface User {
  id: string;
  orgId: string;
  email: string;
  name?: string;
  roles?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Input for creating a new user.
 */
export interface CreateUserInput {
  email: string;
  name?: string;
  password: string;
  roles?: string[];
}

/**
 * Input for updating a user.
 */
export interface UpdateUserInput {
  name?: string;
  email?: string;
  roles?: string[];
}

// ============================================================================
// Tenant Management Types
// ============================================================================

/**
 * A tenant (organization) in the platform.
 */
export interface Tenant {
  id: string;
  name: string;
  envCount: number;
  keyCount: number;
  createdAt?: string;
}

/**
 * Result of waitForCatchup, waitForCatchupBatch, or waitForEvent (#473).
 * On success exactly one of `caughtUp` or `timedOut` is true; errors
 * surface as thrown exceptions on the client.
 */
export interface WaitResult {
  caughtUp: boolean;
  timedOut: boolean;
  /** Cursor at the moment of response. */
  currentSeq: number;
  /** The minSeq the client was waiting for. */
  targetSeq: number;
  /** targetSeq - currentSeq. 0 when caught up. */
  behindByEvents: number;
  /** Reserved — always false in PR1. */
  rebuilding?: boolean;
  /** "managed" or "external" (informational). */
  mode?: string;
}

/**
 * One frame from waitForProjectionCatchupStream (#476). Non-terminal
 * frames report progress as the projection cursor advances toward the
 * target sequence. The terminal frame (`terminal: true`) is emitted
 * exactly once with either `caughtUp`, `timedOut`, or `error` set.
 * Heartbeat frames are filtered inside the SDK and do not surface here.
 *
 * Sequence fields are typed `bigint` because the server values are
 * uint64 and JS `number` loses precision above 2^53-1. For small seqs
 * you can always widen with `Number(p.currentSeq)`; for comparisons
 * stay in bigint (e.g., `p.currentSeq >= targetSeq`).
 */
export interface WaitProgress {
  /** Cursor at the moment of the frame. */
  currentSeq: bigint;
  /** The minSeq the client is waiting for. */
  targetSeq: bigint;
  /** targetSeq - currentSeq. 0n when caught up. */
  behindByEvents: bigint;
  /** True on the terminal frame; false for in-flight progress. */
  terminal: boolean;
  /** Terminal success marker. Only meaningful when `terminal` is true. */
  caughtUp: boolean;
  /** Terminal timeout marker. Only meaningful when `terminal` is true. */
  timedOut: boolean;
  /** Terminal error message (empty on success). Only meaningful when `terminal` is true. */
  error?: string;
  /** "managed" or "external" (informational). */
  mode?: string;
}
