# Ironflow Platform Operations

Provision, deploy, scale, monitor, troubleshoot, and recover Ironflow deployments.

> **Most of this file is Kubernetes. Most self-hosters are not on Kubernetes.**
> The primary documented self-host path is **Docker Compose** (see below); Kubernetes is
> for users who want HA, autoscaling, or an existing cluster. Ask which one they're on
> before running any `kubectl`. A "NO_CONTEXT" result is not a problem to fix — it usually
> means they're on compose or a single binary.
>
> Not covered here on purpose: Ironflow Cloud's own infrastructure (single Hetzner VPS +
> systemd + OpenTofu, no k8s). That's internal ops.

> **On Kubernetes, install from the published chart.** The chart, its template values
> files and the image `ghcr.io/sahina/ironflow-releases` are public. The cluster needs no
> image pull secret. Pull the chart version that matches the `ironflow` binary:
>
> ```bash
> helm pull oci://ghcr.io/sahina/charts/ironflow --version <version> --untar   # creates ./ironflow
> ```
>
> Commands below use `./ironflow` as the chart and `ironflow/values-<template>.yaml` as the
> values file. `ironflow deploy` finds a chart by itself only inside an Ironflow engine
> checkout. Anywhere else it fails with "helm chart directory not found", so pass
> `--chart ./ironflow`.
>
> **Every install needs `blobs.url` and `ironflow.masterKey`.** `blobs.url` is an
> `s3://<bucket>?endpoint=https://<s3-endpoint>&region=<region>` URL with no path after the
> bucket. The chart fails to render without it. A rerun of `ironflow deploy` or
> `helm upgrade -f` renders from the values you pass, so pass both values again each time.
> For a small change, use `helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set ...`
> with no `-f`. Details and the masterKey warning:
> <https://docs.ironflow.run/how-to-guides/deployment/helm-chart/#carry-masterkey-on-every-upgrade>.
>
> Examples use release `ironflow` in namespace `ironflow`. The chart then names resources
> `ironflow`, `ironflow-secret`, `ironflow-nats-0`, `ironflow-postgresql` and so on. With a
> release name that does not contain "ironflow", every name gets the prefix `<release>-ironflow`.
> Run `kubectl get all -n <ns>` for the real names.

## Step 0: Which deployment is this?

| Signal | Deployment | Where to go |
|---|---|---|
| `docker compose ps` shows an `ironflow` service | Docker Compose | Docker Compose section |
| `ironflow serve --dev` in a terminal, SQLite file | Local single binary | Nothing to operate — see `debug.md` |
| `kubectl config current-context` returns a context with ironflow pods | Kubernetes | Step 1 onward |

```bash
docker compose ps 2>/dev/null | grep -i ironflow || echo "NO_COMPOSE"
```

---

## Docker Compose (primary self-host path)
<!-- derived-from: docs/how-to-guides/deployment/docker-compose.mdx#start-a-single-node -->

Runs from the public release mirror — no source access needed:

```bash
git clone https://github.com/sahina/ironflow-releases
cd ironflow-releases/deploy/docker-compose
docker compose -f docker-compose.single-node.yml --profile postgres up -d
```

That starts PostgreSQL, but Ironflow keeps using SQLite until `IRONFLOW_DATABASE_URL` is set. Before the `up`, put `POSTGRES_PASSWORD`, `IRONFLOW_DATABASE_URL` (`postgres://ironflow:<password>@postgres:5432/ironflow?sslmode=disable`) and `IRONFLOW_MASTER_KEY` in a `.env` next to the file.

Day-to-day:

```bash
docker compose ps                        # service state
docker compose logs -f ironflow          # engine logs
docker compose restart ironflow          # restart after config change
docker compose down                      # stop (volumes persist)
docker compose pull && docker compose up -d   # upgrade to a newer image
```

Health is the same as anywhere: `curl -s localhost:9123/health` and `/ready` (both
unauthenticated). Everything under `/api/` needs `IRONFLOW_API_KEY` unless the container
runs with `--dev`.

A cluster in Compose (Starter: 1 node; Cluster: 3 nodes and 3 NATS; HA: adds PostgreSQL
failover) starts from the `cluster/` directory after `./init-env.sh` writes `.env`:

