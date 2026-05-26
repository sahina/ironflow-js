# @ironflow/node

Node.js SDK for [Ironflow](https://ironflow.run), an event-driven backend platform. Provides workers (pull mode), serve handlers (push mode), step execution, projections, entity streams, subscriptions, KV store, config management, webhooks, auth management, and testing utilities.

Published as a public npm package under a commercial license — see [LICENSE](https://github.com/sahina/ironflow-js/blob/main/LICENSE).

## Installation

```bash
npm install @ironflow/node
```

Requires Node.js 22+.

## Table of Contents

1. [Defining Functions](#defining-functions)
2. [Step Primitives](#step-primitives)
3. [Saga Compensation](#saga-compensation)
4. [Push Mode (serve)](#push-mode-serve)
5. [Pull Mode (createWorker)](#pull-mode-createworker)
6. [Streaming Worker](#streaming-worker)
7. [Server-Side Client](#server-side-client)
8. [Entity Streams](#entity-streams)
9. [KV Store](#kv-store)
10. [Config Management](#config-management)
11. [Auth Management](#auth-management)
12. [Subscriptions](#subscriptions)
13. [Projections](#projections)
14. [Webhooks](#webhooks)
15. [Event Versioning (Upcasters)](#event-versioning-upcasters)
16. [Error Handling](#error-handling)
17. [Environment Variables](#environment-variables)
18. [Agent Primitives](#agent-primitives)
19. [Testing](#testing)

---

## Defining Functions

Use `createFunction(config, handler)` to define a workflow function. The function is triggered by events and executes durable steps.

### Basic function (untyped)

```typescript
import { createFunction } from '@ironflow/node';

const processOrder = createFunction(
  {
    id: 'process-order',
    triggers: [{ event: 'order.placed' }],
  },
  async ({ event, step }) => {
    const validated = await step.run('validate', async () => {
      return validateOrder(event.data);
    });
    return { success: true, orderId: validated.orderId };
  }
);
```

### With Zod schema validation

When you provide a `schema`, `event.data` is fully typed from the schema.

```typescript
import { createFunction } from '@ironflow/node';
import { z } from 'zod';

const OrderSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
  customerId: z.string(),
});

const processOrder = createFunction(
  {
    id: 'process-order',
    triggers: [{ event: 'order.placed' }],
    schema: OrderSchema,
  },
  async ({ event, step }) => {
    // event.data is typed as { orderId: string; amount: number; customerId: string }
    const receipt = await step.run('charge', async () => {
      return chargeCard(event.data.customerId, event.data.amount);
    });
    return { receiptId: receipt.id };
  }
);
```

### FunctionConfig reference

All fields on the config object:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | **Required.** Unique function identifier. |
| `name` | `string` | Display name. Defaults to `id`. |
| `description` | `string` | Human-readable description shown in the dashboard. |
| `triggers` | `Trigger[]` | **Required.** Array of event triggers (can be empty for invoke-only functions). |
| `retry` | `RetryConfig` | Retry policy for failed steps. |
| `timeout` | `number` | Function timeout in milliseconds (default: 600000 = 10 min). |
| `concurrency` | `ConcurrencyConfig` | Concurrency control. |
| `debounce` | `DebounceConfig` | Debounce configuration — collapses rapid-fire events into a single invocation. |
| `mode` | `"push" \| "pull"` | Preferred execution mode. |
| `actorKey` | `string` | JSON path for actor-based sticky routing (e.g., `"event.data.customerId"`). |
| `schema` | `ZodType` | Zod schema for event data validation and type inference. |
| `secrets` | `string[]` | Secret names this function requires (resolved by the engine). |
| `stepTimeout` | `string` | Default timeout for all `step.run()` calls (e.g., `"30s"`, `"5m"`). |
| `recording` | `boolean` | Enable audit recording for this function. |
| `recordingRetention` | `string` | Retention period for audit events (`"7d"`, `"30d"`, `"90d"`, `"forever"`). |
| `pauseBehavior` | `"hold" \| "release"` | Controls whether a paused run retains (`"hold"`, default) or releases (`"release"`) its concurrency lane slot. |
| `compensateOnCancel` | `boolean` | Run registered `step.compensate()` handlers in reverse order when a pull-mode run is cancelled mid-saga. Ignored for push-mode. |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata attached to the function definition. |

**Trigger** fields:

| Field | Type | Description |
|-------|------|-------------|
| `event` | `string` | Event name pattern (e.g., `"order.placed"`). |
| `expression` | `string` | Optional CEL expression for filtering. |
| `cron` | `string` | Cron schedule (e.g., `"0 9 * * *"` for 9am daily). |

**RetryConfig** fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum retry attempts. |
| `initialDelayMs` | `number` | `1000` | Initial delay between retries. |
| `backoffFactor` | `number` | `2.0` | Backoff multiplier. |
| `maxDelayMs` | `number` | `300000` | Maximum delay between retries. |

**ConcurrencyConfig** fields:

| Field | Type | Description |
|-------|------|-------------|
| `limit` | `number` | Maximum concurrent executions. |
| `key` | `string` | JSON path for grouping (e.g., `"event.data.customerId"`). |

### Full config example

```typescript
const processOrder = createFunction(
  {
    id: 'process-order',
    name: 'Process Order',
    triggers: [
      { event: 'order.placed' },
      { event: 'order.retry', expression: 'event.data.priority > 5' },
      { cron: '0 */6 * * *', event: 'scheduled.cleanup' },
    ],
    retry: { maxAttempts: 5, initialDelayMs: 2000, backoffFactor: 3 },
    timeout: 300000,
    concurrency: { limit: 10, key: 'event.data.customerId' },
    mode: 'pull',
    actorKey: 'event.data.customerId',
    schema: OrderSchema,
    secrets: ['STRIPE_SECRET_KEY', 'SENDGRID_API_KEY'],
    stepTimeout: '30s',
    recording: true,
    recordingRetention: '30d',
  },
  async ({ event, step, secrets }) => {
    const apiKey = secrets.get('STRIPE_SECRET_KEY');
    // ...
  }
);
```

---

## Step Primitives

Every step is durable and memoized. If the workflow retries, previously completed steps are skipped and their stored results are returned.

### step.run(name, fn, options?)

Execute a memoized step. Use for any non-idempotent operation (API calls, payments, emails).

```typescript
const processOrder = createFunction(
  { id: 'process-order', triggers: [{ event: 'order.placed' }] },
  async ({ event, step }) => {
    // Basic usage
    const result = await step.run('charge-card', async () => {
      return chargeCard(event.data.amount);
    });

    // With timeout override
    const enriched = await step.run('enrich-data', async () => {
      return callSlowApi(event.data.id);
    }, { timeout: '60s' });

    return { transactionId: result.id, enriched };
  }
);
```

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `timeout` | `string` | Step timeout (e.g., `"30s"`, `"5m"`, `"1h"`). Overrides function-level `stepTimeout`. |

### step.sleep(name, duration)

Durable sleep that survives process restarts and server upgrades.

```typescript
const delayedNotification = createFunction(
  { id: 'delayed-notify', triggers: [{ event: 'user.signup' }] },
  async ({ event, step }) => {
    await step.run('send-welcome', async () => {
      return sendWelcomeEmail(event.data.email);
    });

    // Durable sleep - workflow pauses and resumes after duration
    await step.sleep('wait-for-trial', '7d');

    await step.run('send-trial-ending', async () => {
      return sendTrialEndingEmail(event.data.email);
    });
  }
);
```

**Duration formats:** `"30s"`, `"5m"`, `"1h"`, `"7d"`, or milliseconds as a number.

### step.sleepUntil(name, date)

Sleep until a specific point in time.

```typescript
const scheduledTask = createFunction(
  { id: 'scheduled-task', triggers: [{ event: 'task.scheduled' }] },
  async ({ event, step }) => {
    // Sleep until a specific Date object
    await step.sleepUntil('wait-until-date', new Date('2025-12-31T00:00:00Z'));

    // Or an ISO string
    await step.sleepUntil('wait-until-deadline', event.data.deadline);

    await step.run('execute', async () => {
      return executeTask(event.data.taskId);
    });
  }
);
```

### step.waitForEvent(name, filter)

Wait for an external event to arrive. The workflow pauses durably until a matching event is emitted.

```typescript
const approvalWorkflow = createFunction(
  { id: 'approval-flow', triggers: [{ event: 'approval.requested' }] },
  async ({ event, step }) => {
    await step.run('notify-approver', async () => {
      return sendApprovalRequest(event.data.approverId);
    });

    // Wait for the approval event (default timeout: 7 days)
    const approval = await step.waitForEvent('wait-approval', {
      event: 'approval.received',
      match: 'data.requestId',  // JSON path for matching
      timeout: '48h',
    });

    if (approval.data.approved) {
      await step.run('process-approved', async () => {
        return processApproval(event.data.requestId);
      });
    }

    return { approved: approval.data.approved };
  }
);
```

**EventFilter fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `event` | `string` | -- | Event name to wait for. |
| `match` | `string` | -- | JSON path for correlating events. |
| `timeout` | `Duration` | `"7d"` | How long to wait before timing out. |

### step.invoke(functionId, input?, options?)

Call another Ironflow function and wait for its result. Creates a child run.

```typescript
const orchestrator = createFunction(
  { id: 'orchestrator', triggers: [{ event: 'workflow.start' }] },
  async ({ event, step }) => {
    // Invoke and wait for result (default timeout: 30s)
    const result = await step.invoke('process-payment', {
      orderId: event.data.orderId,
      amount: event.data.amount,
    });

    // With custom timeout
    const report = await step.invoke('generate-report', {
      orderId: event.data.orderId,
    }, { timeout: '5m' });

    return { paymentResult: result, report };
  }
);
```

### step.invokeAsync(functionId, input?)

Fire-and-forget: trigger another function without waiting for its result. Returns the child run ID.

```typescript
const orderPipeline = createFunction(
  { id: 'order-pipeline', triggers: [{ event: 'order.placed' }] },
  async ({ event, step }) => {
    // Fire and forget - does not block
    const { runId } = await step.invokeAsync('send-confirmation-email', {
      orderId: event.data.orderId,
      email: event.data.email,
    });

    return { emailRunId: runId };
  }
);
```

### step.parallel(name, branches, options?)

Execute multiple branches in parallel. Each branch receives its own scoped `step` client with isolated step IDs.

```typescript
const enrichUser = createFunction(
  { id: 'enrich-user', triggers: [{ event: 'user.created' }] },
  async ({ event, step }) => {
    const [profile, creditScore, preferences] = await step.parallel(
      'fetch-all',
      [
        async (s) => s.run('fetch-profile', () => fetchProfile(event.data.userId)),
        async (s) => s.run('fetch-credit', () => fetchCreditScore(event.data.userId)),
        async (s) => s.run('fetch-prefs', () => fetchPreferences(event.data.userId)),
      ]
    );

    return { profile, creditScore, preferences };
  }
);
```

**ParallelOptions:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `concurrency` | `number` | unlimited | Maximum concurrent branches. |
| `onError` | `"failFast" \| "allSettled"` | `"failFast"` | `"failFast"`: first failure cancels pending branches. `"allSettled"`: all branches complete, errors in results. |

```typescript
// With concurrency limit and allSettled error handling
const results = await step.parallel(
  'batch-process',
  items.map((item) => async (s) => {
    return s.run(`process-${item.id}`, () => processItem(item));
  }),
  { concurrency: 5, onError: 'allSettled' }
);
```

### step.map(name, items, fn, options?)

Parallel map over an array of items. Convenience wrapper around `step.parallel`.

```typescript
const batchProcessor = createFunction(
  { id: 'batch-process', triggers: [{ event: 'batch.ready' }] },
  async ({ event, step }) => {
    const results = await step.map(
      'process-items',
      event.data.items,
      async (item, s, index) => {
        return s.run(`process-${index}`, () => processItem(item));
      },
      { concurrency: 3 }
    );

    return { processed: results.length };
  }
);
```

### step.compensate(stepName, fn)

Register a compensation function (saga rollback) for a previously completed step. Compensations run automatically in reverse order on terminal (non-retryable) failures.

```typescript
const transferFunds = createFunction(
  { id: 'transfer-funds', triggers: [{ event: 'transfer.requested' }] },
  async ({ event, step }) => {
    const debit = await step.run('debit', async () => {
      return debitAccount(event.data.fromAccount, event.data.amount);
    });
    step.compensate('debit', async () => {
      await creditAccount(event.data.fromAccount, event.data.amount);
    });

    const credit = await step.run('credit', async () => {
      return creditAccount(event.data.toAccount, event.data.amount);
    });
    step.compensate('credit', async () => {
      await debitAccount(event.data.toAccount, event.data.amount);
    });

    return { debitRef: debit.ref, creditRef: credit.ref };
  }
);
```

### step.publish(topic, data)

Publish a message to a developer pub/sub topic. The publish is memoized like any other step.

```typescript
const orderProcessor = createFunction(
  { id: 'order-processor', triggers: [{ event: 'order.placed' }] },
  async ({ event, step }) => {
    const result = await step.run('process', async () => {
      return processOrder(event.data);
    });

    // Publish to a topic (does NOT trigger workflow functions)
    await step.publish('order-notifications', {
      orderId: event.data.orderId,
      status: 'processed',
    });

    return result;
  }
);
```

---

## Saga Compensation

Compensations provide automatic rollback for distributed transactions. When a terminal (non-retryable) failure occurs, all registered compensations run in reverse order. Each compensation is itself a durable, memoized step.

```typescript
import { createFunction, NonRetryableError } from '@ironflow/node';

const bookTrip = createFunction(
  { id: 'book-trip', triggers: [{ event: 'trip.requested' }] },
  async ({ event, step }) => {
    // Step 1: Book flight
    const flight = await step.run('book-flight', async () => {
      return bookFlight(event.data.flightId);
    });
    step.compensate('book-flight', async () => {
      await cancelFlight(flight.confirmationId);
    });

    // Step 2: Book hotel
    const hotel = await step.run('book-hotel', async () => {
      return bookHotel(event.data.hotelId, event.data.dates);
    });
    step.compensate('book-hotel', async () => {
      await cancelHotel(hotel.confirmationId);
    });

    // Step 3: Book car rental (if this fails with a non-retryable error,
    // both hotel and flight compensations run in reverse order)
    const car = await step.run('book-car', async () => {
      const result = await bookCar(event.data.carId);
      if (!result.available) {
        throw new NonRetryableError('Car not available');
      }
      return result;
    });
    step.compensate('book-car', async () => {
      await cancelCar(car.confirmationId);
    });

    return { flight, hotel, car };
  }
);
```

Key behaviors:
- Compensations only run on **terminal** (non-retryable) failures.
- They run in **reverse registration order** (last registered runs first).
- Each compensation is recorded as a durable step (`compensate:<stepName>`).
- If a compensation itself fails, the error is logged but remaining compensations still run.

---

## Push Mode (serve)

The `serve()` function creates a universal HTTP handler for serverless deployment. It works with any framework that uses the Fetch `Request`/`Response` API or Node.js `IncomingMessage`/`ServerResponse`.

### ServeConfig reference

| Field | Type | Description |
|-------|------|-------------|
| `functions` | `IronflowFunction[]` | **Required.** Functions to handle. |
| `projections` | `IronflowProjection[]` | Logs a warning -- use `createWorker` for projections. |
| `signingKey` | `string` | HMAC-SHA256 signing key for request verification. |
| `skipVerification` | `boolean` | Skip signature verification (dev only). |
| `logger` | `Logger \| false` | Custom logger or `false` to disable. |
| `environment` | `string` | Target environment (default: `IRONFLOW_ENV` or `"default"`). |
| `eventDefinitions` | `EventDefinitionRegistry` | Registry for automatic event upcasting. |
| `serverUrl` | `string` | Ironflow server URL (for emitting webhook events). |
| `webhooks` | `IronflowWebhook[]` | Webhook sources to handle. |

### Next.js App Router

```typescript
// app/api/ironflow/route.ts
import { serve } from '@ironflow/node';
import { processOrder } from '@/functions/process-order';

export const POST = serve({
  functions: [processOrder],
  signingKey: process.env.IRONFLOW_SIGNING_KEY,
});
```

### Express

```typescript
import express from 'express';
import { serve } from '@ironflow/node';
import { processOrder } from './functions/process-order.js';

const app = express();

app.post('/api/ironflow', serve({
  functions: [processOrder],
  signingKey: process.env.IRONFLOW_SIGNING_KEY,
}));

app.listen(3000);
```

### Hono

```typescript
import { Hono } from 'hono';
import { serve } from '@ironflow/node';
import { processOrder } from './functions/process-order.js';

const app = new Hono();

app.post('/api/ironflow', serve({
  functions: [processOrder],
  signingKey: process.env.IRONFLOW_SIGNING_KEY,
}));

export default app;
```

---

## Pull Mode (createWorker)

Workers poll the Ironflow server for jobs via REST HTTP. Use for long-running tasks with no timeout limits.

### WorkerConfig reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverUrl` | `string` | `http://localhost:9123` | Ironflow server URL. |
| `functions` | `IronflowFunction[]` | -- | **Required.** Functions this worker handles. |
| `projections` | `IronflowProjection[]` | -- | Projections to run alongside functions. |
| `maxConcurrentJobs` | `number` | `10` | Maximum concurrent job executions. |
| `heartbeatInterval` | `number` | `30000` | Heartbeat interval in ms. |
| `reconnectDelay` | `number` | `5000` | Reconnect delay in ms. |
| `labels` | `Record<string, string>` | -- | Worker labels for routing. |
| `logger` | `Logger \| false` | -- | Custom logger or `false` to disable. |
| `environment` | `string` | `IRONFLOW_ENV` or `"default"` | Target environment. |
| `eventDefinitions` | `EventDefinitionRegistry` | -- | Registry for automatic event upcasting. |
| `apiKey` | `string` | `IRONFLOW_API_KEY` env | API key for authentication. |
| `transport` | `"polling" \| "streaming"` | `"polling"` | Worker transport mode. |

### Worker interface

| Method | Description |
|--------|-------------|
| `start()` | Start the worker. Blocks until stopped. Auto-reconnects on failure. |
| `drain()` | Gracefully drain: stop accepting new jobs, wait for active jobs to complete, then stop. |
| `stop()` | Force stop immediately. Cancels all active jobs. |

```typescript
import { createWorker } from '@ironflow/node';
import { processOrder, sendNotification } from './functions.js';
import { orderTotals } from './projections.js';

const worker = createWorker({
  serverUrl: 'http://localhost:9123',
  functions: [processOrder, sendNotification],
  projections: [orderTotals],
  maxConcurrentJobs: 20,
  labels: { region: 'us-east-1' },
  apiKey: process.env.IRONFLOW_API_KEY,
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.drain();
  process.exit(0);
});

await worker.start();
```

---

## Streaming Worker

For low-latency bidirectional streaming via ConnectRPC. Same `WorkerConfig` as `createWorker`, but uses gRPC bidirectional streaming instead of HTTP polling.

Import from the separate `@ironflow/node/worker-streaming` entry point to avoid loading protobuf dependencies unless needed.

```typescript
import { createStreamingWorker } from '@ironflow/node/worker-streaming';
import { processOrder } from './functions.js';

const worker = createStreamingWorker({
  serverUrl: 'http://localhost:9123',
  functions: [processOrder],
  maxConcurrentJobs: 10,
});

process.on('SIGTERM', async () => {
  await worker.drain();
  process.exit(0);
});

await worker.start();
```

Requires optional dependencies: `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-node`.

---

## Server-Side Client

The HTTP client for interacting with the Ironflow server from your backend code.

### IronflowClientConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverUrl` | `string` | `http://localhost:9123` or `IRONFLOW_SERVER_URL` | Server URL. |
| `apiKey` | `string` | -- | API key for authentication. |
| `timeout` | `number` | `30000` | Request timeout in ms. |
| `onError` | `OnErrorHandler` | -- | Global error handler (optional). |

### Creating a client

```typescript
import { createClient } from '@ironflow/node';

const client = createClient({
  serverUrl: 'http://localhost:9123',
  apiKey: process.env.IRONFLOW_API_KEY,
});
```

### emit(eventName, data, options?)

Emit an event to trigger workflow functions.

```typescript
const result = await client.emit('order.placed', {
  orderId: '123',
  amount: 99.99,
});
console.log('Run IDs:', result.runIds);
console.log('Event ID:', result.eventId);
```

**EmitOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Event schema version (default: 1). |
| `idempotencyKey` | `string` | Prevent duplicate processing. |
| `metadata` | `Record<string, unknown>` | Additional metadata. |

```typescript
await client.emit('order.placed', { orderId: '123' }, {
  version: 2,
  idempotencyKey: 'order-123-placed',
  metadata: { source: 'api', traceId: 'abc' },
});
```

### getRun(runId)

Get a run by its ID.

```typescript
const run = await client.getRun('run_abc123');
console.log(run.status);    // "completed" | "running" | "failed" | "cancelled" | ...
console.log(run.output);    // Function return value (if completed)
console.log(run.error);     // { message, code } (if failed)
```

### listRuns(options?)

List runs with optional filtering and pagination.

```typescript
const result = await client.listRuns({
  functionId: 'process-order',
  status: 'failed',
  limit: 25,
  cursor: 'next_page_cursor',
});
console.log(result.runs);       // Run[]
console.log(result.totalCount); // number
console.log(result.nextCursor); // string | undefined
```

### cancelRun(runId, reason?)

Cancel a running workflow.

```typescript
const run = await client.cancelRun('run_abc123', 'no longer needed');
```

### retryRun(runId, fromStep?)

Retry a failed run, optionally from a specific step.

```typescript
await client.retryRun('run_abc123');
await client.retryRun('run_abc123', 'validate'); // Retry from specific step
```

### resumeRun(runId, fromStep?)

Resume a paused or failed run.

```typescript
await client.resumeRun('run_abc123');
await client.resumeRun('run_abc123', 'charge-card');
```

### patchStep(stepId, output, reason?)

Hot-patch a step's output. Useful for debugging or correcting bad data.

```typescript
await client.patchStep('step_xyz', { correctedValue: 42 }, 'fix bad data');
```

### Scoped Injection

Pause running workflows at step boundaries, inspect and modify step outputs, then resume:

```typescript
// Pause a running workflow
const result = await client.pauseRun("run_abc123");
console.log(result.status); // "pause_requested" or "paused"

// View completed steps while paused
const state = await client.getPausedState("run_abc123");
for (const step of state.steps) {
  console.log(step.name, step.output, step.injected);
}

// Inject modified output for a step
await client.injectStepOutput("run_abc123", "step_xyz", { corrected: true }, "Manual fix");

// Resume the workflow
await client.resumeRun("run_abc123");
```

`pauseBehavior` on `createFunction` controls whether a paused run retains or releases its concurrency lane slot:

```typescript
const fn = createFunction({
  id: "process-order",
  pauseBehavior: "hold", // "hold" (default) or "release"
  // ...
});
```

### listFunctions()

List all registered functions.

```typescript
const functions = await client.listFunctions();
```

### listWorkers()

List all connected workers.

```typescript
const workers = await client.listWorkers();
```

### health()

Server health check. Returns the status string.

```typescript
const status = await client.health();
console.log(status); // "ok"
```

### publish(topic, data, options?)

Publish a message to a developer pub/sub topic. Unlike `emit()`, this does **not** trigger workflow functions.

```typescript
const result = await client.publish('notifications', {
  userId: '123',
  message: 'Hello!',
});
console.log(result.eventId);  // string
console.log(result.sequence); // number
```

**PublishOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `idempotencyKey` | `string` | Prevent duplicate publishing. |

### listTopics()

List all active developer pub/sub topics.

```typescript
const topics = await client.listTopics();
for (const t of topics) {
  console.log(t.name, t.messageCount, t.consumerCount);
}
```

### getTopicStats(topic)

Get detailed statistics for a specific topic.

```typescript
const stats = await client.getTopicStats('notifications');
console.log('Messages:', stats.messageCount);
console.log('Lag:', stats.lag);
console.log('Consumers:', stats.consumerCount);
console.log('First seq:', stats.firstSeq, 'Last seq:', stats.lastSeq);
```

### Projection administration

Read materialized state, list/inspect projection status, and drive rebuilds.

```typescript
// Get current state of a managed projection
const { state, version, lastEventTime } = await client.projections.get<MyState>('order-summary');

// Per-partition projections
const partitioned = await client.projections.get('order-detail-view', { partition: 'order-123' });

// Operational status
const statuses = await client.projections.list();
const status   = await client.projections.getStatus('order-summary');

// Lifecycle
await client.projections.pause('order-summary');
await client.projections.resume('order-summary');
await client.projections.delete('order-summary');

// Rebuild
const job   = await client.projections.rebuild('order-summary');
const jobNow = await client.projections.getRebuildJob('order-summary');
await client.projections.cancelRebuild('order-summary');

// Read-your-writes — wait until a projection has caught up
const { sequence } = await client.streams.append(orderId, event);
await client.projections.waitForCatchup('order-detail-view', {
  minSeq: sequence,
  partition: orderId,
  timeoutMs: 5000,
});

// Batched catch-up wait (max 16 items, single deadline)
await client.projections.waitForCatchupBatch(
  [{ name: 'order-detail-view', minSeq: sequence, partition: orderId }],
  { timeoutMs: 5000 }
);

// Wait for a specific event to be processed (server resolves eventId → seq)
await client.projections.waitForEvent(eventId, 'order-detail-view', { timeoutMs: 5000 });
```

### SQL projections (`client.sqlProjections`)

Materialize event streams into queryable SQL tables. Handlers are parameterized SQL strings evaluated server-side.

```typescript
await client.sqlProjections.create({
  name: 'board',
  tableSql: 'CREATE TABLE proj_board (id TEXT PRIMARY KEY, title TEXT, status TEXT)',
  eventHandlers: {
    'issue.created':         "INSERT INTO proj_board (id, title, status) VALUES (:entity_id, :data.title, 'OPEN')",
    'issue.status_changed':  'UPDATE proj_board SET status = :data.to WHERE id = :entity_id',
  },
  events: ['issue.created', 'issue.status_changed'],
});

const result = await client.sqlProjections.query('board', {
  where: "status = 'OPEN'",
  orderBy: 'title ASC',
  limit: 50,
});
```

### Secrets management (`client.secrets`)

```typescript
await client.secrets.set('stripe-key', 'sk_live_…');
const secret = await client.secrets.get('stripe-key');
await client.secrets.update('stripe-key', 'sk_live_new');
const all = await client.secrets.list();    // names only, no values
await client.secrets.delete('stripe-key');
```

### Projects and environments

```typescript
const project = await client.projects.create({ name: 'my-service' });
await client.projects.update(project.id, { name: 'renamed-service' });
await client.projects.list();
await client.projects.delete(project.id);

const env = await client.environments.create({ name: 'staging', project_id: project.id });
await client.environments.update(env.id, { name: 'staging-v2' });
await client.environments.list();
await client.environments.delete(env.id);
```

### Event schemas (`client.schemas`)

```typescript
await client.schemas.register({
  name: 'order.placed',
  version: 2,
  schema: { type: 'object', properties: { orderId: { type: 'string' } } },
});

const latest = await client.schemas.get('order.placed');
const v1     = await client.schemas.getVersion('order.placed', 1);
await client.schemas.list();
await client.schemas.delete('order.placed', 1);

// Server-side upcast test (use SDK-side defineEvent for runtime upcasting)
const out = await client.schemas.testUpcast({
  eventName: 'order.placed',
  fromVersion: 1,
  toVersion: 2,
  data: { orderId: '123' },
});
```

### Webhook sources (`client.webhooks`) — server-side registry

Manage webhook *sources* registered with the Ironflow server (used by the dashboard and delivery tracking). For defining a webhook handler in code, use `createWebhook()` and pass it to `serve()`.

```typescript
await client.webhooks.create({
  id: 'stripe',
  eventPrefix: 'stripe',
  verifyHeader: 'stripe-signature',
  verifyAlgorithm: 'hmac-sha256',
  verifySecret: process.env.STRIPE_WEBHOOK_SECRET,
});

const sources = await client.webhooks.listSources();
await client.webhooks.deleteSource('stripe');

const { deliveries } = await client.webhooks.listDeliveries({
  sourceId: 'stripe',
  status: 'failed',
  limit: 25,
});
```

### Users and tenants (Enterprise)

```typescript
// User management
const user = await client.users.create({ email: 'alice@example.com', password: 'secret', roles: ['admin'] });
await client.users.list();
await client.users.update(user.id, { name: 'Alice' });
await client.users.delete(user.id);

// Tenant listing (enterprise-only)
const tenants = await client.tenants.list();
```

### Command idempotency (`client.commandDedup`)

Atomic claim-first dedup backed by NATS KV. Store and reuse the instance — do not allocate per request.

```typescript
const dedup = client.commandDedup<OrderResult>('order-commands');

const commandId = 'cmd_123';
const orderId = 'order_456';

const prior = await dedup.tryClaim(commandId, { orderId, claimedAt: new Date().toISOString() });
if (prior !== null) return prior;

try {
  const result = await runOrderHandler();
  await dedup.finalize(commandId, result);
  return result;
} catch (err) {
  await dedup.release(commandId).catch(() => {});
  throw err;
}
```

---

## Entity Streams

Event sourcing primitives via `client.streams`. Append domain events per entity, read them back, and use optimistic concurrency.

### streams.append(entityId, input, options?)

Append an event to an entity stream.

```typescript
const client = createClient({ serverUrl: 'http://localhost:9123' });

const result = await client.streams.append('order-123', {
  name: 'item.added',
  data: { sku: 'ABC', qty: 2 },
  entityType: 'order',
});
console.log(result.entityVersion); // number
console.log(result.eventId);      // string
```

### Optimistic concurrency with expectedVersion

```typescript
// Read current version (returns null if no events have been written yet)
const info = await client.streams.getInfo('order-123');

// Append with version check (fails if another writer modified the stream)
try {
  await client.streams.append('order-123', {
    name: 'item.removed',
    data: { sku: 'ABC' },
    entityType: 'order',
  }, { expectedVersion: info ? info.version : 0 });
} catch (err) {
  console.error('Concurrent modification detected');
}
```

**AppendOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `expectedVersion` | `number` | Optimistic concurrency check. |
| `idempotencyKey` | `string` | Prevent duplicate appends. |
| `version` | `number` | Event schema version (default: 1). |

### streams.read(entityId, options?)

Read events from an entity stream.

```typescript
const { events, totalCount } = await client.streams.read('order-123', {
  direction: 'forward',  // "forward" | "backward"
  fromVersion: 0,
  limit: 50,
});

for (const event of events) {
  console.log(event.name, event.data, event.entityVersion);
}
```

### streams.getInfo(entityId)

Get metadata about an entity stream. Returns `null` if no events have been written to
this stream yet — safe to pass `expectedVersion: 0` to `append()` in that case.

```typescript
const info = await client.streams.getInfo('order-123');
if (info) {
  console.log(info.entityId);    // "order-123"
  console.log(info.entityType);  // "order"
  console.log(info.version);     // current version number
  console.log(info.eventCount);  // total events
  console.log(info.createdAt);   // ISO string
  console.log(info.updatedAt);   // ISO string
}
```

**Returns:** `Promise<StreamInfo | null>`

### streams.createSnapshot / streams.getSnapshot

Speed up state reconstruction for long-lived streams by snapshotting the materialized state at a version.

```typescript
await client.streams.createSnapshot('order-123', {
  entityType: 'order',
  entityVersion: 1000,
  state: { /* materialized */ },
});

const snap = await client.streams.getSnapshot('order-123');
// optional: only consider snapshots at or before a version
const old  = await client.streams.getSnapshot('order-123', { beforeVersion: 500 });
```

### streams.listStreams / streams.getEntityHistory

```typescript
const streams = await client.streams.listStreams();
const events  = await client.streams.getEntityHistory('order-123');
```

---

## KV Store

Distributed key-value storage with bucket management, CAS (compare-and-swap), TTL, and wildcard key listing.

### Getting a KV client

```typescript
const client = createClient({ serverUrl: 'http://localhost:9123' });
const kv = client.kv();
```

### Bucket management

```typescript
// Create a bucket with TTL
await kv.createBucket({ name: 'sessions', ttlSeconds: 3600 });

// List all buckets
const buckets = await kv.listBuckets();

// Get bucket info
const info = await kv.getBucketInfo('sessions');

// Delete a bucket
await kv.deleteBucket('sessions');
```

**KVBucketConfig:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Bucket name. |
| `description` | `string` | Optional description. |
| `ttlSeconds` | `number` | Time-to-live for keys in seconds. |
| `maxValueSize` | `number` | Maximum value size in bytes. |
| `maxBytes` | `number` | Maximum total bucket size. |
| `history` | `number` | Number of historical revisions to keep. |

### Key operations

```typescript
const bucket = kv.bucket('sessions');

// Put a value (unconditional write)
const { revision } = await bucket.put('user-123', { token: 'abc', role: 'admin' });

// Get a value
const entry = await bucket.get('user-123');
console.log(entry.value);    // the stored value
console.log(entry.revision); // revision number for CAS

// Create only if key doesn't exist (throws HTTP 412 on conflict)
await bucket.create('user-456', { token: 'def' });

// Compare-and-swap update (throws HTTP 412 on revision mismatch)
await bucket.update('user-123', { token: 'xyz', role: 'admin' }, entry.revision);

// Soft delete (tombstone)
await bucket.delete('user-123');

// Purge key and all history
await bucket.purge('user-123');

// List keys with optional wildcard filter
const keys = await bucket.listKeys('user-*');
const allKeys = await bucket.listKeys();
```

---

## Config Management

Centralized configuration store with set, get, patch (shallow merge), list, and delete.

```typescript
const client = createClient({ serverUrl: 'http://localhost:9123' });
const config = client.config();

// Set a config (full replacement)
await config.set('app-settings', { theme: 'dark', locale: 'en', maxRetries: 3 });

// Get a config
const settings = await config.get('app-settings');
console.log(settings.data); // { theme: 'dark', locale: 'en', maxRetries: 3 }

// Patch a config (shallow merge)
await config.patch('app-settings', { locale: 'fr' });
// Result: { theme: 'dark', locale: 'fr', maxRetries: 3 }

// List all configs
const all = await config.list();
for (const entry of all) {
  console.log(entry.name, entry.data);
}

// Delete a config (idempotent)
await config.delete('app-settings');
```

---

## Auth Management

### API Keys

```typescript
const client = createClient({
  serverUrl: 'http://localhost:9123',
  apiKey: process.env.IRONFLOW_API_KEY,
});

// Create an API key
const newKey = await client.apiKeys.create({ name: 'ci-key', env_id: 'env_default' });
console.log(newKey.key); // Only returned on create/rotate

// List all API keys
const keys = await client.apiKeys.list();

// Get a specific key
const key = await client.apiKeys.get(keys[0].id);

// Rotate (generates new secret)
const rotated = await client.apiKeys.rotate(key.id);
console.log(rotated.key);

// Delete
await client.apiKeys.delete(key.id);
```

### Organizations (Enterprise)

Requires an enterprise license.

```typescript
const org = await client.orgs.create({ name: 'Acme Corp' });
const orgs = await client.orgs.list();
const fetched = await client.orgs.get(org.id);
await client.orgs.update(org.id, { name: 'Acme Inc' });
await client.orgs.delete(org.id);
```

### Roles (Enterprise)

```typescript
const role = await client.roles.create({ name: 'deployer', org_id: orgId });
const roles = await client.roles.list(orgId);  // optional org filter
const fetched = await client.roles.get(role.id);
await client.roles.update(role.id, { name: 'senior-deployer' });

// Assign/remove policies
await client.roles.assignPolicy(role.id, policyId);
await client.roles.removePolicy(role.id, policyId);

await client.roles.delete(role.id);
```

### Policies (Enterprise)

```typescript
const policy = await client.policies.create({
  name: 'allow-emit',
  effect: 'allow',
  actions: 'emit:*',
  resources: '*',
  org_id: orgId,
});
const policies = await client.policies.list(orgId);  // optional org filter
const fetched = await client.policies.get(policy.id);
await client.policies.update(policy.id, { name: 'allow-all-emit' });
await client.policies.delete(policy.id);
```

---

## Subscriptions

Real-time event subscriptions via WebSocket with auto-reconnect, consumer groups, and ackable delivery.

### SubscriptionClientConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverUrl` | `string` | -- | **Required.** Server URL (e.g., `"http://localhost:9123"`). |
| `apiKey` | `string` | -- | API key for authentication. |
| `environment` | `string` | -- | Environment for scoped subscriptions. |
| `autoReconnect` | `boolean` | `true` | Enable automatic reconnection. |
| `reconnectDelay` | `number` | `1000` | Initial reconnect delay in ms. |
| `maxReconnectDelay` | `number` | `30000` | Maximum reconnect delay in ms. |
| `reconnectBackoff` | `number` | `1.5` | Reconnect backoff multiplier. |
| `connectionTimeout` | `number` | `10000` | Connection timeout in ms. |

### Basic subscription

```typescript
import { createSubscriptionClient } from '@ironflow/node';

const sub = createSubscriptionClient({
  serverUrl: 'http://localhost:9123',
  apiKey: process.env.IRONFLOW_API_KEY,
});

await sub.connect();

// Subscribe with callbacks
const subscription = await sub.subscribe('events:order.*', {
  onEvent: (event) => {
    console.log('Topic:', event.topic);
    console.log('Data:', event.data);
  },
  onError: (err) => console.error(err.message),
});

// Replay last N events on subscribe
const replaySubscription = await sub.subscribe('system.run.>', {
  onEvent: (event) => console.log(event),
  replay: 100,
  includeMetadata: true,
});

// Cleanup
subscription.unsubscribe();
sub.close();
```

### Ackable subscriptions with consumer groups

For load-balanced processing with manual acknowledgment.

```typescript
const subscription = await sub.subscribe('events:order.*', {
  consumerGroup: 'order-processors',
  ackMode: 'manual',
  onEvent: async (event) => {
    try {
      await processOrder(event.data);
      await subscription.ack(event.eventId!);
    } catch (err) {
      // Negative ack with optional redeliver delay in ms
      await subscription.nak(event.eventId!, 5000);
    }
  },
});

// Terminal ack - message will not be redelivered
await subscription.term(eventId);
```

### Connection monitoring

```typescript
// Global connection state changes
const unsubscribe = sub.onConnectionChange((state) => {
  console.log('Connection:', state);
  // state: "connecting" | "connected" | "disconnected" | "reconnecting"
});

// Global error handler
const unsubErr = sub.onError((error) => {
  console.error('Subscription error:', error.code, error.message);
});

// Remove listeners
unsubscribe();
unsubErr();
```

---

## Projections

Projections build derived state from event streams. Two modes: **managed** (pure reducer maintaining state) and **external** (side effects).

### ProjectionConfig

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | **Required.** Unique projection name. |
| `events` | `string[]` | **Required.** Events to subscribe to. |
| `mode` | `"managed" \| "external"` | Auto-detected: `"managed"` if `initialState` is provided, else `"external"`. |
| `initialState` | `() => TState` | Initial state factory (managed mode). |
| `handler` | Function | Event handler (signature varies by mode). |
| `maxRetries` | `number` | Maximum retries per event (default: 3). |
| `batchSize` | `number` | Events per batch (default: 100). |

### Managed projection (pure reducer)

The handler receives current state and an event, and returns the new state. Ironflow persists the state.

```typescript
import { createProjection, createWorker } from '@ironflow/node';

const orderTotals = createProjection({
  name: 'order-totals',
  events: ['order.placed', 'order.cancelled'],
  initialState: () => ({ total: 0, count: 0 }),
  handler: (state, event) => {
    if (event.name === 'order.placed') {
      return {
        total: state.total + event.data.amount,
        count: state.count + 1,
      };
    }
    if (event.name === 'order.cancelled') {
      return {
        total: state.total - event.data.amount,
        count: state.count - 1,
      };
    }
    return state;
  },
});
```

### External projection (side effects)

The handler receives the event and a context object. Use for sending emails, updating external databases, calling APIs.

```typescript
const emailNotifier = createProjection({
  name: 'email-notifier',
  events: ['order.completed'],
  handler: async (event, ctx) => {
    await sendEmail(event.data.email, 'Your order is complete!');
  },
});
```

### Running projections

Projections run inside a worker, not in push mode.

```typescript
const worker = createWorker({
  serverUrl: 'http://localhost:9123',
  functions: [processOrder],
  projections: [orderTotals, emailNotifier],
});

await worker.start();
```

---

## Webhooks

Receive and transform external HTTP events from third-party services.

### WebhookConfig

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Webhook source identifier (used in URL path). |
| `verify` | `(req) => unknown \| Promise<unknown>` | Verify the request and return the parsed payload (or throw to reject). |
| `transform` | `(payload) => WebhookEvent \| Promise<WebhookEvent>` | Transform the verified payload to an Ironflow event. |

### Stripe webhook example

```typescript
import { createWebhook, serve } from '@ironflow/node';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const stripeWebhook = createWebhook({
  id: 'stripe',
  verify: async (req) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) throw new Error('Missing stripe-signature header');
    // Throws if invalid
    stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  },
  transform: (payload) => ({
    name: `stripe.${payload.type}`,
    data: payload.data.object,
    idempotencyKey: payload.id,
  }),
});

// Webhook endpoint: POST /api/ironflow/webhooks/stripe
export const POST = serve({
  functions: [processOrder],
  webhooks: [stripeWebhook],
  serverUrl: process.env.IRONFLOW_SERVER_URL,
});
```

The webhook URL path is derived from the `id`: `POST /api/ironflow/webhooks/<id>`.

---

## Event Versioning (Upcasters)

Upcasters transform event data from older schema versions to newer ones. They are applied SDK-side when reading events.

### defineEvent and EventDefinitionRegistry

```typescript
import { defineEvent, createEventDefinitionRegistry } from '@ironflow/core';

// Define event versions with upcasters
const orderPlacedV1 = defineEvent({
  name: 'order.placed',
  version: 1,
});

const orderPlacedV2 = defineEvent({
  name: 'order.placed',
  version: 2,
  upcast: (data) => ({
    ...(data as Record<string, unknown>),
    // v2 adds a currency field with a default
    currency: (data as Record<string, unknown>).currency ?? 'USD',
  }),
});

const orderPlacedV3 = defineEvent({
  name: 'order.placed',
  version: 3,
  upcast: (data) => {
    const d = data as Record<string, unknown>;
    return {
      ...d,
      // v3 renames "total" to "amount"
      amount: d.total ?? d.amount,
      total: undefined,
    };
  },
});

// Register all versions
const registry = createEventDefinitionRegistry();
registry.register(orderPlacedV1);
registry.register(orderPlacedV2);
registry.register(orderPlacedV3);

// Pass to worker or serve for automatic upcasting
const worker = createWorker({
  serverUrl: 'http://localhost:9123',
  functions: [processOrder],
  eventDefinitions: registry,
});
```

### UpcasterRegistry (lower-level)

```typescript
import { createUpcasterRegistry } from '@ironflow/core';

const upcasters = createUpcasterRegistry();

upcasters.register('order.placed', 1, 2, (data) => ({
  ...(data as Record<string, unknown>),
  currency: 'USD',
}));

upcasters.register('order.placed', 2, 3, (data) => {
  const d = data as Record<string, unknown>;
  return { ...d, amount: d.total, total: undefined };
});

// Manually upcast
const v3Data = upcasters.upcast('order.placed', v1Data, 1, 3);
```

The upcaster chain must be complete. If v2->v3 is registered but v1->v2 is missing, upcasting from v1 to v3 throws an error.

---

## Error Handling

All error classes are re-exported from `@ironflow/core`:

| Error Class | Description |
|-------------|-------------|
| `IronflowError` | Base error class. Has `code`, `retryable`, `details` properties. |
| `StepError` | Step execution failure. Has `stepId`, `stepName`. |
| `TimeoutError` | Request or operation timeout. |
| `ValidationError` | Input validation failure. |
| `SchemaValidationError` | Zod schema validation failure. |
| `SignatureError` | Request signature verification failure. |
| `FunctionNotFoundError` | Function not found. |
| `RunNotFoundError` | Run not found. |
| `NonRetryableError` | Marks an error as non-retryable (triggers compensations). |
| `UnauthenticatedError` | Missing or invalid authentication (HTTP 401). |
| `UnauthorizedError` | Insufficient permissions (HTTP 403). |
| `EnterpriseRequiredError` | Feature requires enterprise license (HTTP 402). |

### Utility functions

```typescript
import { isRetryable, isIronflowError, NonRetryableError } from '@ironflow/node';

// Check if an error is retryable
try {
  await step.run('api-call', async () => { /* ... */ });
} catch (err) {
  if (isRetryable(err)) {
    console.log('Will be retried');
  }
}

// Check if an error is an Ironflow error
if (isIronflowError(err)) {
  console.log(err.code, err.retryable);
}

// Mark an error as non-retryable (stops retries, triggers compensations)
throw new NonRetryableError('Payment declined - do not retry');
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `IRONFLOW_SERVER_URL` | Ironflow server URL | `http://localhost:9123` |
| `IRONFLOW_SIGNING_KEY` | HMAC-SHA256 signing key for push mode verification | -- |
| `IRONFLOW_API_KEY` | API key for authentication (worker and client) | -- |
| `IRONFLOW_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` | `info` |
| `IRONFLOW_ENV` | Target environment name | `default` |

---

## Agent Primitives

The `@ironflow/node/agent` entry point provides durable AI-agent primitives. Each helper (`tool`, `llm`, `approve`, `memory`, `spawn`) is sugar over `step.run` — agents inherit Ironflow's crash-resume, replay, audit, and scoped-injection semantics with no new server primitives.

The agent module is **bring-your-own-provider**: no LLM router, no prompt templates, no graph execution. You pass your provider SDK call into `llm()`; the wrapper memoizes the result and classifies failures.

### Import

```typescript
import { agent, defineTool, exposeMcp } from '@ironflow/node/agent';
```

### Define a tool

```typescript
import { defineTool } from '@ironflow/node/agent';
import { z } from 'zod';

const fetchOrder = defineTool({
  name: 'fetch-order',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  idempotent: 'byArgs',     // or "byCall" (default)
  timeout: '30s',
  handler: async ({ orderId }) => fetchFromDb(orderId),
});
```

### Define an agent

`agent()` returns a plain `IronflowFunction` — register it via `serve()` or `createWorker()` like any other function.

```typescript
import { agent } from '@ironflow/node/agent';

const supportAgent = agent(
  {
    id: 'support-agent',
    triggers: [{ event: 'support.ticket.opened' }],
    tools: [fetchOrder],
    maxTurns: 10,                      // default: 20
    memory: { projection: 'agent-memory' }, // optional persistent memory
  },
  async ({ event, tool, llm, approve, memory, spawn, turn }) => {
    // Call a tool by reference (type-safe)
    const order = await tool(fetchOrder, { orderId: event.data.orderId });

    // Call your LLM provider — wrapper memoizes the result as a step
    const result = await llm({
      messages: [{ role: 'user', content: `Triage order ${order.id}` }],
      call: async () => callAnthropic(/* ... */),
    });

    // Pause for human approval (durable)
    const decision = await approve({
      prompt: 'Refund this order?',
      timeout: '24h',
    });

    // Append to / read from durable agent memory
    await memory.append({ role: 'assistant', content: 'Refund approved' });

    // Spawn a child agent (durable child run)
    const child = await spawn('refund-agent', { orderId: order.id });

    return { turn, approved: decision.approved };
  }
);
```

### Errors

| Error | When |
|-------|------|
| `ToolNotFoundError` | `tool(name, args)` called with name not in `config.tools`. |
| `ToolValidationError` | Tool input failed its Zod schema. |
| `DuplicateToolError` | Two tools registered with the same `name`. |
| `LLMError` | Base LLM failure; `LLMInvalidJSONError`, `LLMMaxTokensError`, `LLMRefusalError` are subclasses. |
| `MaxTurnsExceededError` | Agent exceeded `maxTurns` budget. |
| `MemoryProjectionRequiredError` | `memory.*` called without a projection configured. |

### Expose tools over MCP

`exposeMcp` registers tool definitions with the Ironflow server so MCP-compatible clients can dispatch them. The server POSTs signed dispatch requests to your `callbackUrl`, which must be the same `serve()` mount that hosts your push functions (the mount appends `/ironflow/agent-tools/dispatch` and verifies HMAC).

```typescript
import { exposeMcp } from '@ironflow/node/agent';

const handle = await exposeMcp({
  name: 'order-tools',
  version: '1.0.0',
  tools: [
    { name: 'fetch-order', description: '…', input: /* JSON schema */ },
  ],
  callbackUrl: 'https://api.example.com/api/ironflow',
  // serverUrl + apiKey default to IRONFLOW_SERVER_URL / IRONFLOW_API_KEY env vars
  // (IRONFLOW_URL also accepted as legacy fallback for Go-SDK compat)
});

console.log(handle.toolNames); // ["order-tools.fetch-order"]
await handle.unregister();     // idempotent cleanup
```

---

## Testing

The `@ironflow/node/test` entry point provides a `createTestClient` for unit testing functions without a running server.

### Import

```typescript
import { createTestClient } from '@ironflow/node/test';
```

### TestClient interface

| Method | Description |
|--------|-------------|
| `mockStep(name, fn)` | Mock a `step.run()` call by name. |
| `mockInvoke(functionId, fn)` | Mock a `step.invoke()` or `step.invokeAsync()` call. |
| `sendEvent(eventName, data)` | Pre-register an event for `step.waitForEvent()`. |
| `emit(eventName, data)` | Run the function triggered by this event. Returns `TestRun`. |

### TestRun interface

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `status` | `"completed" \| "failed"` | Run outcome. |
| `output` | `unknown` | Function return value (if completed). |
| `error` | `Error` | Error (if failed). |
| `steps` | `TestStep[]` | All executed steps. |
| `compensationsRan` | `string[]` | Step names whose compensations executed. |
| `stepOutput(name)` | `unknown` | Get output of a specific step by name. |

### Example

```typescript
import { describe, it, expect } from 'vitest';
import { createFunction } from '@ironflow/node';
import { createTestClient } from '@ironflow/node/test';

const processOrder = createFunction(
  { id: 'process-order', triggers: [{ event: 'order.placed' }] },
  async ({ event, step }) => {
    const validated = await step.run('validate', async () => {
      return { orderId: event.data.orderId, valid: true };
    });

    const approval = await step.waitForEvent('wait-approval', {
      event: 'approval.received',
    });

    const result = await step.invoke('send-confirmation', {
      orderId: validated.orderId,
    });

    return { orderId: validated.orderId, confirmed: true };
  }
);

describe('processOrder', () => {
  it('completes successfully', async () => {
    const t = createTestClient({ functions: [processOrder] });

    // Mock steps
    t.mockStep('validate', () => ({ orderId: '123', valid: true }));
    t.mockInvoke('send-confirmation', (input) => ({ sent: true }));

    // Pre-register events for waitForEvent
    t.sendEvent('approval.received', { approved: true });

    // Run function
    const run = await t.emit('order.placed', { orderId: '123' });

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ orderId: '123', confirmed: true });
    expect(run.stepOutput('validate')).toEqual({ orderId: '123', valid: true });
  });
});
```

### Testing compensations

```typescript
import { NonRetryableError } from '@ironflow/node';

const transferFunds = createFunction(
  { id: 'transfer', triggers: [{ event: 'transfer.requested' }] },
  async ({ event, step }) => {
    await step.run('debit', async () => ({ ref: 'D1' }));
    step.compensate('debit', async () => { /* refund */ });

    await step.run('credit', async () => {
      throw new NonRetryableError('Insufficient funds');
    });
  }
);

describe('transferFunds', () => {
  it('runs compensations on failure', async () => {
    const t = createTestClient({ functions: [transferFunds] });
    t.mockStep('debit', () => ({ ref: 'D1' }));
    t.mockStep('credit', () => { throw new NonRetryableError('Insufficient funds'); });

    const run = await t.emit('transfer.requested', {});

    expect(run.status).toBe('failed');
    expect(run.compensationsRan).toContain('debit');
  });
});
```

**Note:** Every `step.run()` and `step.invoke()` call **must** have a corresponding mock registered via `mockStep()` or `mockInvoke()`. Unmocked steps throw with a helpful error message.

---

## API Summary

| Export | Description |
|--------|-------------|
| `createFunction(config, handler)` | Define a workflow function. |
| `serve(config)` / `createHandler(config)` | Create HTTP handler for push mode. |
| `createWorker(config)` | Create pull mode worker (REST polling). |
| `createStreamingWorker(config)` | Create pull mode worker (ConnectRPC streaming). Import from `@ironflow/node/worker-streaming`. |
| `createProjection(config)` | Define a projection. |
| `createProjectionRunner(config)` / `ProjectionRunner` | Lower-level projection runner (advanced). |
| `createClient(config)` / `IronflowClient` | Create server-side HTTP client. |
| `createSubscriptionClient(config)` / `SubscriptionClient` | Create WebSocket subscription client. |
| `createWebhook(config)` | Define a webhook source for `serve()`. |
| `createTestClient(config)` | Create test client. Import from `@ironflow/node/test`. |
| `createSecretsClient(secrets)` | Create a read-only secrets accessor. |
| `KVClient` / `KVBucketHandle` | Direct KV client constructors (advanced — prefer `client.kv()`). |
| `ConfigClient` | Direct config client (advanced — prefer `client.config()`). |
| `CommandDedup` / `DEFAULT_COMMAND_DEDUP_TTL_SECONDS` | Command-level idempotency primitive. |
| `withRunContext` / `getCurrentRunId` | Run-scoped async context for advanced instrumentation. |
| `agent(config, handler)` / `defineTool` / `exposeMcp` | Agent primitives. Import from `@ironflow/node/agent`. |
| `ironflow` | Singleton with `ironflow.createFunction()`. |

Branded ID creators, errors, duration/retry/logger utilities, and the `PushRequestSchema` / `RunStatusSchema` / `parseAndValidate` / `validate` helpers are re-exported from `@ironflow/core` — see that package for details.

## Documentation

Full documentation: [https://docs.ironflow.run](https://docs.ironflow.run)

## License

`LicenseRef-Ironflow-EULA` — see [LICENSE](https://github.com/sahina/ironflow-js/blob/main/LICENSE) at repo root.
