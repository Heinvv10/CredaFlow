# Deploying CredaFlow on Kubernetes

One Helm chart, `helm/credaflow/`, for every deployment model. CredaFlow is one instance
and one database per lender (`docs/ARCHITECTURE.md`): a release serves one audience of
one lender. The Docker Compose stacks in `docs/DEPLOY.md` stay the single-host path.

## What the chart deploys

| Object | Purpose |
|---|---|
| `Deployment` web | Next.js server for staff and portal (`web.appMode`: `all`, `staff` or `client`). `CRON_SCHEDULER=off`. Rolling update, `maxUnavailable: 0`, soft spread over nodes and zones. |
| `HorizontalPodAutoscaler` | Web, 2 to 6 replicas on CPU (needs metrics-server). |
| `PodDisruptionBudget` | Web, at most 1 unavailable during node drains. |
| `Deployment` worker | Same image, runs every in-process cron job (`instrumentation.ts`). One replica, `Recreate`. |
| `Job` migrate | Helm `pre-install,pre-upgrade` hook: `prisma migrate deploy` from the `migrator` image. A failed Job fails the release before any pod changes. |
| `NetworkPolicy` | Web ingress from the ingress controller and metrics scraper only; egress to DNS, PostgreSQL and provider ports. |
| `PersistentVolumeClaim` | `/app/uploads` (documents), shared by web and worker, kept on uninstall. |
| `Service`, `Ingress`, `ServiceMonitor` | Optional pieces: Ingress and ServiceMonitor are off by default. |

Pods run as uid 1001, no capabilities, read-only root filesystem, `RuntimeDefault` seccomp.
`/tmp`, `$HOME`, `.next/cache` and `/dev/shm` (Chromium PDF rendering) are `emptyDir`s.

### Why a separate worker

Only the jobs marked `singleRun` in `lib/registry/cron-jobs/` take a database claim
(`CronRunClaim`) so that one replica runs them each day. **Every other in-process job
fires on every replica that schedules it.** Web replicas therefore set
`CRON_SCHEDULER=off`, and the worker is a single replica with the `Recreate` strategy (a
surge pod during a rolling update would be a second scheduler). Cost: cron pauses for the
few seconds a worker restarts; a missed one-minute firing is caught by the next. Never set
`worker` above one replica.

## Images

```bash
docker build -t registry.example/credaflow:$GIT_SHA \
  --build-arg GIT_SHA=$GIT_SHA --build-arg BUILD_TIME=$(date -u +%FT%TZ) \
  --build-arg NEXT_PUBLIC_TENANT_SLUG=<tenant slug> .      # the runner image (last stage)
docker build --target migrator -t registry.example/credaflow-migrate:$GIT_SHA .
```

`NEXT_PUBLIC_*` values are baked in at build time (see the `Dockerfile` ARGs and `.env.example`),
so the image is per lender. Everything else is runtime configuration.

## Install

```bash
kubectl create namespace credaflow
# Variables are documented in docs/DEPLOY-ENV.md. Minimum: DATABASE_URL, AUTH_SECRET, NEXTAUTH_SECRET,
# CRON_SECRET; add METRICS_TOKEN to enable /api/metrics, UPLOADS_ENC_KEY for encryption at rest, provider keys.
kubectl -n credaflow create secret generic credaflow-app --from-env-file=lender.secrets.env

helm upgrade --install credaflow deploy/helm/credaflow -n credaflow \
  --set image.repository=registry.example/credaflow --set image.tag=$GIT_SHA \
  --set migrate.image.repository=registry.example/credaflow-migrate --set migrate.image.tag=$GIT_SHA \
  --set config.NEXTAUTH_URL=https://staff.lender.example --set config.AUTH_URL=https://staff.lender.example \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=staff.lender.example' \
  --set persistence.storageClass=<a ReadWriteMany class> \
  --wait --timeout 15m
```

The chart never creates Secrets: name existing ones in `existingSecrets` (External Secrets, Sealed
Secrets, Vault agent...). The Secret must exist before the migration hook runs. A separate
client-portal host is a second release: `--set web.appMode=client --set worker.enabled=false`, its own
`AUTH_SECRET` / `NEXTAUTH_URL` / `AUTH_URL`, same database and uploads claim.

## Deployment models

The same chart; what changes is where the cluster and the database live.