```bash
cd ironflow-releases/deploy/docker-compose/cluster
./init-env.sh                                       # prints the admin key and dashboard login
docker compose -f docker-compose.starter.yml up -d  # or docker-compose.cluster.yml / docker-compose.ha.yml
```

For the full walkthrough (sizes, env vars, login, upgrades, backups),
see <https://docs.ironflow.run/how-to-guides/deployment/docker-compose/>.

---

## Single VPS (`ironflow deploy vps`)

The same compose stack, driven remotely over SSH — no Kubernetes, no Helm, no chart
checkout. It uploads a generated Ironflow + PostgreSQL compose stack (plus Caddy for TLS
when `--domain` is set), installing Docker on the host if missing. Re-running preserves
existing secrets and keeps the engine already on the host — omitting `--version` reuses
the deployed tag, skips the image pull, and pins the compose file to the running
container's digest, so a re-run to change `--port` does not upgrade anything and the box
cannot drift forward on its own. Pass `--version latest` to upgrade, which drops the pin. If the host's compose file is unreadable the command stops instead of guessing a tag.

```bash
ironflow deploy vps --host root@1.2.3.4 --domain flow.example.com --email me@example.com
ironflow deploy vps --host root@1.2.3.4                    # no TLS, publishes :9123
ironflow deploy vps --host root@1.2.3.4 --version 0.20.0   # pin an image tag
ironflow deploy vps --host root@1.2.3.4 --version latest   # upgrade the engine
ironflow deploy vps --host root@1.2.3.4 -i ~/.ssh/id_ed25519
```

`--domain` needs its DNS A record already pointing at the host, and pointing *only* there —
one extra address (a leftover proxy record, a stale AAAA) intercepts the ACME challenge no
matter how correct the other record is, and the command warns about that case too. It
resolves the domain before it connects, and once the stack is up it fetches
`https://<domain>/health` from your machine, printing `Ironflow is up at …` only when the
certificate verifies, no redirect is followed, and the body is Ironflow's own health JSON.
A bare 200 is not enough: a parked page or a CDN answers 200 too. The container-level
health wait runs inside the Ironflow container and can never see any of this. Neither
check fails the deploy, because proxied and split-horizon records are legitimate and Caddy
keeps retrying issuance on its own. Dropping `--domain` on a re-run **removes Caddy** — the
command warns, but the TLS endpoint goes away.

Day-to-day operations are the Docker Compose ones above, run over SSH.

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

| User says | Section |
|---|---|
| "docker compose", "compose", "self-host" | Docker Compose |
| "single VPS", "one box", "deploy over SSH" | Single VPS (`ironflow deploy vps`) |
| "provision", "create cluster", "set up k3d/hetzner" | Provision |
| "deploy", "install", "helm install" | Deploy |
| "scale", "add replicas", "more nodes" | Scale |
| "tenant", "multi-tenant", "namespace" | Tenant Management |
| "monitor", "dashboard", "grafana", "alerts" | Monitor |
| "broken", "down", "error", "crash" | Troubleshoot |
| "backup", "restore", "PITR" | Disaster Recovery |
| "upgrade cluster", "upgrade ironflow version" | Upgrade |
| "security", "RBAC", "rotate secrets" | Security |
| "which template", "right size" | Right-sizing |

---

## Provision Clusters

### k3d (local dev)

Prereqs: Docker Desktop, `k3d` CLI.

```bash
ironflow provision create --provider k3d --template small --name dev
ironflow provision create --provider k3d --template medium --name staging
ironflow provision status --provider k3d --name dev
ironflow provision destroy --provider k3d --name dev
```

Kubeconfig: `~/.kube/clusters/k3d-<name>.yaml`

After provisioning, deploy as described in **Deploy**. The cluster pulls the public image
by itself, so no image import is needed.

Limitations: no LB IP (use port-forward), no persistent storage guarantees, no Hetzner
features.

### Hetzner Cloud (production)

Prereqs: `terraform` v1.9+, `HCLOUD_TOKEN` env var. `provision destroy` also needs the `hcloud`
CLI, and `provision status` needs `kubectl` (it does not check that `kubectl` is installed).

