# Deploy the Packaged App to a Target

Deploy the image that `deploy.md` packaged to a VPS, Fly or Railway, with the user's own
account. This file runs commands that cost money or are public. Every such step stops for a
plain yes first.

## Rules

- A **gated step** costs money or is public. Gated: create an app, project, service or server;
  create a volume; push or pull a private image; set a secret or variable; attach a domain or
  create a public URL; every deploy and redeploy; every teardown. Everything else is
  **read-only**.
- Print the exact command and one line on its cost or exposure, then stop. Run it only after a
  clear yes ("yes", "y", "ok", "go ahead"). A change request, a question, or "yes, but ..." is not a
  yes: apply the change, print the step again, ask again.
- Never print the API key or the dashboard password. Never put either on a command line: no
  `-e NAME=VALUE`, no `--variables KEY=VALUE`, no `variable set KEY=VALUE`, no `echo` of the
  value. Pass secrets on stdin from the env file only.
- Never run a command that prints secret values: `fly secrets list`, `railway variable list`,
  `railway run env`, `railway run printenv`. Never `cat` the env file.
- Never read, print or copy a CLI token. The user logs in. You do not.
- One instance, one volume at `/data`. Stop and point to `platform.md` if the project needs more.
- Never deploy a `latest` tag. Use the commit-SHA tag or the digest.
- Run a vendor command only as this file shows it. If a `--help` check differs from this file,
  STOP and tell the user. Do not guess a flag.
- Step 2 (Plan) is mandatory. Run nothing gated until the user approves the plan.

## Step 1: Preflight (read-only, except a private-image pull)

| Check | Command |
|---|---|
| The image exists and has a pinned tag | the tag from `deploy.md` Step 6 or the CI workflow (`ghcr.io/<owner>/<repo>:<sha>`) |
| The engine in the image supports key seeding | see the probe below. It must print `1` or more. If it prints `0`, stop: the image needs a newer engine; see `migrate.md` |
| `openssl` is installed (Step 3 needs it) | `openssl version` prints a version. If not, stop and tell the user |
| The target CLI is installed and logged in | VPS: `ssh -o BatchMode=yes <host> true`. Fly: `fly auth whoami`. Railway: `railway whoami` |
| The image is public or private | ask the user |

The seeding probe. `docker run` pulls the image if it is not on this machine. For a private image
the pull is a gated step: ask for a yes first. The probe runs the image's `ironflow` binary on this
machine. Write the help text to a private file from `mktemp`, then count. Do not pipe `docker run` into
`grep -q`: `grep -q` exits at the first match and the pipe breaks under `set -o pipefail`.

```sh
f=$(mktemp)
docker run --rm --entrypoint ironflow <image> serve --help > "$f" 2>&1
grep -c IRONFLOW_BOOTSTRAP_ADMIN_KEY "$f"
rm -f "$f"
```

If the user is not logged in, tell them to run the login themselves (`! fly auth login`,
`! railway login`). Do not run a login.

Ask the target, one question: VPS, Fly or Railway. For a VPS also ask the host (`user@host`) and
the domain (optional but recommended: without it the app is plain HTTP). For Fly also ask the
region and the organization. For Railway ask for nothing more.

For Fly or Railway, run the `--help` checks for that target before the plan. For each flag in
the table, the help must list it. If one is missing, STOP and tell the user.

| Target | Run | Find |
|---|---|---|
| Fly | `fly launch --help` | `--image`, `--name`, `--region`, `--org`, `--no-deploy`, `--no-db`, `--no-redis`, `--no-object-storage`, `--internal-port`, `--yes`, `--ha` |
| Fly | `fly volumes create --help` | `--region`, `--size`, `--app`, `--yes` |
| Fly | `fly volumes list --help` | `--app` |
| Fly | `fly secrets import --help` | `--app`, `--stage`, values read from stdin |
| Fly | `fly deploy --help` | `--app`, `--ha`; a registry credential flag (only if the image is private) |
| Fly | `fly machine list --help` | `--app`, `--quiet` |
| Fly | `fly logs --help` | `--app`, `--no-tail` |
| Railway | `railway add --help` | `--image`, `--service` |
| Railway | `railway volume add --help` | `--mount-path`, `--service` |
| Railway | `railway variable set --help` | `--stdin`, `--service`, `--skip-deploys` |
| Railway | `railway domain --help` | `--port`, `--service` |
| Railway | `railway scale --help` | `--service`, region `NAME=COUNT` form |
| Railway | `railway status --help` | the command exists |
| Railway | `railway logs --help` | `--lines`, `--service` |
| Railway | `railway --help` | a redeploy command. If none, Step 5 check 3 uses the dashboard |

