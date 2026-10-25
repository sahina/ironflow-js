# Ironflow Platform Operations

Provision, deploy, scale, monitor, troubleshoot, and recover Ironflow deployments.

This file holds the routing and the troubleshooting. The procedures live in the hosted
docs. Fetch the page before you run commands. Do not work from memory.

## Rules for the agent

- Most self-hosters are not on Kubernetes. Ask which deployment the user runs before any `kubectl`.
- `NO_CONTEXT` from `kubectl config current-context` is not a fault. It usually means Docker Compose or a single binary.
- On Kubernetes, pull the chart and pass `--chart ./ironflow` to `ironflow deploy`. Outside an engine checkout, it fails with "helm chart directory not found". Pull the chart as in <https://docs.ironflow.run/how-to-guides/deployment/kubernetes.md>.
- Pass `blobs.url`, `ironflow.masterKey` and any `postgresql.objectStore.destinationPath` you set on every install and every upgrade. A rerun that omits them renders from the values you pass, so the backup path returns to its default. Read <https://docs.ironflow.run/how-to-guides/deployment/helm-chart.md> (section "Carry `masterKey` on every upgrade").
- Examples below use release `ironflow` in namespace `ironflow`. Run `kubectl get all -n <ns>` for the real names.

## Step 0: Which deployment is this?

| Signal | Deployment | Where to go |
|---|---|---|
| `docker ps` shows an `ironflow` container | Docker Compose | Docker Compose row in "Where the procedures live" |
| The user ran `ironflow deploy vps`, or the host has `/opt/ironflow` | Single VPS | Single VPS row in "Where the procedures live" |
| `ironflow serve --dev` in a terminal, SQLite file | Local single binary | Nothing to operate. See `debug.md` |
| `kubectl config current-context` returns a context with ironflow pods | Kubernetes | Step 1 onward |

```bash
docker ps --filter name=ironflow --format '{{.Names}}  {{.Status}}' | grep . || echo "NO_COMPOSE"
```

Plain `docker compose ps` fails in the release-mirror directories. They hold only named
files, such as `docker-compose.single-node.yml`. Every compose command needs `-f <file>`.

## Where the procedures live

Fetch the page with `WebFetch`. In Ironflow Desktop's built-in agent, use `docs_fetch`.
Each URL returns one page as Markdown. Read the section named in the last column.

| Operation | URL | Sections |
|---|---|---|
| Docker Compose: sizes, start, upgrade, backups | https://docs.ironflow.run/how-to-guides/deployment/docker-compose.md | "Choose a size", "Start Starter, Cluster or HA", "Start a single node", "Log in and create an API key", "Pin and upgrade a version", "Data and backups" |
| Single VPS: deploy, re-run, upgrade, backup | https://docs.ironflow.run/reference/cli/commands/deploy.md | "`ironflow deploy vps`", "Backup and restore" |
| Provision a cluster (k3d, Hetzner) | https://docs.ironflow.run/reference/cli/commands/provision.md | "`ironflow provision create`", "`ironflow provision destroy`" |
| Hetzner Cloud, end to end | https://docs.ironflow.run/how-to-guides/deployment/hetzner-cloud.md | "Step 3: Choose a template and node sizes", "Kubernetes cluster sizing", "Step 5: Create the secrets", "Step 6: Deploy Ironflow" |
| Kubernetes install: cluster, chart, secrets, deploy | https://docs.ironflow.run/how-to-guides/deployment/kubernetes.md | "1. Get a cluster" to "4. Deploy", then "5. Sign in" for the first admin key and dashboard login |
| Choose a template (Small, Medium, Large), workload fit | https://docs.ironflow.run/how-to-guides/deployment/overview.md | "Deployment Templates" |
| Deploy command and flags | https://docs.ironflow.run/reference/cli/commands/deploy.md | "`ironflow deploy` (initial deploy)", "`ironflow deploy upgrade`", "`ironflow deploy status`" |
| Helm values, Small and Medium resource defaults, `masterKey` | https://docs.ironflow.run/how-to-guides/deployment/helm-chart.md | "What the chart runs", "Carry `masterKey` on every upgrade" |
| Scale pods, NATS, PostgreSQL, workers | https://docs.ironflow.run/how-to-guides/deployment/scenarios/scaling.md | the section for the component |
| Multi-tenant: add a tenant | https://docs.ironflow.run/how-to-guides/deployment/kubernetes.md | "Multi-tenant deployment" |
| Multi-tenant: upgrade or remove a tenant | https://docs.ironflow.run/how-to-guides/deployment/scenarios/deployment.md | "Upgrade a single tenant", "Remove a tenant" |
| Multi-tenant: resize a tenant | https://docs.ironflow.run/how-to-guides/deployment/scenarios/scaling.md | "Scale a tenant's resources" |
| Health checks, logs | https://docs.ironflow.run/how-to-guides/deployment/kubectl-operations.md | "Health checks", "Logs", "Monitoring operations" |
| First admin key, dashboard login (Kubernetes) | https://docs.ironflow.run/how-to-guides/deployment/kubernetes.md | "5. Sign in" |
| Alerts and Grafana | https://docs.ironflow.run/how-to-guides/deployment/scenarios/alerts-monitoring.md | "First alert fires in Slack, now what?", "False alert: tune or silence" |
| Backup, restore, rebuild | https://docs.ironflow.run/how-to-guides/deployment/scenarios/disaster-recovery.md | the whole page |
| Volume full, quorum loss, PostgreSQL failover, tenant quota, network isolation | https://docs.ironflow.run/how-to-guides/deployment/scenarios/failure-recovery.md | the section for the failure, such as "Persistent volume full (NATS or PostgreSQL)" or "Cross-tenant network leak diagnosis" |
| Upgrade Ironflow, change template, roll back | https://docs.ironflow.run/how-to-guides/deployment/kubernetes.md | "Upgrade" |
| Roll back a bad deployment | https://docs.ironflow.run/how-to-guides/deployment/scenarios/deployment.md | "Rollback a bad deployment" |
| Rotate keys and passwords | https://docs.ironflow.run/how-to-guides/deployment/scenarios/security-access.md | the "Rotate ..." sections |
| API key commands | https://docs.ironflow.run/reference/cli/commands/apikey.md | "`ironflow apikey rotate`" |
| Hetzner server sizes and cluster sizing | https://docs.ironflow.run/how-to-guides/deployment/hetzner-cloud.md | "Kubernetes cluster sizing" |