```bash
ironflow provision create --provider hetzner --template small --name ironflow
ironflow provision create --provider hetzner --template medium --name ironflow
ironflow provision create --provider hetzner --template large --name ironflow
ironflow provision status --provider hetzner --name ironflow
ironflow provision destroy --provider hetzner --name ironflow
```

What's created: Talos Linux nodes, Cilium CNI, cert-manager, Hetzner CCM, Hetzner CSI,
firewall (port 6443 restricted to provisioning IP).

Kubeconfig: `~/.kube/clusters/hetzner-<name>.yaml`

`provision --name` names the cluster. `ironflow deploy --name` names the Helm release in
whatever cluster kubectl targets. Pass `--kubeconfig` when you work with more than one cluster.

Sharp edges:
- **Firewall locks port 6443 to provisioning IP.** VPN/mobile IP change = locked out.
  Fix in Hetzner Cloud Console.
- **Talos bootstrap is slow.** 30 retries (300s) for TLS bootstrap.
- **Control plane count must be odd** (1, 3, 5) for etcd quorum.

---

## Deploy

### Template Selection
<!-- derived-from: docs/how-to-guides/deployment/overview.md#deployment-templates -->

| Template | Replicas | NATS | PostgreSQL | Use case |
|---|---|---|---|---|
| Small | 1 | Bundled, 1 node | Bundled, 1 instance | Dev, eval |
| Medium | 3 | Bundled, 3-node cluster | Bundled, 2 instances + PgBouncer | Production HA |
| Large | 2-10 (HPA) | External (user) | External (user) | Enterprise |
| Multi-Tenant | 1 per tenant | Bundled, per tenant | Bundled, per tenant | Shared cluster (Helm only) |

These are the Kubernetes (Helm) templates. The Docker Compose sizes are a separate set
with different names (Starter, Cluster, HA); do not mix the two.

### Prerequisites

- An S3-compatible bucket for blobs (one per release), and one for PostgreSQL backups on
  Small, Medium and Multi-Tenant.
- The Secret `ironflow-s3-creds` in the release namespace, keys `ACCESS_KEY_ID` and
  `SECRET_ACCESS_KEY`. Blobs and backups both read it.
- A master key kept outside the cluster.
- With `--hetzner-location`: three Secrets in namespace `monitoring`, created before the
  deploy: `alertmanager-slack` (key `webhook-url`), `healthchecks-io` (key `ping-url`) and
  `grafana-admin` (keys `admin-user`, `admin-password`).

```fish
kubectl create namespace ironflow
kubectl create secret generic ironflow-s3-creds -n ironflow \
  --from-literal=ACCESS_KEY_ID="<access-key>" \
  --from-literal=SECRET_ACCESS_KEY="<secret-key>"
set -x IRONFLOW_MASTER_KEY (openssl rand -hex 32)   # zsh: export IRONFLOW_MASTER_KEY=$(openssl rand -hex 32)
set -x BLOBS_URL 's3://ironflow-blobs?endpoint=https://fsn1.your-objectstorage.com&region=fsn1'   # zsh: export BLOBS_URL='s3://...'
```

### Deploy Commands

```bash
helm pull oci://ghcr.io/sahina/charts/ironflow --version <version> --untar

ironflow deploy --template small --name ironflow --chart ./ironflow \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY

# Production with Hetzner LB (needs the three monitoring Secrets)
ironflow deploy --template medium --name ironflow --chart ./ironflow --hetzner-location fsn1 \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY

# Enterprise (external deps)
ironflow deploy --template large --name ironflow --chart ./ironflow \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY \
  --set externalDatabase.url=postgres://user:pass@host:5432/ironflow \
  --set externalNats.url=nats://nats-cluster:4222

# Custom namespace, or a kubeconfig other than the current context
#   add: --namespace staging
#   add: --kubeconfig ~/.kube/clusters/hetzner-ironflow.yaml
```

`--template` takes `small`, `medium` or `large`. Multi-Tenant is Helm only (see Tenant
Management). Without the CLI, use
`helm install ironflow ./ironflow -n ironflow -f ironflow/values-medium.yaml --set blobs.url=... --set ironflow.masterKey=...`
and install the CNPG operator and the Barman Cloud Plugin first (below).

