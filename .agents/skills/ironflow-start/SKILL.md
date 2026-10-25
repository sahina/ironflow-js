---
name: ironflow-start
version: 0.52.0
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
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, WebFetch
---

# Ironflow Start

Workflow for adopting Ironflow: project setup and architectural decisions.
Codebase fit analysis lives in `ironflow-fit`. SDK syntax lives in `ironflow-docs` (read on demand).

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Where the facts live

This skill holds the workflow. The reference facts live in the hosted docs. Fetch the
page before you give the user a command, a flag or code. Do not work from memory.
Fetch with `WebFetch`. In Ironflow Desktop's built-in agent, use `docs_fetch`. Each URL
returns one page as Markdown. Read the section named in the last column.

| Need | URL | Sections |
|---|---|---|
| Install the engine: Desktop, Homebrew, Scoop, Docker | https://docs.ironflow.run/tutorials/installation.md | "Server", "Desktop App" |
| Start the engine: `--dev`, auth, bootstrap key, `.ironflow/` | https://docs.ironflow.run/tutorials/getting-started.md and https://docs.ironflow.run/reference/cli/commands/serve.md | "1. Start the Server"; "Dev Mode", "Local state" |
| Install the SDK | https://docs.ironflow.run/tutorials/installation.md | "TypeScript SDK", "Go SDK", "Python SDK" |
| Scaffold with `ironflow init` | https://docs.ironflow.run/reference/cli/commands/init.md and https://docs.ironflow.run/tutorials/getting-started.md | the whole `init` page; "2. Create Your Project" |
| Push or pull mode | https://docs.ironflow.run/explanation/patterns.md and https://docs.ironflow.run/how-to-guides/workflows/execution-modes.md | "Push vs Pull Mode"; "Push Mode (Default)", "Pull Mode", "Mode Comparison" |
| Entry point code, TypeScript | https://docs.ironflow.run/reference/js-sdk/node.md | "Define a Function", "Push Mode (Serverless)", "Pull Mode (Worker)", "registerFunction", "serve", "Framework Integration" |
| Entry point code, Python | https://docs.ironflow.run/reference/api/python-sdk.md | "Pull worker", "Push mode" |
| Entry point code, Go | https://docs.ironflow.run/reference/api/go-sdk.md | "Push Mode (Serverless)", "Pull Mode (Worker)" |
| Environment variables | https://docs.ironflow.run/reference/configuration.md and https://docs.ironflow.run/reference/js-sdk/node.md | "Environment Variables" on both pages |
| Verify: `emit`, `run list`, 401 errors | https://docs.ironflow.run/reference/cli/commands/emit.md, https://docs.ironflow.run/reference/cli/commands/run.md and https://docs.ironflow.run/reference/cli.md | the whole `emit` page; "`ironflow run list`"; "Global Behavior" |
| Update the installed skills | https://docs.ironflow.run/reference/cli/commands/skills.md | "`ironflow skills sync`", "`ironflow skills doctor`" |
| Ironflow agent in Zed or JetBrains | https://docs.ironflow.run/how-to-guides/ai-acp-agent.md | "Set your model key" |
| Architecture decisions | https://docs.ironflow.run/explanation/patterns.md | see "Decision routing" in Mode 3 |

If no row matches, fetch https://docs.ironflow.run/llms.txt and pick the page from it.

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

On "Update SDK": the skills are compiled into the `ironflow` binary. After the user
upgrades it, run `ironflow skills sync` and `ironflow skills doctor` (see the
"Update the installed skills" row above).

If `language=mixed`, select the target stack before interpreting installation state.
If `framework=unknown`, inspect the files and ask the user to confirm the intended stack.

If the destination has no application yet, including a directory with only Desktop
metadata or ignore files, read `create-project.md` and follow its interview. Inspect
unrecognized files first; missing manifests alone do not make a directory disposable.

### Step 2: Get an engine running

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
skip to starting it. If it reported `none`, ask the user which install route they want
(Desktop app, Homebrew, Scoop or Docker). Take the commands from the install row in
"Where the facts live". Do not choose for them.

Start the engine with `ironflow serve --dev` for local work. Without `--dev`, auth is
on and every call returns 401. Gitignore `.ironflow/` before the first commit: it holds
live credentials. Flags, auth and the contents of `.ironflow/` are in the start row.

In Desktop there is no `ironflow serve` to run. The app runs an engine per workspace.
Point the SDK at the server URL the app shows.

### Step 3: Choose execution mode

Don't default. Show both:

> "Push mode — Ironflow POSTs to your serverless endpoint (Next.js API routes, Vercel,
>   Lambda). Hard 10s ceiling per dispatch.
>
> Pull mode — Your worker polls Ironflow over HTTP for jobs. Best for long-running
>   tasks. No timeout.
>
> Which mode? You can add the other later."

The 10s push ceiling is the engine's, not the host's. Anything longer must be pull. All
three SDKs support both modes. Do not tell the user Go is pull-only. Pull workers poll over
HTTP; each SDK also has an opt-in streaming worker. Details, the `PushTimeout` setting and
the streaming workers are in the "Push or pull mode" row.

### Step 4: Install SDK

Install the SDK for the chosen language from the "Install the SDK" row. Reuse the
project's package manager and, for Python, its existing environment.

### Step 5: Scaffold or build manually

