# Detection — Python

Signal IDs are emitted by `scripts/scan.sh`. This file is the interpretation.

| Signal ID | What it means | What breaks today | Ironflow equivalent | Weight |
|---|---|---|---|---|
| `python.scheduled` | Celery, celery beat, RQ, Dramatiq, APScheduler, django-q | A task queue with whole-task retry and no step memoization. A task that fails at stage 3 reruns stage 1, re-charging the card | Cron or event-triggered function; failed runs resume from the last successful step | strong |
| `python.fire-and-forget` | `.delay()`, `.apply_async()`, `BackgroundTasks`, bare `create_task` | FastAPI `BackgroundTasks` dies with the request worker. `create_task` with no reference is garbage-collectable | Emit an event; the run is durable before work starts | strong |
| `python.signals` | `post_save` / `pre_save` receivers with side effects | Implicit events with no name, no schema, no replay, no ordering. They fire inside the transaction, so a rollback silently un-fires them | Explicit named events with schemas — usually the single clearest before/after in a Django codebase | strong |
| `python.remote-in-txn` + `python.http-client` **in the same file** | `requests`/`httpx` inside `transaction.atomic()` | Dual write, and worse than most: `atomic()` rollback cannot un-send an HTTP request | Outbox for the emit; saga for cross-service writes | strong |
| `python.retry` | tenacity, `@retry`, manual backoff, `max_retries` | In-process retry; lost on restart, invisible to operators | Engine-side retry with backoff, queryable failed-run history, resume from the last step | strong |
| `python.broker-consumer` | kombu, pika, boto3 SQS, KafkaConsumer, aio-pika | Already doing EDA | Verdict becomes **already doing EDA** | reframe |
| `python.status-column` | `status = models.CharField(choices=...)`, `STATUS_CHOICES` | Hand-rolled state machine | Entity stream; the column becomes a projection | supporting |
| `python.history-table` | django-simple-history, `HistoricalRecords`, `*History` models | They wanted an event log and installed one that records rows, not intent | Event sourcing: events carry *why*, not just the new column values | supporting |

## Combination rules

- **Dual write requires `python.remote-in-txn` and `python.http-client` in the same file.**
- `python.signals` is the highest-teaching-value finding in a Django codebase and
  usually the best place to *start*, because it is small: one `post_save` becomes
  one named event, and nothing else changes. Rank it high on effort-to-value even
  when other candidates score more signals.
- Celery present is not "already doing EDA" — Celery is a task queue, not an event
  bus. Only `python.broker-consumer` flips the verdict.

## Adoption note

Python is Tier 1, with a hand-written polling worker and generated clients. It installs from PyPI as
`pip install ironflow-py` (import name `ironflow`) **from v0.33.1** — #1913 landed the
publishing machinery; v0.33.0 was tagged but no wheel reached PyPI, so v0.33.1 is the
first release on PyPI. The worker, `serve` and agent modules ship from v0.40.0. Never say `pip install ironflow`: that bare name belongs to an unrelated
materials-science package from the pyiron group, and it also installs a top-level
`ironflow` module, so the two cannot share a virtualenv.

Python applications use `@function(...)` handlers with
`from ironflow.worker import Worker, function`, then run
`Worker(functions=[...]).run()`. Step bodies must be idempotent.
