# Event-driven readiness checklist

Seven items. Score each **red / amber / green from cited evidence**, never from
what the team says about itself. Every row in the report carries the `file:line`
that produced the score, or the row reads "no evidence found" — which is itself a
finding, not a blank.

This section follows the adoption path in the report (see `report-template.html`). It is
vendor-neutral on purpose: it earns the right to the second half. A reader who
stops after this section has still been handed something useful.

| # | Item | Green | Amber | Red |
|---|---|---|---|---|
| 1 | **Idempotency** | Natural keys, `ON CONFLICT` / upsert / `MERGE`, or an explicit idempotency key on writes (`probe.idempotency`) | Some paths guarded, most not | No evidence anywhere. At-least-once delivery will duplicate their writes on day one |
| 2 | **Ordering** | Nothing depends on strict sequence, or the dependency is explicit and per-entity | Sequence assumed but not enforced | Global ordering assumed across services. This is the assumption events break hardest |
| 3 | **Failure handling** | Retry with backoff *and* a dead-letter path (`probe.dlq`) | Retry present, no DLQ | Neither. Failures vanish |
| 4 | **Observability** | Distributed tracing present (`probe.tracing`) | Structured logs, no tracing | Neither. Async debugging without tracing is guesswork, and this is the item that most often makes an adoption fail after it technically succeeded |
| 5 | **Schema discipline** | Versioned contracts — OpenAPI, protobuf, Avro, an explicit `schema_version` (`probe.contracts`) | Contracts exist, unversioned | Services share DTO classes. Events will inherit that coupling and make it permanent |
| 6 | **Async testing** | A harness that waits for asynchronous outcomes (`probe.async-tests`) | Async code, synchronous tests only | No async tests. They cannot verify an event-driven change once they make one |
| 7 | **Ops capacity** | Multiple services already deployed independently, on-call exists | One deployable, some ops maturity | Single deployment, no on-call. Distributed failure modes will land on someone who has no way to see them |

## Scoring rules

- Rows 1 and 4 are **blocking**. Red on either means the report's recommended
  starting point is "fix this first," ahead of any Ironflow candidate. Say it
  plainly and put it above the opportunities, not in a footnote.
- Row 7 is scored from repository shape (project count, deployment manifests,
  compose services), not from anything the team was asked. If the scan found one
  project and no deployment config, that is amber at best — note the uncertainty
  rather than guessing.
- Never score a row green on absence of evidence. "No retries found" is red on
  row 3, not green on row 1.

## How this reads in the report

A 7-row table, red/amber/green swatch, evidence beside each. Under it, one
sentence naming the blocking reds if any, or "no blockers found" if none.
