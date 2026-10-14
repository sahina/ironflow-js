# Create a runnable project

Use this flow for a new application. Its output is a minimal, verified starter;
`ironflow-code` handles the application's domain features afterward.

## 1. Inspect the destination

Run `scripts/detect-project.sh` relative to this skill's directory. If the harness
serves skill resources instead of executable files, read that script and produce the
same fields using read/search tools. Read project instructions and inspect files.

- Application manifests or source code: use the existing-project Setup flow in
  `SKILL.md`. In mixed-language projects, choose the application directory and language,
  then rerun detection with `ts`, `go`, or `python`. SDK status belongs to that stack.
- An absent/empty directory, or only `.ironflow/`, Git metadata, and ignore files:
  use this creation flow. Preserve that content. Desktop creates
  `.ironflow/.gitignore`; it does not mean an application exists.
- Unknown files or ambiguous/dynamic manifests: inspect them, then ask whether to
  use this directory while preserving them or choose a new directory. Resolve that
  destination question before proposing files. A missing recognized manifest does
  not authorize replacement.

Find the engine connection separately from SDK installation. Reuse a configured
connection in every environment; probe its actual URL, not a default port. In Desktop, use the
workspace's existing engine and authenticated tools/launch settings. Its port need
not be 9123. Inspect whether connection variables are available without printing
secret values. Some harnesses expose the engine through MCP only: that proves tool
access, not SDK-process access. If the generated app lacks credentials, explain how
to provide them locally through the existing workspace facilities or a gitignored
`.env` and verify it afterward. Never ask the user to paste an API key into chat.
Outside Desktop, use Setup Step 2 if no engine is available.

## 2. Interview and recommend

Ask one focused question at a time, skipping answers already in the request or files:

1. What is the project for? Does it need an HTTP app or only a worker?
2. Which language does the developer prefer?
3. Which frameworks, packages, or deployment constraints are required?

Recommend the smallest stack that meets those answers. Explain what each dependency
is for; explicit preferences override these defaults:

| Language | Worker only | Simple HTTP app |
| --- | --- | --- |
| TypeScript | `@ironflow/node` | Hono, its Node adapter, and `@ironflow/node` |
| Python | `ironflow-py` | Flask and `ironflow-py` |
| Go | `github.com/sahina/ironflow-go/ironflow` | `net/http` and the same SDK |

A worker-only project needs no web framework. Reuse the project's package manager;
for a fresh destination recommend an available one and include it in the proposal.
Use a Python virtual environment. Resolve compatible published dependency versions
and record them with the ecosystem's manifest/lock conventions. Honor frameworks
such as FastAPI or Next.js by consulting their current docs and the relevant SDK
reference. The verify step must prove the actual chosen combination.

Recommend pull workers. If the user requires push, explain the engine dispatch
ceiling from Setup Step 3 and use the SDK's push handler and registration path.
`ironflow-ops/deploy.md` rejects applications whose functions must remain push mode;
state that limitation before creating such a starter.

## 3. Propose the starter

Show these items together, then wait for acceptance before creating application files
or installing their dependencies:

- Destination and purpose; language, framework, execution mode, package manager.
- Packages with reasons; files to create and edits to existing files, including
  `git init` when the destination is not yet in a Git work tree, and the `.gitignore`.
- Engine connection method, install/start commands, and the sample verification action.

When component relationships or execution ordering need visual explanation, read
`~/.agents/skills/ironflow-docs/diagrams.md` using this skill's cross-skill resource
convention and include a Mermaid diagram in this proposal. Update it if the proposal
changes before acceptance.

Acceptance covers generation, installation, and that local verification. Merge
approved edits into existing files; preserve unrelated content. Changes beyond the
accepted scope need a revised proposal. Do not add application features merely because
an example contains them.

## 4. Create

Read `ironflow-docs`'s `sdk-typescript.md`, `sdk-python.md`, or `sdk-go.md` for the
selected language, using that skill's resource resolution convention.

Use `ironflow init` only when its quickstart matches the proposal and the destination
is absent. It rejects even an empty existing directory. In Desktop, generate files
in the selected workspace using SDK references instead. Preserve `.ironflow/` and
its ignore file; do not nest the application or erase metadata to make init work.
With `init --skip-install`, remove its monorepo workspace/lock files as documented
in Setup Step 5 before installing external dependencies.

Create only what the accepted starter requires:

- Dependency manifest, reproducible versions/lockfile, and required build settings.
- One example function with a durable step and the chosen execution entry point.
  Pull uses a worker; push uses an HTTP handler plus explicit registration commands.
- An HTTP app, when requested, with an endpoint that emits the sample event and a
  documented way to inspect its result.
- `.env.example` with placeholders and runtime connection-variable handling.
- Version control: see "Git and `.gitignore`" below.
- `README.md` with install, start, sample invocation, result inspection, and a small
  runnable smoke check or exact commands that fail when the example does not complete.

### Git and `.gitignore`

If the destination is not in a Git work tree (`git rev-parse --is-inside-work-tree`),
run `git init` there. Do not commit; the user decides when. If it is already in one,
leave the repository alone.

Whenever the destination is in a work tree, create `.gitignore` or merge into the
existing one. Review what the project actually contains (chosen stack, package manager,
framework, build and test output, virtual environments, editor/OS files, anything the
starter generated or the verify step produced) and ignore what should not be committed:
dependencies, build artifacts, caches, local env files and secrets, Ironflow's local
data and credential files (Setup Step 7), and any other generated or machine-specific
file you find. Append only entries that are missing; never reorder, rewrite, or delete
existing lines. Never ignore lockfiles or `.env.example`. Recheck after Verify, since
installing and running creates files the starter did not.

Read the server URL and credentials at runtime. Preserve existing connection values;
`.env.example` is documentation, not an environment loader. Either use the runtime's
native env-file support, explicitly load a local env file, or document shell exports.
Never commit, print, or embed credentials in example URLs or source code.

## 5. Verify this project

Install dependencies in the chosen environment, run its build/syntax check, start
its entry points, and wait for registration against the chosen engine. Invoke the
HTTP route for an HTTP starter; emit the event directly for a worker-only starter.

Give this invocation a unique marker and capture its event/run ID. Poll with a bounded
wait until that specific function run completes, then assert its expected output.
An unrelated completed run in `run list` is not proof. A push starter must register
before emitting. A failed, timed-out, or unavailable check means setup is incomplete:
report the failed command and preserve files so work can continue.

Fix errors within the accepted scope and repeat the failing check. Stop only temporary
processes you started; retain the user's engine and data. Verify that README commands
can reproduce the same result, including Python environment activation or explicit
`.venv/bin/python` and the real engine connection.

## 6. Hand off

Report what was created, the checks that passed and any remaining failure, and the
commands to run again. Suggest `ironflow-code` for application development. For a
compatible pull application, `ironflow-ops` can package the project it finds using its
existing recipe; packaging is a separate request.
