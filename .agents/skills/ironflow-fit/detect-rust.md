# Detection — Rust

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `rust.scheduled` | `tokio-cron-scheduler`, `JobScheduler`, `cron::` | In-process scheduling. State dies with the process; two replicas double-fire | Cron-triggered function with durable steps | strong |
| `rust.fire-and-forget` | detached `tokio::spawn` | The handle is dropped, so the task is unobservable and unrecoverable. Cancelled on runtime shutdown | Emit an event; the run is persisted first | strong |
| `rust.broker-consumer` | lapin, rdkafka, aws-sdk-sqs, async-nats | Already doing EDA | Verdict becomes **already doing EDA** | reframe |
| `rust.retry` | `backoff::`, `tokio-retry`, hand-rolled retry | In-process retry; no DLQ, no operator visibility | Engine-side retry with backoff, queryable failed-run history, resume from the last step | strong |
| `rust.remote-in-txn` + `rust.http-client` **in the same function** | `sqlx` transaction wrapping a `reqwest` call | Dual write | Outbox for the emit; saga for cross-service writes | strong |

## Combination rules

- `tokio::spawn` over-reports badly — it is the idiomatic way to start any task,
  most of which are structured and awaited elsewhere. Treat it as *supporting*
  unless the spawn result is visibly discarded, and never build a candidate on it
  alone.
- Rust codebases are usually smaller and more deliberate than the other stacks
  here. Be more willing to return **not a fit**.

## Adoption note

Rust is named as a future Tier-2 target in <https://docs.ironflow.run/reference/sdk-comparison/>
(the "Tier 2 — generated client only (Rust, C#, Java later)" heading) and nowhere else — no roadmap entry, no
owner, no date. Label it planned. Today a Rust shop generates
from the OpenAPI and proto artifacts.

**Do not confuse the reader** with `docs/explanation/v2-rust-experiment/`. That is
a brainstorm about rewriting the *server* in Rust, explicitly "not a commitment,"
and render-excluded from the docs site. It has nothing to do with a Rust client.
