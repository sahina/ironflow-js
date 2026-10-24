---
name: ironflow-code
version: 0.51.0
description: |
  Build Ironflow components — write functions, projections, workers, entity streams,
  webhooks, sagas, plus generate tests and audit existing code for anti-patterns.
  Triggers on: "write a function", "create a projection", "add a worker", "implement saga",
  "build a workflow", "write tests for", "add tests for", "test coverage for",
  "audit my code", "review my ironflow", "check anti-patterns".
  NOT for setup/scaffolding (use ironflow-start).
  NOT for runtime debugging (use ironflow-ops).
  NOT for SDK reference lookup (use ironflow-docs).
user-invocable: true
argument-hint: "[what to build, test, or audit] — e.g., 'a function that processes orders'"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Ironflow Code

Workflow for writing Ironflow components, generating tests, and auditing for anti-patterns.
This skill encodes the *process*. SDK syntax lives in `ironflow-docs`.

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Reference Files

When you need SDK syntax, fetch these pages instead of guessing:

```
https://docs.ironflow.run/reference/js-sdk/node.md
https://docs.ironflow.run/reference/api/go-sdk.md
https://docs.ironflow.run/reference/api/python-sdk.md
https://docs.ironflow.run/explanation/patterns.md
https://docs.ironflow.run/explanation/ai-pitfalls.md
```

## Workflow Selection

Identify which mode the user is in:

| Intent | Mode |
|---|---|
| "write/create/add/implement/build" | **Write Code** |
| "test/coverage/spec" | **Generate Tests** |
| "audit/review/check anti-patterns" | **Audit** |

If ambiguous, ask once.

---

## Mode 1: Write Code

### Step 1: Detect language

- Read `package.json` for TS/JS, `go.mod` for Go, `pyproject.toml` or `requirements.txt` for Python.
- If more than one, ask which language.
- Fetch the relevant SDK reference: `https://docs.ironflow.run/reference/js-sdk/node.md`,
  `https://docs.ironflow.run/reference/api/go-sdk.md` or `https://docs.ironflow.run/reference/api/python-sdk.md`.

### Step 2: Clarify component (if ambiguous)

Ironflow has a small set of **primitives** and a larger set of **CQRS roles** realized on
top of them. Ask which role the user wants — it drives testing, state handling, and
invariant placement.

**Primitives:**

| Primitive | What it is |
|---|---|
| **Function** | Durable workflow triggered by an event (serves many CQRS roles — see below) |
| **Projection** | Read model derived from events (pure reducer for managed, side-effect handler for external) |
| **Entity Stream** | Event-sourced write model with per-entity version and optimistic concurrency |
| **Worker** | Pull-mode process that runs functions and projections |
| **Webhook** | External HTTP → Ironflow event transformer |

**CQRS roles (all realized as Functions — name the role in the function `id`):**

| Role | Purpose | Triggers on | `id` prefix |
|---|---|---|---|
| **Command Handler** | Validate intent, load aggregate, append domain events | A command event, verb-first (`place.order`) | `cmd.` |
| **Aggregate Decider** | Pure `(state, command) => events[] \| error` — called by a command handler | (not a function — a pure TS/Go function) | — |
| **Process Manager** | React to events, coordinate, send commands | A domain event | `pm.` |
| **Saga** | Long-running orchestration with `step.compensate` | A command or event | `saga.` |
| **Reactor** | Side effect in response to a fact (email, webhook out, external API) | A domain event | `react.` |
| **Scheduler** | Cron-triggered work | Cron expression | `cron.` |

Full descriptions: fetch `https://docs.ironflow.run/explanation/patterns.md` (Function Roles
section). If the user is writing a command-side workflow, also read the Commands vs
Events and Aggregate Design sections — they drive the decider/evolver shape.

### Step 3: Apply project conventions

