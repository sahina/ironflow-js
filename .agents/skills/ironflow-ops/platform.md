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

> **On Kubernetes without an Ironflow source checkout, use the published chart:**
>
> ```bash
> helm install ironflow oci://ghcr.io/sahina/charts/ironflow
> helm install ironflow oci://ghcr.io/sahina/charts/ironflow --version <chart-version>
> ```
>
> `ironflow deploy` and `ironflow provision` are **repo-local wrappers**: they resolve the
> chart from `deploy/helm/ironflow` relative to the working directory
> (`cmd/ironflow/deploy_helpers.go:30`) and fail with "helm chart directory not found"
> anywhere else. Pass `--chart <path>` at a chart you pulled yourself, or drive Helm
> directly against the OCI chart. Every raw `helm ... ./deploy/helm/ironflow` command
> below has the same requirement — substitute
> `oci://ghcr.io/sahina/charts/ironflow` when you have no checkout.

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
<!-- derived-from: docs/how-to-guides/deployment/self-hosting.mdx#quick-start -->

Runs from the public release mirror — no source access needed:

```bash
git clone https://github.com/sahina/ironflow-releases
cd ironflow-releases/deploy/docker-compose
docker compose -f docker-compose.single-node.yml --profile postgres up -d
```

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

For the full walkthrough (env vars, volume permissions, NATS persistence, PG profile),
see <https://docs.ironflow.run/how-to-guides/deployment/self-hosting/>.

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

After provisioning, pull the published image rather than building one — `docker build .`
needs the Ironflow source tree, which an installed-binary user does not have:

```bash
docker pull ghcr.io/sahina/ironflow-releases:latest
k3d image import ghcr.io/sahina/ironflow-releases:latest -c dev
helm install ironflow oci://ghcr.io/sahina/charts/ironflow \
  --set image.repository=ghcr.io/sahina/ironflow-releases --set image.tag=latest
```

(From a source checkout, `docker build -t ironflow:local .` + `ironflow deploy --template
small --name dev --set image.repository=ironflow --set image.tag=local` still works.)

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

Kubeconfig:
- Workspace: `deploy/terraform/hetzner/kubeconfig` (gitignored)
- Durable: `~/.kube/clusters/hetzner-<name>.yaml`

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

### Deploy Commands

```bash
ironflow deploy --template small --name dev

# Production with Hetzner LB
ironflow deploy --template medium --name prod --hetzner-location fsn1

# Enterprise (external deps)
ironflow deploy --template large --name prod \
  --set externalDatabase.url=postgres://user:pass@host:5432/ironflow \
  --set externalNats.url=nats://nats-cluster:4222

# Custom namespace
ironflow deploy --template medium --name staging --namespace staging

# With kubeconfig
ironflow deploy --template medium --name prod \
  --kubeconfig ~/.kube/clusters/hetzner-ironflow.yaml
```

What happens during deploy:
1. Checks `--name` is set
2. Resolves chart from `deploy/helm/ironflow/`
3. Installs prereqs (cert-manager, kube-prometheus-stack; CNPG operator + Barman Cloud for small/medium; Traefik if Hetzner)
4. Annotates Traefik for Hetzner LB (if `--hetzner-location`)
5. Builds NATS subchart
6. Auto-injects S3 config from `HETZNER_S3_ENDPOINT`, `HETZNER_S3_BUCKET`
7. `helm upgrade --install`

Post-deploy (object names below assume release name `ironflow`; with `--name prod` the
chart renders `prod-ironflow`, `prod-nats-0`, `prod-ironflow-postgresql` — see
`kubectl get all -n <ns>` for the real names):
```bash
kubectl get pods -n ironflow
kubectl port-forward svc/ironflow -n ironflow 9123:9123 &
curl http://localhost:9123/health
curl http://localhost:9123/ready
open http://localhost:9123
```

```bash
ironflow deploy status --name prod
ironflow deploy status --name prod --watch
ironflow deploy delete --name prod
```

---

## Scale

### Ironflow Pods

Requires medium/large (small=1 replica).

```bash
ironflow deploy upgrade --template medium --name prod --set replicaCount=5
# Or directly via Helm
helm upgrade ironflow deploy/helm/ironflow/ -n ironflow --reuse-values --set replicaCount=5
```

Large with HPA (2-10 pods at 70% CPU):
```bash
kubectl get hpa ironflow -n ironflow
ironflow deploy upgrade --template large --name prod \
  --set autoscaling.minReplicas=3 --set autoscaling.maxReplicas=20
```

### NATS Cluster

> **Never scale 3-node NATS below 2 replicas.** Lose quorum → JetStream read-only → all
> event processing stops.

```bash
ironflow deploy upgrade --template medium --name prod --set nats.config.cluster.replicas=5

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
ironflow deploy upgrade --template medium --name prod \
  --set nats.config.jetstream.fileStore.pvc.size=20Gi
```

### PostgreSQL