A private image on Fly or Railway is a stop. Read Step 4 for the target before you go on.

## Step 2: Plan

Print the plan and stop. List every step in the order it runs, each marked `gated` or
`read-only`, with its cost or exposure in a few words. Include the redeploy of Step 5 and the
files the plan writes (the env file; `fly.toml` for Fly). End with `Do you approve this plan?` as
the last line. Read the answer by the same rules as `deploy.md` Step 4.

## Step 3: Make the key

Run this once per app. It writes the key and password to a private file outside the repo and
prints nothing. Replace `<app>` with the app name. `<app>` must match `^[a-z0-9][a-z0-9-]{0,62}$`.
If it does not, STOP and ask the user for another name. The name goes into a file path and a shell
command.

First test whether the file exists: `test -e ~/.config/ironflow/<app>.env && echo exists`. If it
prints `exists`, STOP and ask the user. Never overwrite the file. Never delete a file that was
there before this step: it can hold the only copy of a deployed admin key, and Fly cannot show a
secret again. The command below also fails on an existing file, because of `set -C`, but you
must not depend on that.

```sh
sh -c 'set -C; umask 077; mkdir -p "$HOME/.config/ironflow"; printf "IRONFLOW_BOOTSTRAP_ADMIN_KEY=ifkey_%s\nIRONFLOW_BOOTSTRAP_ADMIN_PASSWORD=%s\n" "$(openssl rand -hex 16)" "$(openssl rand -hex 12)" > "$HOME/.config/ironflow/<app>.env"'
```

The key is `ifkey_` and 32 lower-case hex characters. Do not change that shape: the engine
refuses a key with another shape, or with a space or a newline, and stops at startup.

Check the file. Both commands print nothing secret. Each must print `1` (`grep -c` exits 1 when
the count is `0`). If the file is missing, `grep -c` prints an error and not `0`. That also means
stop:

```sh
grep -cE '^IRONFLOW_BOOTSTRAP_ADMIN_KEY=ifkey_[0-9a-f]{32}$' ~/.config/ironflow/<app>.env
grep -cE '^IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD=[0-9a-f]{24}$' ~/.config/ironflow/<app>.env
```

If either prints `0` (for example `openssl` was missing and a value is empty), this run created the
file, because you tested that it did not exist. Run `rm -f ~/.config/ironflow/<app>.env` and stop.
Tell the user the file was bad and removed. Do not retry before the cause is fixed. If a check
prints an error, or the command failed, delete nothing: tell the user and stop.

Tell the user the path, that the file holds the admin key and the dashboard password, and that
they should keep a copy: Fly cannot show a secret again. Do not `cat` the file.

## Step 4: Run the target

### VPS

Gated steps: private-image login, the deploy (installs Docker, starts a public service), the
domain going live. The command does its own DNS, certificate and URL checks. Do not repeat them.

1. If the image is private, tell the user to run `! ssh -t <host> docker login ghcr.io -u <user>` and
   type a read-only package token at the prompt. The `-t` gives `docker login` a terminal for the
   prompt; without it `docker login` refuses. Never ask for the token in chat, and never put it on a
   command line.
2. `ironflow deploy vps --host <host> --domain <domain> --app <image> --env-file ~/.config/ironflow/<app>.env`
   (add `--app-port` and `--health-path` if the app differs from 8000 and `/healthz`).
   Always pass `--env-file` on a seeded deploy, also on a re-deploy. Without it the new compose
   file has no `env_file`, the container loses `IRONFLOW_BOOTSTRAP_ADMIN_KEY` and the app fails at
   startup. The command refuses a re-deploy without `--env-file` when the host already has a `.env`.
   Say so in the report.
3. Read the result. With `--domain`, the command prints the URL only after the URL answered. A
   warning means the DNS or certificate is not ready; follow its hint. Without `--domain`, the
   command prints the URL with no check ("No check was made without --domain"), so run the Step 5
   checks yourself.

The command refuses a `latest` tag, an env file that is not mode 0600, and a host that holds a
stack-mode deploy. Report the refusal. Do not work around it.

### Fly