- Event names live in `src/events/<domain>-events.ts` as `as const` objects
- **Command names** in `src/commands/<domain>-commands.ts` as `as const` objects,
  verb-first (`place.order`). No `commands.` prefix — Ironflow does no routing on it;
  verb-first vs past-tense is the only signal (#555)
- **Aggregate decider + evolver** live together in `src/aggregates/<name>-aggregate.ts`
  as pure functions with no SDK imports — exported for direct unit testing
- Functions in `src/functions/` with role-prefixed filenames (`cmd.place-order.ts`,
  `pm.fulfill-order.ts`, `react.send-confirmation.ts`)
- Projections in `src/projections/` — one file per read shape
- Go: `internal/events/`, `internal/commands/`, `internal/aggregates/`,
  `internal/functions/`, `internal/projections/`

For CRUD-style work (no aggregate, no command), skip the `commands/` and `aggregates/`
folders — plain events + functions + projections are the full set.

### Step 4: Write the code

Before implementing an entity lifecycle or a workflow with branches, waits, multiple
functions, or saga compensation, read `~/.agents/skills/ironflow-docs/diagrams.md` using the cross-skill
path convention above. Present the proposed flow in Mermaid with a short explanation
so the user can review it, and update it when the design changes. Skip a new diagram
when the conversation already contains one that matches the current design.

Apply these non-negotiable rules (full list: fetch `https://docs.ironflow.run/explanation/ai-pitfalls.md`):

**Mechanical (Ironflow runtime):**
- Event names = typed constants (`as const` objects, never raw strings)
- Every step has a unique ID; loops use `step.map` or indexed IDs
- All I/O inside `step.run()` — nothing outside
- External APIs use idempotency keys
- `NonRetryableError` for permanent/validation failures
- **Never** swallow a yielding step's rejection — `sleep`, `sleepUntil`,
  `waitForEvent`, `invoke`, `invokeAsync` suspend the run by throwing an internal
  `YieldSignal`. A `try/catch` around one, or a `.catch()` chained onto it, eats
  that signal, so the run completes instead of waiting. A `waitForEvent` timeout is not catchable either: the scheduler fails
  the run out from under the handler. Model a deadline as its own event and wait
  on a single settled event. `match` names a key in `event.data` (the `data.` prefix is optional)
- Push mode for <10s; pull mode for >10s (the engine's `PushTimeout` is 10s and
  kills the request — it is not advisory)
- Python pull workers use `from ironflow.worker import Worker, function`:
  `@function(id="job", triggers=[{"event": "job.started"}])` on an `async def`
  handler, then `Worker(functions=[handler]).run()`. Bare durations are seconds;
  step callbacks must be idempotent.
- Recording enabled (`recording: true`) for debuggable functions
- Managed projections are pure; side effects → `mode: "external"`
- Entity stream appends include `expectedVersion`
- **Never dual-emit**: one `streams.append` already publishes to the events topic
  projections filter on (two outbox rows, one transaction). Emitting the same fact
  again makes the reducer run twice and silently double-count. `emit` is only for
  facts that have no entity stream
- Entity IDs are a single path segment — no `/`, `?`, `#`, `%`, `&`, or
  whitespace; use `entityType` for the namespace dimension
- Projections carry the `as IronflowProjection` cast — `createWorker({ projections })`
  takes `IronflowProjection[]`, and the cast erases the state/event generics to fit
- KV `bucket.get()` wrapped in try/catch
- `config.watch()` / `bucket.watch()` watchers stopped on cleanup
- Webhooks always verify signatures
- Secrets resolved via `ctx.secrets.get(name)` (synchronous, throws if unset),
  not import-time `process.env`
- Upcasters always spread `...rest`

**CQRS semantic:**
- **Commands are imperative** — wire `place.order` (verb-first, no `commands.` prefix),
  type `PlaceOrder`. **Events are past tense** — wire `order.placed`, type `OrderPlaced`.
  Never CRUD-named (`UserUpdated`, `OrderChanged`)
- Commands target **one** aggregate; events may have many reactors
- **Invariants live in the pure decider** — never in projections, reactors, or process
  managers. By the time an event exists, the rule has already passed
- **Never query the entity stream for display data** — that's a projection's job
- Events carry **cause and delta**, not full entity state (no `{ ...entireOrder }`)
- Each Function's CQRS role is named in its `id` prefix (`cmd.`, `pm.`, `saga.`,
  `react.`, `cron.`)
- Cross-bounded-context communication is events only, via the owning context's
  **published language**

### Step 5: Suggest next

> "Code written. Next:
> - Tests for this? Stay in `/ironflow-code` (test mode).
> - Set up the worker/serve entry point? Use `/ironflow-start`.
> - Audit existing code? Stay here (audit mode)."

