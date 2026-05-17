# @ironflow/core

Shared types, Zod schemas, error classes, constants, and utilities for the Ironflow JavaScript SDK. This package is the foundation that both `@ironflow/browser` and `@ironflow/node` depend on. It contains zero platform-specific code and runs in any JavaScript environment.

- Source: `sdk/js/core/src/`
- Entry point: `@ironflow/core` (re-exports everything from `index.ts`)
- Sub-path exports: `@ironflow/core/schemas`, `@ironflow/core/protocol`, `@ironflow/core/gen`
- Runtime dependency: `zod` (v4+)
- Optional dependencies: `@bufbuild/protobuf`, `@connectrpc/connect` (only for `/gen` sub-path)
- License: `LicenseRef-Ironflow-EULA` (see [LICENSE](https://github.com/sahina/ironflow-js/blob/main/LICENSE))

Docs: <https://docs.ironflow.run>

---

## Table of Contents

1. [Installation](#installation)
2. [Branded Types](#branded-types)
3. [Function Types](#function-types)
4. [Event Types](#event-types)
5. [Step Types](#step-types)
6. [Run Types](#run-types)
7. [Subscription Types](#subscription-types)
8. [Entity Stream Types](#entity-stream-types)
9. [Pub/Sub Types](#pubsub-types)
10. [KV Types](#kv-types)
11. [Config Types](#config-types)
12. [Auth Types](#auth-types)
13. [Audit Types](#audit-types)
14. [Webhook Types](#webhook-types)
15. [Projection Types](#projection-types)
16. [Error Classes](#error-classes)
17. [Schemas](#schemas)
18. [Protocol Types](#protocol-types)
19. [Constants](#constants)
20. [Utilities](#utilities)
21. [Upcasters](#upcasters)
22. [Logger](#logger)
23. [SecretsClient](#secretsclient)
24. [Paused State Types](#paused-state-types)
25. [Time-Travel Debugging Types](#time-travel-debugging-types)
26. [Server Capabilities](#server-capabilities)
27. [Secrets Management Types](#secrets-management-types)
28. [Entity Stream Extension Types](#entity-stream-extension-types)
29. [Project / Environment Types](#project--environment-types)
30. [Event Schema Registry Types](#event-schema-registry-types)
31. [Webhook Management Types](#webhook-management-types)
32. [User and Tenant Types](#user-and-tenant-types)
33. [AuditTrailEntry](#audittrailentry)
34. [Convenience Aliases](#convenience-aliases)
35. [Sub-Path Exports](#sub-path-exports)

---

## Installation

```bash
npm install @ironflow/core
```

Most users do not install this package directly. It is included as a dependency of `@ironflow/browser` (browser client, subscriptions) and `@ironflow/node` (worker, serve, projections), both of which re-export core types.

---

## Branded Types

Branded types provide compile-time type safety for ID strings. A `RunId` cannot be accidentally passed where a `FunctionId` is expected.

```typescript
import type {
  RunId, FunctionId, StepId, EventId, JobId, WorkerId, SubscriptionId,
  Branded,
} from '@ironflow/core';

import {
  createRunId, createFunctionId, createStepId,
  createEventId, createJobId, createWorkerId, createSubscriptionId,
} from '@ironflow/core';
```

### Factory Functions

Each factory casts a plain string to the branded type at zero runtime cost:

```typescript
const runId: RunId = createRunId('run_abc123');
const fnId: FunctionId = createFunctionId('my-workflow');
const stepId: StepId = createStepId('step_001');
const eventId: EventId = createEventId('evt_xyz');
const jobId: JobId = createJobId('job_456');
const workerId: WorkerId = createWorkerId('wkr_789');
const subId: SubscriptionId = createSubscriptionId('sub_012');
```

### Branded Helper

You can create your own branded types:

```typescript
type OrderId = Branded<string, 'OrderId'>;
```

---

## Function Types

### FunctionConfig

Full configuration for a workflow function.

```typescript
import type { FunctionConfig } from '@ironflow/core';

interface FunctionConfig<TEventSchema extends z.ZodType = z.ZodType> {
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
  /** Debounce configuration — collapse rapid-fire events into a single invocation */
  debounce?: DebounceConfig;
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
  /** Run compensations in reverse order when a pull-mode run is cancelled mid-saga */
  compensateOnCancel?: boolean;
  /** Cancel-on-event specs (OR semantic). Auto-cancels run with cause "cancel-on-event". */
  cancelOn?: CancelOnConfig[];
  /** Custom metadata (e.g., service, team, owner) */
  metadata?: Record<string, unknown>;
}
```

### CancelOnConfig

Auto-cancel a running workflow when a matching event arrives (issue #546 P3 / #572).

```typescript
interface CancelOnConfig {
  /** Event name to match (e.g., "order.cancelled") */
  event: string;
  /** JSON-path that must equal the running run's corresponding field */
  match: string;
}
```

> **Note:** `CancelOnConfig` is declared in `types.ts` but is currently not re-exported from `@ironflow/core`'s root index. Use the inline shape on the `cancelOn` field of `FunctionConfig` until the explicit type re-export lands:
>
> ```typescript
> const cancelOn: { event: string; match: string }[] = [
>   { event: 'order.cancelled', match: '$.data.orderId' },
> ];
> ```

### Trigger

```typescript
interface Trigger {
  /** Event name pattern to match (e.g., "order.placed") */
  event: string;
  /** Optional CEL expression for filtering */
  expression?: string;
  /** Cron schedule expression (e.g., "0 9 * * *" for 9am daily) */
  cron?: string;
}
```

### RetryConfig

```typescript
interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms (default: 1000) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2.0) */
  backoffFactor?: number;
  /** Maximum delay between retries in ms (default: 300000) */
  maxDelayMs?: number;
}
```

### ConcurrencyConfig

```typescript
interface ConcurrencyConfig {
  /** Maximum concurrent executions */
  limit: number;
  /** JSON path for grouping (e.g., "event.data.customerId") */
  key?: string;
}
```

### DebounceConfig

Collapses rapid-fire events into a single invocation after a quiet period. Async-only — `TriggerSync` rejects debounced functions with `FailedPrecondition`.

```typescript
interface DebounceConfig {
  /** Quiet period in milliseconds. Floor: 1000 (1 second). */
  periodMs: number;
  /** JSON path for per-key debouncing (e.g., "userId"). Omit for a global lane. */
  key?: string;
  /**
   * Optional starvation cap. Handler fires at least once every maxWaitMs
   * even under continuous resets. Must be >= periodMs. Omit for no cap.
   */
  maxWaitMs?: number;
}
```

Example — debounce search-as-you-type events per user for 5 seconds:

```typescript
const processSearch = ironflow.createFunction(
  {
    id: "process-search",
    triggers: [{ event: "search.requested" }],
    debounce: { periodMs: 5000, key: "userId" },
  },
  async ({ event, step }) => {
    /* ... */
  }
);
```

### ExecutionMode

```typescript
type ExecutionMode = "push" | "pull";
```

- `"push"` -- HTTP POST to serverless functions (Next.js, Lambda). For tasks under 10 seconds.
- `"pull"` -- gRPC/HTTP polling for long-running workers. No timeout limits.

### FunctionContext

Context object passed to every function handler.

```typescript
interface FunctionContext<TEvent = unknown> {
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
```

### FunctionHandler and IronflowFunction

```typescript
type FunctionHandler<TEvent = unknown, TResult = unknown> = (
  ctx: FunctionContext<TEvent>
) => Promise<TResult>;

interface IronflowFunction<TEvent = unknown, TResult = unknown> {
  config: FunctionConfig;
  handler: FunctionHandler<TEvent, TResult>;
}
```

Usage (typically via `@ironflow/node`'s `createFunction()`):

```typescript
import { createFunction } from '@ironflow/node';

const myWorkflow = createFunction({
  id: 'process-order',
  triggers: [{ event: 'order.placed' }],
  retry: { maxAttempts: 5 },
  concurrency: { limit: 10, key: 'event.data.customerId' },
  mode: 'pull',
  secrets: ['STRIPE_KEY'],
  stepTimeout: '30s',
}, async ({ event, step, logger, secrets }) => {
  const charge = await step.run('charge', async () => {
    return stripe.charges.create({ amount: event.data.amount });
  });
  return { chargeId: charge.id };
});
```

---

## Event Types

### IronflowEvent

```typescript
interface IronflowEvent<T = unknown> {
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
```

### EventSource Constants

```typescript
import { EventSource, type EventSourceType } from '@ironflow/core';

EventSource.API       // "api"
EventSource.CRON      // "cron"
EventSource.WEBHOOK   // "webhook"

// EventSourceType is the union of the EventSource values
const src: EventSourceType = EventSource.API;
```

### EventFilter

Used with `step.waitForEvent()`.

```typescript
interface EventFilter {
  /** Event name to wait for */
  event: string;
  /** JSON path for matching (e.g., "data.orderId") */
  match?: string;
  /** Timeout duration (default: "7d") */
  timeout?: Duration;
}
```

### EmitOptions and EmitResult

```typescript
interface EmitOptions {
  /** Event schema version (default 1) */
  version?: number;
  /** Optional deduplication key */
  idempotencyKey?: string;
  /** Optional metadata (headers, etc.) */
  metadata?: Record<string, unknown>;
  /** Namespace (default: "default") */
  namespace?: string;
}

interface EmitResult {
  /** IDs of runs created by this event */
  runIds: string[];
  /** ID of the stored event */
  eventId: string;
}

interface EmitSyncResult {
  /** ID of the stored event */
  eventId: string;
  /** Per-run sync results (one entry per triggered run) */
  results: Array<{
    runId: string;
    functionId: string;
    status: RunStatus;
    output?: unknown;
    error?: { message: string; code?: string };
    durationMs: number;
  }>;
}
```

---

## Step Types

### StepClient

The durable step execution interface. All methods are memoized -- on retry, previously completed steps return their stored result without re-executing.

```typescript
interface StepClient {
  /**
   * Execute a step with memoization.
   * Use for any non-idempotent operation (API calls, payments, emails).
   */
  run<T>(name: string, fn: () => Promise<T>, options?: StepRunOptions): Promise<T>;

  /**
   * Durable sleep. Worker can restart; workflow resumes after duration.
   * @param duration - "1h", "30m", "7d" or milliseconds as number
   */
  sleep(name: string, duration: Duration): Promise<void>;

  /**
   * Durable sleep until a specific time.
   * @param until - Date object or ISO 8601 string
   */
  sleepUntil(name: string, until: Date | string): Promise<void>;

  /**
   * Wait for an external event. Used for human-in-the-loop and async callbacks.
   */
  waitForEvent<T = unknown>(name: string, filter: EventFilter): Promise<IronflowEvent<T>>;

  /**
   * Execute multiple branches in parallel.
   * "failFast" (default): first failure cancels pending branches.
   * "allSettled": all branches complete, errors in results.
   */
  parallel<T extends unknown[]>(
    name: string,
    branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
    options?: ParallelOptions
  ): Promise<T>;

  /** allSettled overload -- results contain T[K] | Error */
  parallel<T extends unknown[]>(
    name: string,
    branches: { [K in keyof T]: (step: StepClient) => Promise<T[K]> },
    options: ParallelOptions & { onError: "allSettled" }
  ): Promise<{ [K in keyof T]: T[K] | Error }>;

  /**
   * Map over items executing steps in parallel.
   */
  map<T, R>(
    name: string,
    items: T[],
    fn: (item: T, step: StepClient, index: number) => Promise<R>,
    options?: ParallelOptions
  ): Promise<R[]>;

  /**
   * Register a compensation handler (Saga pattern).
   * On failure, compensations run in reverse order.
   */
  compensate(stepName: string, fn: () => Promise<void>): void;

  /**
   * Invoke another function and wait for its result (durable).
   * Target function must have no event triggers.
   */
  invoke<T = unknown>(
    functionId: string,
    input?: unknown,
    options?: { timeout?: string }
  ): Promise<T>;

  /**
   * Fire-and-forget invoke. Returns the child run ID immediately.
   */
  invokeAsync(functionId: string, input?: unknown): Promise<{ runId: string }>;

  /**
   * Publish to a developer pub/sub topic (durable, memoized).
   * Does NOT trigger workflow functions -- use emit for that.
   */
  publish(topic: string, data: unknown): Promise<PublishResult>;
}
```

### StepRunOptions

```typescript
interface StepRunOptions {
  /** Timeout for this step ("30s", "5m", "1h"). Overrides function-level stepTimeout. */
  timeout?: string;
}
```

### Duration

```typescript
type Duration = string | number;
// String: "1s", "30s", "5m", "2h", "7d"
// Number: milliseconds
```

### ParallelOptions

```typescript
interface ParallelOptions {
  /** Maximum concurrent branches (default: unlimited) */
  concurrency?: number;
  /** Error handling: "failFast" (default) or "allSettled" */
  onError?: "failFast" | "allSettled";
}
```

---

## Run Types

### RunStatus

```typescript
type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
```

### RunInfo

Minimal run context passed inside `FunctionContext`.

```typescript
interface RunInfo {
  id: string;
  functionId: string;
  attempt: number;
  startedAt: Date;
}
```

### Run

Full run details returned by API queries.

```typescript
interface Run {
  id: string;
  functionId: string;
  eventId: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string };
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### ListRunsOptions and ListRunsResult

```typescript
interface ListRunsOptions {
  functionId?: string;
  status?: RunStatus;
  limit?: number;
  cursor?: string;
}

interface ListRunsResult {
  runs: Run[];
  nextCursor?: string;
  totalCount: number;
}
```

### InvokeResult, TriggerSyncOptions, TriggerSyncResult

```typescript
interface InvokeResult {
  runIds: string[];
  eventId: string;
}

// TriggerResult is a deprecated alias for InvokeResult

interface TriggerSyncOptions {
  /** Maximum wait time in ms (default: 30000) */
  timeout?: number;
}

interface TriggerSyncResult {
  runId: string;
  functionId: string;
  status: RunStatus;
  output?: unknown;
  error?: { message: string; code?: string };
  durationMs: number;
}
```

---

## Subscription Types

### SubscribeOptions

```typescript
interface SubscribeOptions {
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
```

### AckMode, BackpressureMode, AckType

```typescript
type AckMode = "auto" | "manual";
type BackpressureMode = "drop" | "block" | "buffer";
type AckType = "ack" | "nak" | "term";
```

### SubscriptionEvent

```typescript
interface SubscriptionEvent<T = unknown> {
  /** Event topic (e.g., "system.run.abc123.updated") */
  topic: string;
  /** Event payload data */
  data: T;
  /** Event metadata (if includeMetadata was true) */
  meta?: EventMetadata;
  /** Event ID (for consumer group ack/nak/term) */
  eventId?: string;
}
```

### EventMetadata

```typescript
interface EventMetadata {
  timestamp: string;   // ISO 8601
  sequence?: number;   // Stream sequence number
}
```

### Subscription

```typescript
interface Subscription {
  id: string;
  pattern: string;
  connectionState: ConnectionState;
  lastEvent?: SubscriptionEvent<unknown>;
  unsubscribe(): void;
}
```

### AckableSubscription

Extends `Subscription` with manual acknowledgment methods for consumer groups.

```typescript
interface AckableSubscription extends Subscription {
  ack(eventId: string): Promise<void>;
  nak(eventId: string, delay?: number): Promise<void>;
  term(eventId: string): Promise<void>;
}
```

### AckHandle

```typescript
interface AckHandle {
  ack(): void;
  nak(): void;
}
```

### ConnectionState

```typescript
type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";
```

### SubscriptionCallbacks

```typescript
interface SubscriptionCallbacks<T = unknown> {
  onEvent?: (event: SubscriptionEvent<T>) => void;
  onError?: (error: SubscriptionErrorInfo) => void;
  onStateChange?: (state: ConnectionState) => void;
}
```

### SubscriptionErrorInfo

```typescript
interface SubscriptionErrorInfo {
  subscriptionId?: string;
  code: string;
  message: string;
  retrying?: boolean;
}
```

### BufferConfig

```typescript
interface BufferConfig {
  size: number;
  strategy: "drop-oldest" | "drop-newest" | "block";
}
```

### ConsumerGroupConfig and ConsumerGroup

```typescript
interface ConsumerGroupConfig {
  name: string;
  pattern: string;
  namespace?: string;           // default: "default"
  filterExpr?: string;          // CEL expression
  ackMode?: AckMode;            // default: "auto"
  backpressure?: BackpressureMode; // default: "buffer"
  maxInflight?: number;         // default: 100
  maxRedeliveries?: number;     // default: 3
  redeliverDelayMs?: number;    // default: 5000
  metadata?: Record<string, unknown>;
}

interface ConsumerGroup {
  id: string;
  namespace: string;
  name: string;
  pattern: string;
  filterExpr?: string;
  ackMode: AckMode;
  backpressure: BackpressureMode;
  maxInflight: number;
  maxRedeliveries: number;
  redeliverDelayMs: number;
  metadata?: Record<string, unknown>;
  status: ConsumerGroupStatus;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type ConsumerGroupStatus = "active" | "paused" | "deleted";
```

---

## Entity Stream Types

Entity streams implement event sourcing per entity with optimistic concurrency.

### AppendEventInput

```typescript
interface AppendEventInput {
  /** Event name (e.g., "order.created") */
  name: string;
  /** Event payload data */
  data: Record<string, unknown>;
  /** Entity type (e.g., "order", "user") */
  entityType: string;
}
```

### AppendOptions

```typescript
interface AppendOptions {
  /** Expected entity version for optimistic concurrency control (-1 to skip) */
  expectedVersion?: number;
  /** Idempotency key to prevent duplicate appends */
  idempotencyKey?: string;
  /** Event schema version (default: 1) */
  version?: number;
  /** Cross-cutting metadata (causation, correlation, tenant, trace) attached to the event */
  metadata?: Record<string, unknown>;
}
```

### AppendResult

```typescript
interface AppendResult {
  entityVersion: number;
  eventId: string;
  /**
   * NATS JetStream sequence on the PUBSUB stream. Pass to
   * projections.waitForCatchup({ minSeq }) for read-your-writes.
   * 0 (or undefined) means publish failed or unavailable.
   */
  sequence?: number;
}
```

### ReadStreamOptions

```typescript
interface ReadStreamOptions {
  /** Start reading from this version (inclusive, default: 0) */
  fromVersion?: number;
  /** Maximum number of events to return (0 = all) */
  limit?: number;
  /** Read direction (default: "forward") */
  direction?: "forward" | "backward";
}
```

### StreamEvent

```typescript
interface StreamEvent {
  id: string;
  name: string;
  data: Record<string, unknown>;
  entityVersion: number;
  version: number;          // Schema version
  timestamp: string;        // ISO 8601
  source?: string;
  metadata?: Record<string, unknown>;
}
```

### StreamInfo

```typescript
interface StreamInfo {
  entityId: string;
  entityType: string;
  version: number;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### EntitySubscribeOptions

```typescript
interface EntitySubscribeOptions {
  /** Entity type (e.g., "order") -- required to construct NATS subject pattern */
  entityType: string;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Error) => void;
  /** Number of historical events to replay from NATS stream (0 = live only) */
  replay?: number;
}
```

---

## Pub/Sub Types

Developer pub/sub for topic-based messaging. Unlike `emit()`, publishing to a topic does NOT trigger workflow functions.

### PublishOptions

```typescript
interface PublishOptions {
  idempotencyKey?: string;
}
```

### PublishResult

```typescript
interface PublishResult {
  eventId: string;
  sequence: number;   // JetStream sequence number
}
```

### TopicInfo

```typescript
interface TopicInfo {
  name: string;
  messageCount: number;
  consumerCount: number;
  firstMessageAt?: string;
  lastMessageAt?: string;
}
```

### TopicStats

```typescript
interface TopicStats {
  name: string;
  messageCount: number;
  consumerCount: number;
  lag: number;
  firstSeq: number;
  lastSeq: number;
}
```

---

## KV Types

Key-value store backed by NATS JetStream KV.

### KVBucketConfig

```typescript
interface KVBucketConfig {
  name: string;
  description?: string;
  ttlSeconds?: number;      // 0 = no expiry
  maxValueSize?: number;    // bytes
  maxBytes?: number;        // total bucket size in bytes
  history?: number;         // historical values per key (default: 1)
}
```

### KVBucketInfo

```typescript
interface KVBucketInfo {
  name: string;
  description?: string;
  ttl_seconds?: number;
  values: number;
  bytes: number;
  history: number;
  created_at: string;
}
```

### KVEntry

```typescript
interface KVEntry {
  key: string;
  value: unknown;        // raw bytes as base64 or string
  revision: number;
  created_at: string;
  operation: string;     // "put" or "delete"
}
```

### KVPutResult

```typescript
interface KVPutResult {
  revision: number;
}
```

### KVListKeysResult

```typescript
interface KVListKeysResult {
  keys: string[];
  count: number;
}
```

### KVListBucketsResult

```typescript
interface KVListBucketsResult {
  buckets: KVBucketInfo[];
  count: number;
}
```

### KVWatchEvent

```typescript
interface KVWatchEvent {
  type: "kv_update";
  key: string;
  value: string;
  revision: number;
  operation: "put" | "delete";
  bucket: string;
}
```

### KVWatchCallbacks

```typescript
interface KVWatchCallbacks {
  onUpdate: (event: KVWatchEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}
```

### KVWatchOptions

```typescript
interface KVWatchOptions {
  /** Key pattern to watch (e.g., "user.*", "session.>"). Empty = all keys. */
  key?: string;
}
```

### KVWatcher

```typescript
interface KVWatcher {
  stop: () => void;
}
```

---

## Config Types

Environment-scoped configuration management built on the KV store.

### ConfigResponse

```typescript
interface ConfigResponse {
  name: string;
  data: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}
```

### ConfigEntry

Summary (without full data), used in list responses.

```typescript
interface ConfigEntry {
  name: string;
  revision: number;
  updatedAt: string;
}
```

### ConfigSetResult

```typescript
interface ConfigSetResult {
  name: string;
  revision: number;
}
```

### ConfigWatchCallbacks

```typescript
interface ConfigWatchCallbacks {
  onEvent: (config: ConfigResponse) => void;
  onError?: (error: Error) => void;
}
```

### ConfigWatchEvent and ConfigWatcher

```typescript
interface ConfigWatchEvent {
  name: string;
  data: Record<string, unknown>;
  revision: number;
  operation: "put" | "delete";
}

interface ConfigWatcher {
  stop: () => void;
}
```

---

## Auth Types

Types for API key, organization, role, and policy management.

### API Keys

```typescript
interface APIKey {
  id: string;
  name: string;
  key_prefix: string;
  role_ids?: string[];
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
}

interface APIKeyWithSecret extends APIKey {
  /** Full API key -- only returned on creation */
  key: string;
}

interface CreateAPIKeyInput {
  name: string;
  env_id?: string;
  role_ids?: string[];
  expires_in?: string;
}
```

### Organizations

```typescript
interface Organization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface CreateOrgInput {
  name: string;
}

interface UpdateOrgInput {
  name?: string;
}
```

### Roles

```typescript
interface Role {
  id: string;
  org_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
}

interface CreateRoleInput {
  name: string;
  org_id: string;
}

interface UpdateRoleInput {
  name?: string;
}
```

### Policies

```typescript
interface Policy {
  id: string;
  org_id: string;
  name: string;
  effect: "allow" | "deny";
  actions: string;
  resources: string;
  condition?: string;
  created_at: string;
  updated_at: string;
}

// #943 (ADR 0016 T2): create/update inputs accept effect="deny" only.
// The READ type Policy keeps "allow" in its union so legacy rows fetched
// during the upgrade window can be rendered.
interface CreatePolicyInput {
  name: string;
  effect: "deny";
  actions: string;
  resources: string;
  condition?: string;
  org_id: string;
}

interface UpdatePolicyInput {
  name?: string;
  effect?: "deny";
  actions?: string;
  resources?: string;
  condition?: string;
}
```

---

## Audit Types

Audit trail for function execution recording (enterprise feature).

```typescript
interface AuditEvent {
  id: string;
  runId: string;
  functionId: string;
  stepId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, string>;
  createdAt: string;
}

interface GetAuditTrailOptions {
  eventType?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  limit?: number;
  cursor?: string;
}

interface AuditTrailResult {
  events: AuditEvent[];
  totalCount: number;
  nextCursor?: string;
}
```

---

## Webhook Types

Types for defining webhook sources that transform inbound HTTP requests into Ironflow events.

```typescript
interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

interface WebhookEvent {
  name: string;
  data: unknown;
  idempotencyKey?: string;
}

interface WebhookConfig {
  id: string;
  /** Verify the webhook signature. Return the parsed payload or throw. */
  verify: (req: WebhookRequest) => unknown | Promise<unknown>;
  /** Transform the verified payload into an Ironflow event. */
  transform: (payload: unknown) => WebhookEvent | Promise<WebhookEvent>;
}

interface IronflowWebhook {
  config: WebhookConfig;
}
```

---

## Projection Types

Projections build read models from event streams.

### ProjectionMode and ProjectionStatus

```typescript
type ProjectionMode = "managed" | "external";
// "managed": pure reducer, state stored by Ironflow
// "external": side-effect handler, you manage storage

type ProjectionStatus = "active" | "rebuilding" | "paused" | "error";
```

### ProjectionConfig

```typescript
interface ProjectionConfig<TState = unknown, TEvent = unknown> {
  /** Unique projection name */
  name: string;
  /** Event names to subscribe to (supports wildcards like "order.*") */
  events: string[];
  /** Execution mode -- auto-detected from initialState if omitted */
  mode?: ProjectionMode;
  /** Handler function */
  handler: ManagedProjectionHandler<TState, TEvent> | ExternalProjectionHandler<TEvent>;
  /** Initial state factory (required for managed, absent for external) */
  initialState?: () => TState;
  /** JSONPath for partition key extraction (e.g., "$.data.customerId") */
  partitionKey?: string;
  /** Max retries per event (default 3) */
  maxRetries?: number;
  /** Batch size for polling (default 100) */
  batchSize?: number;
}
```

### ProjectionContext

```typescript
interface ProjectionContext {
  event: { id: string; name: string; seq: number; timestamp: Date };
  projection: { name: string; version: number };
  logger: Logger;
}
```

### Handlers

```typescript
/** Managed: pure reducer. Returns new state. */
type ManagedProjectionHandler<TState = unknown, TEvent = unknown> = (
  state: TState,
  event: TEvent & { name: string; data: unknown },
  ctx: ProjectionContext
) => TState;

/** External: side effects. Return void or Promise<void>. */
type ExternalProjectionHandler<TEvent = unknown> = (
  event: TEvent & { name: string; data: unknown },
  ctx: ProjectionContext
) => void | Promise<void>;
```

#### Determinism & Idempotence (managed mode)

Managed reducers run under at-least-once delivery. PG-backed rebuild (#486) and the live NATS tail can both invoke the handler for the same event during the overlap window; node failover and retries can replay events at any time. **Correctness depends on the reducer.** Four rules:

- **Deterministic** — same `(state, event)` → same `newState`. No `Date.now()`, `new Date()` with no args, `Math.random()`, `crypto.randomUUID()`, env reads. Derive timestamps from `event.timestamp` and IDs from `event.data`.
- **Pure** — no network, no DB writes, no `console.log` as intent. Side effects require `mode: "external"`.
- **Aliasing-safe** — return a fresh object; don't mutate and return the argument.
- **Idempotent** — the same event may be applied multiple times. Prefer keyed-map accumulation (`state.byId[id] = ...`) over counters (`state.count += 1`); key accumulators on `event.id` when you must accumulate.

See [`docs/explanation/projections.md`](../../../docs/explanation/projections.md#reducer-contract-managed-mode) for examples and rationale.

### IronflowProjection

```typescript
interface IronflowProjection<TState = unknown, TEvent = unknown> {
  config: ProjectionConfig<TState, TEvent>;
}
```

### ProjectionStatusInfo

```typescript
interface ProjectionStatusInfo {
  name: string;
  status: ProjectionStatus;
  mode: ProjectionMode;
  lastEventSeq: number;
  lag: number;
  errorMessage?: string;
  updatedAt: Date;
}
```

### ProjectionStateResult

Returned by `client.projections.get()` (Node) and `ironflow.getProjection()` (browser) after `peelProjectionEnvelope()` strips the server REST wire shape. `name`, `version`, `mode`, `status`, `lastEventSeq`, `updatedAt`, and `errorMessage` come from the registry envelope. `partition`, `state`, `lastEventId`, and `lastEventTime` come from the inner state row. `lastEventTime` is `undefined` when no state row exists yet (projection registered, no events applied); `state` is `{}` in that case. `errorMessage` is omitted when the projection is healthy.

```typescript
interface ProjectionStateResult<TState = unknown> {
  name: string;
  partition: string;
  state: TState;
  lastEventId: string;
  lastEventTime?: Date;
  lastEventSeq: number;
  version: number;
  mode: ProjectionMode;
  status?: ProjectionStatus;
  errorMessage?: string;
  updatedAt: Date;
}
```

### GetProjectionOptions and RebuildProjectionOptions

```typescript
interface GetProjectionOptions {
  partition?: string;
}

interface RebuildProjectionOptions {
  partition?: string;
  fromEventId?: string;
  dryRun?: boolean;
}
```

### ProjectionSubscriptionCallbacks

```typescript
interface ProjectionSubscriptionCallbacks<TState = unknown> {
  onUpdate: (state: TState, event: { id: string; name: string }) => void;
  onError?: (error: Error) => void;
}
```

### peelProjectionEnvelope

Strips the server REST wire envelope into a `ProjectionStateResult`.

```typescript
import { peelProjectionEnvelope } from '@ironflow/core';

const state = peelProjectionEnvelope<{ count: number }>(rawResponse);
```

### SQL Projections

For projections backed by relational tables (Cloud / managed PG).

```typescript
interface CreateSQLProjectionInput {
  name: string;
  events: string[];
  sql: string;
  schema?: string;
}

interface QuerySQLProjectionOptions {
  params?: unknown[];
  limit?: number;
}

interface SQLProjectionQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount: number;
}
```

### Projection Management Types

```typescript
interface RebuildJob {
  name: string;
  status: string;
  progress: number;
  startedAt: string;
}

/**
 * Result of waitForCatchup / waitForCatchupBatch / waitForEvent (#473).
 * On success exactly one of `caughtUp` or `timedOut` is true.
 */
interface WaitResult {
  caughtUp: boolean;
  timedOut: boolean;
  /** Cursor at the moment of response */
  currentSeq: number;
  /** The minSeq the client was waiting for */
  targetSeq: number;
  /** targetSeq - currentSeq. 0 when caught up */
  behindByEvents: number;
  rebuilding?: boolean;
  /** "managed" or "external" (informational) */
  mode?: string;
}

/**
 * One frame from waitForProjectionCatchupStream (#476). Seq fields are
 * `bigint` because the server values are uint64.
 */
interface WaitProgress {
  currentSeq: bigint;
  targetSeq: bigint;
  behindByEvents: bigint;
  terminal: boolean;
  caughtUp: boolean;
  timedOut: boolean;
}
```

Usage example (via `@ironflow/node`):

```typescript
import { createProjection } from '@ironflow/node';

const orderStats = createProjection({
  name: 'order-stats',
  events: ['order.placed', 'order.cancelled'],
  initialState: () => ({ total: 0, cancelled: 0 }),
  handler: (state, event) => {
    if (event.name === 'order.placed') return { ...state, total: state.total + 1 };
    if (event.name === 'order.cancelled') return { ...state, cancelled: state.cancelled + 1 };
    return state;
  },
});
```

---

## Error Classes

All errors extend `IronflowError`. Each has a `code` string and a `retryable` boolean.

```typescript
import {
  IronflowError, ConnectionError, SubscriptionError, TimeoutError,
  ValidationError, SchemaValidationError, SignatureError,
  FunctionNotFoundError, RunNotFoundError, StepError, NonRetryableError,
  NotConfiguredError, InvokeError, InvokeTimeoutError, StepTimeoutError,
  RunFailedError, RunCancelledError,
  AgentInvokeTimeoutError, NoRunCreatedError, MemoryCatchupTimeoutError,
  UnauthenticatedError, EnterpriseRequiredError, UnauthorizedError,
  isRetryable, isIronflowError, toError,
} from '@ironflow/core';
```

### IronflowError (base class)

```typescript
class IronflowError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options?: {
    code?: string;       // default: "UNKNOWN_ERROR"
    retryable?: boolean; // default: false
    details?: Record<string, unknown>;
    cause?: Error;
  });
}
```

### Error Reference Table

| Class | Code | Retryable | When Thrown |
|---|---|---|---|
| `ConnectionError` | `CONNECTION_LOST` | true | WebSocket/HTTP connection lost |
| `SubscriptionError` | `SUBSCRIPTION_ERROR` | true | Subscription setup or delivery failure |
| `TimeoutError` | `TIMEOUT` | true | HTTP request or sync trigger timeout |
| `ValidationError` | `VALIDATION_ERROR` | false | Invalid input data |
| `SchemaValidationError` | `VALIDATION_ERROR` | false | Zod schema validation failure |
| `SignatureError` | `SIGNATURE_INVALID` | false | Invalid webhook signature |
| `FunctionNotFoundError` | `FUNCTION_NOT_FOUND` | false | Function ID not in registry |
| `RunNotFoundError` | `RUN_NOT_FOUND` | false | Run ID not found in store |
| `StepError` | `STEP_FAILED` | true | Step execution failure (has `stepId`, `stepName`) |
| `NonRetryableError` | `NON_RETRYABLE` | false | Permanent failure, skip retries |
| `NotConfiguredError` | `NOT_CONFIGURED` | false | Client used before `configure()` |
| `InvokeError` | `INVOKE_FAILED` | false | `step.invoke()` target failed (has `functionId`, `childRunId`) |
| `InvokeTimeoutError` | `INVOKE_FAILED` | false | `step.invoke()` timed out (has `timeoutMs`) |
| `StepTimeoutError` | `STEP_TIMEOUT` | true | `step.run()` exceeded its timeout (has `stepName`, `timeout`) |
| `RunFailedError` | `RUN_FAILED` | false | `emitSync`/`TriggerSync` run failed (has `runId`, `output`) |
| `RunCancelledError` | `RUN_CANCELLED` | false | `emitSync`/`TriggerSync` run cancelled (has `runId`) |
| `AgentInvokeTimeoutError` | `AGENT_INVOKE_TIMEOUT` | true | `agents.invoke()` exceeded `timeoutMs` (has `runId`, `timeoutMs`) |
| `NoRunCreatedError` | `NO_RUN_CREATED` | false | Trigger response carried no `runIds` (has `functionName`) |
| `MemoryCatchupTimeoutError` | `MEMORY_CATCHUP_TIMEOUT` | true | `agents.readMemory()` waited past `timeoutMs` for projection catch-up (has `projection`, `minSeq`, `timeoutMs`) |
| `UnauthenticatedError` | `UNAUTHENTICATED` | false | No/invalid API key (HTTP 401) |
| `EnterpriseRequiredError` | `ENTERPRISE_REQUIRED` | false | Enterprise license needed (HTTP 402) |
| `UnauthorizedError` | `UNAUTHORIZED` | false | Insufficient permissions (HTTP 403) |

### Utility Functions

```typescript
// Check if an error is retryable (also returns true for fetch TypeErrors)
isRetryable(error: unknown): boolean

// Type guard for IronflowError
isIronflowError(error: unknown): error is IronflowError

// Normalize any thrown value to an Error instance
toError(error: unknown): Error
```

Usage:

```typescript
try {
  await client.emit('order.placed', { amount: 100 });
} catch (err) {
  if (isRetryable(err)) {
    // Safe to retry
  }
  if (err instanceof FunctionNotFoundError) {
    console.error(`Function ${err.functionId} not registered`);
  }
}
```

---

## Schemas

Zod schemas for runtime validation of API responses, WebSocket messages, and webhook payloads. All schemas are exported from `@ironflow/core` or the `@ironflow/core/schemas` sub-path.

### Validation Helpers

```typescript
import { parseAndValidate, validate, RunResponseSchema } from '@ironflow/core';

// Parse JSON string and validate against schema
// Throws SchemaValidationError on failure
const run = parseAndValidate(RunResponseSchema, jsonString, 'GetRun response');

// Validate already-parsed data against schema
// Throws SchemaValidationError on failure
const run = validate(RunResponseSchema, parsedData, 'GetRun response');
```

### Available Schemas

**Run & Status:**
- `RunStatusSchema` -- `z.enum(["pending", "running", "completed", "failed", "cancelled", "paused"])`

**Push Request (serve.ts):**
- `PushRequestSchema` -- Full push mode request from engine to SDK
- `PushRequestEventSchema` -- Event portion of push request
- `CompletedStepSchema` -- Memoized step from previous execution
- `ResumeContextSchema` -- Resume context for sleep/waitForEvent/invoke

**API Responses:**
- `TriggerResponseSchema` -- `{ runIds?, eventId }`
- `TriggerSyncResultItemSchema` -- Individual sync trigger result
- `TriggerSyncResponseSchema` -- `{ results?, eventId }`
- `RunResponseSchema` -- Full run details
- `ListRunsResponseSchema` -- `{ runs?, nextCursor?, totalCount? }`
- `RegisterFunctionResponseSchema` -- `{ created? }`
- `HealthResponseSchema` -- `{ status }`
- `ErrorResponseSchema` -- `{ code?, message? }`
- `EmptyResponseSchema` -- `{}`

**Consumer Groups:**
- `AckModeSchema` -- `z.enum(["ACK_MODE_AUTO", "ACK_MODE_MANUAL", "ACK_MODE_UNSPECIFIED"])`
- `BackpressureModeSchema`
- `ConsumerGroupStatusSchema`
- `ConsumerGroupResponseSchema`
- `ListConsumerGroupsResponseSchema`

**Worker Job Assignment:**
- `JobAssignmentSchema` -- Full job assignment for pull-mode workers
- `JobEventSchema`, `JobCompletedStepSchema`, `JobContextSchema`

**WebSocket Messages:**
- `WSServerMessageSchema` -- Discriminated union of all server messages
- `WSEventMessageSchema` -- Event delivery
- `WSSubscriptionResultSchema` -- Subscribe confirmation
- `WSSubscriptionResultItemSchema` -- Single subscribe result item
- `WSSubscriptionErrorSchema` -- Subscription error
- `WSErrorSchema` -- General error
- `EventMetadataSchema`

**Audit:**
- `AuditEventSchema`

**Time-Travel Debugging:**
- `TimeTravelStepSnapshotSchema`
- `TimeTravelRunStateSnapshotSchema`
- `TimeTravelTimelineEventSchema`

### Inferred Types

```typescript
import type {
  ValidatedPushRequest,
  ValidatedRunResponse,
  ValidatedJobAssignment,
  ValidatedWSServerMessage,
} from '@ironflow/core';
```

These are `z.infer<>` types derived from the corresponding schemas.

---

## Protocol Types

Low-level protocol types for SDK authors building custom transports. Import from `@ironflow/core` or `@ironflow/core/protocol`.

### Push Mode (HTTP)

```typescript
interface PushRequest {
  run_id: string;
  function_id: string;
  attempt: number;
  event: {
    id: string; name: string; data: unknown; timestamp: string;
    version?: number; idempotency_key?: string; source?: string;
    metadata?: Record<string, unknown>;
  };
  steps: CompletedStep[];
  resume?: ResumeContext;
}

interface PushResponse {
  status: "completed" | "yielded" | "failed";
  steps: StepResult[];
  result?: unknown;
  error?: {
    message: string; code?: string; step_id?: string;
    retryable: boolean; stack?: string;
  };
  yield?: YieldInfo;
}

interface CompletedStep {
  id: string; name: string;
  status: "completed" | "failed" | "timed_out";
  output?: unknown; error?: string;
}

interface ResumeContext {
  step_id: string;
  type: "sleep" | "wait_for_event" | "invoke_function" | "invoke_function_async";
  data?: unknown;
}

interface StepResult {
  id: string; name: string;
  type: "invoke" | "sleep" | "wait_for_event" | "compensate";
  status: "completed" | "failed";
  started_at: string; ended_at?: string; duration_ms?: number;
  output?: unknown;
  error?: { message: string; retryable: boolean; stack?: string };
  compensation_for?: string;
}
```

### Yield Types

```typescript
type YieldInfo = SleepYield | WaitEventYield | InvokeFunctionYield | InvokeFunctionAsyncYield;

interface SleepYield { step_id: string; type: "sleep"; until: string; }
interface WaitEventYield { step_id: string; type: "wait_for_event"; event_filter: { event: string; match?: string; timeout?: string; }; }
interface InvokeFunctionYield { step_id: string; type: "invoke_function"; function_id: string; input?: unknown; invoke_timeout_ms?: number; }
interface InvokeFunctionAsyncYield { step_id: string; type: "invoke_function_async"; function_id: string; input?: unknown; }
```

### WebSocket Protocol

**Client to server:**

```typescript
interface WSSubscribeRequest {
  type: "subscribe";
  subscription: {
    pattern: string;
    options?: {
      replay?: number; includeMetadata?: boolean; filter?: string;
      consumerGroup?: string; ackMode?: AckMode;
      backpressure?: BackpressureMode; namespace?: string;
    };
  };
}

interface WSUnsubscribeRequest { type: "unsubscribe"; subscriptionId: string; }
interface WSAckRequest { type: "ack"; eventId: string; ackType: AckType; redeliverDelay?: number; }

type WSClientMessage = WSSubscribeRequest | WSUnsubscribeRequest | WSAckRequest;
```

**Server to client:**

```typescript
interface WSSubscriptionResult {
  type: "subscription_result";
  results: Array<{ pattern: string; status: "ok" | "error"; subscriptionId?: string; code?: string; message?: string; }>;
}
interface WSEventMessage { type: "event"; subscriptionId: string; topic: string; data: unknown; meta?: EventMetadata; eventId?: string; }
interface WSSubscriptionError { type: "subscription_error"; subscriptionId: string; code: string; message: string; retrying: boolean; }
interface WSError { type: "error"; code: string; message: string; }

type WSServerMessage = WSSubscriptionResult | WSEventMessage | WSSubscriptionError | WSError;
```

### Retry Types

```typescript
interface RetryEvent { attempt: number; maxAttempts: number; error: Error; delayMs: number; }
interface RetryInfo { eventId: string; attempt: number; maxAttempts: number; delayMs?: number; }

interface ClientRetryConfig {
  maxAttempts?: number;          // default: 3
  initialDelayMs?: number;       // default: 100
  maxDelayMs?: number;           // default: 10000
  backoffMultiplier?: number;    // default: 2.0
  connectionRetryDelayMs?: number; // default: 2000
  onRetry?: (event: RetryEvent) => void;
}
```

---

## Constants

```typescript
import {
  DEFAULT_PORT,          // 9123
  DEFAULT_HOST,          // "localhost"
  DEFAULT_SERVER_URL,    // "http://localhost:9123"
  DEFAULT_WS_URL,        // "ws://localhost:9123/ws"
  DEFAULT_ENVIRONMENT,   // "default"

  DEFAULT_TIMEOUTS,
  // { CLIENT: 30_000, FUNCTION: 600_000, TRIGGER_SYNC: 30_000 }

  DEFAULT_RETRY,
  // { MAX_ATTEMPTS: 3, INITIAL_DELAY_MS: 1000, BACKOFF_FACTOR: 2.0, MAX_DELAY_MS: 300_000 }

  DEFAULT_CLIENT_RETRY,
  // { MAX_ATTEMPTS: 3, INITIAL_DELAY_MS: 100, BACKOFF_MULTIPLIER: 2.0,
  //   MAX_DELAY_MS: 10_000, CONNECTION_RETRY_DELAY_MS: 2_000 }

  DEFAULT_WORKER,
  // { MAX_CONCURRENT_JOBS: 10, HEARTBEAT_INTERVAL_MS: 30_000, RECONNECT_DELAY_MS: 5_000 }

  DEFAULT_RECONNECT,
  // { ENABLED: true, MAX_ATTEMPTS: 10, INITIAL_DELAY_MS: 1_000,
  //   MAX_DELAY_MS: 30_000, MULTIPLIER: 2 }

  ENV_VARS,
  // { SERVER_URL: "IRONFLOW_SERVER_URL", SIGNING_KEY: "IRONFLOW_SIGNING_KEY",
  //   API_KEY: "IRONFLOW_API_KEY", LOG_LEVEL: "IRONFLOW_LOG_LEVEL" }

  STEP_TYPES,
  // { INVOKE: "invoke", SLEEP: "sleep", WAIT_FOR_EVENT: "wait_for_event" }

  STEP_STATUS,
  // { COMPLETED: "completed", FAILED: "failed", WAITING: "waiting" }

  RUN_STATUS,
  // { PENDING: "pending", RUNNING: "running", COMPLETED: "completed",
  //   FAILED: "failed", CANCELLED: "cancelled", PAUSED: "paused" }

  API_ENDPOINTS,
  // ConnectRPC paths: TRIGGER, TRIGGER_SYNC, GET_RUN, LIST_RUNS, CANCEL_RUN,
  // RETRY_RUN, REGISTER_FUNCTION, HEALTH, EMIT, CREATE_CONSUMER_GROUP,
  // GET_CONSUMER_GROUP, LIST_CONSUMER_GROUPS, DELETE_CONSUMER_GROUP

  TIMING,
  // { POLL_INTERVAL_MS: 1000, ERROR_RETRY_DELAY_MS: 5000,
  //   RECONNECT_DELAY_MS: 1000, WS_CLOSE_NORMAL: 1000 }

  ACK_TYPES,
  // { ACK: "ack", NAK: "nak", TERM: "term" }

  ERROR_CODES,
  // FUNCTION_NOT_FOUND, VALIDATION_ERROR, SIGNATURE_INVALID, NETWORK_ERROR,
  // SERVER_ERROR, TIMEOUT_ERROR, CONNECTION_LOST, CONNECTION_REFUSED,
  // SUBSCRIPTION_ERROR, NOT_CONFIGURED

  HEADERS,
  // { ENVIRONMENT: "X-Ironflow-Environment" }

  WS_MESSAGE_TYPES,
  // { SUBSCRIBE, UNSUBSCRIBE, ACK, EVENT, SUBSCRIPTION_RESULT,
  //   SUBSCRIPTION_ERROR, ERROR }

  HTTP_HEADERS,
  // { CONTENT_TYPE_JSON: "application/json" }

  JSON_HEADERS,
  // { "Content-Type": "application/json" }

  getServerUrl,       // () => string  (reads IRONFLOW_SERVER_URL or returns default)
  getWebSocketUrl,    // (serverUrl?) => string  (converts http->ws, appends /ws)
} from '@ironflow/core';
```

### Environment Variables

| Variable | Purpose |
|---|---|
| `IRONFLOW_SERVER_URL` | Server URL (default: `http://localhost:9123`) |
| `IRONFLOW_SIGNING_KEY` | Webhook signature verification key |
| `IRONFLOW_API_KEY` | API key for authenticated requests |
| `IRONFLOW_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error`, `silent` |

---

## Utilities

```typescript
import {
  parseDuration, calculateBackoff, sleep, createDeferred,
  generateId, safeJsonParse, isObject, deepMerge,
} from '@ironflow/core';
```

### parseDuration

Convert a duration string to milliseconds.

```typescript
parseDuration('30s');   // 30000
parseDuration('5m');    // 300000
parseDuration('2h');    // 7200000
parseDuration('7d');    // 604800000
parseDuration('500ms'); // 500
parseDuration(1000);    // 1000 (passthrough)
// Throws Error for invalid format
```

### calculateBackoff

```typescript
calculateBackoff(
  attempt: number,       // 1-based attempt number
  initialDelay: number,  // initial delay in ms
  maxDelay: number,      // maximum delay cap in ms
  multiplier?: number    // default: 2
): number;

calculateBackoff(1, 1000, 30000);  // 1000
calculateBackoff(2, 1000, 30000);  // 2000
calculateBackoff(3, 1000, 30000);  // 4000
calculateBackoff(10, 1000, 30000); // 30000 (capped)
```

### sleep

```typescript
await sleep(1000); // sleep 1 second
```

### createDeferred

Create a promise with externally accessible resolve/reject.

```typescript
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const deferred = createDeferred<string>();
// later:
deferred.resolve('done');
// or:
deferred.reject(new Error('failed'));
// consumer:
const result = await deferred.promise;
```

### generateId

```typescript
const id = generateId(); // e.g., "m1abc23-x4y5z6"
```

### safeJsonParse

Returns `undefined` on parse failure instead of throwing.

```typescript
safeJsonParse('{"a":1}');  // { a: 1 }
safeJsonParse('invalid');  // undefined
```

### isObject

Type guard for non-null, non-array objects.

```typescript
isObject({});        // true
isObject(null);      // false
isObject([]);        // false
isObject('string');  // false
```

### deepMerge

Recursively merge two objects. Source values overwrite target values; nested objects are merged.

```typescript
deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } });
// { a: 1, b: { c: 2, d: 3 } }
```

### Pattern Helpers

Pre-built subscription patterns using NATS-style wildcards (`*` = single token, `>` = one or more tokens at end).

```typescript
import { patterns } from '@ironflow/core';

// System events
patterns.allRuns();              // "system.run.>"
patterns.run('run_abc');         // "system.run.run_abc.>"
patterns.runLifecycle('run_abc');// "system.run.run_abc.*"
patterns.runSteps('run_abc');   // "system.run.run_abc.step.>"
patterns.allFunctions();         // "system.function.>"
patterns.function('my-fn');      // "system.function.my-fn.>"

// User events
patterns.userEvent('order.*');   // "events:order.*"
patterns.allUserEvents();        // "events:>"

// Developer pub/sub topics
patterns.topic('notifications'); // "topic:notifications"
patterns.allTopics();            // "topic:>"

// Secrets
patterns.allSecrets();           // "system.secret.*"
patterns.secret('db-password');  // "system.secret.db-password.*"
patterns.secretAction('updated');// "system.secret.*.updated"
```

---

## Upcasters

Upcasters transform event data between schema versions. They run SDK-side when reading events.

### Low-Level: UpcasterRegistry

```typescript
import { createUpcasterRegistry, type UpcasterFn } from '@ironflow/core';

type UpcasterFn = (data: unknown) => unknown;

const registry = createUpcasterRegistry();

// Register: eventName, fromVersion, toVersion, transform function
registry.register('order.placed', 1, 2, (data: any) => ({
  ...data,
  currency: data.currency ?? 'USD',
}));
registry.register('order.placed', 2, 3, (data: any) => ({
  ...data,
  items: data.items ?? [],
}));

// Upcast through the chain: v1 -> v2 -> v3
const migrated = registry.upcast('order.placed', oldData, 1, 3);

// Get the latest registered version
registry.getLatestVersion('order.placed'); // 3
```

The chain must be complete. If v2->v3 is missing, upcasting from v1->v3 throws.

### High-Level: defineEvent and EventDefinitionRegistry

```typescript
import { defineEvent, createEventDefinitionRegistry } from '@ironflow/core';
import type { EventDefinition, EventDefinitionOptions, EventDefinitionRegistry } from '@ironflow/core';

interface EventDefinitionOptions {
  name: string;
  version: number;
  upcast?: UpcasterFn;  // transforms from version-1 to this version
}

interface EventDefinition {
  name: string;
  version: number;
  upcast?: UpcasterFn;
}

// Define event versions
const OrderPlacedV2 = defineEvent({
  name: 'order.placed',
  version: 2,
  upcast: (data: any) => ({ ...data, currency: data.currency ?? 'USD' }),
});

const OrderPlacedV3 = defineEvent({
  name: 'order.placed',
  version: 3,
  upcast: (data: any) => ({ ...data, items: data.items ?? [] }),
});

// Register all versions
const eventRegistry = createEventDefinitionRegistry();
eventRegistry.register(OrderPlacedV2);
eventRegistry.register(OrderPlacedV3);

// Auto-upcast from any version to latest
const latest = eventRegistry.upcastEvent('order.placed', oldData, 1);

// Query latest version
eventRegistry.getLatestVersion('order.placed'); // 3
```

---

## Logger

```typescript
import { createLogger, createNoopLogger } from '@ironflow/core';
import type { LogLevel, LoggerConfig, Logger } from '@ironflow/core';

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

interface LoggerConfig {
  /** Minimum log level to output (default: "info", or IRONFLOW_LOG_LEVEL env var) */
  level?: LogLevel;
  /** Prefix for log messages (default: "[ironflow]") */
  prefix?: string;
}

interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
```

Usage:

```typescript
const logger = createLogger({ prefix: '[myapp]', level: 'debug' });
logger.info('Processing order', { orderId: '123' });
// Output: [myapp] Processing order {"orderId":"123"}

// Silent logger for tests
const noop = createNoopLogger();
```

The default log level reads from `IRONFLOW_LOG_LEVEL` environment variable, falling back to `"info"`.

---

## SecretsClient

Read-only interface for accessing resolved secrets inside function handlers. Secrets are declared in `FunctionConfig.secrets` and resolved by the engine at execution time.

```typescript
interface SecretsClient {
  /** Get a secret value by name. Throws if not found. */
  get(name: string): string;
  /** Check if a secret exists. */
  has(name: string): boolean;
}
```

Usage inside a function handler:

```typescript
const myFn = createFunction({
  id: 'charge-card',
  triggers: [{ event: 'order.placed' }],
  secrets: ['STRIPE_KEY'],
}, async ({ secrets, step }) => {
  const stripeKey = secrets.get('STRIPE_KEY');
  // ...
});
```

---

## Paused State Types

Returned by `getPausedState()` for runs paused via scoped injection.

```typescript
interface PausedStepInfo {
  id: string;
  name: string;
  output: unknown;
  /** Whether this step's output was injected via the inject API */
  injected: boolean;
  /** When the step completed (ISO 8601) */
  completedAt: string;
}

interface PausedState {
  steps: PausedStepInfo[];
  /** Hint for the next step that will execute on resume */
  nextStepHint: string;
  /** Reason the run was paused (e.g., "injection", "manual") */
  pauseReason: string;
}
```

---

## Time-Travel Debugging Types

Used by the time-travel debugger and inspect TUI to reconstruct historical run state.

```typescript
interface TimeTravelStepSnapshot {
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

interface TimeTravelRunStateSnapshot {
  runId: string;
  functionId: string;
  status: string;
  input: unknown;
  steps: TimeTravelStepSnapshot[];
  timestamp: Date;
  createdAt: Date | null;
}

interface TimeTravelTimelineEvent {
  id: string;
  eventType: string;
  stepId: string;
  stepName: string;
  summary: string;
  significant: boolean;
  timestamp: Date;
}

interface TimeTravelStepOutputSnapshot {
  stepId: string;
  status: string;
  output: unknown;
  originalOutput: unknown | null;
  patched: boolean;
  injected: boolean;
}

// Flat shapes returned by the higher-level time-travel client
interface TimeTravelRunState {
  runId: string;
  status: string;
  steps: Array<{ id: string; name: string; status: string; output: unknown }>;
  timestamp: string;
}

interface TimeTravelStepOutput {
  stepId: string;
  output: unknown;
  timestamp: string;
}
```

---

## Server Capabilities

Returned by the `/capabilities` endpoint.

```typescript
interface ServerCapabilities {
  /** Supported transports (e.g., "http", "grpc") */
  transports: string[];
  /** Feature flags (e.g., "projections", "entity-streams") */
  features: string[];
  /** Server version */
  version: string;
}
```

---

## Secrets Management Types

Distinct from `SecretsClient` (which is the read-only handler API). These are the management-side shapes.

```typescript
interface Secret {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface SecretListEntry {
  name: string;
  created_at: string;
  updated_at: string;
}
```

---

## Entity Stream Extension Types

```typescript
interface StreamListEntry {
  entityId: string;
  entityType: string;
  version: number;
  eventCount: number;
  lastEventAt: string;
}

interface EntityHistoryEntry {
  eventName: string;
  data: unknown;
  version: number;
  timestamp: string;
}

interface StreamSnapshot {
  entityId: string;
  entityType: string;
  version: number;
  state: unknown;
  takenAt: string;
}
```

---

## Project / Environment Types

```typescript
interface Project {
  id: string;
  name: string;
  description: string;
  org_id: string;
  created_at: string;
  updated_at: string;
}

interface Environment {
  id: string;
  name: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}
```

The 7-segment IRN is `irn:ironflow:{org}:{project}:{type}:{env}:{id}` (see project README).

---

## Event Schema Registry Types

```typescript
interface EventSchema {
  event_name: string;
  version: number;
  schema: Record<string, unknown>;
  created_at: string;
}

interface RegisterSchemaInput {
  name: string;
  version: number;
  schema: Record<string, unknown>;
}

interface TestUpcastInput {
  eventName: string;
  fromVersion: number;
  toVersion: number;
  data: unknown;
}

interface UpcastResult {
  success: boolean;
  data: unknown;
  error?: string;
}
```

---

## Webhook Management Types

Distinct from the in-process `WebhookConfig` (handler) — these are the registry/admin shapes.

```typescript
interface WebhookSource {
  id: string;
  eventPrefix: string;
  verifyHeader?: string;
  verifyAlgorithm?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface CreateWebhookSourceInput {
  id: string;
  eventPrefix: string;
  verifyHeader?: string;
  verifyAlgorithm?: string;
  verifySecret?: string;
  metadata?: Record<string, unknown>;
}

interface WebhookDelivery {
  id: string;
  sourceId: string;
  externalId?: string;
  status: string;
  eventId?: string;
  error?: string;
  createdAt?: string;
}

interface ListWebhookDeliveriesOptions {
  sourceId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}
```

---

## User and Tenant Types

```typescript
interface User {
  id: string;
  orgId: string;
  email: string;
  name?: string;
  roles?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface CreateUserInput {
  email: string;
  name?: string;
  password: string;
  roles?: string[];
}

interface UpdateUserInput {
  name?: string;
  email?: string;
  roles?: string[];
}

interface Tenant {
  id: string;
  name: string;
  envCount: number;
  keyCount: number;
  createdAt?: string;
}
```

---

## AuditTrailEntry

Generic timeline entry (distinct from the structured `AuditEvent`).

```typescript
interface AuditTrailEntry {
  id: string;
  type: string;
  timestamp: string;
  data: unknown;
}
```

---

## Convenience Aliases

```typescript
/** Type-erased function for collection slots, registries, factories. */
type AnyIronflowFunction = IronflowFunction<any, any>;
```

---

## Sub-Path Exports

The package provides additional entry points for selective imports:

| Path | What it exports |
|---|---|
| `@ironflow/core` | Everything (types, schemas, errors, constants, utils, protocol, patterns) |
| `@ironflow/core/schemas` | Zod schemas and validation helpers only |
| `@ironflow/core/protocol` | Protocol types and pattern helpers only |
| `@ironflow/core/gen` | Generated protobuf/ConnectRPC code (requires optional deps) |

---

## License

`LicenseRef-Ironflow-EULA` — see [LICENSE](https://github.com/sahina/ironflow-js/blob/main/LICENSE) at the repository root for the full Ironflow EULA.
