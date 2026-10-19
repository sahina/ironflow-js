---
name: ironflow-start
version: 0.48.0
description: |
  Adopt Ironflow — set up in a new or existing project and make architectural
  decisions. Triggers on: "set up ironflow", "install ironflow", "add ironflow to",
  "scaffold ironflow", "create a project", "create a runnable starter", "walk me through", "push vs pull", "entity streams vs events",
  "managed vs external projection".
  NOT for analyzing whether Ironflow fits a codebase (use ironflow-fit).
  NOT for implementing application features after setup (use ironflow-code).
  NOT for runtime debugging or deployment (use ironflow-ops).
  NOT for SDK reference lookup (use ironflow-docs).
user-invocable: true
argument-hint: "[what you need] — e.g., 'set up in my Next.js app' or 'push vs pull'"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Ironflow Start

Workflow for adopting Ironflow: project setup and architectural decisions.
Codebase fit analysis lives in `ironflow-fit`. SDK syntax lives in `ironflow-docs` (read on demand).

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Reference Files

```
https://docs.ironflow.run/reference/js-sdk/node.md   # for code shown during setup
https://docs.ironflow.run/reference/api/go-sdk.md   # Go equivalent
https://docs.ironflow.run/reference/api/python-sdk.md   # Python equivalent
https://docs.ironflow.run/explanation/patterns.md   # for arch decision matrices
https://docs.ironflow.run/reference/cli.md   # for ironflow init / serve commands
```

## Mode Selection

| Intent | Mode |
|---|---|
| "create a project", "create a runnable starter", new application | **Create project**: read `create-project.md` relative to this skill |
| "set up", "install", "configure ironflow", "walk me through" | **Setup** |
| "push vs pull", "entity streams vs events", architecture question | **Architecture Decision** |

Asked whether Ironflow *fits* — "should I use ironflow", "where can we use it",
"fit my app", "analyze my codebase" — that is `ironflow-fit`, not this skill.
Read `~/.agents/skills/ironflow-fit/SKILL.md` and follow it.

If ambiguous, ask once.

---

## Mode 1: Setup

Interactive guided setup. Always present options to the user — never assume.

### Step 1: Detect project

```bash
scripts/detect-project.sh
```

Relative to this skill's own directory, which your harness names when it loads the skill.
If the script cannot be executed — a packaged skill is served as readable resources, not
as files on disk — read `scripts/detect-project.sh` as a skill resource and apply its patterns with the
search tools instead. The fields below are what the rest of this skill branches on, so produce all of them
even when a value is `unknown` or `none`.

Output: `framework=<nextjs|hono|express|remix|node|go|flask|fastapi|django|python|unknown>
language=<ts|go|python|mixed|none> languages=<comma-separated ts,go,python|none>
ironflow_installed=<true|false|unknown> ironflow_cli=<version|none> package_manager=<...>`.

For a mixed project, ask which language/application to target, then rerun
`scripts/detect-project.sh ts`, `go`, or `python` in its directory. Until selected,
framework, package manager, and SDK installation are `unknown`. After selection,
those fields describe only the selected stack. Resource-only agents apply this same
contract. Python detection is a dependency-name heuristic; inspect ambiguous or
dynamic manifests before deciding what to install.

`ironflow_installed` is about the SDK in this project; `ironflow_cli` is about the engine
binary on PATH. They move independently — a project can have the SDK with no engine, or
an engine with no project.

If `ironflow_installed=true`, present what was found and ask:

> "Ironflow is already set up. Want to:
> 1. Switch execution mode (push ↔ pull)
> 2. Add browser SDK
> 3. Add a function (use `/ironflow-code` instead)
> 4. Update SDK
> 5. Start fresh"

On "Update SDK": the skills are compiled into the `ironflow` binary, so after upgrading
it run `ironflow skills sync` (it writes `./.agents/skills`; add `--global` for
`~/.agents/skills`) and `ironflow skills doctor` to re-wire the agent. Otherwise on-disk skills describe an
older engine than the one running.

If `language=mixed`, select the target stack before interpreting installation state.
If `framework=unknown`, inspect the files and ask the user to confirm the intended stack.

If the destination has no application yet, including a directory with only Desktop
metadata or ignore files, read `create-project.md` and follow its interview. Inspect
unrecognized files first; missing manifests alone do not make a directory disposable.

### Step 2: Get an engine running
<!-- derived-from: docs/tutorials/getting-started.mdx#1-start-the-server -->
<!-- derived-from: docs/tutorials/installation.mdx#desktop-app -->

