---
name: ironflow-ops
version: 0.46.0
description: |
  Operate Ironflow — debug failed/stuck runs, migrate SDK versions with upcasters,
  deploy/scale/troubleshoot clusters, package an app with the engine into one container.
  Triggers on: "package my app", "containerize", "ship my app", "run failed", "stuck workflow",
  "debug ironflow", "wrong output", "missing event", "projection drift",
  "upgrade ironflow", "update SDK", "migrate to", "event versioning",
  "deploy ironflow", "deploy my app to fly", "deploy my app to railway",
  "deploy my app to my vps", "scale cluster", "add tenant", "provision", "k3d", "hetzner",
  "helm", "kubectl", "monitor", "backup", "restore".
  NOT for writing application code (use ironflow-code).
  NOT for setup in a fresh project (use ironflow-start).
  NOT for SDK reference lookup (use ironflow-docs).
user-invocable: true
argument-hint: "[issue or operation] — e.g., 'run failed at payment step', 'scale to 5 replicas'"
allowed-tools: Read, Glob, Grep, Bash, WebFetch
---

# Ironflow Ops

Workflow for operating Ironflow at runtime: debugging, migration, and platform ops.
Five sub-domains live in topic files (load on demand).

> **Path convention.** Scripts are named relative to this skill's own directory — your
> harness names that directory when it loads the skill, and a packaged skill serves them as
> readable resources rather than executable files. Reference files in ANOTHER skill are
> shown as `~/.agents/skills/<skill>/...` (global install); if that path does not resolve,
> activate that skill by name instead of guessing at a prefix.

## Reference Files

```
https://docs.ironflow.run/reference/cli.md   # CLI command reference
https://docs.ironflow.run/reference/mcp-tools.md   # MCP tool reference
https://docs.ironflow.run/explanation/ai-pitfalls.md   # for diagnosing root causes
```

## Sub-Topic Files

```
debug.md           # diagnose failed/stuck/wrong runs
migrate.md         # upgrade SDK + write upcasters
platform.md        # deploy/scale/operate clusters
deploy.md          # package the user's app + engine into one container
deploy-target.md   # deploy the packaged app to a VPS, Fly or Railway
```

## Sub-Topic Routing

Match the user's request to one of five sub-topics, then read the corresponding file:

| Intent | Read |
|---|---|
| "run failed", "stuck", "wrong output", "missing event", "projection drift", "worker not processing", "KV broken", "entity stream weird" | `debug.md` |
| "upgrade ironflow", "update SDK", "what changed", "migrate to v...", "upcaster", "event schema versioning" | `migrate.md` |
| "deploy my app to Fly", "put my app on Railway", "deploy my app to my VPS", "ship the packaged app", "go live" (after packaging) | `deploy-target.md` |
| "package my app", "containerize my app", "ship my app", "deploy my app", "one container", "Dockerfile for my app" | `deploy.md` |
| "deploy", "provision", "scale", "cluster", "tenant", "monitor", "backup", "restore", "docker compose", "self-host", "k3d", "hetzner", "helm", "kubectl" | `platform.md` |

Don't load all five. Load what's relevant. "Deploy" is two things: the user's **app**
(with the engine in one container) is `deploy.md`; the **engine** as its own service
(Compose, VPS, Kubernetes) is `platform.md`. After the app is packaged, putting it on a host is `deploy-target.md`. If you cannot tell, ask once.

## Packaging startup and verification

For app packaging, read `deploy.md` before generating commands. Inspect the app's actual
startup dependencies and define readiness for each operation. Starting a process or a
detached container does not establish readiness. Generate bounded, read-only prerequisite
checks before operations, separate acceptance from completion, and repeat the necessary
checks after restart before checking persistence. Report skipped or unavailable validation
as unverified, never passed.

## Auth (read before running anything)

Every `/api/`, `/ws` and `/ironflow.v1.` path requires authentication — always, no config toggle.
Among those, only `/health`, `/ready`, `/metrics`, `/api/v1/capabilities`, `/api/v1/auth/login`,
`/api/v1/auth/validate` and `/api/v1/platform/auth/login` are public, plus `POST /api/v1/webhooks/{id}`
when it presents the source's `ifwh_` ingest token, and `/api/v1/files/signed` (its `?token=` is the credential). `OPTIONS` preflights pass on every path, and the
non-API dashboard shell is served without an API key (it has its own cookie auth).

- **Prefer the `ironflow` CLI.** It attaches `IRONFLOW_API_KEY` for you.
- A bare `curl .../api/v1/...` returns `{"error":"authentication required"}` unless the
  server runs `ironflow serve --dev`. If a curl returns nothing useful, suspect auth
  before suspecting the data.
- REST responses are **snake_case** and mostly **enveloped** (`{"steps": […]}`,
  `{"events": […]}`), not bare arrays. camelCase keys like `functionId` don't exist.

## Quick Health Check (Run First for Any Issue)

Call `ironflow_server_info` (health and version), then `ironflow_overview` (function count,
active runs, workers, recent events). Where MCP is unavailable:

```bash
curl -s http://localhost:9123/health
curl -s http://localhost:9123/ready
```

If the server is unreachable or unhealthy, fix server connectivity before app-level
debugging. This is in `platform.md` (troubleshooting section).

## Cleanup Protocol

If you write any temporary files during ops work (debug scripts, JSON dumps, test event
payloads), delete them at the end. The user's workspace must be left clean. Verify:

```bash
rm -f /tmp/ironflow-debug-* /tmp/if-debug-*
```

Do not leave behind: temp shell scripts, JSON dumps from API queries, test payload files.

---

**Next** (after ops work, depending on outcome):
- `/ironflow-code` — write the fix code, regenerate tests
- `/ironflow-start` — re-architect if the issue revealed a fundamental design problem
- `/ironflow-docs` — look up CLI/SDK syntax for follow-up commands