What happens during deploy:
1. Checks `--name` is set
2. Resolves the chart (`--chart`, or `deploy/helm/ironflow` in an engine checkout)
3. Installs prereqs: cert-manager and kube-prometheus-stack for all templates; CNPG chart
   0.27.1 (operator 1.28) and Barman Cloud Plugin v0.11.0 for small and medium; Traefik with
   `--hetzner-location`
4. With `--hetzner-location`: annotates Traefik for the Hetzner LB and applies a
   kube-prometheus-stack overlay (Prometheus volume, Slack route, Healthchecks ping, Grafana
   admin Secret). Without it, kube-prometheus-stack runs with chart defaults.
5. Sets S3 backup config from `HETZNER_S3_ENDPOINT` and `HETZNER_S3_BUCKET` (backups go to
   `s3://<bucket>/backups`, shared by every release on the bucket). Without them, backups go
   to `s3://ironflow-backups/<release>`.
6. Runs `helm upgrade --install -f values-<template>.yaml`, with no `--reuse-values`

For plain Helm, install the operator and plugin once per cluster (cert-manager first):

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --version 0.27.1 --wait
kubectl apply -f https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.11.0/manifest.yaml
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace --version 72.6.2 --wait
```

Every template puts Grafana dashboards in `monitoring`, and Small and Medium add a NATS
`PodMonitor`, so a plain-Helm install without kube-prometheus-stack fails
(`namespaces "monitoring" not found` / `no matches for kind "PodMonitor"`). Without it, pass
`--set monitoring.dashboards.enabled=false --set nats.promExporter.podMonitor.enabled=false`.

Post-deploy:
```bash
kubectl get pods -n ironflow
kubectl port-forward svc/ironflow -n ironflow 9123:9123 &
curl http://localhost:9123/health
curl http://localhost:9123/ready
open http://localhost:9123
```

For the dashboard login, read the bootstrap key file (see Logs below).

```bash
ironflow deploy status --name ironflow
ironflow deploy status --name ironflow --watch
ironflow deploy delete --name ironflow
```

---

## Scale

### Ironflow Pods

Requires medium/large (small=1 replica).

Scale changes use `--reuse-values` with no `-f`. This keeps `blobs.url` and
`ironflow.masterKey` from the install. `ironflow deploy upgrade` does not reuse values, so
it needs the full flag set from Deploy.

```bash
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set replicaCount=5
```

Large with HPA (2-10 pods at 70% CPU):
```bash
kubectl get hpa ironflow -n ironflow
helm upgrade ironflow ./ironflow -n ironflow --reuse-values \
  --set autoscaling.minReplicas=3 --set autoscaling.maxReplicas=20
```

### NATS Cluster

> **Never scale 3-node NATS below 2 replicas.** Lose quorum → JetStream read-only → all
> event processing stops.

```bash
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set nats.config.cluster.replicas=5

# Verify health
kubectl exec -n ironflow ironflow-nats-0 -c nats -- \
  wget -qO- http://localhost:8222/routez | jq '.num_routes'
```

Expand JetStream storage:
```bash
kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}: {.allowVolumeExpansion}{"\n"}{end}'

# If allowVolumeExpansion=true: patch PVC
kubectl patch pvc ironflow-nats-js-ironflow-nats-0 -n ironflow \
  -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'

# If not supported: must orphan-delete StatefulSet (LOSES JetStream data)
# WARNING: PG is system of record but in-flight events + KV data lost
kubectl delete statefulset ironflow-nats -n ironflow --cascade=orphan
kubectl delete pvc -l app.kubernetes.io/name=nats -n ironflow
helm upgrade ironflow ./ironflow -n ironflow --reuse-values \
  --set nats.config.jetstream.fileStore.pvc.size=20Gi
```

### PostgreSQL

```bash
# Add read replica
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set postgresql.instances=3

# Status
kubectl get cluster -n ironflow
kubectl get pods -n ironflow -l cnpg.io/cluster=ironflow-postgresql -L role