Verifying against a **running dev server**? Wait for it to reload your edit before emitting
a test event. If operating via MCP, call `ironflow_await_reload` first so the test hits the
reloaded version, not the code you just replaced — see `/ironflow-ops` → "Verifying a Fix
Against a Live Dev Server".

---

## Mode 2: Generate Tests

### Step 1: Detect framework

- `vitest.config.ts` or `vitest` in devDependencies → vitest
- `jest.config.*` or `jest` in devDependencies → Jest
- `go.mod` → Go testing
- None? Recommend vitest (TS) or stdlib (Go) and offer install.

### Step 2: Find components to test

```bash
grep -rn "createFunction\|createProjection\|createWorker\|createWebhook" src/ --include="*.ts"
grep -rn "ironflow.CreateFunction\|ironflow.CreateProjection\|ironflow.NewWorker" . --include="*.go"
grep -rn "from ironflow.worker import\|@function(" . --include="*.py"
```

### Step 3: Apply test patterns

| Component | Type | Must test | Server required? |
|---|---|---|---|
| **Aggregate decider** (pure fn) | Unit (Given/When/Then) | Every invariant, every command-path, rejected commands | No |
| **Aggregate evolver** (pure fn) | Unit | Fold correctness, field preservation across events | No |
| Projection | Unit | Initial state, single event, accumulation, immutability | No |
| Function (command handler) | Integration | Dispatch → append → projection reflects | Yes |
| Function (process manager / reactor) | Integration | Event in → command or side effect out | Yes |
| Entity Stream | Integration | Append+read, optimistic concurrency, version info | Yes |
| Worker | Integration | Starts, registers functions | Yes |
| KV Store | Integration | Bucket CRUD, create-if-not-exists | Yes |
| Webhook | Unit | Verify rejects bad sigs, transform output | No |
| Upcaster | Unit | v1→v2 transform, field preservation | No |

**Order of test coverage for a command-side feature:**
1. Decider (Given/When/Then) — every invariant
2. Evolver — folding correctness
3. Projection — view shape per event
4. Command handler integration — one happy path, one rejection
5. Process manager / reactor integration — if present

### Step 4: Projection unit test (vitest)

```typescript
import { describe, it, expect } from "vitest";
import type { ManagedProjectionHandler, ProjectionContext } from "@ironflow/node";
import { orderStats } from "./order-stats";
import { OrderEvents } from "../events/order-events";

// `createProjection` returns `{ config }` and nothing else — reach the reducer
// through `.config`, not off the projection object. `handler` is typed as a
// managed|external union and takes a third `ctx` argument — narrow it and stub ctx.
type State = { totalOrders: number; totalRevenue: number };
const ctx = { logger: console } as unknown as ProjectionContext;
describe("order-stats projection", () => {
  const handler = orderStats.config.handler as ManagedProjectionHandler<State>;
  const initialState = orderStats.config.initialState!();

  it("starts with zero state", () => {
    expect(initialState).toEqual({ totalOrders: 0, totalRevenue: 0 });
  });

  it("accumulates across events", () => {
    const events = [
      { name: OrderEvents.PLACED, data: { orderId: "1", total: 49.99 } },
      { name: OrderEvents.PLACED, data: { orderId: "2", total: 25.00 } },
    ];
    const final = events.reduce((s, e) => handler(s, e, ctx), initialState);
    expect(final.totalOrders).toBe(2);
    expect(final.totalRevenue).toBeCloseTo(74.99);
  });

  it("does not mutate previous state", () => {
    const before = { ...initialState };
    handler(initialState, { name: OrderEvents.PLACED, data: { total: 10 } }, ctx);
    expect(initialState).toEqual(before);
  });
});
```

### Step 4a: Aggregate decider — Given/When/Then (vitest)

The canonical ES test shape. Zero SDK dependency — the decider is a pure function, so
these tests are fast, deterministic, and cover every invariant.