Gated: create app, create volume (billed), set secrets, deploy (public URL). Run in the project
root. `<app>`, `<region>`, `<org>`, `<image>`, `<app-port>` and `<health-path>` are the user's
values. `<health-path>` is the path the app answers with 200 (default `/healthz`).

1. Create the app. No deploy.

   ```sh
   fly launch --no-deploy --image <image> --name <app> --region <region> --org <org> --no-db --no-redis --no-object-storage --internal-port <app-port> --yes
   ```

   This writes `fly.toml`. Tell the user. Read it. It must have `[build]` with `image = "<image>"`.
   If it has no `[build]` image, add it. If you are unsure, STOP and tell the user.
2. Create one volume. The name must equal `source` in `fly.toml`.

   ```sh
   fly volumes create ironflow_data --region <region> --size 1 --app <app> --yes
   ```

   A Fly volume mounts root-owned. The packaged image from `deploy.md` starts as root and gives
   `/data` to the app user, so no extra step is needed. An image that sets `USER` to a non-root
   user at runtime fails at the writable check of `/data`. If that happens, STOP and tell the user
   to repackage the image per `deploy.md`.

3. Edit `fly.toml`. Change the existing tables. Do not add a second copy of one. Put no secret in it.

   ```toml
   [mounts]
     source = "ironflow_data"
     destination = "/data"

   [http_service]
     internal_port = <app-port>
     force_https = true
     auto_stop_machines = "off"
     auto_start_machines = true

     [[http_service.checks]]
       path = "<health-path>"
       method = "GET"
       interval = "15s"
       timeout = "5s"
       grace_period = "30s"
   ```

   `auto_stop_machines = "off"` keeps the one machine running. The default `"stop"` stops an idle
   machine, and the engine with it.
4. Stage the secrets. The env file goes on stdin. No value appears on a command line.

   ```sh
   fly secrets import --app <app> --stage < ~/.config/ironflow/<app>.env
   ```

   The docs show a staged secret before the first deploy only for `fly secrets set`. If this
   command restarts a machine, that is expected. Do not run `fly secrets list`.
5. Deploy. One machine only.

   ```sh
   fly deploy --app <app> --ha=false
   ```

A volume binds to one machine and one region. A volume mount gives one machine on first deploy,
so `--ha=false` is a second guard. Keep exactly one machine and one volume.

A private image: Fly documents its own registry only. If the image is on a private `ghcr.io`
package, STOP. Tell the user to make the package public, or to push the image to the Fly
registry as a gated step: `fly auth docker`, then `docker push registry.fly.io/<app>:<tag>`,
then `fly deploy --app <app> --ha=false --image registry.fly.io/<app>:<tag>`.

### Railway

Gated: create project and service, set variables, create volume (billed), create the domain
(public), deploy. Run in the project root. `railway init` links this directory to the project.

1. Create the project.

   ```sh
   railway init --name <app>
   ```

2. Add the image as a service. Pass no `--variables` and set no start command: a start command
   replaces the image ENTRYPOINT, and the entrypoint starts the engine.

   ```sh
   railway add --image <image> --service <app>
   ```

   This can start a deployment before the variables and the volume exist. Run `railway status`.
   Treat that deployment as not final. Do not run the Step 5 checks on it.
3. Set every variable before you add the volume. The volume is the first boot that keeps data, so
   the seed must exist by then. Set `PORT` to the app port. It holds no secret.

   ```sh
   printf <app-port> | railway variable set PORT --stdin --service <app> --skip-deploys
   ```

   Set the password, then the key, one call per variable. The value goes through a pipe from the
   env file and never appears on a command line. `tr -d '\n'` removes the line end: the engine
   refuses a key with a newline and stops at startup. Every call has `--skip-deploys`.

   ```sh
   sed -n 's/^IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD=//p' ~/.config/ironflow/<app>.env | tr -d '\n' | railway variable set IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD --stdin --service <app> --skip-deploys
   sed -n 's/^IRONFLOW_BOOTSTRAP_ADMIN_KEY=//p' ~/.config/ironflow/<app>.env | tr -d '\n' | railway variable set IRONFLOW_BOOTSTRAP_ADMIN_KEY --stdin --service <app> --skip-deploys
   ```

   Do not run `railway variable list`.
4. Add the one volume. This is the last step before the first deployment that counts.

   ```sh
   railway volume add --mount-path /data --service <app>
   ```

   Run `railway status` and check that a new deployment started. If none started, ask the user to
   redeploy (see Step 5 check 3). That deployment is the first deployment for Step 5.