First check for an existing engine connection in the environment or workspace.
When one is configured, verify that connection and reuse it; an unused port 9123
does not mean the configured engine is unavailable. Do not propose another engine
unless the user requests one or no connection is configured.
In Desktop, reuse the workspace engine and its authenticated connection facilities.
Check whether SDK processes inherit connection variables; MCP access alone does not
guarantee that. If needed, have the user configure credentials locally in a gitignored
file, never paste them in chat. Skip standalone engine installation/startup in that case.

The SDK is a client. It needs an `ironflow` engine to talk to, and on a clean machine
there isn't one. Don't skip to `pnpm add` — the user will hit `command not found:
ironflow` at the verify step.

If Step 1 reported a version for `ironflow_cli`, the binary is already there — say so and
skip to starting it. If it reported `none`, ask:

> "First, Ironflow itself. Four ways:
> 1. **Desktop app** — bundles the engine. No install, no CLI, no Docker. Fastest way to
>    see it work: <https://github.com/sahina/ironflow-desktop-releases/releases/latest>
>    (macOS Apple Silicon is the supported platform; Windows/Linux are experimental.)
> 2. **Homebrew** — `brew install sahina/tap/ironflow`
> 3. **Scoop** (Windows, experimental) — `scoop bucket add ironflow https://github.com/sahina/scoop-ironflow`, then `scoop install ironflow/ironflow`
> 4. **Docker** — `docker run -p 9123:9123 ghcr.io/sahina/ironflow-releases:latest serve --dev`"

Then start it:

```bash
ironflow serve --dev      # localhost:9123 — SQLite, embedded NATS, auth disabled
```

**`--dev` is not optional for local work.** Auth is always enforced otherwise — the only
other off-switch is `auth.devMode: true` in `ironflow.yaml`, the same bypass — so every `ironflow emit`, SDK call, and dashboard request returns
`401 authentication required`. Dropping `--dev` (production) auto-bootstraps an admin
key written to `<db-dir>/.ironflow_bootstrap_key.json` (mode 0400), which you then pass
as `IRONFLOW_API_KEY`.

That `<db-dir>` is `.ironflow/` under the cwd by default, and `serve` fills it with the
SQLite db, the embedded NATS store and `blobs/`. Gitignore the whole directory before the
first commit — the bootstrap key, `.ironflow_jwt_secret` and `engine.json` beside it are live
credentials (`engine.json` holds a copy of the key). `ironflow init` templates already ignore it; an existing project won't.

Desktop users: the app runs an engine per workspace, so there's no `ironflow serve` to
run. Point the SDK at the server URL the app shows.

### Step 3: Choose execution mode

Don't default. Show both:

> "Push mode — Ironflow POSTs to your serverless endpoint. Best for Next.js API routes,
>   Vercel, Lambda. Hard 10s ceiling per dispatch.
>
> Pull mode — Your worker polls Ironflow over HTTP for jobs. Best for
>   long-running tasks, Go services, anything past 10s. No timeout.
>
> Which mode? You can add the other later."

Pull is **HTTP polling** (`GET /api/v1/workers/{id}/jobs`), not gRPC. Each SDK also has an
opt-in ConnectRPC streaming worker: `@ironflow/node/worker-streaming` (Node),
`ironflow.NewStreamingWorker` (Go) and `ironflow.worker.StreamingWorker` (Python). It is not
the default and not what `createWorker`, `NewWorker` or `Worker` do.

The 10s push ceiling is the **engine's**, not your host's: `PushTimeout` defaults to 10s
and the effective budget is `min(function timeout_ms, PushTimeout)`. Raising the
function's `timeout` does not raise it. On a self-hosted server you can raise the
ceiling itself with `engine.pushTimeout` in `ironflow.yaml` (`ironflow serve -f ...`);
on a server you do not control, anything longer must be pull.

Go has both — `ironflow.NewWorker` (pull) and `ironflow.Serve` (push). Pull is the
natural fit for a Go service, but don't tell the user Go is pull-only.
Python uses `Worker(functions=[...]).run()` from `ironflow.worker` for pull,
and `ironflow.serve` (`serve()`, `register()`) for push. Node uses
`createWorker(...).start()`.

### Step 4: Install SDK
<!-- derived-from: docs/tutorials/installation.mdx#typescript-sdk -->

TypeScript:
```bash
pnpm add @ironflow/node                  # required — pulls in @ironflow/core
pnpm add @ironflow/browser               # optional, for client-side real-time
pnpm add @ironflow/langgraph             # optional, durable checkpoints for LangGraph
```

