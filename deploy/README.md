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
| `CronJob` per external job | `messaging-retry`, `email-poll`, `lead-task-reminders`, `cleanup-notifications`: the routes the registry marks `owner: "external"`, which nothing in the application schedules. Each calls the web Service with `x-cron-secret` (`concurrencyPolicy: Forbid`, SAST `timeZone`). See "External cron jobs". |
| `Job` migrate | Helm `pre-install,pre-upgrade` hook: `prisma migrate deploy` from the `migrator` image. A failed Job fails the release before any pod changes. |
| `NetworkPolicy` | Web ingress from the ingress controller (default: ingress-nginx's namespace; replace `networkPolicy.ingressFrom` for any other controller) and metrics scraper only. Egress: DNS, PostgreSQL, and provider ports on public addresses (private ranges excluded: list private providers under `egressExtra`, narrow `databaseTo` to the database). |
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
few seconds a worker restarts. Never set `worker` above one replica.

**A restart can skip a daily job.** In-process jobs are fired by `node-cron` at their minute; there is no
catch-up. If the worker is down at 06:00:00, `arrangement-check` does not run that day (only `singleRun`
jobs retry, +30 and +60 minutes). The `CredaFlowCronJobStale` alert and `/api/health` (operator view,
`cronJobs[].stale`) show it. Re-run by hand, from the worker pod, which already has the secret and the public host:

```bash
ROUTE=arrangement-check METHOD=GET   # METHOD is POST for insurance-renewal, cross-sell, dormant-clients
kubectl -n credaflow exec deploy/<release>-credaflow-worker -- node -e '
  const h = { "x-cron-secret": process.env.CRON_SECRET };
  if (process.env.NEXTAUTH_URL) h.host = new URL(process.env.NEXTAUTH_URL).host;
  require("http").request({ host: "127.0.0.1", port: 3300, path: "/api/cron/" + process.argv[1], method: process.argv[2], headers: h },
    (r) => { console.log(r.statusCode); r.resume(); }).end()' "$ROUTE" "$METHOD"
```

Read the route's own comment first (`app/api/cron/<route>/route.ts`) and `docs/DEPLOY.md`: most sweeps are
idempotent for a same-day re-run, but reminders and Section 129 notices are the reason the dedupe exists.
The kind smoke test of this chart showed the worker's per-minute jobs running; a missed daily one is a manual step.

## External cron jobs

`lib/registry/cron-jobs/100-external-scheduler.ts` lists four routes the application never schedules: its
comment says the deployment's scheduler must call them. Under this chart that is `externalCrons` in `values.yaml`,
one `CronJob` each, running the application image with `node -e` (no shell, no `curl`): `GET` on the web Service with
`x-cron-secret` from `externalCrons.secret` (only that key reaches the pod) and the public host as `Host`. A non-2xx
response fails the Job; the `CredaFlowExternalCronFailed` alert watches `kube_job_status_failed`.

| Route | Schedule (SAST) | Source |
|---|---|---|
| `messaging-retry` | every minute | route comment: "every 60 seconds" |
| `email-poll` | every 5 minutes | route comment: "every few minutes" |
| `lead-task-reminders` | 09:00 | demo simulator slot (`scripts/demo/sim/cron.ts`) |
| `cleanup-notifications` | 23:30 | demo simulator slot |

09:00 and 23:30 were confirmed for the Lesotho PostBank bid. A lender with other times overrides `externalCrons.jobs` in its values file; Helm replaces a list whole, so give all four entries, e.g. `externalCrons.jobs: [{ route: messaging-retry, schedule: "* * * * *" }, ...]`.
`external-crons.test.ts` fails when the registry gains an external route the chart does not list. Set
`externalCrons.enabled=false` if the operator already runs these from their own scheduler (never both: duplicate borrower
messages), and in a `web.appMode=client` release (the audience gate 404s cron routes). `messaging-retry` creates a pod a
minute; that is the price of keeping the schedule out of the application.

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
# CRON_SECRET; add METRICS_TOKEN to enable /api/metrics, UPLOADS_ENC_KEY for encryption at rest, SSO_SECRET_KEY
# (encrypts the SSO client secret; required before SSO is configured, docs/SSO-AND-OAUTH.md), provider keys.
# Also set in values (not secrets): config.NEXTAUTH_URL / AUTH_URL and config.TRUSTED_PROXY, see "Client IP".
kubectl -n credaflow create secret generic credaflow-app --from-env-file=lender.secrets.env

# image.tag is required and "latest" is refused. A digest ("sha256:...") also needs migrate.image.tag.
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
Secrets, Vault agent...). The Secret must exist before the migration hook runs; the hook receives only
`MIGRATE_DATABASE_URL` (`migrate.databaseUrlSecret`), the cron Jobs only `CRON_SECRET` (`externalCrons.secret`).