```bash
# Add read replica
ironflow deploy upgrade --template medium --name prod --set postgresql.instances=3

# Status
kubectl get cluster -n ironflow
kubectl get pods -n ironflow -l cnpg.io/cluster=ironflow-postgresql -L role

# Manual failover
kubectl cnpg switchover ironflow-postgresql -n ironflow
```

PgBouncer (medium): 2 pods, transaction mode, 25 conn/pod, multiplexes 1000+ clients
through 25 PG connections.

### Hetzner Worker Nodes

```bash
cd deploy/terraform/hetzner
# Edit terraform.medium.tfvars: worker_count = 3
terraform plan
terraform apply
```

Joins in ~2 min. Existing pods do NOT redistribute. Force rebalance:
```bash
kubectl rollout restart deployment/ironflow -n ironflow
```

### Scale Down

```bash
ironflow deploy upgrade --template medium --name prod --set replicaCount=1
ironflow provision destroy --provider hetzner --name ironflow   # IRREVERSIBLE
```

---

## Tenant Management (Multi-Tenant)

One Ironflow per tenant per namespace. Each gets own NATS, PG, Ironflow.

```bash
# 1. Namespace
kubectl create namespace tenant-acme

# 2. Secrets
kubectl -n tenant-acme create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io --docker-username=$GITHUB_USERNAME --docker-password=$GITHUB_PAT
kubectl -n tenant-acme create secret generic ironflow-s3-creds \
  --from-literal=ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  --from-literal=SECRET_ACCESS_KEY="$S3_SECRET_KEY"

# 3. Deploy
helm install acme ./deploy/helm/ironflow \
  -n tenant-acme \
  -f deploy/helm/ironflow/values-multi-tenant.yaml \
  --set ingress.host=acme.ironflow.example.com \
  --set ironflow.masterKey=$(openssl rand -hex 32)
```

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
helm upgrade acme ./deploy/helm/ironflow -n tenant-acme --reuse-values \
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

kubectl get secret grafana-admin -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Open `http://localhost:3000`, user `admin`.

Dashboards (in `deploy/helm/ironflow/dashboards/`): `ironflow-performance.json`,
`postgres-cnpg.json`, `nats-monitoring.json`, `k8s-infrastructure.json`.

Key alerts (in `deploy/helm/ironflow/templates/{ironflow,pg,nats}-alerts.yaml` — ~30 rules
in all; these are the ones you reach for first):

| Alert | Severity | Condition |
|---|---|---|
| IronflowDown | critical | `absent(up{job=~".*ironflow.*"} == 1)` for 2m |
| HighErrorRate | critical | HTTP 5xx rate > 5% for 5m |
| HighRunFailureRate | warning | Run failure rate > 5% for 15m |
| PostgreSQLDown | critical | blackbox probe fails for 2m |
| CNPGReplicationLagHigh | critical | Replay lag > 100MB for 5m |
| NATSDown | critical | blackbox probe fails for 2m |
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
```

### Logs

```bash
kubectl logs -n ironflow -l app.kubernetes.io/component=server --tail=100 -f
kubectl logs -n ironflow -l cnpg.io/cluster=ironflow-postgresql --tail=50
kubectl logs -n ironflow ironflow-nats-0 -c nats --tail=50

# Admin API key on first boot
kubectl logs -n ironflow $(kubectl get pods -n ironflow \
  -l app.kubernetes.io/component=server -o name | head -1) | grep -A8 "Admin API Key"
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

Common causes: PG unreachable (check pods/conn string), NATS unreachable, port conflict.
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
ironflow deploy upgrade --template medium --name prod --set nats.config.cluster.replicas=3
```


### PG Connection Exhaustion

Symptoms: 500s on all API calls, "connection pool exhausted".

```bash
kubectl exec -n ironflow ironflow-postgresql-1 -- \
  psql -U ironflow -d ironflow -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

kubectl exec -n ironflow deploy/ironflow-pg-pooler-pgbouncer -- \
  psql -U ironflow -d pgbouncer -c "SHOW POOLS;"

# Fix
ironflow deploy upgrade --template medium --name prod --set postgresql.pooler.instances=3
```


### ImagePullBackOff

```bash
kubectl describe pod -n ironflow <pod> | grep -A5 "Events:"
kubectl get secret ghcr-pull-secret -n ironflow

# Recreate
kubectl -n ironflow create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io --docker-username=$GITHUB_USERNAME --docker-password=$GITHUB_PAT
```

### Ingress TLS Not Issuing

```bash
kubectl get certificate -n ironflow
kubectl describe certificate <name> -n ironflow
kubectl get clusterissuer
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
kubectl get scheduledbackup -n ironflow
kubectl get job -n ironflow | grep backup
kubectl get job -n ironflow | grep backup-verify
kubectl logs -n ironflow -l cnpg.io/cluster=ironflow-postgresql -l role=primary --tail=20 | grep -i wal
```

### PITR (Point-in-Time Recovery)

Requires S3 backups configured (Barman Cloud).

```bash
# 1. Scale Ironflow to 0
kubectl scale deployment ironflow -n ironflow --replicas=0