**Fresh project** — run `ironflow init` and take the flags and templates from the
`init` page. Do not promise the user a directory tree: read the files it creates before
you describe them. There is no Python template; the "2. Create Your Project" section
of the getting-started page shows the manual route. If the user passes `--skip-install`,
follow the monorepo-file note in that section.

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

Fetch the SDK page for the selected language and mode (entry point rows in "Where the
facts live"). Write one sample function with one `step.run` and the entry point for the
mode the user chose. Copy the shapes from the page, not from memory.

A push function needs explicit registration against the engine. Read "registerFunction"
and "serve" on the Node page before you write it. Register with a one-off script or a
`GET` route, as the page shows. Note which one you built: Step 8 uses the same one.
Note the trigger event of the function too. Step 8 emits it. If `ironflow init`
scaffolded the project, the function is `process-order`. Its trigger event is
`order.placed`, with data `{"orderId": "ord-1", "total": 49.99, "email": "a@b.com"}`.

### Step 7: Configure environment

Create `.env.example` with placeholders for the variables in the "Environment
variables" row. Put no real value in it. There is no `APP_URL` convention in Ironflow.
Name the variable for your app's own public URL as you like. Only your registration code
reads it, to build the `endpointUrl` it passes to `registerFunction`. Read
`registerFunction` on the Node page.

Ironflow's local files and `.env` files must stay out of version control. If the project
is in a Git work tree, review it and create or extend `.gitignore` for them and for
everything else its stack generates, as `create-project.md` describes ("Git and
`.gitignore`"). The paths are in the "Local state" section of the `serve` page.

### Step 8: Verify

Two terminals:

```bash
# Terminal 1
ironflow serve --dev

# Terminal 2 (push mode)
pnpm dev
# then register the functions the way you set it up in Step 6:
# run the registration script, or call the GET registration route

# Terminal 2 (pull mode)
npx tsx worker.ts
# or: go run ./cmd/worker
# or: .venv/bin/python worker.py
```

For Desktop, skip Terminal 1 and target the workspace's actual engine URL and local
credentials in all commands. For Python, use the project environment consistently.

Then test:
```bash
ironflow emit <trigger-event> --data '<event-data-json>'   # the event from Step 6
ironflow run list --json
```

Use a unique marker for the sample invocation and check that invocation's run and
expected output with a bounded wait; another completed run does not verify setup.

An empty array after an emit usually means the function never registered (push: did the
GET run? pull: is the worker connected?), not that it failed.

If these commands return 401, read "Global Behavior" on the CLI page and "Dev Mode" on
the `serve` page. Restart the server with `--dev`, or give the CLI the key as the docs
describe.

### Step 9: Suggest next

> "Setup complete. Next:
> - `/ironflow-code` to write your real functions, projections, workers, tests
> - `/ironflow-start` (architecture mode) to choose patterns
> - `/ironflow-ops` once you have failed runs to debug"

If the user codes in Zed or a JetBrains IDE and is not already in the Ironflow agent, add
one line: `@ironflow/agent` puts these skills in the editor's agent panel. Setup is in the
"Ironflow agent in Zed or JetBrains" row.

---

## Mode 2: Fit Analysis — moved

Codebase fit analysis lives in the `ironflow-fit` skill.
Read and follow `~/.agents/skills/ironflow-fit/SKILL.md`.

---

## Mode 3: Architecture Decision

Walk the user through the relevant decision. Don't dump all matrices at once — pick the
2-3 that apply.

### CRUD or CQRS first

Before choosing primitives, decide whether the user is building **CRUD-style** or
**CQRS-style**. For a domain-rich app, read "The Mapping" and "When to Introduce CQRS"
on https://docs.ironflow.run/explanation/ddd/cqrs.md (invariants and read lag are on
https://docs.ironflow.run/explanation/patterns.md, in "Invariants live in the decider"
and "Read-Your-Own-Writes & Projection Lag").

Ironflow supports both. Don't force CQRS on simple CRUD; don't simulate CRUD on top of
Ironflow either. Ask the user — most real apps have **pockets** of each.

### Decision routing

Fetch the page, read the section, then recommend. Every row is on
https://docs.ironflow.run/explanation/patterns.md unless the row says otherwise.

| Decision | Section |
|---|---|
| Push vs Pull | "Push vs Pull Mode" |
| CRUD vs CQRS for an entity | "When to Introduce CQRS" on https://docs.ironflow.run/explanation/ddd/cqrs.md |
| Plain Events vs Entity Streams | "Plain Events vs Entity Streams" |
| Command Event vs Direct Append | "Commands vs Events (CQRS foundational)" |
| Aggregate size | "Sizing rules" |
| Managed vs External Projection | "Managed vs External Projections" |
| Single vs multiple projections | "When to Introduce CQRS" on https://docs.ironflow.run/explanation/ddd/cqrs.md |
| Step Compensation vs Saga | "Saga Patterns" |
| Concurrency limit vs key | "Concurrency Control" |
| `step.parallel` vs `step.map` | "`step.parallel(name, branches)` — Execute branches concurrently" and "`step.map(name, items, fn)` — Fan-out/fan-in pattern" on https://docs.ironflow.run/how-to-guides/workflows/steps.md |
| KV Store vs External DB | "KV Store vs External DB" |
| Config vs KV Store, Config vs Secrets | "Config vs KV vs Secrets" |
| Optimistic UI vs wait-for-projection | "Three ways to handle it" |
| Snapshots | "When to add snapshots" |

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