**Two database logins.** `MIGRATE_DATABASE_URL` is the owner login (it owns the schema and runs migrations and
the role Job); the pods' `DATABASE_URL` is a different login, `appRole.name`, that owns nothing. The
`app-role` Job runs `files/app-role.sql` right after the migration Job, before any pod changes: the role gets the table privileges
and loses the audit evidence tables, so a compromised pod can insert and read `AuditLog` but cannot rewrite
it, switch a trigger off or touch the hash chain, checkpoints or SIEM queue. Also set `AUDIT_CHAIN_KEY`
(32+ characters, not in the database). `/api/health` warns while the pods' role owns or can write those tables.

A separate client-portal host is a second release of the same chart, in the same namespace:

```bash
# migrate.enabled=false: the staff release owns migrations.
# persistence.existingClaim: the staff release's uploads claim.
# existingSecrets: a Secret with its own AUTH_SECRET and the same DATABASE_URL.
helm upgrade --install credaflow-portal deploy/helm/credaflow -n credaflow \
  --set image.repository=... --set image.tag=$GIT_SHA \
  --set web.appMode=client --set worker.enabled=false --set externalCrons.enabled=false \
  --set migrate.enabled=false \
  --set persistence.existingClaim=credaflow-credaflow-uploads \
  --set 'existingSecrets={credaflow-portal}' \
  --set config.NEXTAUTH_URL=https://portal.lender.example --set config.AUTH_URL=https://portal.lender.example
```

`persistence.existingClaim` needs a ReadWriteMany volume, and the portal release's pods must be able to mount it.

## Deployment models

The same chart; what changes is where the cluster and the database live.

| Model | Cluster | Database | Uploads | Notes |
|---|---|---|---|---|
| On-premises (bank data centre) | Customer's Kubernetes (OpenShift, Rancher, kubeadm) | Customer's PostgreSQL 16 cluster or an operator (CloudNativePG, Crunchy) | NFS or CephFS, `ReadWriteMany` | Air-gapped: mirror the two images and the chart into the internal registry; set `networkPolicy.databaseTo` to the DB subnet; SIEM and Prometheus are the bank's. Tracing off or to an internal collector. |
| Public cloud | EKS / AKS / GKE | RDS / Azure Database / Cloud SQL, PostgreSQL 16, private networking | EFS / Azure Files / Filestore | Ingress via the cloud's controller; `serviceAccount.annotations` for workload identity if a secrets manager is used; one node pool per zone. |
| SaaS (operator hosted) | One cluster, one namespace and one release per lender | One database per lender (never shared across lenders) | One claim per lender | `NetworkPolicy` enforces namespace isolation; per-lender image because of `NEXT_PUBLIC_*`; `LOG_FORMAT=json` and the lender name in `OTEL_SERVICE_NAME`/log labels for per-lender dashboards. |

### Client IP

The application takes the caller's address from `X-Forwarded-For`, counting `TRUSTED_PROXY` hops from the right
(`lib/rate-limit.ts`). The chart sets `config.TRUSTED_PROXY: "1"`, right for one ingress controller that appends
the address it saw. Unset, every request is "unknown": one login rate-limit bucket for all users, no IP in audit
rows, no staff IP allowlist. Set it to the number of proxies **that append**:

| In front of the pods | `TRUSTED_PROXY` | Also required |
|---|---|---|
| ingress-nginx, reached directly (bare metal, MetalLB) | 1 | |
| ingress-nginx behind a cloud load balancer | 1 | Preserve the client address at the LB (`externalTrafficPolicy: Local`, or PROXY protocol with `use-proxy-protocol: "true"`), else nginx sees the LB's address for everyone |
| CDN (Cloudflare, CloudFront) then ingress | 2 | The ingress must trust and append to the CDN's header (`use-forwarded-headers: "true"`), **and accept connections only from the CDN's published IP ranges** (`networkPolicy.ingressFrom` / a load-balancer source-range allow-list): otherwise a client that reaches the ingress directly sends its own `X-Forwarded-For` and chooses the address CredaFlow records |
| L7 cloud LB (ALB, GCLB) straight to the pods through the ingress | 2 | Verify with a request and read the audit row |

Too low: the proxy's own address is used (everyone shares a bucket). Too high: the client can forge its address by
sending its own `X-Forwarded-For`. The pods must not be reachable except through the proxies; the default
NetworkPolicy enforces that for the web pods.