If no row matches, fetch https://docs.ironflow.run/llms.txt and pick the page from it.

---

## Step 1: Detect Current Context (Kubernetes)

```bash
echo "=== CONTEXT ==="
kubectl config current-context 2>/dev/null || echo "NO_CONTEXT"
echo "=== NODES ==="
kubectl get nodes -o wide 2>/dev/null | head -10 || echo "NO_NODES"
echo "=== HELM ==="
helm list -A 2>/dev/null | grep -i ironflow || echo "NO_RELEASES"
echo "=== IRONFLOW PODS ==="
kubectl get pods -A -l app.kubernetes.io/name=ironflow 2>/dev/null | head -15 || echo "NO_PODS"
echo "=== NATS PODS ==="
kubectl get pods -A -l app.kubernetes.io/name=nats 2>/dev/null | head -10 || echo "NO_NATS"
echo "=== PG ==="
kubectl get cluster -A 2>/dev/null | head -10 || echo "NO_PG"
```

Parse for provider (k3d / Hetzner) and template (small / medium / large). If everything
returns NO_*, they are probably not on Kubernetes at all — go back to Step 0 rather than
trying to fix the "missing" cluster.

## Step 2: Match Operation

| User says | Go to |
|---|---|
| "docker compose", "compose", "self-host" | "Where the procedures live": Docker Compose |
| "single VPS", "one box", "deploy over SSH" | "Where the procedures live": Single VPS |
| "provision", "create cluster", "set up k3d/hetzner" | "Where the procedures live": Provision a cluster |
| "deploy", "install", "helm install" | "Where the procedures live": Kubernetes install |
| "scale", "add replicas", "more nodes" | "Where the procedures live": Scale |
| "tenant", "multi-tenant", "namespace" | "Where the procedures live": Multi-tenant |
| "monitor", "dashboard", "grafana", "alerts" | "Where the procedures live": Health checks, Alerts |
| "broken", "down", "error", "crash" | Troubleshoot (below) |
| "backup", "restore", "PITR" | "Where the procedures live": Backup, restore |
| "upgrade cluster", "upgrade ironflow version" | "Where the procedures live": Upgrade |
| "security", "rotate secrets" | "Where the procedures live": Rotate keys |
| "RBAC", "permissions" | https://docs.ironflow.run/how-to-guides/deployment/helm-chart.md, section "Key design decisions" |
| "which template", "right size" | "Where the procedures live": Choose a template |

---

## Troubleshoot

### CrashLoopBackOff

```bash
kubectl logs -n ironflow <pod> --tail=50 --previous
```