# Manual failover
kubectl cnpg switchover ironflow-postgresql -n ironflow
```

PgBouncer (medium): 2 pods, transaction mode, 25 conn/pod, multiplexes 1000+ clients
through 25 PG connections.

### Hetzner Worker Nodes

`ironflow provision create` writes the shipped tfvars back into `~/.ironflow/terraform/hetzner`
on every run, so an edit there is lost. Override the value on the Terraform command line
instead (`-var` after `-var-file` wins), and keep the cluster name:

```bash
export TF_VAR_hcloud_token=$HCLOUD_TOKEN
terraform -chdir=$HOME/.ironflow/terraform/hetzner apply \
  -var-file=$HOME/.ironflow/terraform/hetzner/terraform.medium.tfvars \
  -var=cluster_name=ironflow -var=worker_count=3
```

Never run a bare `terraform apply`: it uses the default cluster name `ironflow`, asks for the
token, and can plan a replacement. A later `ironflow provision create` applies the template
sizes again.


Joins in ~2 min. Existing pods do NOT redistribute. Force rebalance:
```bash
kubectl rollout restart deployment/ironflow -n ironflow
```

### Scale Down

```bash
helm upgrade ironflow ./ironflow -n ironflow --reuse-values --set replicaCount=1
ironflow provision destroy --provider hetzner --name ironflow   # IRREVERSIBLE
```

---

## Tenant Management (Multi-Tenant)

One Ironflow per tenant per namespace. Each gets own NATS, PG, Ironflow.

```bash
# 1. Namespace
kubectl create namespace tenant-acme

# 2. Secrets
kubectl -n tenant-acme create secret generic ironflow-s3-creds \
  --from-literal=ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  --from-literal=SECRET_ACCESS_KEY="$S3_SECRET_KEY"

# 3. Deploy (chart pulled as in Deploy). Each tenant needs its own blob bucket
#    and its own master key, kept outside the cluster.
helm install acme ./ironflow \
  -n tenant-acme \
  -f ironflow/values-multi-tenant.yaml \
  --set ingress.host=acme.ironflow.example.com \
  --set blobs.url='s3://acme-blobs?endpoint=https://fsn1.your-objectstorage.com&region=fsn1' \
  --set ironflow.masterKey=<acme-master-key>
```

Blob keys start with the environment ID, and every release starts with `env_default`.
Two tenants on one bucket overwrite each other's blobs. With release `acme`, resources are
named `acme-ironflow`, `acme-ironflow-secret` and so on.

Tenant isolation:
- NetworkPolicy default-deny (blocks cross-namespace)
- ResourceQuota: 2/4 CPU, 4Gi/8Gi memory, 50Gi storage, 20 pods
- Allowed namespaces: `traefik` (ingress), `monitoring` (metrics)

Verify isolation:
```bash
kubectl exec -n tenant-acme deploy/acme-ironflow -- \
  wget -qO- --timeout=3 http://globex-ironflow.tenant-globex:9123/health
# Expected: timeout (blocked)
```

Customize per tenant:
```bash
helm upgrade acme ./ironflow -n tenant-acme --reuse-values \
  --set resources.requests.cpu=250m --set postgresql.persistence.size=20Gi
```

Remove tenant:
```bash
helm uninstall acme -n tenant-acme
kubectl delete namespace tenant-acme   # deletes ALL tenant data
```

---

## Monitor

### Grafana

```bash
kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring 3000:80
```

Open `http://localhost:3000`. With `--hetzner-location`, the login is the `grafana-admin`
Secret:

