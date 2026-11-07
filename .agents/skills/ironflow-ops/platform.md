# Ironflow Platform Operations

Run, upgrade, scale, monitor, troubleshoot, back up, and recover a self-hosted Ironflow.

Self-hosted Ironflow is the engine container plus the Docker Compose files from the release
repository. This file holds the routing and the troubleshooting. The procedures live in the
hosted docs. Fetch the page before you run commands. Do not work from memory.

## Rules for the agent

- Ironflow ships no Helm chart, no Kubernetes manifests, and no command that deploys over SSH.
  If the user asks for one, say so and offer the Docker Compose files. Do not write a chart or
  manifests from memory.
- Every compose command needs `-f <file>`. The release-mirror directories hold only named
  files, such as `docker-compose.single-node.yml`, so a plain `docker compose ps` fails.
- `.env` holds `IRONFLOW_MASTER_KEY`, the only key that decrypts stored secrets. Never print
  it, never overwrite `.env`, and never run `init-env.sh` against a stack that already started.
- Ask before any command that deletes data: `docker compose down -v`, `docker volume rm`.

## Step 0: Which deployment is this?

| Signal | Deployment | Where to go |
|---|---|---|
| `ironflow serve --dev` in a terminal, SQLite file | Local single binary | Nothing to operate. See `debug.md` |
| `docker ps` shows `ironflow-ironflow-1` | Docker Compose, single node | Docker Compose rows in "Where the procedures live" |
| `docker ps` shows `ironflow-starter-*`, `ironflow-cluster-*` or `ironflow-ha-*` | Docker Compose: Starter, Cluster or HA | Docker Compose rows in "Where the procedures live" |
| The engine is a service in the user's own compose file | Alongside the user's app | "Run alongside an app" row |

```bash
docker ps --filter name=ironflow --format '{{.Names}}  {{.Status}}' | grep . || echo "NO_COMPOSE"
```

## Where the procedures live

Fetch the page with `WebFetch`. In Ironflow Desktop's built-in agent, use `docs_fetch`.
Each URL returns one page as Markdown. Read the section named in the last column.

| Operation | URL | Sections |
|---|---|---|
| Where to run Ironflow, common env vars | https://docs.ironflow.run/how-to-guides/deployment/overview.md | "Where to run it", "Common configuration" |
| Choose a size, start a stack | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Choose a size", "Start Starter, Cluster or HA", "Start a single node" |
| First admin key, dashboard login | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Log in and create an API key" |
| Upgrade Ironflow or NATS | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Pin and upgrade a version", "Upgrade the NATS image" |
| Back up and restore | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Data and backups", "Back up and restore a single node", "Back up Starter, Cluster and HA" |
| Move to a newer PostgreSQL major | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Move to a newer PostgreSQL major" |
| Rotate the master key | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Rotate the master key" |
| Rotate an API key | https://docs.ironflow.run/reference/cli/commands/apikey.md | "`ironflow apikey rotate`" |
| Scale: move to a larger size | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Move to a larger size" |
| Run on several hosts | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Production on your own infrastructure", "Production Considerations" |
| Monitoring and Grafana | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Monitoring" |
| Metrics, health endpoints, dashboards | https://docs.ironflow.run/how-to-guides/observability.md | "Health Endpoints", "Grafana Dashboards", "Alerting" |
| Error messages at startup | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Troubleshooting" |
| `/ready` answers 503 with `stream:<name>`, `JetStreamStreamFault` | https://docs.ironflow.run/how-to-guides/deployment/recover-a-stuck-stream.md | the whole page; never run `nats stream rm` before reading it |
| Run alongside an app | https://docs.ironflow.run/how-to-guides/deployment/alongside-your-app.md | "Docker Compose", "Health checks" |
| Add a tenant | https://docs.ironflow.run/reference/cli/commands/tenant.md | the whole page |

If no row matches, fetch https://docs.ironflow.run/llms.txt and pick the page from it.

## Step 1: Match the operation