5. Keep one replica. Run `railway status`. If a region shows more than one replica, run
   `railway scale <region>=1 --service <app>`. Replicas and volumes do not work together.
6. Create the public domain. `--port` points it at the app port, never at the engine port.

   ```sh
   railway domain --port <app-port> --service <app>
   ```

   The output is the public URL.

A private image: Railway takes registry credentials in the dashboard only (service Settings,
Source, Registry Credentials; Pro plan). Tell the user to set them. Never ask for the token in chat.

## Step 5: Verify

Run every check. Use the public URL: VPS, the URL `deploy vps` printed; Fly,
`https://<app>.fly.dev`; Railway, the URL `railway domain` printed.

Write platform logs to a private file, then count with `grep -c`. Run `mktemp` once per capture.
It creates the file with mode 0600. Use its path as `<logfile>` below. `grep -c` exits 1 when the
count is `0`; that is a pass for the `0` counts below.

Capture the logs after the first deployment (checks 1 and 2) and again after the redeploy (check
4 runs on both captures). The engine prints `Seeded from IRONFLOW_BOOTSTRAP_ADMIN_KEY` on its first
boot only. Every later boot prints a short key prefix and `(created on first boot)`.

| Target | Log command |
|---|---|
| VPS | `ssh <host> 'cd /opt/ironflow && docker compose logs app' > <logfile> 2>&1` |
| Fly | `fly logs --no-tail --app <app> > <logfile> 2>&1` |
| Railway | `railway logs --lines 1000 --service <app> > <logfile> 2>&1` |

1. The app's own route that uses Ironflow answers, and the run completes (retry up to 30 seconds
   while the worker registers). Do not probe `/api/v1/functions`: it is not a valid probe.
2. The engine used the seeded key. Run this on the logs of the FIRST deployment, before the
   redeploy: `grep -c 'Seeded from IRONFLOW_BOOTSTRAP_ADMIN_KEY' <logfile>` must print `1` or
   more, and `grep -c 'Written to:' <logfile>` must print `0`. On Railway, the first deployment is
   the one that started after the volume was added. Check 1 already proves the app's key works.
3. Redeploy the same image, then the earlier run is still listed. VPS: re-run the Step 4
   command. Fly: `fly deploy --app <app> --ha=false`. Railway: use the redeploy command from the
   preflight, or ask the user to press Redeploy in the dashboard. The redeploy is a gated step.
4. No capture holds a key: `grep -cE 'ifkey_[A-Za-z0-9]{16,}' <logfile>` must
   print `0` for each. The engine banner prints a short key prefix; the pattern needs 16 or more
   characters, so the prefix does not match.
5. Exactly one instance runs.

   | Target | Command | Must show |
   |---|---|---|
   | VPS | `ssh <host> 'cd /opt/ironflow && docker compose ps -q app'` | one id |
   | Fly | `fly machine list --app <app> --quiet` and `fly volumes list --app <app>` | one machine id, one volume |
   | Railway | `railway status` | one replica, one volume |

Run `rm -f <logfile>` when the checks end, on a pass and on a fail.

If a check fails, report the failure and the log lines that explain it. Do not print a key. Do not
claim success.

## Step 6: Report

State the URL; the checks that passed; where the key file is; how to rotate (`### Rotation`); how
to stop the bill (`### Teardown`); and the limits. On a VPS, say that you passed `--env-file`.

### Rotation

Rotation changes the admin key only. The engine seeds the dashboard password on first boot only,
so the password does not rotate. Keep the password line in the file.

Write a new env file with a new key and the old password line. The command keeps the old file as
`<app>.env.old`. It prints `rotated` when it is done, and it prints nothing secret. If the old file
has no password line, it prints an error and changes nothing:

```sh
sh -c 'set -e; umask 077; f="$HOME/.config/ironflow/<app>.env"; if ! grep -q "^IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD=" "$f"; then echo "rotation failed: no password line in $f" >&2; exit 1; fi; cp "$f" "$f.old"; { printf "IRONFLOW_BOOTSTRAP_ADMIN_KEY=ifkey_%s\n" "$(openssl rand -hex 16)"; grep "^IRONFLOW_BOOTSTRAP_ADMIN_PASSWORD=" "$f.old"; } > "$f.new" || { rm -f "$f.new"; echo "rotation failed: could not write the new file" >&2; exit 1; }; mv "$f.new" "$f"; echo rotated'
```

