# Debugging Ironflow

Systematic diagnosis for runtime failures.

> **If you have the Ironflow MCP server, prefer its tools over the commands below.**
> This file is written for a terminal, but every remediation step it reaches for now has
> an MCP tool: `ironflow_resume_run`, `ironflow_rebuild_projection`,
> `ironflow_outbox_dlq_list` / `_requeue` / `_discard`, `ironflow_circuit_breaker_list` /
> `_reset`. The tools are named inline at each step.
>
> This is not a style preference. In some hosts — Ironflow Desktop's read mode among
> them — you have no shell at all; and where you do, the CLI defaults to
> `http://localhost:9123`, which may be a **different engine** from the one your MCP
> tools address. A command that succeeds against the wrong engine is worse than one that
> is unavailable. The diagnosis verbs (`_list`) work without `--allow-writes`; the
> remediation verbs need it.

## How Ironflow Execution Works

Essential mental model:
- **Steps are memoized by ID.** On retry, completed steps return cached output. They do
  NOT re-execute. Step IDs MUST be unique within a function.
- **Failed runs resume from last successful step** — but that is memoization, not a restart
  point. The function re-enters at the **top**; completed `step.run()` calls return cached
  output, and anything *between* steps executes again. Side effects outside a step must be
  idempotent or they repeat on every resume.
- **`recording: true` enables time-travel.** Without it, only final output is stored —
  `ironflow inspect` won't work.
- **Crash recovery is automatic.** No manual intervention needed.

## Quick Health Check

```bash
curl -s http://localhost:9123/health | jq
curl -s http://localhost:9123/ready | jq
```

If unhealthy → fix server connectivity first (see `platform.md`).

> **`/health` and `/ready` are the only unauthenticated endpoints you'll want here.**
> Everything under `/api/` requires auth — always, with no config toggle — so a bare
> `curl http://localhost:9123/api/v1/...` returns `{"error":"authentication required"}`
> unless the server was started with `ironflow serve --dev`. Prefer the `ironflow` CLI:
> it attaches `IRONFLOW_API_KEY` for you. Where this file shows a raw `curl` against
> `/api/`, it assumes a `--dev` server; otherwise add
> `-H "Authorization: Bearer $IRONFLOW_API_KEY"`.
>
> The full public list is `/health`, `/ready`, `/metrics`, `/api/v1/capabilities`, the auth
> login/validate paths and the platform login (plus webhook ingest, which needs its own `ifwh_`
> token, `/api/v1/files/signed` with its `?token=`, `OPTIONS` preflights, and the non-API dashboard shell).

## Symptom Routing

| Symptom | Section |
|---|---|
| Run failed with error | Failed Run Diagnosis |
| Run stuck in `waiting_for_capacity`/`waiting`/`running` | Stuck Run Diagnosis |
| Run completed, output wrong | Wrong Output Diagnosis |
| Event emitted, nothing happened | Missing Event Diagnosis |
| Projection state doesn't match | Projection Drift Diagnosis |
| Worker not processing | Worker Diagnosis |
| KV operations failing | KV Store Diagnosis |
| Entity stream weird | Entity Stream Diagnosis |

If user gives a run ID, jump straight to Failed/Stuck Diagnosis based on its status.

---

## Failed Run Diagnosis

```bash
ironflow run list --status failed --limit 5 --json
ironflow run get <run-id> --json                             # id, function, status, mode, error, worker_id
ironflow inspect <run-id>                                    # TUI (needs recording: true)
```

Step-level detail (authenticated, and the shape you actually want):
```bash
ironflow sql "SELECT step_id, status, error FROM steps WHERE run_id='<run-id>' ORDER BY created_at" --format json
```

Connect JSON returns an envelope with a `steps` array:
```bash
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" \
  -H "Content-Type: application/json" -d '{"runId":"<run-id>"}' \
  http://localhost:9123/ironflow.v1.IronflowService/GetRunSteps | jq '.steps[]'
```

### Common Error Patterns

