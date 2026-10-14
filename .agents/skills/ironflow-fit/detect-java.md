# Detection — Java / Spring

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.
The script owns the regexes; never re-derive them here.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `java.scheduled` | `@Scheduled`, Quartz, Spring Batch | A cron holds business state in memory. A restart mid-run loses it; two instances run it twice unless you added a lock | Cron-triggered function with durable steps; the engine holds the state, not the pod | strong |
| `java.fire-and-forget` | `@Async`, `CompletableFuture.supplyAsync`, `TaskExecutor` | The work is gone if the JVM dies between the return and the completion. No retry, no record it ever started | Emit an event; the run is persisted before any work happens | strong |
| `java.transactional` + `java.remote-in-txn` **in the same file** | A remote call inside a database transaction | The classic dual write. The DB commits and the remote call fails, or the reverse. Nothing reconciles them | Outbox for the emit; saga with compensation for multi-service writes | strong |
| `java.broker-consumer` | `@RabbitListener`, `@KafkaListener`, `@JmsListener`, Spring Cloud Stream | Nothing — they already do EDA. What they usually lack is replay, a durable run record, and compensation | Verdict becomes **already doing EDA**. Pitch durability and replay, not the pattern | reframe |
| `java.retry` | `@Retryable`, `RetryTemplate`, resilience4j | Retry lives in the process. A restart mid-backoff drops the attempt; there is no dead-letter and no visibility into what is retrying | Engine-side retry with backoff, a queryable failed run, resume from the last step | strong |
| `java.status-column` | A status/state enum on an entity | The status column is a hand-rolled state machine. Rows get stuck in intermediate states when a step fails halfway, which is what the reconciliation cron exists to clean up | Entity stream — the lifecycle becomes the events, the column becomes a projection | supporting |
| `java.history-table` | `*_history`, `*_audit`, `*_log`, `outbox` tables | They already wanted an event log and built one by hand, without ordering guarantees or replay | Event sourcing with projections; the audit table is derived, not maintained | supporting |
| `java.long-timeout` | Async request timeouts, long client timeouts | Work is bounded by an HTTP timeout it should not be bounded by | Pull-mode worker: no timeout | supporting |
| `java.webhook` | `@PostMapping` on a webhook path, signature headers | Inbound webhook processed inline. A slow handler drops the delivery; the provider retries into a non-idempotent path | Webhook source → event → durable run. Signature verification at ingress | supporting |
| `java.feign-edge` | `@FeignClient(name=...)` | Names the synchronous service edge. Feeds the diagram, not a candidate by itself | — | context |

## Combination rules

- **The dual-write finding requires `java.transactional` and `java.remote-in-txn` in the same file.** Either alone is context, not a candidate. `java.remote-in-txn` matches HTTP client usage anywhere, so it over-reports by design — the intersection is the signal.
- `java.status-column` + `java.scheduled` together is the strongest single pattern in a Spring codebase: a lifecycle column plus a cron that unsticks it. Name the reconciliation job in the report; it is the reader's own evidence that the current design leaks.
- `java.broker-consumer` present flips the whole report to the **already doing EDA** verdict path. Do not pitch "you should adopt events" to a team that already has `@KafkaListener`.

## Adoption note

Java is Tier 2. Their side stays Java — see `adoption-paths.md`, and link the team
to <https://docs.ironflow.run/how-to-guides/integration/other-languages/>, which walks client
generation, `RegisterFunction`, and a push handler end to end. Do not show a Java
team a TypeScript workflow without the Java half beside it.
