# Detection — C# / .NET

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `dotnet.scheduled` | Hangfire, Quartz.NET, `BackgroundService`, `IHostedService`, timer triggers | Hangfire keeps job state in their database and retries in-process. It has no notion of a step, so a job that fails at stage 3 restarts at stage 1 | Cron or event-triggered function; failed runs resume from the last successful step | strong |
| `dotnet.fire-and-forget` | `Task.Run(...)` with no await, discarded task | Silently dropped on shutdown. No record, no retry | Emit an event; the run is durable before work starts | strong |
| `dotnet.broker-consumer` | MassTransit, NServiceBus, Rebus, Service Bus, SQS, `IConsumer<T>` | Nothing — already doing EDA. Usually missing replay and a queryable run history | Verdict becomes **already doing EDA** | reframe |
| `dotnet.retry` | Polly `WaitAndRetry`, circuit-breaker policies | In-process retry. Restart mid-backoff loses the attempt; the circuit state is per-instance, so N pods mean N circuits | Engine-side retry + DB-backed circuit breaker shared across nodes | strong |
| `dotnet.remote-in-txn` + `dotnet.httpclient` **in the same file** | `SaveChanges` and an HTTP call in one method | Dual write. EF commits, the carrier call fails, the row says Dispatched | Outbox for the emit; saga for the cross-service write | strong |
| `dotnet.status-column` | A `Status` enum property or enum type | Hand-rolled state machine in a column. Intermediate states strand on failure | Entity stream; the column becomes a projection | supporting |
| `dotnet.history-table` | `DbSet<*History>`, `DbSet<*Audit>`, `DbSet<Outbox*>` | They built an event log or an outbox by hand | Event sourcing with projections; a first-class transactional outbox | supporting |
| `dotnet.service-edge` | `BaseUrl`, `ServiceUrl`, `ApiUrl` in `appsettings.json` | Names the synchronous edge. Feeds the diagram | — | context |

## Combination rules

- **Dual write requires `dotnet.remote-in-txn` and `dotnet.httpclient` in the same file.** `SaveChanges` alone is just EF.
- An existing `DbSet<Outbox*>` is worth naming explicitly and warmly: they already
  identified the problem and built half the solution. That is a better opening
  than telling them about outboxes.
- `dotnet.scheduled` matching Hangfire deserves its own sentence. Hangfire is the
  closest thing in the .NET world to what Ironflow does, and the honest
  difference is durable *steps* — resume from stage 3, not from stage 1. Say that
  rather than implying Hangfire is not a real tool.

## Adoption note

C# is Tier 2. <https://docs.ironflow.run/how-to-guides/integration/other-languages/> carries a worked
Kiota example, which is the .NET-nearest path in the docs. Issue #172 (a first-party C# SDK) was closed `NOT_PLANNED` —
"speculative, no demand signal. Reopen if a .NET user materializes." If the room
is a .NET shop, that is worth saying out loud; it is a demand signal and they are
it. See `adoption-paths.md`.