# 2. Delete existing PG cluster
kubectl delete cluster ironflow-postgresql -n ironflow

# 3. Apply recovery cluster YAML
cat <<EOF | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ironflow-postgresql
  namespace: ironflow
spec:
  instances: 2
  storage:
    size: 10Gi
    storageClassName: hcloud-volumes
  bootstrap:
    recovery:
      source: ironflow-postgresql
      recoveryTarget:
        targetTime: "2026-04-05T10:30:00Z"
  externalClusters:
    - name: ironflow-postgresql
      barmanObjectStore:
        destinationPath: "s3://ironflow-backups/backups"
        endpointURL: "https://fsn1.your-objectstorage.com"
        s3Credentials:
          accessKeyId: { name: ironflow-s3-creds, key: ACCESS_KEY_ID }
          secretAccessKey: { name: ironflow-s3-creds, key: SECRET_ACCESS_KEY }
EOF

# 4. Watch
kubectl get cluster ironflow-postgresql -n ironflow -w

# 5. Scale Ironflow back
kubectl scale deployment ironflow -n ironflow --replicas=3
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
ironflow deploy --template medium --name prod --hetzner-location fsn1
# Restore PG from S3 (PITR steps above)
# Re-create K8s secrets (master key, S3 creds)
# Re-set application secrets via `ironflow secret set`
```

### What Auto-Recovers

| Component | Auto | Notes |
|---|---|---|
| JetStream streams | YES | Recreates on startup |
| NATS KV (config, secrets) | EMPTY | Values must re-set |
| PG schema | YES | Auto-migrated |
| PG data | NO | Backup restore |
| Master encryption key | NO | K8s secret pre-deploy |
| S3 credentials | NO | K8s secret pre-deploy |
| Helm release state | NO | Re-deploy |

---

## Upgrade Paths

### Ironflow Version

```bash
ironflow deploy upgrade --template medium --name prod
# Or with explicit chart version
helm upgrade ironflow ./deploy/helm/ironflow -n ironflow \
  -f deploy/helm/ironflow/values-medium.yaml --set image.tag=v0.17.0
```

Prereqs auto-reinstall (CNPG, kube-prometheus-stack).

### Rollback

```bash
helm history ironflow -n ironflow
helm rollback ironflow -n ironflow                 # to previous
helm rollback ironflow 3 -n ironflow               # to specific revision
```

> Helm rollback restores binary, NOT DB schema. Migrations are forward-only and some drop
> columns (038, 039), so a rollback across one of those needs a DB restore.

### Template Switch (Small → Medium)

> CANNOT simply `helm upgrade` from small to medium. NATS StatefulSet changes 1→3 replicas
> with clustering, and `volumeClaimTemplates` are immutable in K8s.

Procedure:
1. Verify recent PG backup
2. Export NATS KV: `ironflow secret list` + `ironflow secret get <key>`
3. `helm uninstall ironflow -n ironflow`
4. `kubectl delete pvc -l app.kubernetes.io/name=nats -n ironflow`
5. `ironflow deploy --template medium --name prod`
6. Restore PG from backup (if bundled PG was deleted)
7. Re-set secrets

### CNPG Operator

Installed as Helm release `cnpg` (chart `cnpg/cloudnative-pg`, deployment
`cnpg-cloudnative-pg` in `cnpg-system`). `ironflow deploy upgrade` re-applies the pinned
prereq versions; do not `kubectl apply` the upstream manifest over it (field-manager conflicts).

```bash
kubectl get deployment cnpg-cloudnative-pg -n cnpg-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

---

## Security

### Network Isolation

```bash
kubectl get networkpolicy -n ironflow
kubectl get networkpolicy ironflow-default-deny -n ironflow -o yaml

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
# Master key — a Helm value (ironflow.masterKey), stored in <release>-secret; rotate via helm
# (rolls the pod). WARNING: any later `helm upgrade` that omits --set ironflow.masterKey
# silently drops encryption — keep it in your values file.
ironflow deploy --template medium --name prod --set ironflow.masterKey=$(openssl rand -hex 32)

# API keys — rotate keeps the same key record and returns a new value
ironflow apikey rotate <key-id> --json
# or issue a separate key (name is positional, not --name), then retire the old one:
ironflow apikey create new-key
ironflow apikey delete <old-key-id>

# ghcr-pull-secret
kubectl delete secret ghcr-pull-secret -n ironflow
kubectl -n ironflow create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io --docker-username=$GITHUB_USERNAME --docker-password=$NEW_PAT
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
- [ ] TLS ClusterIssuer (`letsencrypt-prod` or custom)
- [ ] S3 credentials secret for PG backups
- [ ] `HETZNER_S3_ENDPOINT`, `HETZNER_S3_BUCKET` env vars
- [ ] `ghcr-pull-secret` in target namespace
- [ ] Master key backed up (needed for cluster rebuild)
- [ ] Monitoring namespace + Grafana password noted
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
