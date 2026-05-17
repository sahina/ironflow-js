# `@ironflow/browser` Agents Module — Specification

This document is the contract for `ironflow.agents.{invoke, subscribe, readMemory}`. It defines event taxonomy, error semantics, race-window analysis, retry/idempotency, abort behavior, authorization scope, and the read-your-writes consistency model for memory reads.

Source of truth for implementers and reviewers. Code that disagrees with this spec is wrong.

Lane B-3 S1 (`invoke`, `subscribe`), issue #625. Reviewed in `/plan-ceo-review` (decisions D1-D13) and `/plan-eng-review` (decisions D14-D15).
Lane B-3 S2 (`readMemory`), issue #625. Reviewed in `/plan-ceo-review` (decisions D-S2-1..8).

## Surface

```typescript
ironflow.agents.invoke<TOutput = unknown>(
  name: string,
  payload: unknown,
  opts?: AgentInvokeOptions,
): Promise<AgentInvokeResult<TOutput>>;

ironflow.agents.subscribe(
  runId: string,
  callbacks: AgentSubscribeCallbacks,
): Subscription;
```

`AgentInvokeOptions`:
- `timeoutMs?: number` — default `30000`. Local timeout. Triggers `AgentInvokeTimeoutError` and calls `cancelRun(runId)` server-side.
- `signal?: AbortSignal` — caller cancellation. On abort, throws `AbortError` and calls `cancelRun(runId)`.
- `idempotencyKey?: string` — opt-in dedup. Server returns the same `runId` for repeat calls with same key (existing event-idempotency path).
- `replay?: number` — events to replay on subscribe. Default `1000` (matches the server's `ReplayMaxEvents` cap). Lowering this risks missing terminal events for step-heavy agents. See "Race window" below.
- `onRunStarted?: (runId) => void | Promise<void>` — surfaces the runId as soon as Trigger returns. Awaited by the SDK so async setup (e.g., attaching a watcher subscription) finishes before terminal events dispatch.

`AgentInvokeResult<TOutput>`:
- `runId: string`
- `output: TOutput | undefined` — populated from terminal `run.completed` event payload.
- `durationMs: number`

## Run event taxonomy

Subjects published by server: `system.run.{runId}.{event}`. Bridge prefixes with `public.{projectName}.{envID}.` before NATS publish; browser SDK subscribes with the bridge-aware pattern via existing `client.subscribe()`.

Source: `internal/pubsub/types.go:187-197`, `internal/engine/event_publisher.go:43-91`.

### Terminal events

| Event | Triggers | SDK behavior |
|---|---|---|
| `system.run.{runId}.completed` | run reached `RunStatusCompleted` | resolve `{runId, output, durationMs}` |
| `system.run.{runId}.failed`    | run reached `RunStatusFailed`    | throw `RunFailedError(runId, error)` |
| `system.run.{runId}.cancelled` | run reached `RunStatusCancelled` | throw `RunCancelledError(runId)` |

### Non-terminal events

| Event | Meaning |
|---|---|
| `system.run.{runId}.created` | run row inserted; not always published (cron bypasses EventRouter) |
| `system.run.{runId}.updated` | status transition; may include `running`, `paused`, etc. |
| `system.run.{runId}.resumed` | run resumed from pause |
| `system.run.{runId}.step.{stepId}.{created\|completed\|...}` | step lifecycle |

`agents.invoke` ignores non-terminal events for resolution. Step events still surface to `agents.subscribe` callbacks (`onStep`).

## Race window

```
t0  Browser  POST /Trigger
t1  Server   creates run, publishes system.run.{runId}.created/.updated
t2  Server   responds with runId
t3  Browser  reads runId from response
t4  Browser  subscribe(`system.run.{runId}.>`, {replay: N})
t5  Bridge   delivers buffered events (replay) + new events
```

Window is `t1..t4`. Worst-case: agent starts and emits `.completed` between t1 and t4. Without replay, completion is missed and invoke hangs.

### Mitigation: replay

Default `replay: 1000`, matching the server's `ReplayMaxEvents` cap. Subscribe replays the last N events on the matching subject. Since the run's run-events stream did not exist before t1, replay covers the entire t1..t4 window for new runs whose total emitted events fit within the budget.

For step-heavier agents (>500 steps in one run; each step emits `created`+`completed`), raise both `opts.replay` and the server's `ReplayMaxEvents` config. Otherwise the terminal `.completed` event can fall off the replay buffer and `agents.invoke` waits until timeout.

### Verification (D10 ship-blocking gate)

`tests/integration/agents-race.test.ts` runs 100 invocations against an agent that emits `step.completed` within ~1ms of start, then transitions the run to `completed` immediately. Asserts: zero hangs, all 100 invokes resolve with the correct `output`. If the gate fails, escalate to issue #626 (server-side `TriggerSyncByFunctionId`).

## Errors

Class hierarchy in `@ironflow/core`:

```
IronflowError
├── ValidationError       (existing)
├── RunFailedError        (existing) — agents.invoke throws on .failed
├── RunCancelledError     (existing) — agents.invoke throws on .cancelled
├── AgentInvokeTimeoutError  (NEW, B-3 S1)
└── NoRunCreatedError        (NEW, B-3 S1)
```

`AgentInvokeTimeoutError(runId, timeoutMs)`: thrown when local timeout elapses before terminal event. SDK best-effort calls `client.cancelRun(runId)` to stop server-side execution.

`NoRunCreatedError(name)`: thrown when the Trigger response contains an empty `runIds` array. Indicates server misconfiguration or function not registered.

## AbortSignal

`opts.signal` follows browser fetch idiom:
- If signal is already aborted at call entry: throw `AbortError` immediately, no Trigger call.
- If signal aborts during the wait: throw `AbortError`, call `client.cancelRun(runId)`, unsubscribe.
- AbortError is a standard `DOMException` with name `'AbortError'`, not a custom class.

## Idempotency and retry

`opts.idempotencyKey`:
- Wires through to existing event-idempotency path on server.
- Same key → same `runId` returned. Server-side dedup is authoritative.
- Behavior across reconnect/refresh: re-invoking with the same key returns the same `runId`. If the original run is still running, the new invoke attaches and waits. If terminal, it resolves/throws based on terminal state. (Implementer note: cleanly handled because `subscribe` with replay re-fetches the terminal event.)

Without `idempotencyKey`: each call creates a new run. Caller is responsible for client-side debounce.

## Cleanup contract

Every exit path of `agents.invoke` MUST:
1. Unsubscribe the subscription.
2. Clear the timeout.
3. On error / timeout / abort: best-effort `cancelRun(runId)` (only if a runId was obtained).

Implementation uses `try/finally`. Verified by `tests/integration/agents-leak.test.ts`: 100 invokes with 50% failure → SubscriptionManager active-sub-count == 0.

## Authorization scope

Subscribe uses HTTP/ConnectRPC auth (API key or JWT cookie). Tenant boundary = env (verified in D5 audit).

- Cross-env subscribe is NOT possible: bridge prefix scopes all subjects to the caller's env.
- Within-env runId guessing IS possible by design: env is the trust boundary.
- For per-user run isolation within an env, future work would add run-level ACLs. Not in B-3 scope.

## Subscribe (`agents.subscribe`)

Thin wrapper:

```typescript
function subscribe(client, runId, callbacks): Subscription {
  validateRunId(runId);
  return client.subscribe(`system.run.${runId}.>`, {
    onEvent: dispatchByTopic(callbacks),
    onError: callbacks.onError,
  });
}
```

`AgentSubscribeCallbacks`:
- `onProgress?(event: { topic, sequence, status?, data? })` — non-terminal `run.*` events
- `onStep?(event: { stepId, type, data })` — step events
- `onComplete?(result: { output })`
- `onFailed?(error: { message, code })`
- `onCancelled?()`
- `onError?(err)` — transport / parse errors

## `readMemory` (S2)

Typed read of agent memory projection state, with optional read-your-writes catchup.

```typescript
ironflow.agents.readMemory<TState = unknown>(
  projection: string,
  opts?: AgentReadMemoryOptions,
): Promise<AgentMemoryResult<TState>>;
```

`AgentReadMemoryOptions`:
- `minSeq?: number | bigint` — sequence number from a prior `streams.append` response. When set, `readMemory` calls `waitForProjectionCatchup` before reading state. Provides read-your-writes for the caller that just wrote.
- `timeoutMs?: number` — catchup timeout, default `30000`. Ignored when `minSeq` is not provided.
- `signal?: AbortSignal` — caller cancellation; throws `AbortError` (DOMException). Aborts checked pre-flight, between catchup and state read, and via Promise race during in-flight calls.
- `partition?: string` — passthrough to both catchup and state read for partitioned projections. Default unpartitioned (`__global__` server-side).

`AgentMemoryResult<TState>`:
- `state: TState`
- `version: number`
- `lastEventId?: string` — omitted when server returns empty.
- `caughtUp: boolean` — always `true` on a successful return. Catchup timeouts throw, never return `caughtUp: false`.

### Composition

```
readMemory(projection, opts):
  1. validate projection name + pre-flight abort check
  2. if opts.minSeq:
       waitForProjectionCatchup(projection, {minSeq, timeoutMs, partition})
       if WaitResult.timedOut → throw MemoryCatchupTimeoutError
  3. abort check
  4. getProjection<TState>(projection, {partition})
  5. return {state, version, lastEventId, caughtUp: true}
```

No new server RPC. Composes `client.waitForProjectionCatchup` + `client.getProjection`.

### Consistency contract

- Without `minSeq`: **eventual consistency.** Reader observes whatever projection cursor exists at request time. Lag typical 10-50ms post-append on a healthy system.
- With `minSeq`: **read-your-writes** for the caller that wrote. Catchup blocks until projection cursor ≥ `minSeq` or `timeoutMs` elapses. Caller sources `minSeq` from a `streams.append` response; the SDK never auto-discovers `minSeq`.

### `minSeq` semantics

- Scoped to the projection's underlying event stream sequence (NATS seq).
- If `minSeq` exceeds the projection's eventual `last_event_seq` (e.g., typo, stale value), the catchup blocks until `timeoutMs` and throws `MemoryCatchupTimeoutError`. Caller is responsible for sourcing valid sequences.
- `minSeq=0` and `minSeq=0n` are treated as "no catchup required" — the SDK skips the catchup call entirely. Pass `undefined` instead for clarity, but `0` works as a defensive default.

### Errors

- `ValidationError` — empty / oversized projection name.
- `MemoryCatchupTimeoutError(projection, minSeq, timeoutMs)` — catchup did not reach `minSeq` within `timeoutMs`. Retryable: `true`. New class in `@ironflow/core`.
- `AbortError` (DOMException) — caller signal aborted at any of the three checkpoints.
- `IronflowError` (existing) — projection 404, network, or other transport failures propagate from `getProjection` / `waitForProjectionCatchup`.

### AbortSignal

Three checkpoints:
1. **Pre-flight** — throws before any request if `signal.aborted`.
2. **Between catchup and read** — explicit `throwIfAborted` after catchup resolves.
3. **In-flight Promise race** — the SDK races each network call against the abort signal so a hung server does not pin the caller past abort.

The underlying `getProjection` / `waitForProjectionCatchup` calls do not themselves accept signals; the race aborts the SDK-level Promise but lets the original fetch settle in the background. Acceptable: each call has its own server-side timeout.

### Authorization scope

Reuses HTTP/ConnectRPC auth (API key or JWT cookie). Tenant boundary = env, enforced at the store layer via `envFilter` on `GetProjectionRegistry` + `GetProjectionState` (verified 2026-04-27).

- Cross-env reads return 404 (projection name lookup is scoped to the caller's env).
- Within-env projection guessing IS possible by design: env is the trust boundary. Per-projection ACLs are future work.

### Out of scope (S2)

- `appendMemory` write surface (D3 — server-trust boundary; agent runtime owns writes).
- `readMemoryStream` live-update iterable (deferred to TODOS, see #627).
- Raw events read via `streams.read` from this helper (callers use `client.streams.read` directly).
- React hooks (#627, P3).
- Per-user run-level ACLs within an env (future).

### Ship gates (S2)

1. Unit tests cover happy / minSeq-order / partition / catchup-timeout / abort variants / error propagation.
2. Integration test: server-side append → browser `readMemory` with returned seq → state matches written event.
3. Cross-env negative test: env B caller cannot read env A's projection — 404, not 200.
4. ≥80% coverage on `src/agents/readMemory.ts`.

## Out of scope (S1)

- React hooks (#627, P3)
- SSE LLM token streaming (Phase 3)
- Browser-side LangGraph (Phase 4)
- Server-side `TriggerSyncByFunctionId` (#626, P2 — escalation if D10 fails)
- Per-user run-level ACLs within an env (future)

## Ship gates

1. D10 race test passes (`tests/integration/agents-race.test.ts`).
2. Leak audit passes (`tests/integration/agents-leak.test.ts`).
3. `tests/integration/agents-invoke.test.ts` round-trip passes.
4. ≥80% coverage on `src/agents/*`.
5. `pnpm -C sdk/js test` green.