Go:
```bash
go get github.com/sahina/ironflow-go/ironflow
```

Python (reuse an existing environment/package manager; fresh pip example):
```bash
python3 -m venv .venv
.venv/bin/python -m pip install ironflow-py
```

`@ironflow/core` is a transitive dependency of node and browser — don't install it
separately. The Go import path is the public mirror; `github.com/sahina/ironflow/sdk/go/...`
is engine-internal and won't resolve for users.

### Step 5: Scaffold or build manually
<!-- derived-from: docs/tutorials/getting-started.mdx#2-create-your-project -->

**Fresh project** — `ironflow init my-app`, or `ironflow init my-app --template
go-quickstart`. Those are the only two templates (`quickstart` is the TS default);
anything else errors. It runs `pnpm install` for you — `--skip-install` opts out.
There is no Python template: create a venv, `pip install ironflow-py`, and write one
`worker.py` by hand.

What it actually produces is **flat**: one `worker.ts` (or `main.go`) holding a function,
a projection, and the worker, plus `package.json` / `tsconfig.json`. No `src/`, no
`.env`, no push-mode route. Don't promise the user a directory tree it doesn't create.

If the user passes `--skip-install`, tell them to delete the template's
`pnpm-workspace.yaml` and `pnpm-lock.yaml` before installing — they point at monorepo
paths that don't exist in their project, and the install step is what removes them.

**Existing project** — no layout is required; the SDK imports from wherever you put
things. If the user wants a convention, offer this one and say it's a suggestion:

```
src/functions/<name>.ts          # function definitions
src/projections/<name>.ts        # projection definitions
src/events/<domain>-events.ts    # event name constants
worker.ts                        # createWorker entry point (pull)
app/api/ironflow/route.ts        # serve() handler (Next.js push)
```

### Step 6: Create entry point

For SDK syntax, fetch `https://docs.ironflow.run/reference/js-sdk/node.md`, `https://docs.ironflow.run/reference/api/go-sdk.md`,
or `https://docs.ironflow.run/reference/api/python-sdk.md` for the selected language.

**Push mode (Next.js)** — `app/api/ironflow/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { serve, createClient } from "@ironflow/node";
import { hello } from "@/functions/hello";

const allFunctions = [hello];

export const POST = serve({
  functions: allFunctions,
  signingKey: process.env.IRONFLOW_SIGNING_KEY,   // omit = unverified POSTs (SDK warns)
});

// GET = register functions (call once after deploy)
export async function GET() {
  const client = createClient({
    serverUrl: process.env.IRONFLOW_SERVER_URL!,
    apiKey: process.env.IRONFLOW_API_KEY,
  });
  for (const fn of allFunctions) {
    await client.registerFunction({
      id: fn.config.id,
      triggers: fn.config.triggers,
      recording: fn.config.recording,
      endpointUrl: `${process.env.NEXT_PUBLIC_URL}/api/ironflow`,
    });
  }
  return NextResponse.json({ registered: true });
}
```

Two things to flag before the user builds on this:

- **`registerFunction` sends only the fields you pass.** Its request takes `id`, `name`,
  `description`, `triggers`, `retry`, `timeoutMs`, `concurrency`, `debounce`,
  `preferredMode`, `endpointUrl`, `actorKey`, `cancelOn`, `secrets`, `recording`,
  `recordingProfile` and `metadata`. The sample above passes
  `recording` through. Without it a push function runs with `recording: false`, so
  `ironflow inspect` has no frames to replay, no matter what the `createFunction` config
  says. Pull mode's `worker.start()` sends these fields for you (`stepTimeout` is enforced
  client-side by the worker in both modes).
- `serve()` returns `Promise<Response | void>` (it also accepts Node req/res). Next.js
  typed-route checking can reject that as a route export; cast if `next build` complains.

**Pull mode** — `worker.ts` or `cmd/worker/main.go`:

```typescript
import { createWorker } from "@ironflow/node";
import { hello } from "./functions/hello";

const worker = createWorker({
  serverUrl: process.env.IRONFLOW_SERVER_URL || "http://localhost:9123",
  functions: [hello],
});
await worker.start();   // automatically registers all functions
```

Python pull worker: `from ironflow.worker import Worker, function`, decorate
an `async def` handler with `@function(id="hello", triggers=[{"event": "hello"}])`,
then call `Worker(functions=[hello]).run()`. See
`https://docs.ironflow.run/reference/api/python-sdk.md` for the complete form.