```bash
kubectl get secret grafana-admin -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Without it, kube-prometheus-stack uses chart defaults. Read the admin password from
`kube-prometheus-stack-grafana` in `monitoring`.

The chart ships four dashboards: `ironflow-performance`, `postgres-cnpg`, `nats-monitoring`
and `k8s-infrastructure`. They land in the Grafana General folder.

Alerts are PrometheusRules in the release namespace: `ironflow-alerts`, `ironflow-pg-alerts`
and `ironflow-nats-alerts`. List them with `kubectl get prometheusrules -n ironflow`. These
are the ones you reach for first:

| Alert | Severity | Condition |
|---|---|---|
| IronflowDown | critical | no `up` series for the `<release>-metrics` Service for 2m |
| HighErrorRate | critical | HTTP 5xx rate > 5% for 5m |
| HighRunFailureRate | warning | Run failure rate > 5% for 15m |
| PostgreSQLDown | critical | blackbox probe `target="postgresql"` fails for 2m (only with `monitoring.alerts.blackboxProbes=true`) |
| CNPGReplicationLagHigh | critical | Replay lag > 100MB for 5m |
| NATSDown | critical | blackbox probe `target="nats"` fails for 2m (only with `monitoring.alerts.blackboxProbes=true`) |
| DiskSpaceLow | critical | Volume free < 15% for 5m |
| WorkerDisconnected | warning | Zero workers connected for 5m, after previously having some |

### Health Checks

```bash
# Ironflow
kubectl exec -n ironflow deploy/ironflow -- wget -qO- http://localhost:9123/health
kubectl exec -n ironflow deploy/ironflow -- wget -qO- http://localhost:9123/ready

# NATS cluster
kubectl exec -n ironflow ironflow-nats-0 -c nats -- \
  wget -qO- http://localhost:8222/routez | jq '.num_routes'

kubectl exec -n ironflow ironflow-nats-0 -c nats -- \
  wget -qO- http://localhost:8222/jsz | jq '{memory, storage, streams, consumers}'

# PG
kubectl exec -n ironflow ironflow-postgresql-1 -- pg_isready
kubectl exec -n ironflow ironflow-postgresql-1 -- \
  psql -U ironflow -d ironflow -c "SELECT count(*) FROM pg_stat_activity;"

# Database URL (not in ironflow-secret), or open psql directly
kubectl get secret ironflow-postgresql-app -n ironflow -o jsonpath='{.data.uri}' | base64 -d; echo
kubectl cnpg psql ironflow-postgresql -n ironflow
```

The `nats` CLI needs the bundled NATS token:

```bash
TOKEN=$(kubectl get secret ironflow-nats-auth -n ironflow -o jsonpath='{.data.token}' | base64 -d)
kubectl run nats-box --image=natsio/nats-box -n ironflow -it --rm -- \
  nats --server nats://$TOKEN@ironflow-nats:4222 stream ls
```

### Logs

```bash
kubectl logs -n ironflow -l app.kubernetes.io/component=server --tail=100 -f
kubectl logs -n ironflow -l cnpg.io/cluster=ironflow-postgresql --tail=50
kubectl logs -n ironflow ironflow-nats-0 -c nats --tail=50

# Admin API key and dashboard login on first boot: a key file in the pod, not the log.
# Only one pod writes it, so check every server pod. Copy it, then delete it.
for pod in $(kubectl get pods -n ironflow -l app.kubernetes.io/component=server -o name); do
  kubectl exec -n ironflow $pod -- sh -c 'test -f /tmp/.ironflow_bootstrap_key.json && cat /tmp/.ironflow_bootstrap_key.json'
done
# Then: kubectl exec -n ironflow <pod-that-printed-it> -- rm -f /tmp/.ironflow_bootstrap_key.json
```

### Prometheus

```bash
kubectl port-forward svc/prometheus-operated -n monitoring 9090:9090
```

Useful PromQL:
```
rate(ironflow_http_requests_total[5m])
rate(ironflow_http_requests_total{status_code=~"5.."}[5m]) / rate(ironflow_http_requests_total[5m])
rate(ironflow_runs_total{status="completed"}[5m])
rate(nats_server_sent_msgs_total[5m])
```

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
chart or a values file that dropped `blobs.url`. Set `blobs.url` and upgrade (see Deploy).

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

## Disaster Recovery

### Backup Status

```bash
kubectl get scheduledbackup,backups -n ironflow
kubectl cnpg backup ironflow-postgresql -n ironflow -m plugin --plugin-name barman-cloud.cloudnative-pg.io   # on-demand backup
kubectl get job -n ironflow | grep backup
kubectl get job -n ironflow | grep backup-verify
kubectl logs -n ironflow -l cnpg.io/cluster=ironflow-postgresql -l role=primary --tail=20 | grep -i wal
```

### PITR (Point-in-Time Recovery)

Requires S3 backups configured (Barman Cloud Plugin). Backups use the plugin method, so
restore with a Helm recovery values file. This keeps the Cluster settings (resources, pooler,
monitoring). Release `ironflow`, so the ObjectStore is `ironflow-objectstore` and the
server name is `ironflow-postgresql`.

```bash
# 1. Check that the ObjectStore and backups exist
kubectl get objectstores.barmancloud.cnpg.io -n ironflow
kubectl get backups -n ironflow

