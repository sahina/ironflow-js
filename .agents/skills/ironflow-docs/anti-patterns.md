# Anti-Patterns Reference

Things that break Ironflow code. Each entry: WHY it breaks, WHAT to do instead.
Grouped by severity. CQRS-semantic issues live alongside mechanical ones — both
cause production pain, just on different timescales.

## CRITICAL — Cause data corruption or runtime failures

### 1. Side effects outside `step.run()`

Code outside steps re-executes on every retry. Causes duplicate charges, emails, writes.

```typescript
// WRONG
const user = await db.users.find(id);                    // re-runs every replay
await step.run("process", async () => processUser(user));

// RIGHT
const user = await step.run("fetch-user", () => db.users.find(id));
await step.run("process", () => processUser(user));
```

### 2. Non-unique step IDs in loops

Duplicate IDs return the first execution's cached output for all subsequent calls.

```typescript
// WRONG
for (const item of items) {
  await step.run("process-item", () => processItem(item));   // all return first result
}

// RIGHT
const results = await step.map("process-items", items, async (item, s, i) => {
  return s.run(`process-${i}`, () => processItem(item));
});
```

### 3. Impure managed projections
<!-- derived-from: docs/explanation/projections.md#reducer-contract-managed-mode -->
<!-- derived-from: docs/explanation/projections.md#2-pure -->

Side effects in managed handlers break rebuild and cause duplication.

```typescript
// WRONG (managed projection with side effect)
handler: async (state, event) => {
  await sendSlackNotification(...);
  return { ...state };
}

// RIGHT (split: managed for state, external for side effects)
const stats = createProjection({ /* pure handler */ });
const notifier = createProjection({ mode: "external", handler: async (e) => sendSlackNotification(...) });
```

### 3a. Non-deterministic managed reducer
<!-- derived-from: docs/explanation/projections.md#1-deterministic -->

Under #486, a rebuild (which reads the `events` table) and the live NATS tail can both
call the reducer for the same event. Reading the wall clock, generating a random ID, or reading
an env var produces a different `newState` on each call — the rebuilt state
disagrees with the live state, silently. No runtime check catches this.

```typescript
// WRONG — wall clock
handler: (state, event) => ({ ...state, lastSeen: Date.now() })
// WRONG — random ID
handler: (state, event) => ({ ...state, lineId: crypto.randomUUID(), qty: event.data.qty })
// WRONG — env read
handler: (state, event) => ({ ...state, region: process.env.REGION })

// RIGHT — derive everything from the event
handler: (state, event) => ({ ...state, lastSeen: event.timestamp })
handler: (state, event) => ({ ...state, lineId: event.data.lineId, qty: event.data.qty })
```

Go equivalents to ban inside managed handlers: `time.Now()`, `rand.Int*`,
`uuid.New()`, `os.Getenv`, file reads. Derive timestamps from
`event.Timestamp` and IDs from `event.Data`.

See <https://docs.ironflow.run/explanation/projections/#reducer-contract-managed-mode> for the
full four-rule contract.

### 3b. Mutating the state argument then returning it
<!-- derived-from: docs/explanation/projections.md#3-aliasing-safe -->