| Error | Cause | Fix |
|---|---|---|
| "context deadline exceeded" / timeout | External service slow | Add retry config and idempotency keys. `stepTimeout` is enforced client-side by the SDK in both modes; in push mode the whole request is still capped by the engine's `pushTimeout` (default 10s), so raising `stepTimeout` past that is a no-op |
| Validation error retried 3x | Threw `Error` instead of `NonRetryableError` | Use `NonRetryableError` for permanent failures |
| Duplicate emails / charges | I/O outside `step.run()` | Wrap all I/O inside `step.run()` |
| "Cannot read properties of undefined" | Missing null check on event data or step output | Add null/undefined checks; verify event.data shape |
| "expected version 3, got 4" | Concurrent stream appends | `getInfo()` first, pass `expectedVersion` |

For full anti-pattern reference: `Read ~/.agents/skills/ironflow-docs/anti-patterns.md`.

---

## Stuck Run Diagnosis

```bash
ironflow run get <run-id> --json
ironflow capacity queue        # segments awaiting admission
ironflow capacity leases       # who holds concurrency right now
ironflow capacity sessions     # pull-worker sessions
```

`ironflow capacity ...` requires **platform** credentials (any platform principal — the
view is global across tenants). Set `IRONFLOW_API_KEY` to an `ifplatform_` key; a tenant
`ifkey_` gets `403 platform credentials required`.

