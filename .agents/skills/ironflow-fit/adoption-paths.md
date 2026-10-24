# Adoption paths by stack

The section of the report that decides whether the reader trusts the rest of it.
It goes **before** the opportunities. The audience will verify every claim here in
week one, so all of it is checkable — and all of it now links to published docs.

Sources, in order of usefulness for a non-Go/TS team:

- <https://docs.ironflow.run/how-to-guides/integration/other-languages/> — the
  end-to-end guide: generating a client, registering a function, push mode at two
  levels, and the known gaps. Read it before writing this section of a report.
- <https://docs.ironflow.run/reference/api/push-protocol/> — the full push wire
  contract: request and response shapes, signature verification, step IDs and the
  escape function, memoization rules, yields and resume.
- <https://docs.ironflow.run/reference/sdk-comparison/> — the tier model.

**Do not restate these in the report.** Summarize in two or three sentences and
link. A report that reproduces a reference page goes stale the week it is written,
and the reader can follow a link.

## The tiers

**Tier 1 — Go, TypeScript, Python.** Hand-written worker runtimes provide
pull mode and durable-step memoization. Python's client surface is generated.
The three are peers: the SDK comparison lists each step primitive per language.
Check it before promising a specific operation.

**Tier 2 — Rust, C#, Java later.** Generated client, no worker runtime.
Functions can still execute via **push mode**: the server POSTs to an HTTP
endpoint you own, which needs no SDK runtime.

**No SDK.** Generate your own. Everything below applies.

## What to tell a Java, C#, or Rust shop

Three tiers, in this order. State all three; do not stop at the good news.

### 1. Calling Ironflow — available today, no SDK required

Use **both** surfaces:

- **REST** — generate a client from `api/openapi.json`, OpenAPI 3.1, published as
  `/openapi.json` on the docs site and served by every server at
  `GET /api/v1/openapi.json`.
- **ConnectRPC** — send plain proto3-JSON `POST /ironflow.v1.<Service>/<Method>` with the
  same bearer token and environment header. `other-languages.md` walks `RegisterFunction`
  as the pattern for every method. Fields are camelCase, 64-bit integers are decimal
  strings, and empty fields are omitted. The `api/proto/ironflow/v1/*.proto` files are
  the schema, and Buf can generate Java, C# and Rust clients from them for readers who
  have the files.

The OpenAPI artifact is **REST only** (ADR 0079; #1972 removed the REST duplicates of Connect
routes). It reaches event *reads*, KV with compare-and-set, config, secrets,
workers, and the whole ops/admin surface — DLQ, circuit breakers, capacity, API keys,
users, tenants, policies. On that ops surface the generated client is **wider than the
Go and Node SDKs**. Everything workflow-shaped is Connect-only (next section).

`other-languages.md` carries a worked Kiota example and a "Known gaps in generated
clients" table — absent `servers`, under-declared `X-Ironflow-Environment-ID`, no
enums on `status` and `yield.type`, and `register`/`heartbeat` accepting both POST
and PUT. Point the reader at that table rather than listing the gaps yourself.

### 2. Being called by Ironflow — push mode, a controller they already know