Managed handlers must return a fresh state object. In-place mutation plus
returning the same reference is an aliasing hazard: if the runner ever retains
the pre-mutation reference (for progress reporting, caching, or diagnostics),
your mutation silently rewrites it. The Go SDK deep-copies `state` before each
call (#486 I3) which neutralizes the sharpest case, but the JS SDK does not,
and mutating-then-returning is still the wrong pattern.

```typescript
// WRONG — mutates the argument
handler: (state, event) => { state.count += 1; return state; }

// RIGHT — fresh object
handler: (state, event) => ({ ...state, count: state.count + 1 })
```

Go:

```go
// WRONG
Handler: func(state map[string]any, event ironflow.ProjectionEvent, _ ironflow.ProjectionContext) (map[string]any, error) {
    state["count"] = state["count"].(float64) + 1
    return state, nil
}

// RIGHT
Handler: func(state map[string]any, event ironflow.ProjectionEvent, _ ironflow.ProjectionContext) (map[string]any, error) {
    next := map[string]any{}
    for k, v := range state { next[k] = v }
    next["count"] = state["count"].(float64) + 1
    return next, nil
}
```

### 4. Polling projections from browser

Re-fetching on raw event subscription returns stale data (projection runner async).

```typescript
// WRONG
setInterval(() => ironflow.getProjection("name"), 2000);
ironflow.subscribe("events:order.>", { onEvent: () => ironflow.getProjection("name") });

// RIGHT — server pushes state on save
ironflow.subscribeToProjection("name", { onUpdate: (state) => setState(state) });
```

### 5. Trying to handle a `waitForEvent` timeout inside the handler

A timeout is **not** observable from the handler at all — not as `null`, not as a
rejection. The return type is `Promise<IronflowEvent<T>>`; on expiry the scheduler
marks the step `timed_out` and fails the whole run
(`internal/engine/scheduler.go`). The handler is never resumed, so no line
after the wait ever executes.

Catching is worse than useless here — `try/catch` or a chained `.catch()`, same
result. `waitForEvent` suspends the run by throwing an
internal `YieldSignal` that the SDK catches at the handler boundary
(`sdk/js/node/src/serve.ts`). A user `catch` swallows that signal, so the run does
not suspend — it returns as if it had finished, and the wait silently never happens.

```typescript
// WRONG — dead guard. Nothing below the await runs on timeout.
const approval = await step.waitForEvent("wait", { ..., timeout: "24h" });
if (!approval) return { status: "cancelled" };

// ALSO WRONG — the catch eats the YieldSignal; the run completes instead of waiting.
try {
  const approval = await step.waitForEvent("wait", { ..., timeout: "24h" });
} catch {
  return { status: "cancelled" };
}

// ALSO WRONG — a chained .catch() swallows exactly the same signal.
await step.waitForEvent("wait", { ..., timeout: "24h" }).catch(() => undefined);

// RIGHT — model the deadline as an event and wait on a single settled event.
// A sibling function sleeps, then emits order.settled with outcome "expired".
await step.invokeAsync("order-approval-deadline", { orderId });

const settled = await step.waitForEvent("await-settlement", {
  event: OrderEvents.SETTLED,
  match: "data.orderId",
  timeout: "48h",              // hard ceiling — if THIS fires the run fails
});
await step.run("process", () => processSettlement(settled.data));
```

If failing the run is acceptable, let the timeout fire and react from a listener on
`system.run.*.failed`.

Same rule for `sleep`, `sleepUntil`, `invoke` and `invokeAsync` — they all yield.
Only `step.run` throws catchable errors, because it runs your callback inline.

### 5a. Querying the entity stream for display data

The entity stream is the **write model** — loading its history to render a list or UI
couples display to aggregate shape and scales O(events). Use a projection.

```typescript
// WRONG — UI lists by folding entity streams
const orders = await Promise.all(ids.map(id => client.streams.read(id)));
return orders.map(foldOrder);   // cost grows with every entity's history

// RIGHT — dedicated projection keyed for the view
// Node: client.projections.get(...). `getProjection` is the BROWSER client's name.
const { state } = await client.projections.get("orders-by-customer");
return state[customerId];
```

Rule: entity streams exist to enforce invariants on append. Projections exist to serve
reads. Crossing the streams defeats CQRS.

### 5b. Dual-emitting `streams.append` + `emit` for the same fact

`streams.append` already reaches projections. One append writes **two** outbox rows in
the same transaction (`internal/eventtrigger/helper.go`): one on the entity topic
for stream subscribers, one on `BuildUserEventTopic(eventName)` — the exact subject a
projection's durable filters on (`internal/projection/coordinator.go`). Emitting the
same fact again publishes it twice, so the reducer runs twice and every total silently
double-counts.

```typescript
// WRONG — the same fact reaches the projection twice
await client.streams.append(streamId, { name: "issue.created", data, entityType: "issue" },
  { expectedVersion: v });
await client.emit("issue.created", data);   // duplicate

// RIGHT — append alone is enough
await client.streams.append(streamId, { name: "issue.created", data, entityType: "issue" },
  { expectedVersion: v });
```

`emit` is for facts that have no entity stream. Pick one path per fact, never both.

**If `last_event_seq` really is 0 while the stream holds events**, the cause is a failed
outbox drain, not a missing emit — the events-namespace row never published. Diagnose it
at the outbox, not at the append site:

```bash
ironflow outbox dlq list --env <env> --json
ironflow outbox dlq requeue <event-id> --env <env>
```

Then confirm the projection's `events` array actually lists the event name; an unlisted
name is ignored and looks identical from the outside.

## WARNING — Operational problems, harder debugging

### 6. Missing `recording: true`

No time-travel debugging. `ironflow inspect --at` and the timeline view refuse to run (the plain step list still works).

```typescript
{ id: "fn", triggers: [...], recording: true }   // add this
```

### 7. Validation throws regular `Error`

Wastes retry attempts on permanent failures.

```typescript
// WRONG
if (!isValidEmail(email)) throw new Error("Invalid email");

// RIGHT
import { NonRetryableError } from "@ironflow/node";
if (!isValidEmail(email)) throw new NonRetryableError("Invalid email");
```

### 8. Missing idempotency keys on external APIs

Retry after partial failure → duplicate charges/records.

```typescript
// RIGHT
await step.run("charge", () => stripe.charges.create({
  amount, currency: "usd",
  idempotencyKey: `order-${orderId}-charge`,
}));
```

### 9. `waitForEvent` `match` pointing at the wrong field

`match` is a path inside `event.data`; the engine strips an optional `data.` prefix, so `match: "orderId"` and `match: "data.orderId"` are equivalent. What never matches is a key that is not in the payload (`match: "id"` when the event carries `orderId`), or a value that differs between the triggering event and the awaited one.

```typescript
// RIGHT
await step.waitForEvent("wait-payment", {
  event: PaymentEvents.COMPLETED,
  match: "data.orderId",
  timeout: "1h",
});
```

### 10. Entity stream append without `expectedVersion`

Concurrent appends silently corrupt state. `getInfo` returns `null` when the stream
has no events yet — pass `expectedVersion: 0` for the first append.

```typescript
// RIGHT
const info = await client.streams.getInfo(id);
await client.streams.append(id, event, { expectedVersion: info ? info.version : 0 });
```

### 10-id. Namespacing entity IDs with `/`

Slashes in entity IDs collide with REST path segments and dashboard links. The server
rejects them at write time, but legacy streams created before validation are visible in
the list view yet 404 on click. Same story for `?`, `#`, `%`, `&`, whitespace.

```typescript
// WRONG — breaks every path-based route
await client.streams.append(`${venueId}/issue-${issueId}`, event, opts);

// RIGHT — flatten to one segment, or use entityType for the namespace dimension
await client.streams.append(`${venueId}-${issueId}`, event, { ...opts });
await client.streams.append(issueId, { ...event, entityType: `issue.${venueId}` }, opts);  // entityType lives on the event, not the options
```

Allowed charset: letters, digits, `-`, `_`, `.`, `:`, `~`.

### 10a. CRUD-named events

`UserUpdated`, `OrderChanged`, `ItemModified` erase intent. Consumers can't tell why
and must inspect the diff — which defeats the point of events as facts. Over time,
every reactor grows a defensive `if (event.data.something_changed)` branch.

```typescript
// WRONG
await client.emit("user.updated", { email: "new@ex.com", reason: "user_request" });

// RIGHT — one fact per intent
await client.emit("user.email_changed", { from: old, to: new, reason: "user_request" });
await client.emit("user.name_corrected", { from: old, to: new });
```

Rule: if the event name doesn't tell you *why*, it's a CRUD event. Rename to the
domain action.

### 10b. Fat events (carrying full entity state)

Events that carry `...entity` freeze the read shape into the stream. Schema changes
become upcaster work for every event instead of just the affected field.

```typescript
// WRONG — the event is a state snapshot
{ name: "order.placed", data: { ...entireOrderObject } }

// RIGHT — the event is a fact with cause and delta
{ name: "order.placed", data: { orderId, customerId, items, totalCents, placedAt } }
```

Rule: events carry **what happened**, not **what the entity now looks like**. Projections
derive the "looks like" shape.

### 10c. Anemic aggregates (rules leak out of the decider)

If the entity stream is a dumb event log and the business rules live in function bodies,
projection handlers, or reactive listeners, you have CRUD with extra steps. The aggregate
owns its invariants or it isn't one.

```typescript
// WRONG — rule enforced in a downstream reactor, too late
const reactToPlaced = createFunction({ triggers: [{ event: "OrderPlaced" }] }, async ({ event }) => {
  if (event.data.total > creditLimit) { /* now what? the event is already a fact */ }
});

// RIGHT — rule enforced in the decider before the event is appended
function decideOrder(state, cmd) {
  if (cmd.total > state.creditLimit) throw new NonRetryableError("exceeds credit limit");
  return [{ name: "OrderPlaced", data: { ... } }];
}
```

Rule: all invariant checks happen in the pure decider, before `streams.append`. After
append, it's a fact — no going back.

## INFO — Code quality, maintainability

### 11. Hardcoded URLs

```typescript
// WRONG
createClient({ serverUrl: "http://localhost:9123" });

// RIGHT
createClient({ serverUrl: process.env.IRONFLOW_SERVER_URL || "http://localhost:9123" });
```

### 12. `event.data as any`

Lose compile-time safety. Define interfaces.

```typescript
interface OrderData { orderId: string; total: number; }
const data = event.data as OrderData;
```

### 13. Projections missing `as IronflowProjection` cast

```typescript
import { type IronflowProjection } from "@ironflow/node";
createWorker({ projections: [myProjection as IronflowProjection] });
```

This cast applies to TypeScript workers. Go's `NewWorker` and Python's
`Worker(functions=[...], projections=[...]).run()` have different configuration shapes;
Python's `projections` take `ironflow.projection.create_projection(...)` values, so no cast.

### 14. KV `bucket.get()` without try/catch

Throws if key missing.

```typescript
try {
  const entry = await bucket.get(key);
} catch { /* missing key — use default */ }
```

### 15. `config.watch()` / `bucket.watch()` without cleanup

Memory leaks from accumulating NATS subscriptions.

```typescript
const watcher = config.watch("flags", { onUpdate: ... });
// cleanup:
watcher.stop();
```

### 16. Webhook without signature verification

Anyone can send fake payloads.

```typescript
verify: async (req) => stripeSdk.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret)
```

### 17. Raw string event names

```typescript
// WRONG
triggers: [{ event: "order.placed" }]   // typos compile

// RIGHT
import { OrderEvents } from "../events/order-events";
triggers: [{ event: OrderEvents.PLACED }]
```

### 17a. Present-tense or imperative event names

Events are facts — something that **already happened**. Imperative names (`PlaceOrder`)
read as commands; present-tense (`OrderPlacing`) reads as process state. Past tense
makes subscription code obvious.

```typescript
// WRONG
const OrderEvents = { PLACE: "order.place", PROCESSING: "order.processing" } as const;

// RIGHT
const OrderEvents = { PLACED: "order.placed", SHIPPED: "order.shipped" } as const;
const OrderCommands = { PLACE: "place.order", CANCEL: "cancel.order" } as const;   // verb-first = command
```

Rule: past tense `{noun}.{verb-ed}` for events, imperative `{verb}.{noun}` for commands.
No `commands.` prefix — Ironflow does no routing on it; verb-first shape is the signal.
See `patterns.md` → Commands vs Events.

### 18. Secrets resolved at import time

Use `ctx.secrets.get()` inside the handler, not `process.env` at module level.
It hangs off the function context, not `step`, and is synchronous — it throws
when the secret is unset rather than returning undefined.

```typescript
// RIGHT
const fn = createFunction({ ..., secrets: ["stripe-key"] }, async ({ secrets, step }) => {
  const key = secrets.get("stripe-key");   // resolved at execution
});
```

### 19. Missing `...rest` spread in upcasters

Deletes data during schema migration.

```typescript
// WRONG
registry.register("user.created", 1, 2, (data) => ({
  fullName: `${data.firstName} ${data.lastName}`,    // deletes everything else!
}));

// RIGHT
registry.register("user.created", 1, 2, (data) => {
  const { firstName, lastName, ...rest } = data;
  return { ...rest, fullName: `${firstName} ${lastName}` };
});
```

---

## Full Reference

- AI pitfalls: https://docs.ironflow.run/explanation/ai-pitfalls/
- AI development guide: https://docs.ironflow.run/explanation/ai-development/