**Read the status first — it names the diagnosis.** `pending` was retired (#1222); the
runs table CHECK constraint now rejects it, so `--status pending` finds nothing and reads
as "no stuck runs". The stuck states are:

| Status | Means | Look at |
|---|---|---|
| `waiting_for_capacity` | A runnable segment is queued, awaiting admission | `ironflow capacity queue` / `lanes` / `leases` |
| `waiting` | Blocked on a durable wait — sleep, event, invoke, retry delay, recovery grace | the step's wait condition |
| `paused` | Paused for injection | `ironflow run paused-state <id> --json` |

### What to check

- **`waiting_for_capacity`?** Something upstream is holding the lane. `ironflow capacity
  leases` shows current holders; `ironflow capacity lanes` shows the limit being enforced.
- **Circuit breaker tripped?** A breaker open on the endpoint blocks dispatch at
  reservation, so runs sit unadmitted with no error on the run itself:
  ```bash
  ironflow circuit-breaker list
  ironflow circuit-breaker reset <endpoint-url | function-id>
  ```
  MCP: `ironflow_circuit_breaker_list`, then `ironflow_circuit_breaker_reset` with the
  `key` field verbatim from the list. Reset only after fixing the cause — a breaker that
  reopens tells you nothing new.
- **`step.sleep()` running?** Sleeps are durable. Wait for expiry — not a bug.
- **`step.waitForEvent()` waiting?**
  - Was the expected event emitted? There is no `ironflow event list`; use
    `ironflow sql "SELECT id, name, timestamp FROM events ORDER BY timestamp DESC LIMIT 20"`
    (`ironflow event ...` only has `schema`, `upcast` and `redact` subcommands).
  - `match` names a key that is actually in `event.data`? (`match: "orderId"` and
    `match: "data.orderId"` are equivalent — the engine strips the optional `data.` prefix)
  - Event name spelled exactly? Case-sensitive.
  - Timeout expired? Then the run is already **failed**, not stuck — the scheduler marks
    the step `timed_out` and fails the run. `waitForEvent` never returns `null` and never
    rejects catchably; nothing after it in the handler runs.
- **Concurrency limit?** `ironflow function get --json` does **not** emit `concurrency` —
  it only returns id/name/description/mode/endpoint/triggers/status/metadata. Use
  `ironflow capacity lanes` for the enforced limit.
- **Pull mode but no worker?** `ironflow capacity sessions`, or
  `ironflow run get <id> --json` and check `worker_id` is set. A `mode: "pull"` function
  with no worker connected waits forever.
- **Paused for injection?** `ironflow run paused-state <run-id> --json`. Resume with
  `ironflow run resume <run-id>` (`--from-step` optional).
  MCP: `ironflow_resume_run`. It takes failed runs as well as paused ones, so it is the
  retry verb too. Completed steps are memoized, but code outside a step re-runs — see the
  mental model at the top. Do not fire it twice in quick succession: a second resume inside
  the stream's dedupe window returns **HTTP 409** ("a resume for this run is already in
  flight") and leaves the run exactly as it found it. Wait for the first to land; do not
  retry on 409.

---

## Wrong Output Diagnosis

Best tool: time-travel debugger (requires `recording: true`):

```bash
ironflow inspect <run-id>
```

Step outputs use `stepId` for the step name. Read `outputValue` when present, then fall back to `output`:
```bash
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" \
  -H "Content-Type: application/json" -d '{"runId":"<run-id>"}' \
  http://localhost:9123/ironflow.v1.IronflowService/GetRunSteps | jq '.steps[] | {step_id: .stepId, output: (if has("outputValue") then .outputValue else .output end)}'
```

### What to check

- **Event data correct?** `event.data` is the input. If wrong, problem is upstream emitter.
  If using event name constants, verify the constant's underlying string matches what was
  emitted.
- **Step return values walking backward?** Walk each step's output. First step with wrong
  output is where the bug lives.
- **Stale memoized value?** If you changed code and re-ran, completed steps still return
  cached output. New code runs only for the failed step + later. Re-execute earlier steps =
  new run required.
- **Step returning wrong type?** TS: if `step.run()` callback returns a Promise but doesn't
  `await`, memoized output is `{}` instead of resolved value.

---

## Missing Event Diagnosis

```bash
ironflow sql "SELECT id, name, source, timestamp FROM events WHERE name='<event-name>' ORDER BY timestamp DESC LIMIT 20" --format json
ironflow function list --json
ironflow function get <function-id> --json
ironflow emit test.event --data '{"test": true}'             # smoke test
ironflow outbox dlq list --env <env> --json                   # delivery failures land here
```

Every `outbox dlq` subcommand requires `--env` unless `IRONFLOW_ENV` is set.

MCP: `ironflow_list_events` takes `names`, `since`, `source` and `search`, so the SQL and
`curl` above are usually unnecessary. `ironflow_outbox_dlq_list` needs an explicit `env`
— get one from `ironflow_list_environments`.

Raw REST alternative — note the envelope (`{"events": [...]}`) and quote the URL so the
shell doesn't glob `?`:
```bash
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" \
  "http://localhost:9123/api/v1/events?limit=50&name=<event-name>" | jq '.events[]'
```

### What to check

- **Event actually emitted?** Not in event list = emit failed silently. Check emitter
  error handling.
- **Trigger pattern matches exactly?** Case-sensitive. `Order.Placed` ≠ `order.placed`.
- **Function registered?** If defined in code but absent from `function list`, the
  worker/serve handler hasn't started or connected.
- **Environment scope?** Events + functions are project+env scoped. Mismatch = no trigger.
- **Function paused/archived?** Check function status.

---

## Projection Drift Diagnosis

```bash
ironflow projection status <name> --json                     # lag, error, last_event_seq
ironflow projection get <name> --json                        # current state
ironflow projection list --json                              # all projections
```

### What to check

- **Caught up?** `lag > 0` = behind. Wait or check for errors.
- **Processing error?** `error` field set = handler crashed. Fix handler, projection
  resumes.
- **Handler pure?** Managed projections must be pure reducers. Side effects → use
  `mode: "external"`.
- **Event list correct?** `events` array determines which events processed. Missing event
  name = ignored.
- **Handler covers all event types?** If listening to `[order.placed, order.cancelled]`
  but handler only switches on `placed`, the other is consumed but ignored.
- **`initialState` is a function, not object?** Common bug: `initialState: { count: 0 }`
  should be `initialState: () => ({ count: 0 })`.
- **Need rebuild?** Changed handler logic? State was built by old handler:
  ```bash
  ironflow projection rebuild <name>
  ```
  MCP: `ironflow_rebuild_projection`, then poll `ironflow_rebuild_projection_status` —
  a rebuild is asynchronous and the start call only returns a job.
- **`last_event_seq=0` but the stream has events?** Check the **outbox**, not the append
  site:
  ```bash
  ironflow outbox dlq list --env <env> --json
  ironflow projection rebuild <name> --dry-run    # text mode prints "Total Events:"
  ```
  `streams.append` enqueues **two** outbox rows — one to the entity namespace and one to
  the events namespace that projections consume. If the outbox drain fails, the second
  publish never lands, so the stream holds events while `last_event_seq` stays 0. That is
  this symptom's actual cause. Requeue with `ironflow outbox dlq requeue <event-id>
  --env <env>`, or MCP `ironflow_outbox_dlq_requeue` (`event_id` + `env`). Fix the drain
  failure first, or the entry dead-letters again.

  **`--dry-run` works.** The guard sits above every mutation
  (`internal/projection/rebuild.go:415`), so a dry run is a pure query: it reports the
  start cursor, the target and the event count, registers no job and deletes nothing.
  It can still FAIL: with `IRONFLOW_EVENT_RETENTION_DAYS` set, a rebuild that would
  replay from before the retention horizon is refused — by the dry run as well as the
  real one — because replaying a pruned window produces a read model with a silently
  missing prefix. Rebuild with `--from <event-id>`, naming an event created at or after
  the horizon, to accept the shortened history. An environment younger than the window is
  exempt — nothing in it can be old enough to have been pruned.
  `ironflow_rebuild_projection` exposes `dry_run` too. Always preview first — a real
  rebuild IS destructive: it deletes the read model and the projection serves nothing
  until the replay finishes.

  Then confirm the projection's `events` array actually lists the event name — a name
  that isn't listed is ignored, which looks identical from the outside.

  > **Do not "fix" this by dual-emitting** `streams.append` + `emit` with the same
  > name/data. Appends already reach projections through the events-namespace outbox row,
  > so dual-emit publishes the same domain fact twice and the reducer runs twice —
  > silently double-counting every total. There is also no `include_entity=true` query
  > param on `/api/v1/events`; entity events appear in the default listing already.

---

## Worker Diagnosis

```bash
ironflow capacity sessions                                   # pull-worker sessions
ironflow capacity credits                                    # per-worker credit state
ironflow run list --status waiting_for_capacity --json       # NOT "pending" — retired in #1222
ironflow function get <function-id> --json                   # verify mode: "pull"
```

`/api/v1/workers` also exists (`{"workers": [...], "count": N}`) but is categorized
server-only/SDK-internal — prefer `ironflow capacity sessions`.

Check worker process logs for connection errors, auth failures, crashes.

### What to check

- Worker process running? Hasn't crashed?
- `serverUrl` matches running server? Right port/hostname?
- Function in worker's `functions` array?
- Network reachable? Firewall, proxy, DNS?
- Authenticated? API key present if server requires?
- Overwhelmed? All concurrency slots full = new runs queue.

---

## Entity Stream Diagnosis

```bash
ironflow stream list --json
ironflow stream read <entity-id> --json
```

### What to check

- Events in version order? Non-sequential = concurrency bug.
- All events share `entityType`? Mixed types = emitter bug.
- Upcasters running for old events?
- Optimistic concurrency conflicts repeating? Too many concurrent writers — add concurrency
  key on writer function to serialize per entity.

---

## KV Store Diagnosis

```bash
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" http://localhost:9123/api/v1/kv/buckets | jq '.buckets[]'
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" http://localhost:9123/api/v1/kv/buckets/<bucket>/keys | jq '.keys[]'
curl -s -H "Authorization: Bearer $IRONFLOW_API_KEY" http://localhost:9123/api/v1/kv/buckets/<bucket>/keys/<key> | jq
```

All three are enveloped (`{"buckets": …}`, `{"keys": …}`); the single-key read returns a
bare `KVEntry` whose `value` is base64 — decode with `jq -r '.value | @base64d'`.

**A 404 here means no NATS, not an empty bucket.** The KV routes are only registered when
the server has a NATS provider; without one they don't exist at all.

### What to check

- Bucket exists? Created on first SDK use OR via `createBucket()`.
- `APP_` prefix? User buckets are `APP_*`. SDK adds it automatically; direct API calls
  must include it. Only `APP_` buckets show in dashboard.
- NATS healthy? `curl -s http://localhost:9123/ready | jq`.
- Watch callbacks stopped firing? Stale shared consumers. Page refresh / worker restart.

---

## Common Failure Patterns Quick Reference

| Pattern | Symptom | Root | Fix |
|---|---|---|---|
| Non-idempotent steps | Duplicate charges/emails on retry | No idempotency key | Add `idempotencyKey` to API calls |
| Side effects outside steps | Op runs every replay | I/O not in `step.run()` | Wrap all I/O inside `step.run()` |
| Wrong match | `waitForEvent` never resolves | `match` names a key not in `event.data`, or its value differs between events | Match on a key both events carry (`data.` prefix optional) |
| Projection drift | State mismatch | Impure handler / missing event type | Pure handler; verify events array |
| Concurrency conflict | Append fails | Stale `expectedVersion` | `getInfo()` first |
| Stale memoized output | Retry uses old results | Step previously completed | Create new run instead of retrying |
| Push timeout (10s default) | Long task in serverless | Wrong mode | Switch to pull with Node `createWorker`, Go `NewWorker`, or Python `Worker(functions=[...]).run()`. Self-hosters can raise `engine.pushTimeout` in `ironflow.yaml`; on a managed server you cannot |
| Missing registration | Event emitted, no run | Function not in serve/worker | Add to functions array |
| Wrong event name | Function never fires | Typo, case mismatch | Verify exact event name |
| `waitForEvent` timeout | Run fails; nothing after the wait runs | Timeout is not observable in the handler — no null, no catchable error | Model the deadline as its own event, or react to `system.run.*.failed`. Never catch a yielding step's rejection — `try/catch` or `.catch()`, both eat the YieldSignal |

For all → after diagnosis, suggest `/ironflow-code` to write the fix.

---

## Verifying a Fix Against a Live Dev Server

When a dev server with file-watch is running (`tsx watch`, `node --watch`, `air`, …),
editing function or projection code triggers a **versioned re-registration** (reload).
Emit a verification event *before* that reload lands and you test the OLD code — a
misleading pass or fail on the exact fix you're checking.

**When operating via MCP** (e.g. the Ironflow Desktop agent loop), gate the cycle:

```
edit code → ironflow_await_reload → ironflow_emit_event  (or ironflow_invoke_function)
```

`ironflow_await_reload` blocks until the registry passes the version your last test hit,
then returns — immediately if the reload already landed, after ~15s if none is detected
(it never blocks the emit itself). It is registered only when **both** `--allow-writes`
and `--evidence-file` are set — the reload baseline rides the evidence tap — so the server
must run as `ironflow mcp --allow-writes --evidence-file trail.jsonl`. If the evidence file
cannot be opened the server logs a warning and serves without it, and the tool is absent
even with both flags. See `~/.agents/skills/ironflow-docs/mcp.md`.

**CLI fallback:** `ironflow function list/get --json` does **not** expose `version` — the
column exists but the CLI drops it, so polling those commands can never observe the bump.
Query the column directly instead:

```bash
ironflow sql "SELECT id, version FROM functions WHERE id='<function-id>'" --format json
```

Poll that until `version` increases, then emit.

---

## Time-Travel Debugger

`ironflow inspect <run-id>` opens a TUI. Requires `recording: true`.

Modes:
```bash
ironflow inspect <run-id>                              # standard TUI
ironflow inspect <run-id> --replay                     # frame-by-frame
ironflow inspect <run-id> --replay --all-events        # include step.started etc
ironflow inspect <run-id> --at 2026-03-15T10:30:00Z    # snapshot mode
ironflow inspect <run-id> --dap                        # VS Code DAP (--dap-port, default 4711)
```

The modes are mutually exclusive in precedence order: `--at`, then `--replay`, then
`--dap`. `--replay --dap` silently ignores `--dap` — pass `--dap` alone.

TUI: arrow keys, Enter, `q` to quit.

Use for: failed run analysis, wrong output investigation, comparing successful vs failed
runs, production incidents (replay without reproducing).

---

## Advanced: SQL Queries

```bash
ironflow sql "SELECT id, function_id, status, error FROM runs WHERE status='failed' ORDER BY started_at DESC LIMIT 10"
ironflow sql "SELECT step_id, status, error FROM steps WHERE run_id='<id>' ORDER BY created_at"
```

Useful for: cross-run pattern analysis, step timing investigation, database-level state
not exposed via API.

---

## Diagnosis Checklist

When you complete a diagnosis:
1. **Root cause identified** — explain WHY it failed
2. **Evidence collected** — run ID, step outputs, error messages
3. **Fix suggested** — tell user what to change, offer `/ironflow-code` to implement
4. **Prevention noted** — pattern to avoid recurrence
5. **Cleanup done** — temp files removed
