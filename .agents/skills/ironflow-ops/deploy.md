# Package an App with Ironflow

Package the user's app and the Ironflow engine into ONE container, and prove it on the
user's machine. This file is for the user's own app. To operate the engine (Compose
stack, VPS, Kubernetes), read `platform.md`.

**This file packages. It does not deploy. Deploying is `deploy-target.md`, which the user asks
for separately.** While following this file, never run a deploy command, a registry push, or a
command that costs money. Print those commands in the report.

## Rules

- Never print the API key in the chat. Never write it into a Dockerfile, an image, or a
  committed file.
- Never use the `latest` engine tag. Pin a version.
- Never publish the engine port. Only the app port is published.
- A workflow file is written, never run. Tag the image with the commit SHA, never `latest`.
  Pin each GitHub Action to a full commit SHA, with its release tag in a comment.
- Do not choose packages or a framework for the user. Package the project that exists.
- Step 4 (Plan) is mandatory. Write nothing and run nothing until the user approves the plan
  in the chat.
- Step 6 (Verify) is mandatory. Without a passed verify, report failed or incomplete verification.

## Step 1: Inspect

Find these facts before you ask a question:

| Fact | Where to look |
|---|---|
| Language and dependency file | `requirements.txt`, `pyproject.toml`, `package.json`, `go.mod` |
| Startup dependencies and readiness | startup code, initialization/migrations, registrations, dependency checks, existing readiness probes |
| Web start command | `Procfile`, `package.json` scripts, README, the framework default |
| Worker entry point | the file that calls `Worker(...).run()`, `createWorker(...)`, or `ironflow.NewWorker(...)`; none for a client-only app |
| App port | the start command, `PORT`, the framework default |
| Existing `Dockerfile` or Compose file | project root |
| Ironflow version in use | the SDK pin in the dependency file, else `ironflow version` |
| Git remote and existing workflows | `git remote -v`, `.github/workflows/` |

## Step 2: Interview

Ask only for what Step 1 did not answer. One question at a time, three at most:

1. The web start command.
2. The worker entry point, or "none".
3. The app port.

## Step 3: Check fit

Stop and point to `platform.md` if one of these is true. The single-container shape is
wrong for that project.

- The app must run more than one instance.
- The project uses PostgreSQL for Ironflow (`IRONFLOW_DATABASE_URL`) or an external NATS.
- The functions are push mode and must stay push mode.

If the prompt asks for a CI/CD workflow and the project has no GitHub remote, write the
container only. Say why in the plan.

## Step 4: Plan

Show the plan, then stop. Do not create or change a file, and do not run a command, before
the user approves.

Print the plan in this order:

1. **Detected:** the stack, web command, worker entry point, app port, and the engine
   version you will pin.
2. **Files:** each file you will create or change. For an existing `Dockerfile`, show the
   diff. With a workflow, list `.github/workflows/deploy.yml`.
3. **Verify:** the exact commands in execution order, including `docker build`, `docker run`,
   readiness gates, one application operation, acceptance and completion checks, restart,
   renewed readiness gates, and persistence checks. Include the container name, volume name,
   host port, probe deadlines, and expected results.
4. **CI/CD:** only when the prompt asks for it. The branch, the image name
   (`ghcr.io/<owner>/<repo>`, lower case), and the line: "The workflow is written here but
   not run here. It runs on your next push to `<branch>`."
5. **Limits:** the known limits (Step 7).
6. **Not doing:** no registry push, no deploy, and the API key is never printed.

End with this question, as the last line of the message: `Do you approve this plan?`

Read the user's next message:

- A clear yes ("yes", "y", "ok", "go ahead", "approved", "looks good") is approval. Go to
  Step 5.
- A change request ("use port 9000", "pin 0.39.0") is not approval. Update the plan, print
  it again, and ask the question again.
