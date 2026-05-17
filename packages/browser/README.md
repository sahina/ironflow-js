# @ironflow/browser

Browser client for [Ironflow](https://ironflow.run), an event-driven backend platform. Provides real-time subscriptions, workflow triggers, event emission, entity streams, projections, KV store, config management, and auth management for web applications.

This README is the sole reference for coding agents integrating with the browser SDK.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Connection Management](#connection-management)
- [Events and Subscriptions](#events-and-subscriptions)
- [Emitting Events](#emitting-events)
- [Workflow Operations](#workflow-operations)
- [Agents (`ironflow.agents.*`)](#agents-ironflowagents)
- [Entity Streams (Event Sourcing)](#entity-streams-event-sourcing)
- [Projections](#projections)
- [KV Store](#kv-store)
- [Config Management](#config-management)
- [Auth Management](#auth-management)
- [Server Inspection](#server-inspection)
- [React Integration Patterns](#react-integration-patterns)
- [Transport Configuration](#transport-configuration)
- [Error Handling](#error-handling)
- [Browser Compatibility](#browser-compatibility)

## Installation

```bash
npm install @ironflow/browser
```

The package re-exports commonly used types from `@ironflow/core`, so most applications only need this single dependency.

## Configuration

Call `ironflow.configure()` once at application startup before any other operations. The client is a singleton.

```typescript
import { ironflow } from '@ironflow/browser';

ironflow.configure({
  serverUrl: 'http://localhost:9123',   // Default: 'http://localhost:9123'
  transport: 'connectrpc',              // Default: 'connectrpc'. Options: 'connectrpc' | 'websocket'
  environment: 'default',               // Default: 'default'. Target environment for isolation.
  timeout: 30000,                       // Request timeout in ms (default: 30000)
  auth: {
    apiKey: 'your-api-key',             // API key for authentication
    token: 'bearer-token',              // Alternative: bearer token
  },
  reconnect: {
    enabled: true,                      // Default: true
    maxAttempts: 10,                    // Default: 10. Use -1 for infinite.
    backoff: {
      initial: 1000,                    // Default: 1000ms
      max: 30000,                       // Default: 30000ms
      multiplier: 2,                    // Default: 2
    },
  },
  visibility: {
    pauseOnHidden: true,                // Default: true. Pause subscriptions when tab is hidden.
    reconnectOnVisible: true,           // Default: true. Resume when tab becomes visible.
  },
  logger: false,                        // Default: console logger with [ironflow] prefix. Pass false to disable.
});
```

You can also pass `reconnect: false` as shorthand to disable reconnection entirely.

### Transport Auto-Detection

Use `detectTransport()` to probe the server and choose the best available transport. ConnectRPC is preferred over WebSocket.

```typescript
const transport = await ironflow.detectTransport();
// Returns 'connectrpc' | 'websocket'

ironflow.configure({
  serverUrl: 'http://localhost:9123',
  transport,
});
```

### Reading Configuration

```typescript
const config = ironflow.getConfig(); // Returns IronflowConfig. Throws NotConfiguredError if not configured.
const configured = ironflow.isConfigured; // boolean
```

## Connection Management

```typescript
// Subscriptions auto-connect on first use (10s connect timeout). You only
// need to call connect() eagerly if you want to surface connection failures
// before subscribing, or wait for the first handshake before rendering.
await ironflow.connect();

// Disconnect and clean up all subscriptions
ironflow.disconnect();

// Monitor connection state changes
const unsubscribe = ironflow.onConnectionChange((state) => {
  // state: 'connected' | 'disconnected' | 'connecting' | 'reconnecting'
  console.log('Connection state:', state);
});

// Stop listening
unsubscribe();

// Read current connection state
const state = ironflow.connectionState;
// Returns 'connected' | 'disconnected' | 'connecting' | 'reconnecting'
```

### Global Error Handler

Register a global handler that fires for all subscription errors:

```typescript
const unsubscribe = ironflow.onError((error) => {
  // error: { message: string; code: string; retryable?: boolean }
  console.error('Ironflow error:', error.message, error.code);
});
```

## Events and Subscriptions

### Basic Subscription

```typescript
import { ironflow } from '@ironflow/browser';

const sub = await ironflow.subscribe('events:order.*', {
  onEvent: (event) => {
    console.log('Event:', event.topic, event.data);
  },
  onError: (error) => {
    console.error('Subscription error:', error.message);
  },
  onStateChange: (state) => {
    console.log('Subscription connection state:', state);
  },
});

// Cleanup
sub.unsubscribe();
```

### Subscription Options

All options from `SubscribeOptions` plus `trackState` (browser-specific):

```typescript
const sub = await ironflow.subscribe('events:order.*', {
  onEvent: (event) => { /* ... */ },

  // Replay the last N historical events on connect
  replay: 100,

  // Include event metadata (timestamp, sequence)
  includeMetadata: true,

  // CEL expression for server-side content-based filtering
  filter: 'data.amount > 100',

  // Namespace for the subscription (default: "default")
  namespace: 'production',

  // Consumer group for load-balanced delivery (see Consumer Groups below)
  consumerGroup: 'order-processors',

  // Acknowledgment mode: 'auto' (default) | 'manual'
  ackMode: 'manual',

  // Backpressure handling: 'buffer' (default) | 'drop'
  backpressure: 'buffer',

  // Browser-specific: track last event for state access
  trackState: true,
});

// When trackState is true, access the last received event:
console.log(sub.lastEvent);
```

### Multiple Patterns

Subscribe to an array of patterns. Returns a combined subscription that unsubscribes from all at once:

```typescript
const sub = await ironflow.subscribe(
  ['system.run.*', 'events:order.*', 'events:payment.*'],
  {
    onEvent: (event) => {
      console.log('Received:', event.topic);
    },
  }
);

// Unsubscribes from all three patterns
sub.unsubscribe();
```

### Pattern Helpers

Use the `patterns` utility to build subscription patterns. Available as a static property on the client class and as a direct import:

```typescript
import { ironflow, patterns } from '@ironflow/browser';

// System run patterns
patterns.allRuns()                    // 'system.run.>'
patterns.run('run_abc123')            // 'system.run.run_abc123.>'
patterns.runLifecycle('run_abc123')   // 'system.run.run_abc123.*'
patterns.runSteps('run_abc123')       // 'system.run.run_abc123.step.>'

// Function patterns
patterns.allFunctions()               // 'system.function.>'
patterns.function('process-order')    // 'system.function.process-order.>'

// User event patterns
patterns.userEvent('order.*')         // 'events:order.*'
patterns.allUserEvents()              // 'events:>'

// Secret patterns
patterns.allSecrets()                 // 'system.secret.*'
patterns.secret('db-password')        // 'system.secret.db-password.*'
patterns.secretAction('updated')      // 'system.secret.*.updated'

// Developer pub/sub topic patterns
patterns.topic('chat.room-1')         // 'topic:chat.room-1'
patterns.allTopics()                  // 'topic:>'
```

### Subscription Groups

Batch-manage multiple subscriptions for easy cleanup:

```typescript
const group = ironflow.subscriptionGroup();

await group.add('system.run.*', {
  onEvent: (event) => console.log('Run event:', event),
});

await group.add('events:payment.*', {
  onEvent: (event) => console.log('Payment event:', event),
  replay: 10,
});

await group.add('events:order.*', {
  onEvent: (event) => console.log('Order event:', event),
});

// Unsubscribe from all at once
group.unsubscribeAll();
```

### Consumer Groups

Join a consumer group for load-balanced event processing across multiple browser tabs or clients. Consumer group subscriptions always use manual acknowledgment:

```typescript
const sub = await ironflow.joinConsumerGroup(
  'order-processors',      // group name
  'events:order.created',  // pattern
  {
    onEvent: (event) => {
      console.log('Processing order:', event.data);
    },
  }
);

// Returns AckableSubscription
sub.ack(eventId);                // Acknowledge successful processing
sub.nak(eventId, 5000);         // Negative ack with optional redelivery delay (ms)
sub.term(eventId);               // Terminate - do not redeliver

sub.unsubscribe();
```

Alternatively, use `subscribe` directly with `consumerGroup` and `ackMode` options:

```typescript
const sub = await ironflow.subscribe('events:order.created', {
  onEvent: (event) => { /* ... */ },
  consumerGroup: 'order-processors',
  ackMode: 'manual',
});

// sub is AckableSubscription when ackMode is 'manual'
const ackableSub = sub as AckableSubscription;
ackableSub.ack(eventId);
```

## Emitting Events

```typescript
import { ironflow } from '@ironflow/browser';

// Basic emit
const result = await ironflow.emit('order.approved', {
  orderId: '123',
  approvedBy: 'user@example.com',
});

console.log(result.eventId);   // Unique event ID assigned by server
console.log(result.runIds);    // IDs of any workflow runs triggered by this event

// With options
const result = await ironflow.emit(
  'order.approved',
  { orderId: '123', approvedBy: 'user@example.com' },
  {
    version: 2,                               // Event schema version (default: 1)
    idempotencyKey: 'order-123-approval',     // Deduplication key
    metadata: { source: 'dashboard' },        // Arbitrary metadata
    namespace: 'production',                  // Namespace (default: "default")
  }
);
```

## Workflow Operations

### Invoke a Workflow Function

```typescript
import { ironflow } from '@ironflow/browser';

// Invoke with typed input
const result = await ironflow.invoke<{ orderId: string }>('process-order', {
  data: { orderId: '123' },
});

console.log(result.runIds);   // ['run_abc123']
console.log(result.eventId);  // Event ID that triggered the run
```

### Get Run Status

```typescript
const run = await ironflow.getRun('run_abc123');

console.log(run.id);           // 'run_abc123'
console.log(run.functionId);   // 'process-order'
console.log(run.status);       // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
console.log(run.attempt);      // Current attempt number
console.log(run.maxAttempts);  // Maximum retry attempts
console.log(run.input);        // Input data
console.log(run.output);       // Output data (if completed)
console.log(run.error);        // Error message (if failed)
console.log(run.startedAt);    // Date | undefined
console.log(run.endedAt);      // Date | undefined
console.log(run.createdAt);    // Date
console.log(run.updatedAt);    // Date
```

### List Runs

```typescript
const result = await ironflow.listRuns({
  functionId: 'process-order',   // Filter by function
  status: 'failed',              // Filter by status
  limit: 25,                     // Page size
  cursor: 'next-page-token',    // Pagination cursor
});

console.log(result.runs);        // Run[]
console.log(result.totalCount);  // Total matching runs
console.log(result.nextCursor);  // Cursor for next page (undefined if last page)
```

### Cancel, Retry, Resume, Patch

```typescript
// Cancel a running workflow
const run = await ironflow.cancelRun('run_abc123', 'No longer needed');

// Retry a failed run (optionally from a specific step)
const run = await ironflow.retryRun('run_abc123', 'step-that-failed');

// Resume a paused or failed run
const run = await ironflow.resumeRun('run_abc123', 'step-to-resume-from');

// Hot-patch a step's output (replaces the stored output and replays downstream)
await ironflow.patchStep('step_xyz789', { correctedValue: 42 }, 'Manual fix');
```

### Scoped Injection

```typescript
// Pause a running workflow at the next step boundary
await ironflow.pauseRun("run_abc123");

// Get the paused state with completed steps
const state = await ironflow.getPausedState("run_abc123");
for (const step of state.steps) {
  console.log(step.name, step.output, step.injected);
}

// Inject modified output
const result = await ironflow.injectStepOutput(
  "run_abc123",
  "step_xyz",
  { corrected: true },
  "Fix calculation error"
);
console.log("Previous output:", result.previousOutput);

// Resume with injected data
await ironflow.resumeRun("run_abc123");
```

### Time-Travel Debugging (DVR Playback)

Replay and inspect workflow execution at any point in time. Requires the function to have `recording: true` enabled.

#### Get Run State at Timestamp

```typescript
const snapshot = await ironflow.getRunStateAt('run_abc123', new Date('2026-03-05T10:00:00Z'));
console.log(snapshot.status);  // Run status at that time
for (const step of snapshot.steps) {
  console.log(step.name, step.status, step.output);
}
```

#### Get Execution Timeline

```typescript
const timeline = await ironflow.getRunTimeline('run_abc123');
for (const event of timeline) {
  console.log(event.timestamp, event.summary);
}
```

#### Get Step Output at Timestamp

```typescript
const output = await ironflow.getStepOutputAt('run_abc123', 'step-id', new Date('2026-03-05T10:00:00Z'));
console.log(output.output);
console.log(output.patched);  // Whether output was injected
```

## Agents (`ironflow.agents.*`)

Browser helpers for `agent()` functions. Mirror the `@ironflow/node/agent` shape so the same agent runs in browser-driven UIs and server workers without divergence.

Spec: `src/agents/spec.md`. Issue #625.

### `agents.invoke(name, payload, opts?)`

Fire-and-wait. Triggers the agent, subscribes to its run events, resolves on the terminal `system.run.{runId}.completed` event.

```typescript
import { ironflow } from '@ironflow/browser';

const result = await ironflow.agents.invoke<{ category: string }>(
  'doc-processor',
  { docId: 'doc-1', imageUrl: 'https://example.com/x.png' },
  {
    timeoutMs: 60_000,             // default 30s
    idempotencyKey: 'click-abc',   // server-side dedup
    signal: ac.signal,             // AbortController
    replay: 1000,                  // default; covers the race window
    onRunStarted: (runId) => {},   // optional: surfaces runId before terminal
  }
);
console.log(result.runId, result.output, result.durationMs);
```

Errors:

| Throws | When |
|---|---|
| `ValidationError` | empty/oversized `name` |
| `AbortError` (DOMException) | `signal` aborts; SDK calls `cancelRun(runId)` server-side |
| `AgentInvokeTimeoutError` | local `timeoutMs` elapsed; SDK calls `cancelRun(runId)` |
| `NoRunCreatedError` | server returned empty `runIds` |
| `RunFailedError` | `system.run.{runId}.failed` |
| `RunCancelledError` | `system.run.{runId}.cancelled` |

### `agents.subscribe(runId, callbacks)`

Typed wrapper over the broader `subscribe(pattern)` API. Dispatches by topic.

```typescript
const sub = await ironflow.agents.subscribe(runId, {
  onProgress: (e) => console.log('progress', e.topic, e.status),
  onStep: (e) => console.log('step', e.stepId, e.type),
  onComplete: (r) => console.log('done', r.output),
  onFailed: (err) => console.warn('failed', err.message),
  onCancelled: () => console.warn('cancelled'),
  onError: (err) => console.error('transport', err),
});

// Unsubscribe is idempotent.
sub.unsubscribe();
```

### `agents.readMemory(projection, opts?)`

Typed read of an agent memory projection. Optional read-your-writes via `minSeq` from a prior `streams.append`.

```typescript
interface DocMemory {
  docs: Record<string, { status: 'ocr' | 'classified' | 'published'; category?: string }>;
}

// Read current state — eventual consistency.
const mem = await ironflow.agents.readMemory<DocMemory>('doc-processor-memory');
console.log(mem.state.docs, mem.version);

// Read-your-writes: pass the seq returned by a prior append so the
// projection has caught up before the read.
const { sequence } = await ironflow.streams.append('agent-memory:doc-1', {
  name: 'DocProcessed',
  data: { docId: 'doc-1', status: 'classified' },
});
const fresh = await ironflow.agents.readMemory<DocMemory>('doc-processor-memory', {
  minSeq: sequence,
  timeoutMs: 5_000,
});
```

Throws `MemoryCatchupTimeoutError` if the projection cannot catch up to `minSeq` within `timeoutMs`. Throws `AbortError` on caller cancellation.

### React example

A complete browser-driven demo lives at `examples/agents/doc-processor-agent/web/`. It exercises `agents.invoke` + `agents.subscribe` against the doc-processor agent's crash-resume flow, and `agents.readMemory` to render per-doc state.

### Server compatibility

Requires Ironflow server with `waitForProjectionCatchup` (#473) and the unified Trigger path. Any server built from `main` after #608 (Lane D) supports the full surface.

### Stuck or hanging?

See `_internal/runbooks/runbook-browser-agent-stuck.md` for triage.

## Entity Streams (Event Sourcing)

Entity streams store domain events per entity with optimistic concurrency control.

### Append Events

```typescript
import { ironflow } from '@ironflow/browser';

const result = await ironflow.streams.append('order-123', {
  name: 'order.created',       // Event name
  data: { total: 99.99 },      // Event payload
  entityType: 'order',         // Entity type (required)
}, {
  expectedVersion: 0,          // Optimistic concurrency (-1 = any, 0 = must not exist)
  idempotencyKey: 'create-order-123',  // Deduplication
  version: 1,                  // Event schema version (default: 1)
});

console.log(result.entityVersion);  // New entity version after append
console.log(result.eventId);        // Unique event ID
console.log(result.sequence);       // NATS JetStream sequence (pass to projections.waitForCatchup({ minSeq }))
```

### Read Stream

```typescript
const { events, totalCount } = await ironflow.streams.read('order-123', {
  direction: 'forward',     // 'forward' (default) | 'backward'
  limit: 50,                // Max events to return (0 = all)
  fromVersion: 0,           // Start from this version (0 = beginning)
});

for (const event of events) {
  console.log(event.id);             // Event ID
  console.log(event.name);           // 'order.created'
  console.log(event.data);           // { total: 99.99 }
  console.log(event.entityVersion);  // Version number
  console.log(event.version);        // Schema version
  console.log(event.timestamp);      // ISO 8601 timestamp
  console.log(event.source);         // Optional source identifier
  console.log(event.metadata);       // Optional metadata
}
```

### Get Stream Info

Returns `null` if no events have been written to this stream yet — safe to pass
`expectedVersion: 0` to `append()` in that case.

```typescript
const info = await ironflow.streams.getInfo('order-123');

if (info) {
  console.log(info.entityId);    // 'order-123'
  console.log(info.entityType);  // 'order'
  console.log(info.version);     // Current version number
  console.log(info.eventCount);  // Total events in stream
  console.log(info.createdAt);   // ISO 8601 timestamp
  console.log(info.updatedAt);   // ISO 8601 timestamp
}
```

**Returns:** `Promise<StreamInfo | null>`

### Subscribe to Stream Updates

```typescript
const sub = await ironflow.streams.subscribe('order-123', {
  entityType: 'order',                               // Required
  onEvent: (event) => {
    console.log('Stream event:', event.name, event.data);
  },
  onError: (error) => {
    console.error('Stream subscription error:', error);
  },
  replay: 100,                                       // Replay last 100 events
});

// Cleanup
sub.unsubscribe();
```

The subscription pattern is automatically constructed as `entity:{entityType}.{entityId}.>`.

## Projections

Projections build read models from event streams, maintained server-side.

### Get Projection State

```typescript
import { ironflow } from '@ironflow/browser';

// Get global projection state
const result = await ironflow.getProjection<{ totalOrders: number }>('order-stats');

console.log(result.name);           // 'order-stats'
console.log(result.state);          // { totalOrders: 42 }
console.log(result.partition);      // '__global__' or partition key
console.log(result.lastEventId);    // Last processed event ID
console.log(result.lastEventTime);  // Date | undefined (undefined before first event)
console.log(result.lastEventSeq);   // Last processed sequence number
console.log(result.version);        // Projection version
console.log(result.mode);           // 'managed' | 'external'
console.log(result.status);         // 'active' | 'rebuilding' | 'paused' | 'error'
console.log(result.errorMessage);   // Error string when status is 'error', else undefined
console.log(result.updatedAt);      // Date

// Get partitioned projection state
const result = await ironflow.getProjection('order-stats', {
  partition: 'customer-123',
});
```

### Subscribe to Projection Updates

```typescript
const sub = await ironflow.subscribeToProjection<{ totalOrders: number }>(
  'order-stats',
  {
    onUpdate: (state, event) => {
      console.log('New state:', state);             // { totalOrders: 43 }
      console.log('Triggered by:', event.id, event.name);
    },
    onError: (error) => {
      console.error('Projection error:', error);
    },
  },
  {
    partition: 'customer-123',  // Optional: subscribe to specific partition
    replay: 10,                  // Optional: replay last N updates
  }
);

sub.unsubscribe();
```

Without a partition, subscribes to `system.projection.{name}.>` (all partitions). With a partition, subscribes to `system.projection.{name}.{partition}.updated`.

### Projection Management

```typescript
// List all projections
const projections = await ironflow.listProjections();
for (const p of projections) {
  console.log(p.name, p.status, p.mode, p.lag);
}

// Get detailed status of a projection
const status = await ironflow.getProjectionStatus('order-stats');
console.log(status.name);          // 'order-stats'
console.log(status.status);        // 'active' | 'rebuilding' | 'paused' | 'error'
console.log(status.mode);          // 'managed' | 'external'
console.log(status.lastEventSeq);  // Last processed sequence number
console.log(status.lag);           // Number of unprocessed events
console.log(status.errorMessage);  // Error message if status is 'error'
console.log(status.updatedAt);     // Date

// Trigger a rebuild
const result = await ironflow.rebuildProjection('order-stats', {
  partition: 'customer-123',  // Optional: rebuild specific partition
  fromEventId: 'evt_abc',    // Optional: rebuild from specific event
  dryRun: true,               // Optional: validate without rebuilding
});
console.log(result.status);  // 'rebuilding' | 'dry_run_ok'
```

## KV Store

Distributed key-value storage backed by NATS JetStream with bucket management, TTL, compare-and-swap, and real-time watch.

### Getting a KV Client

```typescript
import { ironflow } from '@ironflow/browser';

const kv = ironflow.kv();
```

### Bucket Management

```typescript
// Create a bucket
const bucketInfo = await kv.createBucket({
  name: 'sessions',
  description: 'User session store',   // Optional
  ttlSeconds: 3600,                     // Optional: auto-expire keys (0 = no expiry)
  maxValueSize: 1024 * 1024,            // Optional: max value size in bytes
  maxBytes: 100 * 1024 * 1024,          // Optional: max total bucket size in bytes
  history: 5,                           // Optional: historical values per key (default: 1)
});

// List all buckets
const buckets = await kv.listBuckets();
// Returns KVBucketInfo[]

// Get bucket info
const info = await kv.getBucketInfo('sessions');

// Delete a bucket
await kv.deleteBucket('sessions');
```

### Key Operations

```typescript
const bucket = kv.bucket('sessions');

// Put a value (unconditional write)
const { revision } = await bucket.put('user-123', { token: 'abc', expiresAt: '...' });

// Get a value
const entry = await bucket.get('user-123');
console.log(entry.value);     // The stored value
console.log(entry.revision);  // Revision number for CAS

// Create only if key does not exist (if-not-exists)
const { revision } = await bucket.create('user-456', { token: 'def' });

// Update only if revision matches (compare-and-swap)
const { revision: newRev } = await bucket.update('user-123', { token: 'xyz' }, entry.revision);

// Soft delete (tombstone)
await bucket.delete('user-123');

// Hard delete (purge key and all history)
await bucket.purge('user-123');

// List keys with optional wildcard filter
const allKeys = await bucket.listKeys();
const userKeys = await bucket.listKeys('user-*');
```

### Watch for Changes

Real-time notifications via WebSocket when keys are updated or deleted:

```typescript
const watcher = bucket.watch(
  {
    onUpdate: (event) => {
      // event: KVWatchEvent (type: 'kv_update')
      console.log('Key changed:', event);
    },
    onError: (error) => {
      console.error('Watch error:', error);
    },
    onClose: () => {
      console.log('Watch connection closed');
    },
  },
  {
    key: 'user.*',  // Optional: only watch keys matching pattern
  }
);

// Stop watching
watcher.stop();
```

## Config Management

Centralized configuration management with set, get, patch, list, delete, and real-time watch.

```typescript
import { ironflow } from '@ironflow/browser';

const config = ironflow.configManager();

// Set a config (full document replacement)
const result = await config.set('app-settings', {
  theme: 'dark',
  locale: 'en',
  maxRetries: 3,
});

// Get a config by name
const settings = await config.get('app-settings');
console.log(settings.data);      // { theme: 'dark', locale: 'en', maxRetries: 3 }
console.log(settings.revision);  // Revision number

// Patch a config (shallow merge)
await config.patch('app-settings', { locale: 'fr' });

// List all configs
const all = await config.list();
// Returns ConfigEntry[]

// Delete a config (idempotent)
await config.delete('app-settings');

// Watch for real-time config changes.
// Subscribes to system.config.{name}.updated. Auto-connects on first call —
// no explicit ironflow.connect() needed. The server emits on set() and
// patch() after the KV write, so cross-tab / CLI / REST-triggered updates
// all reach the subscriber. Payload includes `revision`; drop events whose
// revision is lower than the last one you applied to guard against rare
// out-of-order deliveries under retry.
const watcher = await config.watch('app-settings', {
  onUpdate: (event) => {
    // event: ConfigWatchEvent ({ type: "config_update", name, data, revision, updatedAt })
    console.log('Config updated:', event.data, event.revision);
  },
  onError: (error) => {
    console.error('Watch error:', error);
  },
});

// `watcher` is a Subscription — call unsubscribe() to stop watching.
watcher.unsubscribe();
```

When the tab is backgrounded long enough that the browser silently kills the
websocket (common on mobile Safari), the SDK reconnects automatically as
soon as the tab becomes visible again — no subscriber action required.

## Auth Management

### API Keys

```typescript
import { ironflow } from '@ironflow/browser';

// Create an API key
const keyWithSecret = await ironflow.apiKeys.create({
  name: 'my-service-key',
  env_id: 'env_default',
});
console.log(keyWithSecret.key);  // Only returned once at creation time

// List all API keys
const keys = await ironflow.apiKeys.list();

// Get a specific API key
const key = await ironflow.apiKeys.get('apikey_abc123');

// Rotate an API key (returns new secret)
const rotated = await ironflow.apiKeys.rotate('apikey_abc123');
console.log(rotated.key);  // New secret

// Delete an API key
await ironflow.apiKeys.delete('apikey_abc123');
```

### Organizations (Enterprise)

Requires an Enterprise license. Returns `EnterpriseRequiredError` (HTTP 402) without one.

```typescript
// Create an organization
const org = await ironflow.orgs.create({ name: 'Acme Corp' });

// List all organizations
const orgs = await ironflow.orgs.list();

// Get a specific organization
const org = await ironflow.orgs.get('org_abc123');

// Update an organization
const updated = await ironflow.orgs.update('org_abc123', { name: 'Acme Inc' });

// Delete an organization
await ironflow.orgs.delete('org_abc123');
```

### Roles (Enterprise)

```typescript
// Create a role
const role = await ironflow.roles.create({
  name: 'editor',
  org_id: 'org_abc123',
});

// List roles (optionally filtered by org)
const roles = await ironflow.roles.list('org_abc123');

// Get a specific role
const role = await ironflow.roles.get('role_xyz789');

// Update a role
const updated = await ironflow.roles.update('role_xyz789', { name: 'senior-editor' });

// Assign a policy to a role
await ironflow.roles.assignPolicy('role_xyz789', 'policy_abc');

// Remove a policy from a role
await ironflow.roles.removePolicy('role_xyz789', 'policy_abc');

// Delete a role
await ironflow.roles.delete('role_xyz789');
```

### Policies (Enterprise)

```typescript
// Create a policy
const policy = await ironflow.policies.create({
  name: 'allow-read',
  effect: 'allow',
  actions: 'read',
  resources: '*',
  org_id: 'org_abc123',
});

// List policies (optionally filtered by org)
const policies = await ironflow.policies.list('org_abc123');

// Get a specific policy
const policy = await ironflow.policies.get('policy_abc');

// Update a policy
const updated = await ironflow.policies.update('policy_abc', {
  name: 'allow-read-write',
  actions: 'read,write',
});

// Delete a policy
await ironflow.policies.delete('policy_abc');
```

## Server Inspection

```typescript
import { ironflow } from '@ironflow/browser';

// List registered functions
const functions = await ironflow.listFunctions();

// List connected workers
const workers = await ironflow.listWorkers();

// Health check
const health = await ironflow.health();
console.log(health.status);     // 'ok'
console.log(health.timestamp);  // ISO 8601
console.log(health.version);    // Server version

// Get server capabilities
const caps = await ironflow.getCapabilities();
console.log(caps.transports);  // ['connectrpc', 'websocket']
console.log(caps.features);    // ['kv', 'projections', 'entity-streams', ...]
console.log(caps.version);     // Server version
```

## React Integration Patterns

### Subscription with useEffect Cleanup

```typescript
import { useEffect, useRef, useState } from 'react';
import { ironflow, type Subscription, type SubscriptionEvent } from '@ironflow/browser';

function OrderFeed() {
  const [orders, setOrders] = useState<SubscriptionEvent[]>([]);
  const subRef = useRef<Subscription | null>(null);

  useEffect(() => {
    let cancelled = false;

    ironflow.subscribe('events:order.*', {
      onEvent: (event) => {
        if (!cancelled) {
          setOrders((prev) => [...prev, event]);
        }
      },
      replay: 50,
    }).then((sub) => {
      if (cancelled) {
        sub.unsubscribe();
      } else {
        subRef.current = sub;
      }
    });

    return () => {
      cancelled = true;
      subRef.current?.unsubscribe();
      subRef.current = null;
    };
  }, []);

  return (
    <ul>
      {orders.map((o, i) => (
        <li key={i}>{o.name}: {JSON.stringify(o.data)}</li>
      ))}
    </ul>
  );
}
```

### Custom useIronflowSubscription Hook

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ironflow,
  type Subscription,
  type SubscriptionEvent,
  type SubscriptionCallbacks,
  type BrowserSubscribeOptions,
} from '@ironflow/browser';

function useIronflowSubscription<T = unknown>(
  pattern: string | null,
  options?: BrowserSubscribeOptions
) {
  const [events, setEvents] = useState<SubscriptionEvent<T>[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [connected, setConnected] = useState(false);
  const subRef = useRef<Subscription | null>(null);

  useEffect(() => {
    if (!pattern) return;

    let cancelled = false;

    ironflow.subscribe<T>(pattern, {
      onEvent: (event) => {
        if (!cancelled) {
          setEvents((prev) => [...prev, event]);
        }
      },
      onError: (err) => {
        if (!cancelled) {
          setError(new Error(err.message));
        }
      },
      onStateChange: (state) => {
        if (!cancelled) {
          setConnected(state === 'connected');
        }
      },
      ...options,
    }).then((sub) => {
      if (cancelled) {
        sub.unsubscribe();
      } else {
        subRef.current = sub;
        setConnected(true);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err);
      }
    });

    return () => {
      cancelled = true;
      subRef.current?.unsubscribe();
      subRef.current = null;
    };
  }, [pattern]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, error, connected, clear };
}

// Usage
function Dashboard() {
  const { events, error, connected } = useIronflowSubscription('system.run.>', {
    replay: 20,
  });

  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
      {events.map((e, i) => (
        <div key={i}>{e.name}</div>
      ))}
    </div>
  );
}
```

### Connection State Display

```typescript
import { useEffect, useState } from 'react';
import { ironflow, type ConnectionState } from '@ironflow/browser';

function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>(ironflow.connectionState);

  useEffect(() => {
    const unsubscribe = ironflow.onConnectionChange(setState);
    return unsubscribe;
  }, []);

  const colors: Record<ConnectionState, string> = {
    connected: 'green',
    disconnected: 'red',
    connecting: 'yellow',
    reconnecting: 'orange',
  };

  return (
    <span style={{ color: colors[state] }}>
      {state}
    </span>
  );
}
```

### App-Level Configuration

```typescript
// app/layout.tsx or main.tsx - configure once at app startup
import { ironflow } from '@ironflow/browser';

ironflow.configure({
  serverUrl: process.env.NEXT_PUBLIC_IRONFLOW_URL ?? 'http://localhost:9123',
  auth: {
    apiKey: process.env.NEXT_PUBLIC_IRONFLOW_API_KEY,
  },
});
```

## Transport Configuration

The browser client supports two transport protocols for real-time subscriptions:

### ConnectRPC (Default)

Uses HTTP/2 with Protocol Buffers. Preferred for production because it shares the same connection as REST API calls and supports bidirectional streaming.

```typescript
ironflow.configure({
  serverUrl: 'http://localhost:9123',
  transport: 'connectrpc',
});
```

### WebSocket

Uses a dedicated WebSocket connection. Useful as a fallback or when ConnectRPC is not available.

```typescript
ironflow.configure({
  serverUrl: 'http://localhost:9123',
  transport: 'websocket',
});
```

The WebSocket URL is derived from `serverUrl` by replacing `http://` with `ws://` and `https://` with `wss://`.

### Advanced: Custom Transport

For advanced use cases, transport factories and types are exported:

```typescript
import {
  createWebSocketTransport,
  createConnectRPCTransport,
  type Transport,
  type TransportOptions,
  type TransportCallbacks,
  type TransportFactory,
} from '@ironflow/browser';

// Create a transport manually
const options: TransportOptions = {
  auth: { apiKey: 'my-key' },
  autoReconnect: true,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  reconnectBackoff: 2,
  environment: 'default',
  connectionTimeout: 10000,
};

const transport = createConnectRPCTransport('http://localhost:9123', options);
```

## Error Handling

### Error Types

All error types are re-exported from `@ironflow/core`:

```typescript
import {
  IronflowError,           // Base error class for all Ironflow errors
  ConnectionError,         // Connection failures
  SubscriptionError,       // Subscription failures
  TimeoutError,            // Request timeouts
  ValidationError,         // Invalid response or input validation
  NotConfiguredError,      // Client used before configure() was called
  RunFailedError,          // agents.invoke: terminal run failure
  RunCancelledError,       // agents.invoke: terminal run cancellation
  AgentInvokeTimeoutError, // agents.invoke: local timeoutMs elapsed
  NoRunCreatedError,       // agents.invoke: server returned no runIds
} from '@ironflow/browser';
```

Additionally, the REST request helper maps HTTP status codes to specific error types. Import these (and `MemoryCatchupTimeoutError` for `agents.readMemory`) from `@ironflow/core`:

- **401** -> `UnauthenticatedError` -- missing or invalid credentials
- **402** -> `EnterpriseRequiredError` -- enterprise license required
- **403** -> `UnauthorizedError` -- insufficient permissions

### Error Utilities

```typescript
import { isRetryable, isIronflowError } from '@ironflow/browser';

try {
  await ironflow.invoke('process-order', { data: { orderId: '123' } });
} catch (error) {
  if (isIronflowError(error)) {
    console.log(error.message);    // Human-readable message
    console.log(error.code);       // Machine-readable code (e.g., 'HTTP_500', 'TIMEOUT')

    if (isRetryable(error)) {
      // Safe to retry (5xx errors, timeouts, connection failures)
    }
  }
}
```

### Error Codes

Common error codes returned by the client:

| Code | Description |
|------|-------------|
| `HTTP_4xx` / `HTTP_5xx` | HTTP status-based errors |
| `TIMEOUT` | Request exceeded the configured timeout |
| `REQUEST_FAILED` | Network or fetch failure |
| `PATCH_FAILED` | Step patch operation failed |
| `RESUME_FAILED` | Run resume operation failed |
| `NOT_CONFIGURED` | Client used before `configure()` |

## Browser Compatibility

- Chrome 80+
- Firefox 75+
- Safari 13.1+
- Edge 80+

Requires native `fetch`, `WebSocket`, and `AbortController` support.

## Exported Types

The package re-exports the following types from `@ironflow/core` for convenience:

**Run types:** `Run`, `RunStatus`, `RunInfo`, `ListRunsOptions`, `ListRunsResult`

**Event types:** `IronflowEvent`, `EmitOptions`, `EmitResult`

**Invoke/Trigger types:** `InvokeResult`, `TriggerSyncOptions`, `TriggerSyncResult`

**Subscription types:** `SubscribeOptions`, `Subscription`, `AckableSubscription`, `SubscriptionEvent`, `SubscriptionErrorInfo`, `SubscriptionCallbacks`, `ConnectionState`, `AckHandle`

**Consumer group types:** `ConsumerGroup`, `ConsumerGroupConfig`, `ConsumerGroupStatus`, `AckMode`, `BackpressureMode`

**Entity stream types:** `AppendEventInput`, `AppendOptions`, `AppendResult`, `ReadStreamOptions`, `StreamEvent`, `StreamInfo`, `EntitySubscribeOptions`

**Projection types:** `ProjectionStatusInfo`, `ProjectionStateResult`

**Time-travel types:** `TimeTravelRunStateSnapshot`, `TimeTravelTimelineEvent`, `TimeTravelStepSnapshot`, `TimeTravelStepOutputSnapshot`

**Scoped injection types:** `PausedStepInfo`, `PausedState`

**KV types:** `KVBucketConfig`, `KVBucketInfo`, `KVEntry`, `KVPutResult`, `KVListKeysResult`, `KVListBucketsResult`, `KVWatchEvent`, `KVWatchCallbacks`, `KVWatchOptions`, `KVWatcher`

**Config types:** `ConfigResponse`, `ConfigEntry`, `ConfigSetResult`, `ConfigWatchCallbacks`

**Browser-specific types:** `IronflowConfig`, `IronflowConfigOptions`, `ReconnectConfig`, `VisibilityConfig`, `AuthConfig`, `BrowserSubscribeOptions`, `SubscriptionGroup`, `Transport`, `TransportCallbacks`, `TransportFactory`, `TransportOptions`

**Utilities:** `patterns`, `DEFAULT_SERVER_URL`, `DEFAULT_WS_URL`, `DEFAULT_TIMEOUTS`, `getServerUrl`, `getWebSocketUrl`

**Classes:** `BrowserKVClient`, `BrowserKVBucketHandle`, `BrowserConfigClient`

## Links

- [Documentation](https://docs.ironflow.run)
- [GitHub Repository](https://github.com/sahina/ironflow-js)

## License

LicenseRef-Ironflow-EULA — see repository LICENSE for full terms.
