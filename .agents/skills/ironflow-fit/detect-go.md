# Detection — Go

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `go.scheduled` | `time.NewTicker`, robfig/cron, gocron | In-process scheduling; state dies with the process, replicas double-fire | Cron-triggered function with durable steps | strong |
| `go.fire-and-forget` | bare `go func()` | Killed on shutdown, no record, no retry. A panic inside takes the process with it | Emit an event; the run is persisted first | strong |
| `go.broker-consumer` | watermill, NATS, kafka-go, sarama (IBM or Shopify path) | Already doing EDA | Verdict becomes **already doing EDA** | reframe |
| `go.retry` | `backoff.`, `retry.Do`, `MaxRetries` | In-process retry, lost on restart | Engine-side retry with backoff, queryable failed-run history, resume from the last step | strong |
| `go.remote-in-txn` | `db.Begin()` / `tx.Commit()` near an HTTP call | Dual write | Outbox for the emit; saga for cross-service writes | strong |

## Combination rules

- `go func()` over-reports harder than any other signal in this skill — it is the
  language's basic concurrency primitive. Never build a candidate on it alone.
  Promote only when it appears with no `sync.WaitGroup`, `errgroup`, or channel
  receive in the same function.
- `go.remote-in-txn` does not check proximity to an HTTP call. Read the file
  before claiming a dual write.

## Adoption note

Go is Tier 1 — full worker runtime, durable steps, pull mode. No adoption caveat.
Python is also Tier 1 for polling workers: `ironflow.worker.Worker(functions=[...]).run()`.