- A question, a "no", or an answer you cannot read as yes is not approval. Answer or clarify,
  then ask again. Never take silence, or a yes with a change attached ("yes, but use another
  port"), as approval: apply the change, print the plan, and ask again.

Approval covers the plan as printed. If Step 5 or Step 6 needs a change to it, such as a new
file or a different port, print the change and ask again.

## Step 5: Write

### Readiness and dependency order

Inspect the application's startup path before filling the recipe. For each process and
verification operation, identify the prerequisites it actually needs: engine readiness,
credentials, schema or data initialization, function registration, subscriptions, workers,
or another application dependency. Start independent processes together only when their
prerequisites allow it. Gate dependent startup commands and application operations on the
required checks. Apply the same order in entrypoints, README commands, and verification scripts.

Choose checks from the application, rather than assuming an HTTP route exists. Examples
include an existing readiness endpoint, an authenticated read-only query, a registration or
subscription check, or a CLI status command. Check the conditions needed for the next operation.
A listening port, a live process, a successful `docker run -d`, or Ironflow's `/ready` alone
does not prove the application is ready. `/health` is liveness; `/ready` checks the engine's
own dependencies. A worker's process existing does not prove its registration is complete.

Bound every wait with an overall deadline and timeouts on each probe. Poll read-only checks;
stop on process exit or deadline with a message naming the missing prerequisite and elapsed
limit. A fixed sleep alone is not a readiness check. Keep credentials out of probe output and
failure diagnostics. If no adequate check exists, explain the gap and report the dependent
validation as unverified; do not invent a successful probe.

Readiness permits an operation to be attempted. Acceptance means the application accepted
that specific operation, such as returning an event or run ID. Completion requires a terminal
success state and the expected result. An HTTP success or accepted event is not completion.
Submit side-effecting operations once and retain their identifiers; poll read-only status
for completion. On an ambiguous response or timeout, inspect existing state before deciding
whether to resubmit. Retry a mutation only with a verified idempotency mechanism or proof it
had no side effects. A failure response alone does not prove that nothing was written.

### How it works
<!-- derived-from: examples/flask-single-container/README.md#how-it-works -->

The engine is one static binary. Copy it from the pinned engine image into the app's own
image, then let an entrypoint script start the engine first, hand the key to the app, and
stop the container when a process dies.

The recipe has four slots. Fill them from the project.

| Slot | Python | Node / TypeScript | Go and other |
|---|---|---|---|
| Base image | `python:<version>-slim` | `node:<version>-slim` | build stage + `debian:stable-slim` with `curl` and `jq` |
| Install | `pip install --no-cache-dir -r requirements.txt` | `npm ci --omit=dev` (or the project's package manager) | copy the built binary |
| Web command | for example `gunicorn --bind 0.0.0.0:${PORT:-8000} app:app` | for example `node dist/server.js` | the binary |
| Worker command | `python worker.py`, or none | `node dist/worker.js`, or none | the worker binary, or none |
| Engine ready probe | `python -c "import urllib.request; urllib.request.urlopen('$IRONFLOW_SERVER_URL/ready', timeout=2)"` | `node -e "fetch('$IRONFLOW_SERVER_URL/ready', {signal: AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"` | `curl --connect-timeout 1 --max-time 2 -sf "$IRONFLOW_SERVER_URL/ready"` |
| Key read | `python -c "import json,sys; print(json.load(open(sys.argv[1]))['key'])" "$KEY_FILE"` | `node -p "require(process.argv[1]).key" "$KEY_FILE"` | `jq -r .key "$KEY_FILE"` |

Python is proven in CI by the reference example. The other stacks use the same recipe
and are proven only by Step 6 on this project. Tell the user which case applies.

`Dockerfile` (Python shown; change the slots for other stacks):

```dockerfile
ARG ENGINE_IMAGE=ghcr.io/sahina/ironflow-releases:<engine-version>
FROM ${ENGINE_IMAGE} AS engine

FROM python:<version>-slim
COPY --from=engine /app/ironflow /usr/local/bin/ironflow

RUN useradd --system --create-home app && mkdir /data && chown app:app /data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# No USER line: the entrypoint starts as root only to take ownership of a platform volume
# (Fly mounts /data root-owned), then drops to the app user.
VOLUME ["/data"]
EXPOSE <app-port>
ENTRYPOINT ["./entrypoint.sh"]
```

`entrypoint.sh` (make it executable). Replace the marked lines with the slots and add gates
between app commands where the inspected dependencies require them. The engine probe below gates engine-dependent startup;
Step 6 still needs application-specific readiness checks.

```bash
#!/usr/bin/env bash
set -euo pipefail

# A platform volume (Fly) mounts root-owned. Start as root only to hand /data to the app user,
# then run the rest of this script as that user. HOME is reset because gunicorn writes under it.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  # Only when the owner differs: a recursive chown of a full volume on every start is slow.
  # A mount that refuses chown falls through to the writable check below, which says why.
  [ "$(stat -c %u /data)" = "$(id -u app)" ] || chown -R app:app /data || true
  HOME=/home/app exec setpriv --reuid=app --regid=app --init-groups "$0" "$@"
fi

DATA_DIR=/data
KEY_FILE="$DATA_DIR/.ironflow_bootstrap_key.json"
export IRONFLOW_SERVER_URL=http://127.0.0.1:9123

if [ ! -w "$DATA_DIR" ]; then
  echo "entrypoint: $DATA_DIR is not writable. Mount a volume there." >&2
  exit 1
fi

NATS_STORE_DIR="$DATA_DIR/nats" ironflow serve \
  --host 127.0.0.1 --port 9123 --db "$DATA_DIR/ironflow.db" &
engine=$!

# Install the trap before the readiness wait, so a SIGTERM during startup stops the engine.
pids=()
shutdown() {
  if [ "${#pids[@]}" -gt 0 ]; then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  kill -TERM "$engine" 2>/dev/null || true
  wait "$engine" 2>/dev/null || true
}
trap 'shutdown; exit 143' TERM INT

ready=0
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if <ENGINE READY PROBE> 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; then ready=1; break; fi
  if ! kill -0 "$engine" 2>/dev/null; then
    echo "entrypoint: the engine exited before it was ready" >&2
    exit 1
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "entrypoint: the engine was not ready after 60s" >&2
  exit 1
fi

# A seeded key comes from the platform secret store, so nothing is read from the volume and
# nothing is left on it. Without one, the engine writes the key to a file and never to stdout;
# read it into the environment and do not echo it.
if [ -z "${IRONFLOW_API_KEY:-}" ]; then
  if [ -n "${IRONFLOW_BOOTSTRAP_ADMIN_KEY:-}" ]; then
    IRONFLOW_API_KEY="$IRONFLOW_BOOTSTRAP_ADMIN_KEY"
  else
    IRONFLOW_API_KEY="$(<KEY READ>)"
  fi
fi
export IRONFLOW_API_KEY
# The app has no use for the dashboard password, and the worker and web process inherit this env.
unset IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD

<WORKER COMMAND> & pids+=($!)     # delete this line for a client-only app
<WEB COMMAND> & pids+=($!)

status=0
wait -n || status=$?
shutdown
[ "$status" -eq 0 ] && status=1
exit "$status"
```

Before you write:

- If a `Dockerfile` exists, show the user the diff and ask before you change it.
- Pin `<engine-version>` to the version of the Ironflow SDK that the project uses. Keep
  the SDK and the engine on the same release.
- Create or validate the effective ignore file for every build context: `.dockerignore`,
  or `<Dockerfile>.dockerignore` when present. Exclude `.git`, `node_modules`,
  `__pycache__`, `.ironflow`, and credential files found during inspection. Exclude all
  root and nested environment files with `.env*` and `**/.env*`; put these exclusions
  after any `!` rules that could re-include them. Verify the effective rules exclude
  `.env`, `.env.local`, and `.env.production` before building, even if the file existed.
- The app must read `IRONFLOW_SERVER_URL` and `IRONFLOW_API_KEY` from the environment.
  The worker SDKs do this by default. Check the client code in the web process.

### CI/CD workflow

Only when the prompt asks for it, and only for a GitHub project. Write
`.github/workflows/deploy.yml`. Replace `<branch>` with the branch from the prompt. Keep the
single quotes: without them YAML reads a branch named `true`, `null`, `1.0` or `yes` as a
boolean, null or number, and the workflow never triggers.

```yaml
name: Build and push image

on:
  push:
    branches: ['<branch>']

permissions:
  contents: read
  packages: write

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Name the image
        # GHCR rejects upper-case names, and the owner or repository can contain them.
        run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"
      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
```

This is the minimum: it builds and pushes. It does not start the image anywhere. Do not add
a deploy step, a `latest` tag, or a secret. If a `.github/workflows/deploy.yml` exists, show
the diff and ask before you change it.

The three SHAs are the releases named in their comments. Before you write the file, check
each action's latest release with `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`.
If a newer release exists, resolve its tag to a commit
(`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, and follow an annotated tag to its commit)
and use that SHA with the new tag in the comment. If you cannot check, keep these three and
say so in the plan.

The complete reference example is `examples/flask-single-container` in
<https://github.com/sahina/ironflow-releases>.

## Step 6: Verify

Run the generated commands in their documented order, without manual delays or out-of-order
retries. Use project-specific container and volume names. Match the readiness gates and
success criteria to Step 4's plan.

1. `docker build -t <name>:local .`
2. `docker run -d --name <name> -p 127.0.0.1:<host-port>:<app-port> -v <name>-data:/data <name>:local`
3. Wait for the application's prerequisites using the planned bounded, read-only checks.
   Verify required initialization, registrations, and dependencies before submitting work.
4. Submit one operation that uses Ironflow. Check acceptance and save its identifiers.
   Separately wait with bounded read-only checks for successful completion and assert the
   expected result. Do not retry the operation to work around startup or completion delays.
5. `docker restart <name>`. Repeat the readiness checks needed to read persisted state,
   including engine connectivity, authentication, and any application initialization or
   registration the read depends on. Read the earlier operation by its saved identifier
   and verify its successful state and result. Do not create new work as proof of persistence.
   If also testing new work after restart, first recheck its submission prerequisites and
   track it separately from the persisted operation.
6. After restart, check logs for full credentials without printing matching lines:
   `docker logs <name> > <temporary-log> 2>&1`, then
   `grep -cE 'ifkey_[A-Za-z0-9]{16,}' <temporary-log>` must print `0`. Confirm log collection
   succeeded and remove the temporary log. Treat grep exit 1 as no matches and exit >1 as a
   check error. The banner's short prefix (`ifkey_78e548b5...`)
   is not a leak. Sanitize diagnostics before sharing logs; never print full credentials.
7. `docker port <name>` must show the app port only.
8. If you wrote a workflow: `actionlint .github/workflows/deploy.yml` must print nothing. If
   `actionlint` is not installed, parse the file with a YAML parser and say that you did not
   lint it. Do not run the workflow.

If a check fails, inspect logs without exposing credentials and fix the cause. Repeat the
relevant checks in dependency order, preserving operation IDs and reconciling side effects
before submitting more work. If Docker, dependencies, credentials, or another prerequisite
are unavailable, name every blocked or skipped check and why. Static review or parsing does
not establish runtime readiness, completion, or persistence. Without a passed runtime verify,
report packaging verification as incomplete or failed, never as proven.

Remove the container when you are done. Ask the user before you remove the volume.

## Step 7: Report

Tell the user:

- The files you wrote or changed.
- Which checks passed, with the command for each, and which failed or remain unverified with
  their reasons. Distinguish readiness, acceptance, completion, and post-restart persistence.
- If the stack is CI-proven (Python) or proven only by Step 6.
- If you wrote a workflow: it was checked, not run. It runs on your next push to
  `<branch>`. It pushes `ghcr.io/<owner>/<repo>:<commit-sha>` and nothing deploys that image.
- The known limits below.
- The commands for a deploy to a host with a persistent volume. Do not run them from this file.
  Tell the user that deploying is a separate request and name `deploy-target.md`.

### Known limits
<!-- derived-from: examples/flask-single-container/README.md#known-limits -->

- One instance only. Two containers are two engines with two separate data sets.
- A volume on `/data` is mandatory. Without one, removing the container deletes all runs
  and events.
- The dashboard is not reachable from outside the container.
- The bootstrap key stays on the volume unless it is seeded (`deploy-target.md`). Seeding needs
  an engine release that supports it; check with `ironflow serve --help`.
- A restart stops the engine. There is no zero-downtime deploy.

### CI/CD limits

- The workflow builds and pushes an image. Nothing starts it. A host, and the secrets for it,
  are your next step.
- The first push to a new package makes it private. Make it public or give the host a pull
  token.
- The workflow has no dev or prod split. One branch, one image tag per commit.
- When you change the SDK version, change the engine pin in the `Dockerfile` to the same
  release. Read `migrate.md` before you move an existing `/data` volume to a new engine.