```typescript
import { describe, it, expect } from "vitest";
import { decideOrder, evolveOrder, type OrderState } from "./order-aggregate";
import { NonRetryableError } from "@ironflow/node";

function given(events: any[]): OrderState {
  return events.reduce(evolveOrder, evolveOrder(undefined as any, { name: "__init" } as any));
}

describe("Order aggregate", () => {
  it("Given nothing, When Place, Then OrderPlaced is produced", () => {
    const state = given([]);
    const cmd = { type: "Place", orderId: "o1", items: [{ sku: "A", qty: 1 }] };
    const events = decideOrder(state, cmd);
    expect(events).toEqual([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
  });

  it("Given OrderPlaced, When Place again, Then rejected", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
    expect(() => decideOrder(state, { type: "Place", orderId: "o1", items: [] }))
      .toThrow(NonRetryableError);
  });

  it("Given OrderPlaced, When Cancel, Then OrderCancelled", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [{ sku: "A", qty: 1 }] } },
    ]);
    const events = decideOrder(state, { type: "Cancel", orderId: "o1", reason: "oops" });
    expect(events[0].name).toBe("OrderCancelled");
  });

  it("Given OrderShipped, When Cancel, Then rejected (cannot cancel shipped)", () => {
    const state = given([
      { name: "OrderPlaced", data: { orderId: "o1", items: [] } },
      { name: "OrderShipped", data: { orderId: "o1", trackingId: "T1" } },
    ]);
    expect(() => decideOrder(state, { type: "Cancel", orderId: "o1", reason: "late" }))
      .toThrow(/cannot cancel/i);
  });
});
```

Rules:
- **One invariant per test.** Test name reads as the Given/When/Then clause
- **Never mock the decider.** Test it directly; it has no I/O
- **Expectations are events, not state.** The decider's contract is "given this history,
  which events does this command produce?"
- **Rejections throw `NonRetryableError`** — assert the error class, not the string
- Cover every guard clause — one negative test per invariant

### Step 5: Function integration test (vitest)

Requires `ironflow serve` running.

```typescript
import { describe, it, expect } from "vitest";
import { createClient } from "@ironflow/node";
import { OrderEvents } from "../events/order-events";

const client = createClient({
  serverUrl: process.env.IRONFLOW_SERVER_URL || "http://localhost:9123",
});

describe("process-order (integration)", () => {
  it("completes on valid order", async () => {
    const { eventId } = await client.emit(OrderEvents.PLACED, {
      orderId: "test_1", total: 99.99,
    });
    const run = await waitForRun(client, "process-order", eventId, 10_000);
    expect(run.status).toBe("completed");
  });
});

async function waitForRun(client: any, fnId: string, evId: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // listRuns returns { runs, nextCursor, totalCount } — not a bare array.
    const { runs } = await client.listRuns({ functionId: fnId, limit: 10 });
    const run = runs.find((r: any) => r.eventId === evId);   // field is eventId
    if (run && (run.status === "completed" || run.status === "failed")) return run;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${fnId}`);
}
```

### Step 6: Entity stream test (optimistic concurrency)

```typescript
it("enforces optimistic concurrency", async () => {
  const id = `order-${Date.now()}`;
  await client.streams.append(id, {
    name: OrderEvents.PLACED, data: { total: 50 }, entityType: "order",
  }, { expectedVersion: 0 });

  await expect(
    client.streams.append(id, {
      name: OrderEvents.UPDATED, data: { total: 60 }, entityType: "order",
    }, { expectedVersion: 0 }),   // wrong — should be 1
  ).rejects.toThrow();
});
```

### Step 7: Run tests

```bash
pnpm vitest run path/to/file.test.ts
pnpm jest path/to/file.test.ts
go test -v -run TestName ./path/...
```

If integration tests fail with connection errors, prompt user to start `ironflow serve`.

### Test file naming

- TS: `*.test.ts` next to source; integration in `tests/` or `*.integration.test.ts`
- Go: `*_test.go` in same package

---

## Mode 3: Audit

### Step 1: Run the scanner

```bash
scripts/audit-scan.sh <directory>
```

Relative to this skill's own directory, which your harness names when it loads the skill.
Output is `file:line:severity:rule:message` format. The script greps for known
anti-patterns: 18 TypeScript rules and 4 Go rules (`missing-recording`, `hardcoded-url`,
`PROJ-DET-002`, `PROJ-DET-003`) — Go code gets no coverage for side-effects, yielding
steps, `expectedVersion`, idempotency, webhooks or upcasters; review those by hand.

If the script cannot be executed — a packaged skill is served as readable resources, not
as files on disk — read `scripts/audit-scan.sh` as a skill resource and apply its patterns with the
search tools instead. Keep the rule names it uses so the report matches scanner output;
classify each hit against `https://docs.ironflow.run/explanation/ai-pitfalls.md` by topic (the sections are numbered, not keyed by rule ID).