| User says | Go to |
|---|---|
| "docker compose", "compose", "self-host", "deploy ironflow", "install" | Choose a size, start a stack |
| "my vps", "one server" | Choose a size, start a stack. A VPS runs the Compose files like any other host |
| "kubernetes", "helm", "kubectl" | Rules for the agent: none of these ship. Offer the Compose files |
| "scale", "add replicas", "more nodes" | Scale: move to a larger size. For more than one host, Run on several hosts |
| "tenant", "multi-tenant" | Add a tenant |
| "monitor", "dashboard", "grafana", "alerts" | Monitoring and Grafana |
| "broken", "down", "error", "crash" | Troubleshoot (below) |
| "backup", "restore" | Back up and restore |
| "upgrade ironflow version", "upgrade nats" | Upgrade Ironflow or NATS |
| "security", "rotate secrets", "rotate master key" | Rotate the master key |
| "which size", "right size" | Choose a size, start a stack |

---

## Troubleshoot

`<file>` below is the compose file the stack runs, such as `docker-compose.starter.yml`.

### A container restarts or does not start

```bash
docker compose -f <file> ps
docker compose -f <file> logs --tail=50 <service>
```

Common causes:

- `set it in .env (new install - run ./init-env.sh)`: a required key is empty. On a new
  install, run `./init-env.sh`. On an upgraded stack, add the key to `.env` by hand from
  `.env.example`. Do not run `init-env.sh` again.
- PostgreSQL or NATS unreachable. Check that service's state and logs first.
- `external NATS requires PostgreSQL` and the other startup errors: see the "Troubleshooting"
  section of the Compose page.
- A port already in use. The sizes share host ports, so run one size per host. Set
  `POSTGRES_HOST_PORT` or `S3_HOST_PORT` in `.env` when another service holds `5432` or `8333`.

A missing master key is only a log warning on a single node, never a crash cause. There is
no license check: the Ironflow License runs on the honor system, so "invalid license" is never the
answer.

### NATS quorum loss (Cluster, HA)

Symptoms: event processing stops, workers disconnect, the dashboard goes stale.

```bash
docker compose -f <file> ps
for n in nats-1 nats-2 nats-3; do   # HA: add nats-4 nats-5
  docker compose -f <file> exec -T $n wget -q --spider http://localhost:8222/healthz && echo "$n ok"
done
```

Cluster needs 2 of its 3 servers healthy to write, and HA needs 3 of 5. Start a stopped server with `docker compose -f <file> up -d --no-deps nats-2`, one server at a time,
and wait for its `/healthz` before the next. Never recreate every NATS container at once.

### PostgreSQL connection exhaustion

Symptoms: 500s on all API calls, "connection pool exhausted".

```bash
docker compose -f <file> exec -T postgres psql -U ironflow -d ironflow -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
```

In HA, run it on `pg-1` with `-U postgres`. Each Ironflow node opens up to 25 connections by
default, so three nodes need about 75.

### Image pull fails

The image `ghcr.io/sahina/ironflow-releases` is public and needs no login. Check that
`VERSION` (single node) or `IRONFLOW_IMAGE` (Starter, Cluster, HA) in `.env` names a published
tag, and that the host can reach `ghcr.io`.

---

## Pre-production checklist

- [ ] A copy of `.env` kept outside the host (it holds the master key)
- [ ] `IRONFLOW_MASTER_KEY` set (the single-node file runs without one and stores secrets unencrypted)
- [ ] The compose files cloned from a release tag, not `main`
- [ ] A TLS-terminating proxy in front of the entry port (the Compose files serve plain HTTP)
- [ ] Grafana admin password changed before the stack is reachable beyond localhost
- [ ] A backup taken and a restore tested

## Post-deploy checklist

- [ ] `docker compose -f <file> ps` shows every service healthy
- [ ] `/health` returns 200
- [ ] `/ready` returns 200
- [ ] Dashboard loads
- [ ] `ironflow emit test.ping --data '{}'` succeeds

## Pre-scale checklist

- [ ] A recent backup exists
- [ ] The new size starts on new volumes: plan to restore the dump and set secrets again
- [ ] PostgreSQL `max_connections` exceeds `nodes * 25`