Common causes: PG unreachable (check pods; the URL is in `ironflow-postgresql-app`, key
`uri`), NATS unreachable, port conflict. A missing master key is only a log warning, never a
crash cause.

`multi-node deployment requires an s3:// blobs.url` in the log: the release has no
`blobs.url`. The current chart fails at render time instead, so this error means an older
chart or a values file that dropped `blobs.url`. Set `blobs.url` and upgrade. The Kubernetes page above shows the full flag set.

There is no license check — Ironflow is FSL-1.1 on the honor system, so "invalid license"
is never the answer.

### NATS Quorum Loss

Symptoms: event processing stops, workers disconnect, dashboard stale.

```bash
kubectl get pods -n ironflow -l app.kubernetes.io/name=nats
kubectl exec -n ironflow ironflow-nats-0 -c nats -- \
  wget -qO- http://localhost:8222/routez | jq '.num_routes'   # need >= 2
kubectl exec -n ironflow ironflow-nats-0 -c nats -- \
  wget -qO- http://localhost:8222/jsz | jq '.meta.leader'

# Fix
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set nats.config.cluster.replicas=3
```


### PG Connection Exhaustion

Symptoms: 500s on all API calls, "connection pool exhausted".

```bash
kubectl exec -n ironflow ironflow-postgresql-1 -- \
  psql -U ironflow -d ironflow -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

kubectl get pods -n ironflow -l cnpg.io/poolerName=ironflow-pg-pooler

# Fix
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set postgresql.pooler.instances=3
```


### ImagePullBackOff

The image `ghcr.io/sahina/ironflow-releases` is public. The cluster needs no pull secret.

```bash
kubectl describe pod -n ironflow <pod> | grep -A5 "Events:"
kubectl get pod -n ironflow <pod> -o jsonpath='{.spec.containers[0].image}'
```

Common causes: a wrong `image.repository` or `image.tag` set by hand, a node with no route
to `ghcr.io`, or a registry mirror that blocks the image.

### Ingress TLS Not Issuing

```bash
kubectl get certificate -n ironflow
kubectl describe certificate <name> -n ironflow
kubectl get clusterissuer   # letsencrypt-prod-ironflow; the TLS Secret is ironflow-tls
nslookup your-domain.com
kubectl logs -n cert-manager -l app=cert-manager --tail=50
```

### LB Stuck in Pending

```bash
kubectl get pods -n kube-system | grep cloud-controller
kubectl get svc -n traefik traefik
kubectl get secret -n kube-system hcloud-token -o yaml

# Force refresh — WARNING: releases LB IP, breaks DNS
kubectl delete svc traefik -n traefik
```

### General

```bash
kubectl get all -n ironflow
kubectl get events -n ironflow --sort-by='.lastTimestamp' | tail -20
kubectl top pods -n ironflow
kubectl top nodes
```

---

## Pre-Production Checklist

- [ ] DNS A record → LB IP
- [ ] TLS ClusterIssuer (`letsencrypt-prod-<release>`, created by the chart, or your own)
- [ ] `blobs.url` set (required) and the blob bucket exists
- [ ] `ironflow-s3-creds` Secret in the release namespace (backups and blobs)
- [ ] `HETZNER_S3_ENDPOINT`, `HETZNER_S3_BUCKET` env vars (optional, set the backup destination)
- [ ] Master key backed up (needed for cluster rebuild and passed on every upgrade)
- [ ] With `--hetzner-location`: `alertmanager-slack`, `healthchecks-io`, `grafana-admin` in `monitoring`
- [ ] Grafana password noted
- [ ] AlertManager configured (Slack/Healthchecks)
- [ ] Medium or Large template (NEVER Small for prod)
- [ ] Backup schedule verified

## Post-Deploy Checklist

- [ ] All pods Running (no Pending/CrashLoop)
- [ ] `/health` returns 200
- [ ] `/ready` returns 200
- [ ] Dashboard loads
- [ ] NATS routes count expected
- [ ] PG `pg_isready` OK
- [ ] Prometheus targets show ironflow UP
- [ ] HTTPS request to ingress succeeds
- [ ] `ironflow emit test.ping --data '{}'` succeeds

## Pre-Scale Checklist

- [ ] Recent backup exists
- [ ] NATS replica count stays odd and at least 3 (two replicas tolerate no failure)
- [ ] PVC expansion supported (`allowVolumeExpansion`)
- [ ] PG connection pool: `replicaCount * 25` < `max_connections`
- [ ] PgBouncer enabled (medium, scaling > 3 replicas)
- [ ] HPA limits appropriate (large)
- [ ] Node capacity headroom (`kubectl top nodes`)