| Model | Cluster | Database | Uploads | Notes |
|---|---|---|---|---|
| On-premises (bank data centre) | Customer's Kubernetes (OpenShift, Rancher, kubeadm) | Customer's PostgreSQL 16 cluster or an operator (CloudNativePG, Crunchy) | NFS or CephFS, `ReadWriteMany` | Air-gapped: mirror the two images and the chart into the internal registry; set `networkPolicy.databaseTo` to the DB subnet; SIEM and Prometheus are the bank's. Tracing off or to an internal collector. |
| Public cloud | EKS / AKS / GKE | RDS / Azure Database / Cloud SQL, PostgreSQL 16, private networking | EFS / Azure Files / Filestore | Ingress via the cloud's controller; `serviceAccount.annotations` for workload identity if a secrets manager is used; one node pool per zone. |
| SaaS (operator hosted) | One cluster, one namespace and one release per lender | One database per lender (never shared across lenders) | One claim per lender | `NetworkPolicy` enforces namespace isolation; per-lender image because of `NEXT_PUBLIC_*`; `LOG_FORMAT=json` and the lender name in `OTEL_SERVICE_NAME`/log labels for per-lender dashboards. |

### Releases and migrations

The pre-upgrade Job applies migrations while the old pods still serve. That is safe for additive,
nullable changes. **A migration that adds a trigger, CHECK or UNIQUE takes effect immediately and
rejects writes the old code still makes** (`CLAUDE.md`, "The Database Enforces the Rules"). Ship such a
migration with its code as a maintenance-window upgrade: `kubectl scale deploy/<release>-credaflow-web
--replicas=0`, `helm upgrade`, scale back (disable the HPA first). Zero-downtime upgrades hold for
expand/contract migrations only.

Roll back with `helm rollback`; it does not roll the schema back.

## Observability

All three are off until configured, so a plain install changes nothing.

**Logs.** `LOG_FORMAT=json` (the chart's default) turns every `console.*` call into one JSON line on
stdout/stderr: `time, level, service, component, message` plus `trace_id` and `span_id` when tracing is on.
Collect with the cluster's log agent (Fluent Bit, Promtail, Vector) and index `trace_id`.

**Traces.** Set `observability.otlpEndpoint` (OTLP/HTTP, port 4318) to an OpenTelemetry Collector, Tempo or
Jaeger. Next.js request, render and fetch spans are exported; `service.name` is `credaflow-web` or
`credaflow-worker`. Sampling and headers use the standard `OTEL_*` variables via `observability.extraEnv`
(`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`). Database queries are not traced.

**Metrics.** Add `METRICS_TOKEN` to the Secret; `GET /api/metrics` then answers a Prometheus scrape with
`Authorization: Bearer <token>` (404 while unset, 401 on a wrong token). Series: `credaflow_http_requests_total`,
`credaflow_http_request_duration_seconds` (route labels have ids collapsed and are capped at 500),
`credaflow_cron_runs_total{job,outcome}` (worker pod), `credaflow_cron_last_success_timestamp_seconds`,
`credaflow_cron_freshness_budget_seconds`, `credaflow_database_up`, `credaflow_webhook_outbox_failures_24h`, and Node.js
process metrics. With Prometheus Operator: `--set serviceMonitor.enabled=true`. Block the path at the edge, e.g.
nginx ingress annotation `nginx.ingress.kubernetes.io/server-snippet: "location = /api/metrics { return 404; }"`
(if snippets are allowed on the controller). Queue depth is not exported (see limits).

**Dashboards and alerts.** `monitoring/grafana-dashboard.json` (import in Grafana, choose the Prometheus data
source) and `monitoring/prometheus-alerts.yaml`:

| Alert | Condition |
|---|---|
| `CredaFlowHigh5xxRate` | 5xx above 5% of requests for 10 min |
| `CredaFlowHighP95Latency` | p95 above 3 s for 10 min |
| `CredaFlowDatabaseDown` | `credaflow_database_up == 0` for 2 min |
| `CredaFlowCronJobFailing` | any cron run not `ok` in 30 min |
| `CredaFlowCronJobStale` | no success within the job's freshness budget |
| `CredaFlowMetricsAbsent`, `CredaFlowPodsUnavailable`, `CredaFlowWebhookOutboxFailures`, `CredaFlowEventLoopLag` | scrape lost, rollout stuck, lost webhook events, blocked event loop |

Health endpoints: `/api/health/live` (process), `/api/health/ready` (database; the pod probe),
`/api/health` (database + storage round trip; operators also get cron freshness and warnings).

## CI

`.github/workflows/security.yml` (separate from the quality gate): Semgrep SAST, `npm audit --omit=dev
--audit-level=high`, gitleaks over the full history, Trivy on the runner and migrator images (HIGH and CRITICAL,
unfixed ignored). Scanners are pinned by digest or sha256; actions by commit SHA. Runs on pull requests, weekly and
on demand. It is not a required check until branch protection is changed.

## Verify a chart change

```bash
helm lint deploy/helm/credaflow -f deploy/helm/credaflow/ci/full-values.yaml
helm template rel deploy/helm/credaflow -f deploy/helm/credaflow/ci/full-values.yaml | kubeconform -strict -ignore-missing-schemas -
promtool check rules deploy/monitoring/prometheus-alerts.yaml
```