If it does not print `rotated`, stop and tell the user. Do not say the key was rotated. Then run the
two `grep -c` checks from Step 3 on the new file. Each must print `1`. If not, restore the old file
(`mv ~/.config/ironflow/<app>.env.old ~/.config/ironflow/<app>.env`) and stop. Then:

| Target | Command |
|---|---|
| VPS | re-run the Step 4 command with `--env-file` |
| Fly | `fly secrets import --app <app> < ~/.config/ironflow/<app>.env` (no `--stage`: it restarts the machine) |
| Railway | the `IRONFLOW_BOOTSTRAP_ADMIN_KEY` call of Step 4 item 3, with `--skip-deploys` removed so it starts the redeploy |

The engine replaces its stored key at the next start and logs a warning. Capture the logs as in
Step 5, then run
`grep -c 'bootstrap admin API key rotated to match IRONFLOW_BOOTSTRAP_ADMIN_KEY' <logfile>`. It must
print `1` or more. Run `grep -cE 'ifkey_[A-Za-z0-9]{16,}' <logfile>` too. It must print `0`. Then run
`rm -f <logfile>`. Only after both checks pass, tell the user the key was rotated. If the warning is
missing, tell the user the rotation is not proven and stop. Tell the user to keep the new file as
their copy, and to delete `<app>.env.old` when the new key works.

### Teardown

Print the commands for the target. Say which stop the bill. Run none of them without a yes.
Deleting a volume deletes the data. Tell the user to get the data out first.

| Target | Command | Effect |
|---|---|---|
| VPS | `ssh <host> 'cd /opt/ironflow && docker compose down'` | stops the app, keeps the volume. The server bills until the user deletes it at the provider |
| VPS | `ssh <host> 'cd /opt/ironflow && docker compose down -v'` | stops the app, deletes the data |
| Fly | `fly apps destroy <app> --yes` | removes machines, volumes, secrets and images. Stops all billing |
| Fly | `fly volumes destroy <volume-id> --app <app> --yes` | deletes the volume only. Get the id from `fly volumes list --app <app>` |
| Railway | `railway volume delete --volume <name> --yes` | deletes the volume. Billing for storage stops. Restorable for 48 hours |
| Railway | `railway delete --project <id-or-name> --yes` | deletes the project, its services and its data. Irreversible |

Do not use `railway down` for teardown. It removes only the latest deployment. The service and
the volume stay, and so does the bill. Railway can ask for `--2fa-code <code>`: ask the user for
it. Do not guess it.

### Limits

- One instance; two instances are two engines with separate data.
- The engine port is not public. For the dashboard or CLI, run the CLI inside the container.
  The CLI reads `IRONFLOW_API_KEY` and defaults to `http://localhost:9123`, which is the engine's
  loopback address, so set no server URL. A session in the container does not hold
  `IRONFLOW_API_KEY` (only the app process does) but does hold `IRONFLOW_BOOTSTRAP_ADMIN_KEY`.
  Copy one into the other inside the container, so the shell in the container expands the value
  and nobody types it:
  VPS `ssh <host> "cd /opt/ironflow && docker compose exec -T app sh -c 'IRONFLOW_API_KEY=\$IRONFLOW_BOOTSTRAP_ADMIN_KEY ironflow <args>'"`;
  Fly `fly ssh console --app <app> --command "sh -c 'IRONFLOW_API_KEY=\$IRONFLOW_BOOTSTRAP_ADMIN_KEY ironflow <args>'"`;
  Railway `railway ssh --service <app> sh -c 'IRONFLOW_API_KEY=$IRONFLOW_BOOTSTRAP_ADMIN_KEY ironflow <args>'`.
  First check that the session holds the variable. Run the same command, with the whole
  `sh -c '...'` text replaced by `sh -c 'printenv IRONFLOW_BOOTSTRAP_ADMIN_KEY >/dev/null && echo set'`.
  It prints no value. It must print `set`. If it prints nothing or the quoting fails, STOP and tell
  the user. Never improvise `--api-key <value>` or any other form that types the key.
  Do not use `fly proxy`: it reaches the machine's private address, not its loopback.
- A restart stops the engine. There is no zero-downtime deploy.
- No dev or prod split, no automatic rollback.
- Rotation restarts the app.
