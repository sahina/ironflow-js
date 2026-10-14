# Ironflow Patterns

Canonical patterns for common scenarios. Each pattern names the right primitive and shows
the minimal correct shape.

## Push vs Pull Mode

| Use push | Use pull |
|---|---|
| < 10s tasks, serverless deploy | > 10s tasks, persistent workers |
| API handlers, webhooks | Video processing, ML, ETL |

Push is capped by the engine's `PushTimeout` (default **10s**), enforced as both the
request context budget and the HTTP client timeout. It is a hard kill, not a guideline —
anything slower belongs in pull mode.

Mix both when you have both kinds of tasks.

For pull, Node uses `createWorker(...).start()`, Go uses
`ironflow.NewWorker(...).Run(ctx)`, and Python uses
`Worker(functions=[...]).run()` from `ironflow.worker`. Python's worker polls
over HTTP; its `async def` handlers use `ctx.step` for durable work.

## Commands vs Events (CQRS foundational)

The most important CQRS distinction. Conflating these is the #1 defect in event-driven
systems.

| Command | Event |
|---|---|
| Expresses **intent** (may be rejected) | Expresses a **fact** (already happened, immutable) |
| Wire name imperative `{verb}.{noun}`: `place.order`, `change.email` | Wire name past-tense `{noun}.{verb-ed}`: `order.placed`, `email.changed` |
| TS type name `PlaceOrder`, `ChangeEmail` | TS type name `OrderPlaced`, `EmailChanged` |
| Targets **one** aggregate, validated against it | Broadcast — many handlers can react |
| Fails with business-rule errors | Cannot fail after emission |
| Carries auth/user context | Carries only what happened |

### Ironflow realization

Ironflow has no dedicated `Command` primitive — you express commands as events with a
command-shaped wire name (`place.order`, verb-first) handled by exactly one function
that acts as the **command handler**. The command handler loads the aggregate,
validates, then appends **domain events** to the entity stream (which many projections
and process managers may react to).

> Do NOT prefix command wire names with `commands.` — Ironflow does no routing on that
> prefix. The verb-first shape (`place.order`) vs past-tense shape (`order.placed`)
> is the distinguishing signal.

```typescript
// commands bus: a command event → exactly one handler
// No client is injected: the handler context is { event, step, run, logger, secrets }.
const client = createClient();

const placeOrder = createFunction(
  { id: "cmd.place-order", triggers: [{ event: "place.order" }], recording: true },
  async ({ event, step }) => {
    const cmd = event.data as PlaceOrderCommand;

    // 1. Load prior history — read returns { events, totalCount }
    const history = await step.run("load", () => client.streams.read(cmd.orderId));
    const state = history.events.reduce(evolveOrder, initialOrderState());
    let version = history.events.at(-1)?.entityVersion ?? 0;

    // 2. Decide: pure function from (state, command) to events | error
    const newEvents = decideOrder(state, cmd);   // throws NonRetryableError on invariant break

    // 3. Append domain events with optimistic concurrency.
    //    append takes ONE event per call — walk the list, bumping expectedVersion.
    //    No emit alongside it: the append already fans out to projections.
    for (const [i, ev] of newEvents.entries()) {
      await step.run(`append-${i}`, async () => {
        const { entityVersion } = await client.streams.append(
          cmd.orderId, ev, { expectedVersion: version },
        );
        version = entityVersion;
      });
    }
  },
);
```

Rule: commands mutate; events notify. Never rename `OrderPlaced` → `OrderPlace` to trigger
a handler — that leaks command-side vocabulary into the facts.

## Ubiquitous Language & Event Naming

Events and commands carry the domain's vocabulary across the system. Bad names cause the
wrong model.

| Rule | Why |
|---|---|
| **Past tense** for events — wire `order.placed`, type `OrderPlaced` (not `PlaceOrder`, not `OrderUpdated`) | An event is a fact that has happened |
| **Imperative** for commands — wire `place.order` (verb-first), type `PlaceOrder` (not `OrderPlace`, no `commands.` prefix) | A command is intent yet to be acted on |
| **Domain language**, not CRUD (`EmailChanged`, not `UserUpdated`) | CRUD erases intent — *why* was the user updated? |
| **One fact per event** (`AddressCorrected` + `NameChanged`, not `UserUpdated`) | Consumers filter on intent, not on "something changed" |
| **Carry cause, not state** (`PriceReduced { fromCents, toCents, reason }`, not `ProductUpdated { ...everything }`) | Facts replay cleanly; state-blobs don't |

