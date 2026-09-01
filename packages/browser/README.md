# @ironflow/browser

Browser client for [Ironflow](https://ironflow.run), an event-driven backend platform. Provides real-time subscriptions, workflow triggers, event emission, entity streams, projections, KV store, config management, and auth management for web applications.

This README is the sole reference for coding agents integrating with the browser SDK.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Connection Management](#connection-management)
- [Events and Subscriptions](#events-and-subscriptions)
- [Emitting Events](#emitting-events)
- [Offline Writes](#offline-writes)
- [Workflow Operations](#workflow-operations)
- [Agents (`ironflow.agents.*`)](#agents-ironflowagents)
- [Entity Streams (Event Sourcing)](#entity-streams-event-sourcing)
- [Projections](#projections)
- [KV Store](#kv-store)
- [Config Management](#config-management)
- [Auth Management](#auth-management)
- [Event Schema Registry](#event-schema-registry)
- [Webhook Source Management](#webhook-source-management)
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
    token: 'short-lived-session-token', // Preferred for browser applications
    // apiKey: 'ifkey_...',              // Development only; never ship in a browser bundle
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
  // error: { subscriptionId?: string; code: string; message: string; retrying?: boolean }
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

  // Backpressure handling: 'buffer' (default) | 'drop' | 'block'
  backpressure: 'buffer',

  // Browser-specific: track last event for state access
  trackState: true,
});

// When trackState is true, access the last received event:
console.log(sub.lastEvent);
```

To resume after an exact sequence, use `startAfterSequence` instead of
`replay`. Do not combine it with a consumer group. The SDK advances the cursor
after each delivered event and uses it on reconnect. Delivery remains
at-least-once, so handlers must tolerate a repeated in-flight event.

`replay` applies only to the initial subscribe request. Reconnects preserve the
filter, consumer group, metadata, acknowledgment, backpressure, and namespace
options but omit the original replay count. A fan-out subscription without a
cursor reconnects at the current tail and can miss events published while it
was offline. Use `startAfterSequence` or a consumer group when that gap matters.

```typescript
await ironflow.subscribe('events:order.*', {
  startAfterSequence: 400,
  onEvent: handleOrder,
});
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

Use the `patterns` utility to build subscription patterns. Import it directly:

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
await sub.ack(eventId);          // Acknowledge successful processing
await sub.nak(eventId, 5000);   // Negative ack with optional redelivery delay (ms)
await sub.term(eventId);         // Terminate - do not redeliver

sub.unsubscribe();
```

Create and manage the durable group definition separately from joining it:

```typescript
const group = await ironflow.consumerGroups.create({
  name: 'order-processors',
  pattern: 'events:order.*',
});
const groups = await ironflow.consumerGroups.list();
const one = await ironflow.consumerGroups.get(group.name);
await ironflow.consumerGroups.update(group.name, { maxInflight: 50 });
await ironflow.consumerGroups.delete(group.name);
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
await ackableSub.ack(eventId);
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

Publish to a developer topic without triggering workflow functions:

```typescript
const published = await ironflow.publish(
  'notifications',
  { userId: '123', message: 'Hello!' },
  { idempotencyKey: 'notification-123' },
);
console.log(published.eventId, published.sequence);
```

### Emit and Wait, Batch Emit

```typescript
// Wait for EVERY run the event triggers. Returns EmitSyncResult[] -- an event
// that matches nothing returns []. Run outcomes are never thrown: inspect
// status, error and waitTimedOut per element. A wait timeout leaves the run active.
const results = await ironflow.emitSync('order.placed', { orderId: '123' }, {
  timeout: 30000,
  idempotencyKey: 'order-123-placed',
});
for (const r of results) {
  console.log(r.runId, r.functionId, r.status, r.output, r.waitTimedOut);
}

// One round trip, one EmitResult per event, in order
const results = await ironflow.triggerBatch([
  { event: 'order.placed', data: { orderId: '1' } },
  { event: 'order.placed', data: { orderId: '2' }, idempotencyKey: 'order-2' },
]);
```

### Reading Stored Events

```typescript
// Keyset-paginated page of the event log
const page = await ironflow.listEvents({ name: 'order.placed', limit: 50 });
console.log(page.events, page.nextCursor);

// One stored event
const event = await ironflow.getEvent('evt_abc123');

// Distinct event names with counts, for pickers and filters
const { names } = await ironflow.listEventNames();
```

## Offline Writes

For apps that keep working with no connection. `createClient()` returns a client
whose `emit()` and `streams.append()` are written to an IndexedDB outbox first
and sent by a background drainer.

```typescript
import { createClient } from '@ironflow/browser';

const app = await createClient({
  serverUrl: 'https://api.example.com',
  auth: { token: session.accessToken },
  offlineQueue: {
    identity: session.userId,           // required, see below
    onAuthRequired: async () => ({ token: await refreshToken() }),
    onWriteLost: (write, reason) => toast(`A change was not saved: ${reason}`),
  },
});

const { localId } = await app.emit('order.placed', { orderId: '123' });
// Resolves immediately — nothing has been sent yet.

app.queue.watch(localId, (status) => {
  if (status.status === 'sent') markRowSynced();
});
```

Everything the ordinary client can do is on `app.client`:

```typescript
const run = await app.client.getRun(runId);
await app.client.subscribe('order.*', handler);
```

### What it does and does not promise

**Writes survive a reload, a crash, and a discarded tab.** They are on disk
before `emit()` resolves.

**They are not delivered in the background.** Nothing drains while the page is
frozen or closed; delivery happens the next time the app is open. Tell users
"saved, will sync when you're back", never "sent in the background". True
background delivery needs a service worker — see ADR 0053, Alternative A.

**Storage is best-effort.** Safari evicts an origin's IndexedDB after roughly
seven days with no interaction.

**`runIds` are not returned.** A run id cannot exist before the server creates
the run, and the point of the queue is to answer before contacting the server.
Subscribe for the outcome instead.

**Nothing attached to the returned promise survives a reload.** After a refresh
the `await` is gone but the write is still queued. Use `queue.watch(localId)` or
an event subscription — never a `.then()` — to react to delivery.

**The outbox is not encrypted.** Any XSS on your origin can read queued writes.
This matches Sentry, Segment, Workbox and Firestore, all of which store
plaintext. For a write that must never sit on disk, send it through
`app.client.emit()` instead, which throws when offline rather than queueing.

### `identity` is required, and is not your token

The outbox is per-origin, so a shared machine can hold one user's queue when the
next signs in. Every write records the `identity` in force when it was queued,
and a mismatch quarantines it rather than sending it as the wrong person.

Pass a stable id for the principal — a user id works. Do not pass the token: a
hash of a credential identifies the *credential*, so an ordinary token rotation
would make the same user look like a different one and quarantine their own
writes.

**`onAuthRequired` must report who signed in**, not just the new credential:

```typescript
onAuthRequired: async () => {
  const session = await showLoginPrompt();
  return { token: session.accessToken, identity: session.userId };
},
```

Returning the identity is what makes a shared machine safe. If a *different*
person signs in at that prompt — the normal outcome of showing a login form —
the queue rebinds to them, and the previous user's pending writes are
quarantined instead of being transmitted under the new user's credentials.

The callback is bounded at five minutes — generous, since the honest case is
someone reading a login form. The bound is there because a promise that never
settles at all (a modal the user dismissed, an auth server that hangs) would
otherwise hold the drain loop open for the life of the page: delivery would stop
with no in-app recovery while `pending` climbed to `maxItems`. On timeout the
queue backs off and asks again, and nothing is dead-lettered. Returning an
identity with no credential leaves the existing credential in place rather than
clearing it — `setAuth({})` would take the shared client's subscriptions down
with it.

Writes are also bound to the server and environment they were enqueued against.
Reconfiguring the underlying client while the queue is non-empty quarantines
those writes (`destination-mismatch`) rather than sending them somewhere they
were never meant to go.

### Delivery rules

| Response | What happens |
| --- | --- |
| 2xx | Removed from the outbox; watchers see `sent` |
| Network failure, 5xx, 429 | Retried with exponential backoff and jitter; stays at the head |
| 401 | Queue pauses, `onAuthRequired` runs, then it resumes |
| 403 and other 4xx | Moved to the dead-letter store; the queue advances |
| 2xx with an unreadable body | Dead-lettered as `RESPONSE_UNPARSEABLE` — retrying cannot fix it, and treating it as retryable would stall the whole queue behind it |

Writes are sent strictly in order, one at a time, and the queue does not advance
past one that has not been acknowledged. That is deliberate: `order.placed`
arriving after `order.shipped` is a corrupted projection, not a slow request. A
consequence worth planning for is that a full queue drains in as many round
trips as it has writes — `queue.subscribe()` reports `total` so you can render
"syncing 34 of 500" rather than a spinner that looks stuck.

### When it refuses

`emit()` and `streams.append()` throw rather than silently dropping:

- **`QueueFullError`** at 500 writes or 5 MB. The queue rejects rather than
  evicting the oldest. Dropping `order.placed` while keeping `order.shipped`
  would manufacture exactly the corruption the ordering guarantee prevents, so
  the app is told instead and can stop generating dependent writes.
- **A write bound to a different server, environment, or principal.** Quarantined
  to the dead-letter store rather than sent, with the reason naming which.
- **`streams.append` with `expectedVersion`.** A version read before the write
  was queued is stale by the time it sends, so the append would always lose its
  concurrency check. Use `expectedVersion: -1`, or write through
  `app.client.streams.append()`.
- **Bodies that are not JSON-serializable** (cycles, `BigInt`). Caught at
  enqueue rather than reporting "saved" for a write that could never be sent.

Writes older than `maxRetentionMs` (default 7 days) are dead-lettered instead of
delivered — a change queued nine days ago is usually more harmful to apply than
to drop. Everything that will never be sent lands in the dead-letter store:

```typescript
for (const entry of await app.queue.deadLetter()) {
  console.warn(entry.reason, entry.message, entry.write.body);
  await app.queue.retry(entry.write.localId);   // or .discard(...)
}
```

### Multiple tabs

One tab drains at a time, held by a Web Lock; the others keep their counters in
sync over `BroadcastChannel`. Without `navigator.locks` (Safari < 16) tabs may
interleave — writes are still deduplicated by the engine, but ordering across
tabs is not guaranteed.

### Environments without IndexedDB

Server rendering, Node, or a locked-down browser: the queue disables itself with
a console warning and writes are sent directly, so a shared config that sets
`offlineQueue` does not crash a server render. Check `app.queue.enabled` to know
which mode you are in; results report `queued: false, pending: false`.

## Workflow Operations

### Invoke a Workflow Function

`invoke()` is keyed by **function ID** and blocks for that one run's result over
`InvokeFunctionSync`. Because there is exactly one run, it throws
`RunFailedError`, `RunCancelledError` and `RunWaitTimeoutError` on the outcome --
the deliberate counterpart to `emitSync()`, which never does (ADR 0067).

```typescript
import { ironflow } from '@ironflow/browser';

// Invoke one function by ID, with typed input
const result = await ironflow.invoke<{ orderId: string }>('process-order', {
  data: { orderId: '123' },
  timeout: 30000,        // server-side wait budget, not a transport deadline
  idempotencyKey: 'order-123',
});

console.log(result.runId, result.status, result.output, result.durationMs);
```

Aborting the request cancels the run server-side: `InvokeFunctionSync` ties the
run's lifetime to the request context. To start a function *by event* without
waiting, use `emit()`, which returns `{ runIds, eventId }`.

### Get Run Status

```typescript
const run = await ironflow.getRun('run_abc123');

console.log(run.id);           // 'run_abc123'
console.log(run.functionId);   // 'process-order'
console.log(run.status);       // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'waiting_for_capacity' | 'waiting'
console.log(run.attempt);      // Current attempt number
console.log(run.maxAttempts);  // Maximum retry attempts
console.log(run.input);        // Input data
console.log(run.output);       // Output data (if completed)
console.log(run.error);        // { message, code } (if failed)
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

// Resume a paused or failed run
const run = await ironflow.resumeRun('run_abc123', 'step-to-resume-from');

// Hot-patch a step's output (replaces the stored output and replays downstream)
await ironflow.patchStep('step_xyz789', { correctedValue: 42 }, 'Manual fix');
```

### Run Introspection

```typescript
const { steps, count } = await ironflow.getRunSteps('run_abc123');
const { entityIds } = await ironflow.getRunStreams('run_abc123');
```

### Audit Trail

```typescript
const trail = await ironflow.getAuditTrail('run_abc123', { eventType: 'step.completed', limit: 50 });
```

### Function Lifecycle and Versioning

```typescript
const fn = await ironflow.getFunction('process-order');

await ironflow.updateFunctionStatus('process-order', 'paused');   // pause dispatch
await ironflow.deleteFunction('process-order');

const history = await ironflow.listFunctionHistory('process-order', { limit: 20 });
const older   = await ironflow.getFunctionAtVersion('process-order', 3);
await ironflow.rollbackFunction('process-order', 3, 'bad concurrency key');
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

Fire-and-wait. One `InvokeFunctionSync` call: the server creates exactly one run, waits for it, and returns its outcome. There is no subscribe and no replay window (ADR 0067).

```typescript
import { ironflow } from '@ironflow/browser';

const result = await ironflow.agents.invoke<{ category: string }>(
  'doc-processor',
  { docId: 'doc-1', imageUrl: 'https://example.com/x.png' },
  {
    timeoutMs: 60_000,             // default 30s
    idempotencyKey: 'click-abc',   // server-side dedup
    signal: ac.signal,             // AbortController; the server cancels the run
    // replay:       DEPRECATED, unread -- there is no subscription to replay
    // onRunStarted: DEPRECATED -- now fires AFTER the run settles, not before
    //               the wait. Use agents.subscribe(runId, { replay }) for
    //               live progress.
  }
);
console.log(result.runId, result.output, result.durationMs);
```

Errors:

| Throws | When |
|---|---|
| `ValidationError` | empty/oversized `name` |
| `AbortError` (DOMException) | `signal` aborts; the request dies and the **server** cancels the run -- the SDK issues no `cancelRun` |
| `AgentInvokeTimeoutError` | `timeoutMs` elapsed. An expired budget deliberately leaves the run alive, so here the SDK does best-effort `cancelRun(runId)` |
| `RunFailedError` | the run failed |
| `RunCancelledError` | the run was cancelled |

### `agents.subscribe(runId, callbacks, opts?)`

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

Typed read of an agent memory projection. Optional read-your-writes via `minSeq` (a NATS sequence, e.g. `targetSeq` from a prior `waitForEvent`).

```typescript
interface DocMemory {
  docs: Record<string, { status: 'ocr' | 'classified' | 'published'; category?: string }>;
}

// Read current state — eventual consistency.
const mem = await ironflow.agents.readMemory<DocMemory>('doc-processor-memory');
console.log(mem.state.docs, mem.version);

// Read-your-writes: streams.append does not return a NATS sequence under
// the transactional outbox — wait for the appended event to be processed
// (the server resolves eventId → seq), then read with the resolved seq.
const { eventId } = await ironflow.streams.append('agent-memory:doc-1', {
  name: 'DocProcessed',
  data: { docId: 'doc-1', status: 'classified' },
});
const wait = await ironflow.waitForEvent(eventId, 'doc-processor-memory', { timeoutMs: 5_000 });
const fresh = await ironflow.agents.readMemory<DocMemory>('doc-processor-memory', {
  minSeq: wait.targetSeq,
  timeoutMs: 5_000,
});
```

Throws `MemoryCatchupTimeoutError` if the projection cannot catch up to `minSeq` within `timeoutMs`. Throws `AbortError` on caller cancellation.

### React example

A complete browser-driven demo lives at `examples/agents/doc-processor-agent/web/`. It exercises `agents.invoke` + `agents.subscribe` against the doc-processor agent's crash-resume flow, and `agents.readMemory` to render per-doc state.

### Server compatibility

Requires Ironflow server with `waitForProjectionCatchup` (#473) and the unified Trigger path. Any server built from `main` after #608 (Lane D) supports the full surface.

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
console.log(result.eventId);        // Unique event ID (pass to waitForEvent for read-your-writes)
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

### List Streams and Read Entity History

```typescript
const streams = await ironflow.streams.listStreams();
const history = await ironflow.streams.getEntityHistory('order-123');
```

### Snapshots

Skip replaying a long stream from version 0 by snapshotting the materialized
state at a version.

```typescript
const { snapshotId } = await ironflow.streams.createSnapshot('order-123', {
  entityType: 'order',
  entityVersion: 1000,
  state: materialized,
});

const snap = await ironflow.streams.getSnapshot('order-123');
// Optional: only consider snapshots at or before a version
const older = await ironflow.streams.getSnapshot('order-123', { beforeVersion: 500 });
```

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
```

Projection lifecycle operations such as rebuild, pause, resume, and delete are
operator concerns and are intentionally not exposed by the Browser SDK.

### Read-Your-Writes

`streams.append()` returns no NATS sequence under the transactional outbox, so
resolve the event ID to a sequence with `waitForEvent`, then wait on it.

```typescript
const { eventId } = await ironflow.streams.append('order-123', event);

const wait = await ironflow.waitForEvent(eventId, 'order-detail-view', { timeoutMs: 5000 });

await ironflow.waitForProjectionCatchup('order-detail-view', {
  minSeq: wait.targetSeq,
  partition: 'order-123',
  timeoutMs: 5000,
});
```

### Query a SQL Projection

For projections materialized into relational tables (PostgreSQL backend).

```typescript
const result = await ironflow.querySQLProjection('board', {
  where: "status = 'OPEN'",
  orderBy: 'title ASC',
  limit: 50,
});
console.log(result.columns, result.rows, result.totalCount);
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

Read environment-scoped configuration and watch changes in real time. Config
mutations are intentionally limited to trusted server-side and operator clients.

```typescript
import { ironflow } from '@ironflow/browser';

const config = ironflow.configManager();

// Get a config by name
const settings = await config.get('app-settings');
console.log(settings.data);
console.log(settings.revision);  // Revision number

// List all configs
const all = await config.list();
// Returns ConfigEntry[]

// Watch for real-time config changes.
// Subscribes to system.config.{name}.updated. Auto-connects on first call —
// no explicit ironflow.connect() needed. Changes made through a trusted SDK,
// the CLI, dashboard, or REST API reach the subscriber. Payload includes
// `revision`; drop events whose
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

### Organizations

Gated by RBAC, not by a licence tier. Creating an org needs a **platform**
credential (`ifplatform_`) — a tenant key gets `403 platform credential
required`, because a tenant is pinned to one org (#660). Get/update/delete need
`orgs:manage` and are scoped to the caller's own org.

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

### Roles

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

// List policies assigned to a role
const assignedPolicies = await ironflow.roles.listPolicies('role_xyz789');

// Delete a role
await ironflow.roles.delete('role_xyz789');
```

### Policies

```typescript
// Create a policy
const policy = await ironflow.policies.create({
  name: 'allow-read',
  effect: 'deny',
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

### Rotating Credentials at Runtime

`setAuth` swaps the credential in place. Every request path reads `config.auth`
at send time, so the next request picks it up; an already-open subscription
keeps the credentials it connected with until it reconnects.

```typescript
ironflow.setAuth({ token: refreshedSession.accessToken });
```

## Event Schema Registry

Server-side JSON Schema registry for event contracts.

```typescript
await ironflow.schemas.register({
  name: 'order.placed',
  version: 2,
  schema: { type: 'object', properties: { orderId: { type: 'string' } } },
});

const all     = await ironflow.schemas.list();
const latest  = await ironflow.schemas.get('order.placed');
const v1      = await ironflow.schemas.getVersion('order.placed', 1);
await ironflow.schemas.delete('order.placed', 1);

// Dry-run a server-side upcast
const out = await ironflow.schemas.testUpcast({
  eventName: 'order.placed',
  fromVersion: 1,
  toVersion: 2,
  data: { orderId: '123' },
});
```

## Webhook Source Management

Manage the server-side webhook registry the dashboard and delivery tracking
read. Operator surface — an app that only receives webhooks does not need it.

```typescript
// ingestToken is returned only here and on rotate (ADR 0048) — capture it now.
const source = await ironflow.webhooks.create({
  name: 'Stripe production',
  eventPrefix: 'stripe',
});

const sources = await ironflow.webhooks.listSources();
const current = await ironflow.webhooks.getSource(source.id);

// Full-replace, not patch: omitted fields are cleared server-side.
await ironflow.webhooks.updateSource({
  id: current.id,
  name: 'Stripe production (EU)',
  expectedUpdatedAt: current.updatedAt,
});

// graceSeconds is tri-state: omit = server default, 0 = instant cutover, N = seconds.
await ironflow.webhooks.rotateSecret({ id: source.id, verifySecret: 'whsec_new' });
await ironflow.webhooks.expireSecretPrev(source.id);
await ironflow.webhooks.disableSignatureVerification({ id: source.id, graceSeconds: 0 });
await ironflow.webhooks.rotateIngestToken(source.id);

const { deliveries } = await ironflow.webhooks.listDeliveries({ sourceId: source.id, limit: 25 });
await ironflow.webhooks.deleteSource(source.id);
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

// Query the environment-wide audit stream
const auditPage = await ironflow.listAuditEvents({ eventType: 'run.failed', limit: 50 });

// Provision a tenant and initial administrator key. Both tenant calls
// require the `users:manage` permission; 403 otherwise.
const tenant = await ironflow.tenants.provision({ orgName: 'Acme' });
const tenants = await ironflow.tenants.list();

// Active subscription count — for leak audits; 0 when not configured
console.log(ironflow.getActiveSubscriptionCount());
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
    token: session.accessToken,
  },
});
```

Obtain `session.accessToken` from a trusted authentication backend. Do not put
an `ifkey_` environment key in a `NEXT_PUBLIC_*` variable or browser bundle.
Development builds warn when an `ifkey_` credential is configured.

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

The WebSocket URL is derived from `serverUrl` by replacing `http://` with
`ws://` and `https://` with `wss://`. Authentication is sent as WebSocket
subprotocol metadata, not as a `token=` query parameter, so credentials do not
appear in ordinary proxy access logs.

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
  auth: { token: session.accessToken },
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
  RunWaitTimeoutError,     // invoke() wait expired; durable run continues
  RunFailedError,          // agents.invoke: terminal run failure
  RunCancelledError,       // agents.invoke: terminal run cancellation
  AgentInvokeTimeoutError, // agents.invoke: local timeoutMs elapsed
  QueueFullError,          // offline queue at 500 writes or 5 MB
} from '@ironflow/browser';
```

Additionally, the REST request helper maps HTTP status codes to specific error types. Import these (and `MemoryCatchupTimeoutError` for `agents.readMemory`) from `@ironflow/core`:

- **401** -> `UnauthenticatedError` -- missing or invalid credentials
- **402** -> `EnterpriseRequiredError` -- legacy. Ironflow ships a single tier (ADR 0015) and the server no longer returns 402; the mapping is retained for compatibility
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
| `RUN_WAIT_TIMEOUT` | `invoke()` stopped waiting; the durable run continues. `emitSync()` sets `waitTimedOut` per result instead of throwing |
| `REQUEST_FAILED` | Network or fetch failure |
| `PATCH_FAILED` | Step patch operation failed |
| `NOT_CONFIGURED` | Client used before `configure()` |

## Browser Compatibility

- Chrome 80+
- Firefox 75+
- Safari 13.1+
- Edge 80+

The offline write queue degrades rather than requiring a newer baseline:

| Feature | Needs | Without it |
| --- | --- | --- |
| Outbox persistence | IndexedDB (all of the above) | Queue disables itself, writes go direct |
| Idempotency keys | `crypto.randomUUID` (Safari 15.4+) | Falls back to `crypto.getRandomValues` |
| One drainer across tabs | `navigator.locks` (Safari 16+) | Single-tab drain; tabs may interleave |
| Cross-tab pending counts | `BroadcastChannel` | Counters are tab-local |

Requires native `fetch`, `WebSocket`, and `AbortController` support.

## Exported Types

The package re-exports the following types from `@ironflow/core` for convenience:

**Run types:** `Run`, `RunStatus`, `RunInfo`, `ListRunsOptions`, `ListRunsResult`, `RunStep`, `RunStepsResult`, `RunStreamsResult`

**Function types:** `FunctionStatus`, `RegisteredFunction`, `FunctionChangeType`, `FunctionHistoryEntry`, `ListFunctionHistoryOptions`, `ListFunctionHistoryResult`

**Event types:** `IronflowEvent`, `EmitOptions`, `EmitResult`, `TriggerBatchEvent`, `StoredEvent`, `ListEventsOptions`, `ListEventsResult`, `EventNameCount`, `ListEventNamesOptions`, `ListEventNamesResult`

**Pub/Sub types:** `PublishOptions`, `PublishResult`

**Invoke/Trigger types:** `InvokeResult`, `TriggerResult` (deprecated alias), `EmitSyncResult`, `InvokeSyncOptions`, `InvokeSyncResult`

**Subscription types:** `SubscribeOptions`, `Subscription`, `AckableSubscription`, `SubscriptionEvent`, `SubscriptionErrorInfo`, `SubscriptionCallbacks`, `ConnectionState`, `AckHandle`

**Consumer group types:** `ConsumerGroup`, `ConsumerGroupConfig`, `ConsumerGroupStatus`, `AckMode`, `BackpressureMode`, `UpdateConsumerGroupInput`

**Entity stream types:** `AppendEventInput`, `AppendOptions`, `AppendResult`, `ReadStreamOptions`, `StreamEvent`, `StreamInfo`, `EntitySubscribeOptions`, `StreamListEntry`, `EntityHistoryEntry`

**Projection types:** `ProjectionStatusInfo`, `ProjectionStateResult`

**Audit types:** `AuditEvent`, `AuditTrailResult`, `GetAuditTrailOptions`, `ListAuditEventsOptions`

**Webhook management types:** `WebhookSource`, `CreateWebhookSourceInput`, `UpdateWebhookSourceInput`, `RotateWebhookSecretInput`, `DisableWebhookSignatureVerificationInput`, `WebhookDelivery`, `ListWebhookDeliveriesOptions`

**Tenant types:** `Tenant`, `ProvisionTenantInput`, `ProvisionTenantResult`

**KV types:** `KVBucketConfig`, `KVBucketInfo`, `KVEntry`, `KVPutResult`, `KVListKeysResult`, `KVListBucketsResult`, `KVWatchEvent`, `KVWatchCallbacks`, `KVWatchOptions`, `KVWatcher`

**Config types:** `ConfigResponse`, `ConfigEntry`, `ConfigWatchCallbacks`, `ConfigWatchEvent`

**Browser-specific types:** `IronflowClient` (type only — construct through `ironflow` or `createClient()`), `IronflowConfig`, `IronflowConfigOptions`, `ReconnectConfig`, `VisibilityConfig`, `AuthConfig`, `BrowserSubscribeOptions`, `SubscriptionGroup`, `Transport`, `TransportCallbacks`, `TransportFactory`, `TransportOptions`

**Agent types:** `AgentsNamespace`, `AgentInvokeOptions`, `AgentInvokeResult`, `AgentProgressEvent`, `AgentStepEvent`, `AgentSubscribeCallbacks`

**Offline queue types:** `CreateClientOptions`, `OfflineQueueConfig`, `QueueApi`, `QueuedWriteResult`, `QueuedWrite`, `QueuedWriteKind`, `DeadLetteredWrite`, `QueueState`, `QueueStats`, `WriteStatus`, `WriteLostReason`

**Logger:** `Logger`

**Utilities:** `patterns`, `DEFAULT_SERVER_URL`, `DEFAULT_WS_URL`, `DEFAULT_TIMEOUTS`, `getServerUrl`, `getWebSocketUrl`, `DEFAULT_CONFIG`, `mergeConfig`, `createWebSocketTransport`, `createConnectRPCTransport`, `queueDbName`

**Classes:** `BrowserKVClient`, `BrowserKVBucketHandle`, `BrowserConfigClient`, `SubscriptionManager`, `OfflineClient`, `createClient`

## Links

- [Documentation](https://docs.ironflow.run)
- [GitHub Repository](https://github.com/sahina/ironflow-js)

## License

LicenseRef-Ironflow-EULA — see repository LICENSE for full terms.
