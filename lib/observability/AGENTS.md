<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: lib/observability
<!-- summary: JSON console logs, OpenTelemetry tracing, Prometheus metrics; each off until its env is set -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Logs, traces and `/api/metrics` for the Kubernetes deployment (`deploy/README.md`).
`instrumentation.ts` starts them; every one is off unless its env is set, so a Compose
stack behaves as before.

## Rules
- The metrics registry lives on `globalThis` (`metrics.ts`): `instrumentation.ts`, the
  HTTP hook and the route handlers are bundled separately, and a module-level registry
  would exist once per bundle. Create metrics through `getMetrics()` only.
- `route-label.ts` labels a request with its Next route template from
  `.next/routes-manifest.json` (shipped in the standalone image); unmatched paths and
  every 404 are `unmatched`. Without a manifest (dev, tests) it falls back to path
  shapes with a cap. Never put a client id, loan id, token or any request-derived free
  text in a metric label.
- `span-scrub.ts` is deny-by-default: every string attribute, the span name and event
  attributes lose `?query`, `#fragment` and `user:pass@`; `http.*.header.*` are dropped.
  Do not turn it into a key allow-list; attribute names change between Next versions.
- `/api/metrics` is 404 until `METRICS_TOKEN` is set, then bearer-only. It is in
  `lib/public-routes.ts` because it authenticates itself, like `/api/cron/*`.
- DB-backed gauges (`metrics-collectors.ts`) read only tables without row-level
  security (`CronHeartbeat`, `WebhookOutboxFailure`). A count over a tenant table
  would be 0 under RLS without a tenant context: do not add one here.
- `json-console.ts` rewrites `console.*` (LOG_FORMAT=json). New code may use `logger`.
  Do not put personal data in log messages, with either.
- `CRON_SCHEDULER=off` (`lib/ops/cron-scheduler-flag.ts`) is for web replicas beside the
  one worker; only `singleRun` cron jobs are claim-guarded, the rest fire on every
  scheduling replica.