# 2. Uninstall the release (keeps the namespace and Secrets), then delete leftover PVCs
helm uninstall ironflow -n ironflow
kubectl delete pvc -n ironflow -l cnpg.io/cluster=ironflow-postgresql

# 3. Recovery values. Remove recoveryTarget to restore to the latest point.
cat <<EOF > recovery.yaml
postgresql:
  recovery:
    source: origin
    recoveryTarget:
      targetTime: "2026-04-05T10:30:00Z"
    externalClusters:
      - name: origin
        plugin:
          name: barman-cloud.cloudnative-pg.io
          parameters:
            barmanObjectName: ironflow-objectstore
            serverName: ironflow-postgresql
EOF

# 4. Reinstall with the ORIGINAL master key and the same blobs.url
helm install ironflow ./ironflow -n ironflow \
  -f ironflow/values-medium.yaml -f recovery.yaml \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY

# 5. Watch until the Cluster is healthy
kubectl get cluster ironflow-postgresql -n ironflow -w
```

### NATS Recovery

> NATS is NOT system of record — PostgreSQL is. NATS holds transient streams + KV.

If lost:
- JetStream streams auto-recreate on Ironflow startup
- KV must be re-set (secrets, config)
- In-flight events may be lost (PG-persisted ones safe)

```bash
kubectl rollout restart statefulset ironflow-nats -n ironflow

# Nuclear (loses all NATS data)
kubectl delete pvc -l app.kubernetes.io/name=nats -n ironflow
kubectl rollout restart statefulset ironflow-nats -n ironflow
```

### Full Cluster Rebuild

```bash
ironflow provision destroy --provider hetzner --name ironflow
ironflow provision create --provider hetzner --template medium --name ironflow
# Re-create the namespace secrets first: ironflow-s3-creds, and the three monitoring Secrets
# if you use --hetzner-location. Keep the ORIGINAL master key.
helm pull oci://ghcr.io/sahina/charts/ironflow --version <version> --untar
ironflow deploy --template medium --name ironflow --chart ./ironflow --hetzner-location fsn1 \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY
# To restore PG from S3, install with the recovery values (PITR steps above)
# Re-set application secrets via `ironflow secret set`
```

### What Auto-Recovers

| Component | Auto | Notes |
|---|---|---|
| JetStream streams | YES | Recreates on startup |
| NATS KV (config, secrets) | EMPTY | Values must re-set |
| PG schema | YES | Auto-migrated |
| PG data | NO | Backup restore |
| Master encryption key | NO | Pass `ironflow.masterKey` at deploy |
| S3 credentials | NO | `ironflow-s3-creds` Secret pre-deploy |
| Helm release state | NO | Re-deploy |

---

## Upgrade Paths

### Ironflow Version

```bash
helm pull oci://ghcr.io/sahina/charts/ironflow --version <new-version> --untar --destination new
ironflow deploy upgrade --template medium --name ironflow --chart ./new/ironflow \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY
# Or with Helm
helm upgrade ironflow ./new/ironflow -n ironflow -f new/ironflow/values-medium.yaml \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=$IRONFLOW_MASTER_KEY
```

The chart version sets the image tag. Both forms render from the values you pass, so repeat
every value from the install. Prereqs auto-reinstall with `ironflow deploy` (CNPG,
kube-prometheus-stack).

### Rollback

```bash
helm history ironflow -n ironflow
helm rollback ironflow -n ironflow                 # to previous
helm rollback ironflow 3 -n ironflow               # to specific revision
```

> Helm rollback restores binary, NOT DB schema. Migrations are forward-only and some drop
> columns or tables (038, 039, 080, 083), so a rollback across one of those needs a DB restore.

### Template Switch (Small → Medium)

> CANNOT simply `helm upgrade` from small to medium. NATS StatefulSet changes 1→3 replicas
> with clustering, and `volumeClaimTemplates` are immutable in K8s.

Procedure:
1. Verify recent PG backup
2. Export NATS KV: `ironflow secret list` + `ironflow secret get <key>`
3. `helm uninstall ironflow -n ironflow`
4. `kubectl delete pvc -l app.kubernetes.io/name=nats -n ironflow`
5. `ironflow deploy --template medium --name ironflow --chart ./ironflow ...` with the full flag set from Deploy
6. Restore PG from backup (if bundled PG was deleted)
7. Re-set secrets

### CNPG Operator

Installed as Helm release `cnpg` (chart `cnpg/cloudnative-pg` 0.27.1, operator 1.28,
deployment `cnpg-cloudnative-pg` in `cnpg-system`). `ironflow deploy upgrade` re-applies the
pinned prereq versions; do not `kubectl apply` the upstream manifest over it (field-manager conflicts).

```bash
kubectl get deployment cnpg-cloudnative-pg -n cnpg-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