Ironflow POSTs to an endpoint they own: a Spring `@RestController`, an ASP.NET
controller, an axum handler. No runtime, no new dependency. This is the blessed
Tier-2 authoring path, and it is fully documented — `push-protocol.md` covers the
request and response shapes, HMAC verification, and, for durable steps, the step-ID
formula and memoization rules. `ironflow conformance push --url <endpoint>` checks a
handler against that contract with no server, and a language counts as supported for
push mode when its handler passes level 3
(<https://docs.ironflow.run/reference/api/push-conformance/>).

### 3. Pull mode — a Tier-1 SDK worker

Pull mode, a long-running worker with no request timeout, needs a Tier-1 runtime.
The durable-step and saga-compensation helpers ship in Go, Node and Python alike.
Push mode can also memoize steps and yield sleeps and waits, but the handler
implements the replay rules itself and each call stays inside your platform's
request timeout. **Their services stay Java.** The worker calls those services; it
does not replace them.

## Both surfaces, or the path dead-ends

**The workflow surface is ConnectRPC-only.** Emit, register/list/get/invoke functions,
list/get/cancel/resume runs, read and patch their steps, the run audit trail, entity
streams, projections, event schemas, publish, read-only SQL and webhook management
have no REST route
(`other-languages.md` §"What the generated client does NOT reach"). A team that
uses OpenAPI alone ends up with a client that can rotate API keys but cannot
emit an event. And a cron is a *field on the function*, so no registration means no
scheduled work either.

Always instruct both surfaces.

## Needs the Connect surface

Emit; register a function; list/get/cancel/resume runs and read steps; register a
projection **and** the external projection worker loop; entity streams; event schemas;
publish; `ExecuteSQL`; `TriggerSync` and `TriggerBatch`; webhook management; `PauseRun`,
`InjectStepOutput` and `PatchStep`; `GetAuditTrail`; agent tools.

## Unreachable from generated code, at any price

**A push subscription.** `api/openapi.json` contains zero streaming media types.
`PubSubService/Subscribe` and `JoinConsumerGroup` are server streams;
`SubscribeBidirectional` is a consumer-group stream that carries events and
acks; Go and Node wrap it. The
`GET /ws` and KV/config `/watch` upgrades are absent from the OpenAPI artifact
entirely.

Inbound means push mode: an endpoint they own. For a Spring shop that is a
controller, which is fine — but it is the only inbound door.

## Pull mode: the warning, and how to phrase it now

A generated client **will** contain `workers_register`, `workers_list_jobs` and
`workers_update_jobs`, fully typed. They look ready to use. `other-languages.md`
§"Pull mode is not supported outside the Go, TypeScript and Python SDKs" draws
the support boundary. Generated clients alone are not
part of the supported worker surface. The guide lists four traps:
ack-before-execute, fence echo on every mutating call, two response shapes,
and POST-or-PUT.

Phrase it as **unsupported, not undocumented.** The rules are published now; what is
missing is a runtime and anyone to support the result. The step ID is the
memoization key on both sides of the wire, and getting it wrong re-runs a step that
already completed — a double charge, silently. Recommending a Tier-1 worker sidecar is
still the right call, and telling skeptical engineers not to build against your own
typed endpoints is the most credibility-earning sentence in the report.

## Gotchas to carry into the report

Keep this short and link out; `other-languages.md` has the full table.

- **`X-Ironflow-Environment-ID` is under-declared in the spec.** A generated client
  will not ask for it. Set it once as a default header in the transport core, to the
  environment the `ifkey_` key was created for. The key's own environment decides what
  a call touches: a header naming another environment's ID gets `403`, an environment
  name gets `400`, and the secrets routes answer `400` without the header. Most likely first-week surprise.
- **Authenticate with a long-lived `ifkey_` bearer token.** The only login route in the
  spec is the platform-admin one (`/api/v1/platform/auth/login`); there is no tenant
  login, so a generated tenant client works from an API key.
- **No numbered `4xx`/`5xx` in the spec.** Every operation declares one typed
  `default` response of shape `{error, code, details}`. Handle that plus the status
  code.
- **Python installs as `ironflow-py`, not `ironflow`.** `pip install ironflow-py`
  from v0.33.1 (#1913); the import name stays `ironflow`. The bare name on PyPI is an
  unrelated materials-science package. The polling worker ships from v0.40.0.
- **Ironflow's outbox covers only Ironflow's store.** A write to the reader's own
  database that must also produce an event is their outbox: an outbox row in the same
  local transaction, relayed to Ironflow with a stable idempotency key. Making an entity
  stream the write removes the question. Link
  <https://docs.ironflow.run/explanation/outbox/>.
- **A first-party C# SDK was designed and closed** (so "C# later" above means "not
  planned", not "on the roadmap"). Issue #172, `NOT_PLANNED`:
  "speculative, no demand signal. Closing as not planned; reopen if a .NET user materializes." If the reader
  is a .NET shop, they are the demand signal. Say so.
- Anything described as planned must be **labeled planned**.

## Snippet rule (D14)

Every strong-fit snippet is **two-sided**:

- **Their side, in their language** — the service they already have, changed only at
  the line that emits, or the controller that receives the push.
- **The orchestration side, in TypeScript** — short, and always introduced as:
  *"your services stay Java; this is the 12-line orchestration file that sequences
  them."*

Never show a TypeScript snippet alone to a non-TypeScript codebase. The reader must
see their own language first, and must see that the TS file orchestrates rather than
replaces. For Node, Go and Python readers this rule collapses to one snippet.