**Sample function** — `src/functions/hello.ts`:

```typescript
import { createFunction } from "@ironflow/node";

const HelloEvents = { REQUESTED: "hello.requested" } as const;

export const hello = createFunction(
  {
    id: "hello",
    triggers: [{ event: HelloEvents.REQUESTED }],
    recording: true,
  },
  async ({ event, step }) => {
    return await step.run("greet", async () => ({
      message: `Hello, ${(event.data as any)?.name ?? "World"}!`,
    }));
  },
);
```

### Step 7: Configure environment

Create `.env.example`:

```env
IRONFLOW_SERVER_URL=http://localhost:9123
# IRONFLOW_API_KEY=ifkey_...              # REQUIRED unless the server runs with --dev or .ironflow/engine.json supplies it

# Push mode:
# IRONFLOW_SIGNING_KEY=...                # pass as serve({ signingKey }) — the SDK never reads this env var itself
# NEXT_PUBLIC_URL=http://localhost:3000   # your app's own URL — you build endpointUrl from it

# Server-side only (not read by the SDK):
# IRONFLOW_DATABASE_URL=postgres://...    # production
```

`IRONFLOW_SERVER_URL` is the only server-URL variable on every path: the CLI, the SDK
clients and workers, `serve()` push and webhook emit, agent memory, and `exposeMcp`.
The order is an explicit `serverUrl` first, then `IRONFLOW_SERVER_URL`, then
`http://localhost:9123`. Blank values count as unset.
Agent memory and `exposeMcp` have no localhost default: they need
`IRONFLOW_SERVER_URL` or an explicit value.

There is no `APP_URL` convention in Ironflow — for a non-Next framework, name your app's
own URL variable whatever you like; only your registration code reads it.

Ironflow's local files must stay out of version control: `serve` writes the SQLite db,
embedded NATS store and `blobs/` under `.ironflow/`, alongside `.ironflow_bootstrap_key.json`
(an admin API key), `.ironflow_jwt_secret` and `engine.json`; `.env` and `.env.local` hold
credentials.
Setting `spec.storage.path` moves the data to that file's directory, so ignore that path
instead. If the project is in a Git work tree, review it and create or extend `.gitignore`
for these and for everything else its stack generates, as `create-project.md` describes
("Git and `.gitignore`").

### Step 8: Verify

Two terminals:

```bash
# Terminal 1
ironflow serve --dev

# Terminal 2 (push mode)
pnpm dev
curl http://localhost:3000/api/ironflow   # register functions

# Terminal 2 (pull mode)
npx tsx worker.ts
# or: go run ./cmd/worker
# or: .venv/bin/python worker.py
```

For Desktop, skip Terminal 1 and target the workspace's actual engine URL and local
credentials in all commands. For Python, use the project environment consistently.

Then test:
```bash
ironflow emit hello.requested --data '{"name": "Ironflow"}'
ironflow run list --json
```

Use a unique marker for the sample invocation and check that invocation's run and
expected output with a bounded wait; another completed run does not verify setup.

`run list --json` prints an array of `{id, function, status, started_at, ended_at}`.
Empty array after an emit usually means the function never registered (push: did the
GET run? pull: is the worker connected?), not that it failed.

If these 401, the server is running without `--dev` and no key reached the CLI. Either
restart the server with `--dev` or export `IRONFLOW_API_KEY` from the bootstrap key file.
There is no `--api-key` flag on `emit` or `run`. The CLI and the SDKs read the key from
`IRONFLOW_API_KEY`; only when `IRONFLOW_SERVER_URL` and `IRONFLOW_API_KEY`
are all unset do they fall back to `.ironflow/engine.json`, which a local SQLite `serve`
writes. A 401 therefore points to a remote or Postgres engine, a non-loopback `--host`, a
different working directory, or `IRONFLOW_NO_DISCOVERY=1`.

### Step 9: Suggest next

> "Setup complete. Next:
> - `/ironflow-code` to write your real functions, projections, workers, tests
> - `/ironflow-start` (architecture mode) to choose patterns
> - `/ironflow-ops` once you have failed runs to debug"

If the user codes in Zed or a JetBrains IDE and is not already in the Ironflow agent, add one line:
`@ironflow/agent` puts these skills in the editor's agent panel with their own model key
(`npx -y @ironflow/agent login`). Setup: https://docs.ironflow.run/how-to-guides/ai-acp-agent/

---

## Mode 2: Fit Analysis — moved