---

## Security

### Network Isolation

```bash
# NetworkPolicy is on only in Large and Multi-Tenant
kubectl get networkpolicy -n tenant-acme
kubectl get networkpolicy acme-ironflow-default-deny -n tenant-acme -o yaml

# Test
kubectl exec -n tenant-acme deploy/acme-ironflow -- \
  wget -qO- --timeout=3 http://globex-ironflow.tenant-globex:9123/health
# Expected: timeout (blocked)
```

### RBAC

```bash
kubectl auth can-i --list --as=system:serviceaccount:ironflow:ironflow -n ironflow
kubectl get clusterrolebinding | grep ironflow
```

### Secret Rotation

```bash
# Master key: Helm value ironflow.masterKey, stored in <release>-secret.
# Pass the same key on every upgrade (see Deploy). A different key cannot decrypt
# secrets stored under the old one, so set them again after a change.
helm upgrade ironflow ./ironflow -n ironflow -f ironflow/values-medium.yaml \
  --set blobs.url=$BLOBS_URL --set ironflow.masterKey=<new-key>

# API keys — rotate keeps the same key record and returns a new value
ironflow apikey rotate <key-id> --json
# or issue a separate key (name is positional, not --name), then retire the old one:
ironflow apikey create new-key
ironflow apikey delete <old-key-id>
```

---

## Right-sizing

| Workload | Template | Why |
|---|---|---|
| Local dev/test | Small on k3d | Free, disposable |
| Staging, small team | Small on Hetzner | Real infra, cheap |
| Production single-tenant | Medium on Hetzner | HA, NATS cluster, PG failover |
| Production multi-tenant | Medium + multi-tenant values | Per-tenant isolation |
| Enterprise managed deps | Large + external NATS/PG | HPA, RDS/CloudSQL |
| Load testing | Medium/Large on k3d | Test scaling locally |

When to upgrade:
- **Small → Medium:** any production workload (HA, PG failover, NATS clustering)
- **Medium → Large:** outgrow bundled deps, need HPA, want managed DB

Resource estimates:

| Template | Ironflow CPU | Memory | PG | NATS |
|---|---|---|---|---|
| Small | 100m | 256-512Mi | 5Gi | 2Gi (chart default) |
| Medium | 750m (3x250m) | 1.5-3Gi | 10Gi | 30Gi (3x10Gi) |
| Large | HPA | HPA | External | External |

Hetzner servers (current pricing: hetzner.com/cloud):

| Type | vCPU | RAM | Used for |
|---|---|---|---|
| cpx22 | 3 | 4GB | Control plane (all templates); workers on medium |
| cpx32 | 4 | 8GB | Workers on small and large |
| cpx42 | 8 | 16GB | High-throughput workers (upgrade, not a default) |

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
- [ ] NATS quorum safe (never below 2 of 3)
- [ ] PVC expansion supported (`allowVolumeExpansion`)
- [ ] PG connection pool: `replicaCount * 25` < `max_connections`
- [ ] PgBouncer enabled (medium, scaling > 3 replicas)
- [ ] HPA limits appropriate (large)
- [ ] Node capacity headroom (`kubectl top nodes`)
