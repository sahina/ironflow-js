# Detection — Node / TypeScript

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.
Seeded from the pattern table that used to live in `ironflow-start` Mode 2.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `node.scheduled` | bullmq, pg-boss, agenda, node-cron, Bree, `@nestjs/schedule` | A queue without durable steps. A job failing at stage 3 restarts at stage 1 | Pull-mode function; resume from the last successful step | strong |
| `node.fire-and-forget` | `void someAsync()`, `.catch(() => {})`, `setImmediate` | Swallowed failures. The most common source of "it just didn't happen" | Emit an event; the run is durable and queryable | strong |
| `node.broker-consumer` | amqplib, kafkajs, SQS client, NATS | Already doing EDA | Verdict becomes **already doing EDA** | reframe |
| `node.retry` | p-retry, async-retry, hand-rolled backoff | In-process retry, lost on restart | Engine-side retry with backoff, queryable failed-run history, resume from the last step | strong |
| `node.status-column` | `status: 'pending' \| 'processing' \| ...` | Hand-rolled state machine | Entity stream; the column becomes a projection | supporting |
| `node.read-model` | Three or more JOINs in one query | A read model computed on every request | Managed projection — the reducer maintains the shape | supporting |

## Combination rules

- `node.fire-and-forget` over-reports: `void` and empty `.catch` have legitimate
  uses. Require a second signal in the same module before promoting it.
- Node is Tier 1. This is the one stack where the report can show a single
  snippet in the reader's own language and be done.

## Adoption note

Node and TypeScript are Tier 1 — full worker runtime, durable steps, pull mode.
Python is also Tier 1 for polling workers: `ironflow.worker.Worker(functions=[...]).run()`.
No adoption caveat applies. See `adoption-paths.md`.