Codebase fit analysis now lives in its own skill. It scans Java/Spring, C#/.NET,
Python, Rust, Node and Go, scores event-driven readiness, and writes a visual HTML
report with `file:line` evidence.

Read and follow `~/.agents/skills/ironflow-fit/SKILL.md`.

---

## Mode 3: Architecture Decision

Walk the user through the relevant decision. Don't dump all matrices at once — pick the
2-3 that apply.

For full decision matrices and examples: fetch `https://docs.ironflow.run/explanation/patterns.md`.

### CQRS mental model (read this first if the app has a real domain)

Before choosing primitives, decide whether the user is building **CRUD-style** or
**CQRS-style**:

| CRUD-style (simpler) | CQRS-style (domain-rich) |
|---|---|
| One model, one DB, same shape for reads and writes | **Two models** — write model (aggregate + stream) and read model (projections) |
| Controllers call ORM, return rows | HTTP dispatches **commands**; commands return acknowledgement, not state |
| Events (if any) are notifications after the fact | Events **are** the state — stored, folded, projected |
| Business rules in service layer / controller | Invariants in the **aggregate decider** (pure function) |
| Read-your-own-writes is trivial (same transaction) | Reads are **eventually consistent** — handled via `subscribeToProjection` or optimistic UI |

CQRS pays off when: you have rich business rules, multiple read shapes, audit
requirements, or long-running processes. It's overhead when: the app is a form+table
CRUD with one read view.

Ironflow supports both. Don't force CQRS on simple CRUD; don't simulate CRUD on top of
Ironflow either. Ask the user — most real apps have **pockets** of each.

### Decision quick reference

| Decision | Choose A when... | Choose B when... |
|---|---|---|
| **Push** vs **Pull** | Tasks under the 10s engine ceiling, serverless | Anything past 10s, persistent workers |
| **CRUD** vs **CQRS** for a given entity | Simple form-and-table, no multi-view reads | Rich rules, multi-view reads, lifecycle events |
| **Plain Events** vs **Entity Streams** | Fire-and-forget signals, no per-entity ordering | Entity lifecycles, DDD aggregates, invariants |
| **Command Event** vs **Direct Append** | Validation needed, auth context, retriable | Internal state transitions with no rules |
| **Aggregate size: small** vs **large** | Contention, distinct lifecycles, fast fold | All state loaded together, invariants span parts |
| **Managed** vs **External Projection** | Pure read models | Side effects (DB sync, emails) |
| **Single projection** vs **Multiple projections** | One view shape | Multiple query paths (by-customer, by-status, etc.) |
| **Step Compensation** vs **Saga** | Simple undo within one fn | Complex rollback across services |
| **Concurrency Limit** vs **Key** | Global rate limiting | Per-entity serialization |
| **`step.parallel`** vs **`step.map`** | Fixed set of operations | Dynamic list of same op |
| **KV Store** vs **External DB** | Small, key-value, real-time | Relational, complex queries |
| **Config** vs **KV Store** | App settings, feature flags | User-facing data |
| **Config** vs **Secrets** | Non-sensitive | API keys, passwords |
| **Optimistic UI** vs **Wait-for-projection** | Most actions (reconcile via subscribe) | Critical confirmations (checkout, payment) |
| **Snapshots: yes** vs **no** | Aggregate history > ~10k events, load latency budget breached | Day-one; revisit when measured |

### Workflow

1. Ask 1-2 clarifying questions about their constraints (deployment target, task duration,
   data shape, whether the entity has a real lifecycle vs. simple storage).
2. **First gate: CRUD or CQRS?** — for domain-rich entities, check whether the user wants
   event-sourced write model. If yes, continue through aggregate/command decisions. If
   no, skip to infra decisions (push/pull, KV/DB, etc.).
3. Identify the 2-3 decisions that matter for their case.
4. State the recommendation clearly with rationale.
5. Note when the alternative would be better.
6. If CQRS: name the aggregates, commands, domain events, and at least one projection
   before moving on. These become the skeleton `/ironflow-code` builds.
7. When relationships, ordering, or lifecycles need visual explanation, read
   `~/.agents/skills/ironflow-docs/diagrams.md` using the cross-skill path convention
   above and include a Mermaid diagram with the recommendation. Update it as the
   user revises the design.
8. Suggest `/ironflow-code` to implement.

---

**Next:** After setup or decisions:
- `/ironflow-code` — write the code
- `/ironflow-ops` — debug failures, deploy, scale
- `/ironflow-docs` — look up specific syntax