### Rate limits are per pod

`lib/rate-limit.ts` keeps its counters in memory ("single-replica deployments only" in its header). With N web
replicas the effective limit on a login, OTP or API key is up to N times the configured one, and a restart resets it.
That is a known limit of this release, not a feature of the chart; a Postgres-backed limiter is a separate work item.
Until then, enforce an edge limit at the ingress for the login and portal OTP paths
(`nginx.ingress.kubernetes.io/limit-rps`).

### Releases and migrations

The pre-upgrade Job applies migrations while the old pods still serve. That is safe for additive,
nullable changes. **A migration that adds a trigger, CHECK or UNIQUE takes effect immediately and
rejects writes the old code still makes** (`CLAUDE.md`, "The Database Enforces the Rules"). Such a migration
ships with its code in a maintenance window, with every pod down while it runs. The hook runs on *every*
`helm upgrade`, so the order matters; this is the sequence (`-f lender.yaml` is the release's own values file):

```bash
RELEASE=credaflow; NS=credaflow; CHART=deploy/helm/credaflow
DOWN="--set autoscaling.enabled=false --set web.replicaCount=0 --set worker.enabled=false --set externalCrons.enabled=false"

# 1. Stop everything. --no-hooks: do not migrate yet, the old code is still the running version.
helm upgrade $RELEASE $CHART -n $NS -f lender.yaml --set image.tag=$OLD_TAG $DOWN --no-hooks --wait
# helm --wait returns while the old pods are still terminating (up to 70 s): wait until they are gone.
kubectl -n $NS wait --for=delete pod --timeout=180s \
  -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component in (web,worker)"

# 2. Migrate with nothing running: the hook Job runs before the (zero-replica) rollout.
helm upgrade $RELEASE $CHART -n $NS -f lender.yaml --set image.tag=$NEW_TAG $DOWN --wait

# 3. Start the new code. The hook runs again and finds nothing to apply.
helm upgrade $RELEASE $CHART -n $NS -f lender.yaml --set image.tag=$NEW_TAG --wait
```

Step 1 removes the HPA, the web pods, the worker and the cron Jobs together (a plain `kubectl scale` is undone by the
HPA, and the worker would keep firing jobs against a half-migrated schema). Cron firings that fall inside the window
are lost like any worker restart (see "A restart can skip a daily job"). Zero-downtime upgrades hold for
expand/contract migrations only. Rehearsed on a kind cluster (2026-10-29): the Job ran with no application pod up.

Roll back with `helm rollback`; it does not roll the schema back.

## Observability

All three are off until configured, so a plain install changes nothing.

**Logs.** `LOG_FORMAT=json` (the chart's default) turns every `console.*` call into one JSON line on
stdout/stderr: `time, level, service, component, message` plus `trace_id` and `span_id` when tracing is on.
Collect with the cluster's log agent (Fluent Bit, Promtail, Vector) and index `trace_id`.

**Traces.** Set `observability.otlpEndpoint` (OTLP/HTTP, port 4318) to an OpenTelemetry Collector, Tempo or
Jaeger. Next.js request, render and fetch spans are exported; `service.name` is `credaflow-web` or
`credaflow-worker`. Sampling and headers use the standard `OTEL_*` variables via `observability.extraEnv`
(`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`). Database queries are not traced. Before export every span is scrubbed (`lib/observability/span-scrub.ts`): query strings, fragments and `user:pass@` are removed from any URL-shaped value, header attributes are dropped, and the request path is replaced by its route template wherever it appears. That includes Next's middleware span, which carries the raw pathname: its path is mapped through the same route table as the metrics, so a one-time link token (`/pasq/<token>`) is exported as `/pasq/[token]` (as `unmatched` or `:id` shapes if the build has no routes manifest). The collector is reached through the `networkPolicy.otlpTo` rule, which defaults to a namespace called `observability`: set `networkPolicy.otlpTo` (and `otlpPort`) when the collector runs elsewhere, or outside the cluster add its address under `networkPolicy.egressExtra`; otherwise the NetworkPolicy blocks the export silently.

**Metrics.** Add `METRICS_TOKEN` to the Secret; `GET /api/metrics` then answers a Prometheus scrape with
`Authorization: Bearer <token>` (404 while unset, 401 on a wrong token). Series: `credaflow_http_requests_total`,
`credaflow_http_request_duration_seconds` (`route` is the matched Next route template, e.g. `/api/loans/[id]/statement`, read from `.next/routes-manifest.json`; every 404 is `unmatched`),
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