### Step 2: For each finding, classify

Fetch `https://docs.ironflow.run/explanation/ai-pitfalls.md` and read the relevant section for the
detailed why and fix.

The scanner is a grep heuristic and says so — `missing-expectedversion` counts parens,
`side-effect-outside-step` cannot see that a helper module is only ever called from
inside `step.run()`. When a finding is genuinely wrong, annotate the line rather than
contorting the code around the scanner:

```ts
// audit-ignore: side-effect-outside-step — this is the HTTP client itself, not a
// handler body; its callers wrap it in step.run().
await fetch(url);
```

The pragma goes on the flagged line, or in the `//` or JSDoc block directly above it
(a single-line `/* ... */` is not recognised). Naming the rule is mandatory, so it
cannot silence a different finding that later lands on the same line. For a multi-line
call, put it above the line the scanner actually reports — that is the line the call
*starts* on.

Fix real findings; reserve the pragma for false positives, and always write the why.

### Step 3: Generate report

```markdown
## Ironflow Audit Report

**Scope:** src/functions/, src/projections/
**Files scanned:** N
**Findings:** X critical, Y warnings, Z info

### Critical Issues

1. **Side effects outside steps** — src/functions/process-order.ts:15
   `db.users.find()` outside `step.run()` — re-executes on every retry
   Fix: wrap in `step.run("fetch-user", ...)`

### Warnings

2. **Missing recording flag** — src/functions/process-order.ts:3
   No `recording: true` — time-travel debugging unavailable

### Info

3. **Hardcoded URL** — src/infrastructure/client.ts:5
   `http://localhost:9123` hardcoded — use `process.env.IRONFLOW_SERVER_URL`
```

### Step 4: Offer fixes

> "Want me to fix these? I can:
> - Apply all fixes in one pass
> - Apply only critical fixes
> - Walk through each one with explanation"

Then switch to Write Code mode for the chosen scope.

---

## Common Mistakes Quick Lookup

For the full anti-pattern reference: fetch `https://docs.ironflow.run/explanation/ai-pitfalls.md`.

**Mechanical — top 5 by impact:**
1. Side effects outside `step.run()` — duplicate operations on retry
2. Non-unique step IDs in loops — only first iteration runs
3. Impure managed projections — break rebuild
   - 3a. Non-deterministic managed reducer (`Date.now()`, `Math.random()`, `time.Now()`, `os.Getenv`) — rebuild diverges from live
   - 3b. Mutating state arg then returning it — aliasing hazard; return a fresh object
4. Polling `getProjection()` from browser — use `subscribeToProjection`
5. Yielding step in a `try/catch` or a `.catch()` chain — the catch eats the
   `YieldSignal`, so the run "completes" without ever waiting (and a null check
   never fires either)

**CQRS-semantic — top 5 by impact:**
1. CRUD-named events (`UserUpdated`) — intent erased, consumers write defensive diffs
2. Querying entity streams for display data — couples UI to write model
3. Anemic aggregates — invariants leak into reactors, get enforced too late
4. Fat events carrying full entity state — projections can't cleanly re-derive
5. Command vocabulary on event names (`OrderPlace` instead of `OrderPlaced`) — breaks
   "event = fact" invariant

The audit scanner (`audit-scan.sh`) flags mechanical issues by regex. CQRS-semantic
issues require **reading** the code — during Mode 3 audit, after the scanner runs,
look for these five by hand: grep for event-name constants and check tense; grep for
`streams.read` or `streams.getInfo` in rendering/API code; check whether business rule
violations throw from deciders or from reactors.

---

**Next:** After writing code, you may need:
- `/ironflow-start` — set up entry points (worker, serve handler)
- `/ironflow-ops` — debug runtime failures
- `/ironflow-docs` — look up specific SDK syntax
