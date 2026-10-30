# Write Code

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
> - Tests for this? Read [generate-tests.md](generate-tests.md) before switching to test mode.
> - Set up the worker/serve entry point? Use `/ironflow-start`.
> - Audit existing code? Read [audit.md](audit.md) before switching to audit mode."

Verifying against a **running dev server**? Wait for it to reload your edit before emitting
a test event. If operating via MCP, call `ironflow_await_reload` first so the test hits the
reloaded version, not the code you just replaced — see `/ironflow-ops` → "Verifying a Fix
Against a Live Dev Server".