Keep one ubiquitous language per bounded context. Cross-context events should use the
**published language** (a curated, documented subset of the owning context's events).

## Plain Events vs Entity Streams

| Plain events | Entity streams |
|---|---|
| Fire-and-forget signals, analytics | Entity lifecycles, DDD aggregates |
| No ordering per entity | Per-entity version + optimistic concurrency |
| `client.emit(name, data)` | `client.streams.append(id, ev, { expectedVersion })` |

> **One append already reaches projections — do NOT also emit.** A single
> `streams.append` writes two outbox rows in one transaction: the entity topic for
> stream subscribers, and `BuildUserEventTopic(eventName)`, which is the exact subject a
> projection's durable filters on. Emitting the same fact again publishes it twice and
> the reducer double-counts. Use `emit` only for facts with no entity stream.
> See `anti-patterns.md` §5b.

Entity IDs must be URL-safe: letters, digits, `-`, `_`, `.`, `:`, `~`. The server rejects
`/`, `?`, `#`, `%`, `&`, and whitespace at write time so the same ID works in dashboard
links, REST path routes, and body-based RPCs.

## Aggregate Design

An aggregate is the **transactional consistency boundary**: one entity stream, one
version, all invariants enforced atomically on append.

### Sizing rules

| Make aggregate **smaller** when | Make aggregate **larger** when |
|---|---|
| Contention on append (concurrent writers) | Invariants span multiple entities |
| Most state never read together | State is always loaded together |
| Lifecycle differs across parts | Lifecycle is uniform |
| History fetch is slow | History is small, reads cheap |

Default bias: **small**. One aggregate per domain entity with its own lifecycle
(`Order`, `Subscription`, `Account`). Split further if one field mutates on a different
rhythm than the rest (e.g. `OrderShipment` separate from `Order`).

### Invariants live in the decider

The decider is a **pure function** `(state, command) => events[] | error`. All business
rules live here — never in projections, never inline in step handlers.

```typescript
// Pure decider — 100% unit-testable, no SDK dependencies
export function decideOrder(state: OrderState, cmd: OrderCommand): DomainEvent[] {
  switch (cmd.type) {
    case "Place":
      if (state.status !== "none") throw new NonRetryableError("already placed");
      if (cmd.items.length === 0) throw new NonRetryableError("empty order");
      return [{ name: "OrderPlaced", entityType: "order", data: { orderId: cmd.orderId, items: cmd.items } }];

    case "Cancel":
      if (state.status !== "placed") throw new NonRetryableError(`cannot cancel in ${state.status}`);
      return [{ name: "OrderCancelled", entityType: "order", data: { orderId: cmd.orderId, reason: cmd.reason } }];
  }
}

// Evolver — folds events into state (pure reducer, same shape as a projection)
export function evolveOrder(state: OrderState, event: DomainEvent): OrderState { /* ... */ }
```

Command handler = load history → evolve → decide → append. Keeping decider/evolver pure
makes the aggregate trivially unit-testable via Given/When/Then (see `ironflow-code`
Mode 2).

### Anemic aggregate = no CQRS

If your "aggregate" is just a dumb data bag and the rules live in functions or
projections, you have CRUD with extra steps. The aggregate owns its invariants or it
isn't one.

## Function Roles

`createFunction` is one primitive that serves several distinct CQRS roles. Name the role
in comments/IDs — it drives how you test, where state lives, and what can go wrong.

| Role | Purpose | State source | Example `id` prefix |
|---|---|---|---|
| **Command handler** | Validate intent, load aggregate, append events | Entity stream history | `cmd.` |
| **Process manager** | React to events, coordinate, emit commands | Own state (KV or folded events) | `pm.` |
| **Saga** | Long-running orchestration with compensation | Step outputs + compensation log | `saga.` |
| **Reactor / listener** | Side effect in response to a fact (email, webhook out) | Stateless | `react.` |
| **Scheduler** | Cron-triggered work | Stateless | `cron.` |

Rules by role:
- **Command handler**: exactly one per command type; must be deterministic given history;
  all rule violations → `NonRetryableError`.
- **Process manager**: never embeds business rules — it decides *when* to send commands,
  not *whether* commands are valid. Validation belongs to the command handler it invokes.
- **Saga**: uses `step.compensate` for local rollback; for cross-service rollback, emit
  failure events and let reactors handle them.
- **Reactor**: no writes to aggregates — only side effects. If you need to append to a
  stream, you're actually a process manager; rename the function.

## Managed vs External Projections
<!-- derived-from: docs/explanation/projections.md#managed-vs-external-mode -->

| Managed (default) | External (`mode: "external"`) |
|---|---|
| Pure reducer `(state, event) => state` | Side-effect handler `(event) => void` |
| Ironflow stores state | You manage your own storage |
| Read models, dashboards, counters | DB sync, send emails, call APIs |
| Rebuild via `ironflow projection rebuild` | You handle rebuild logic |

## Saga Patterns

### Step Compensation (within one function)

```typescript
const reservation = await step.run("reserve", () => inventory.reserve(items));
step.compensate("reserve", () => inventory.release(reservation.id));

const charge = await step.run("charge", () => payments.charge(amount, {
  idempotencyKey: `order-${orderId}`,
}));
step.compensate("charge", () => payments.refund(charge.id));

await step.run("ship", () => shipping.create(...));   // if this throws NonRetryableError, both compensations run
// A plain Error is retried instead; once retries are exhausted NOTHING compensates.
// Wrap terminal failures in NonRetryableError (or WrapNonRetryable) to trigger the saga.
```

### Saga Pattern (across services)

Each service emits events; compensation flows react to failure events:

```typescript
const handleInventoryFailure = createFunction(
  { id: "handle-inv-fail", triggers: [{ event: InventoryEvents.RESERVATION_FAILED }] },
  async ({ event, step }) => {
    await step.run("notify", () => notify(event.data.customerId));
  },
);
```

Use compensation for simple undo within one function. Use saga pattern for complex
multi-service rollback or human-in-the-loop.

## Webhooks

```typescript
const stripe = createWebhook({
  id: "stripe",
  verify: async (req) => {
    // ALWAYS verify signature — never accept unsigned payloads
    return stripeSdk.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  },
  transform: (payload) => ({
    name: `webhook/stripe.${payload.type}`,
    data: payload.data.object,
  }),
});

export const POST = serve({ functions: [...], webhooks: [stripe] });
```

Endpoint: `POST /webhooks/stripe`. Functions trigger on `webhook/stripe.<type>` events.

## Concurrency Control

```typescript
// Global limit
{ concurrency: { limit: 5 } }

// Per-key serialization (one at a time per customer)
{ concurrency: { limit: 1, key: "customerId" } }   // path inside event.data; a "data." prefix breaks resolution and fails the run

// Strict serial queue
{ concurrency: { limit: 1 } }
```

## Bounded Contexts (DDD)

- **Project** = bounded context (own events, functions, projections, ubiquitous language)
- **Environment** = deployment stage (dev, staging, prod)
- Cross-context communication = events only (never direct function invocation)
- Each context owns its events; never emit events from another context
- Expose a **published language** — a curated subset of domain events intended for other
  contexts. Keep "internal" events (intermediate facts) out of the published surface so
  consumers can't form hidden dependencies on your implementation
- Use an **anti-corruption layer** when integrating with a legacy or third-party context:
  a function that consumes foreign events and re-emits them translated into your language

## Schema Evolution (Upcasters)

```typescript
registry.register("user.created", 1, 2, (data) => {
  const { firstName, lastName, ...rest } = data;
  return { ...rest, fullName: `${firstName} ${lastName}` };  // ALWAYS spread
});

// Chain sequentially: v1→v2, v2→v3, never skip
```

Rules:
1. Never delete fields from events in production — upcast instead
2. Always spread `...rest` to preserve un-migrated fields
3. Read-time transform — stored events unchanged
4. Forward only — no downcasters

## Snapshots & Projection Rebuilds

Aggregates with long histories become expensive to load (fold cost grows linearly).
Projections occasionally need rebuild after a bug fix or schema change. Plan for both.

### Aggregate snapshots

Snapshot = cached fold of events up to version N. On load: fetch snapshot + events after
N, fold only the tail.

Entity streams have first-class snapshots — do **not** hand-roll them in KV:

```typescript
await client.streams.createSnapshot(entityId, {
  entityType: "order",
  entityVersion: version,
  state,                                     // your folded state
});

const snap = await client.streams.getSnapshot(entityId, { beforeVersion: version });
const { events } = await client.streams.read(entityId, { fromVersion: snap.entityVersion + 1 });  // fromVersion is inclusive
const current = events.reduce(evolveOrder, snap.state);
```

- Snapshot **every K events** (K = 100–500 depending on event size)
- Snapshot is a **cache**, not source of truth — rebuilds must be tolerated
- Invalidate snapshots on schema change (add version to the state you store)

### Projection rebuilds

- Managed projections: `ironflow projection rebuild <name>` re-folds all events from zero
- Design handlers to be **idempotent on replay** — no external side effects in managed
  projections (NOT enforced at runtime — see anti-pattern #3)
- For zero-downtime rebuild: deploy projection at new name, let it catch up, swap reads,
  delete old
- External projections own their rebuild logic — typically "delete rows, replay events,
  reinsert"

### When to add snapshots

Not day-one. Add when you measure: command handler P99 load latency > budget, or
aggregate history > ~10k events. Don't pre-optimize.

## KV Store vs External DB

| KV Store | External DB |
|---|---|
| Small, key-value, real-time updates | Relational, complex queries, large data |
| Feature flags, settings, session state | Orders, users, analytics |
| Built-in watch | Polling or change streams |
| Zero config | Separate service to manage |

## Config vs KV vs Secrets

| Config | KV Store | Secrets |
|---|---|---|
| App settings | User-facing data | Credentials |
| `SYS_config_*` (hidden from KV dash) | `APP_*` (visible in dash) | `SYS_secrets_*` (encrypted; CLI or `client.secrets.*`) |
| Watch supported | Watch supported | No watch |

## Browser Real-Time Pattern

```typescript
useEffect(() => {
  ironflow.getProjection<S>("name").then(r => setState(r.state));     // initial
  ironflow.subscribeToProjection<S>("name", {                          // live
    onUpdate: (state) => setState(state),
  }).then(sub => { subRef.current = sub; });
  return () => subRef.current?.unsubscribe();
}, []);
```

NEVER `setInterval(getProjection)` or re-fetch on raw event subscription.

## Read-Your-Own-Writes & Projection Lag

CQRS means the read model is **eventually consistent** with the write model. The user
who just submitted a command expects to see the result in the next list/detail view,
but the projection may lag by milliseconds-to-seconds.

### Three ways to handle it

| Approach | When | How |
|---|---|---|
| **Optimistic UI** | Most forms, action buttons | Update local UI immediately from the command payload; reconcile when `subscribeToProjection` fires |
| **Wait-for-projection** | Critical flows (checkout confirmation) | `await client.projections.waitForEvent(eventId, "order-detail-view", { timeoutMs })` with the `eventId` the write returned. Never poll — see `waitForCatchup` / `waitForCatchupBatch` for the seq-based forms |
| **Read-from-write** | Rare — only when absolutely required | Load the aggregate directly after command; costs you denormalization benefits, so justify it |

### Rule

Never query the entity stream for display data as a workaround for stale projections —
that couples the UI to the write model and defeats CQRS. Instead: fix the projection
lag, add a lighter projection for the hot path, or use optimistic UI.

`subscribeToProjection` is the default answer: the server pushes new state on save, so
the "lag" is bounded to the projection runner's batch window (sub-second in practice).

---

## Full Reference

- Workflows: https://docs.ironflow.run/explanation/workflows/
- Event sourcing: https://docs.ironflow.run/explanation/event-sourcing/
- DDD with Ironflow: https://docs.ironflow.run/explanation/ddd/why-ddd/
- Pub/sub: https://docs.ironflow.run/explanation/pubsub/
