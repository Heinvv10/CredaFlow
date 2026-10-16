/**
 * Typed helpers for registry entry files (docs/ARCHITECTURE.md, "Registries").
 *
 * Each list the app reads — audit actions, tenant-scoped models, cron jobs,
 * simulated integrations, permissions — is assembled from one small file per
 * domain under `lib/registry/<kind>/`. `scripts/gen-registries.ts` merges them
 * (sorted by path) into `lib/registry/generated/`, which is gitignored: two
 * PRs that each add an entry file never touch the same lines.
 *
 * Entry files hold data only. They import nothing but this module, because the
 * generator loads them outside the app.
 */

import type { UserRole } from "../permissions"

export const HOUR = 60
export const DAY = 24 * HOUR

export type AuditActionEntries = Readonly<Record<string, string>>

export function defineAuditActions<T extends AuditActionEntries>(actions: T): T {
  return actions
}

export function defineTenantScopedModels<T extends readonly string[]>(models: T): T {
  return models
}

/**
 * Who runs a `/api/cron/*` route. Every route under `app/api/cron/` must be
 * declared exactly once (instrumentation.cron-census.test.ts).
 *
 * - `in-process`: instrumentation.ts schedules it with node-cron, pinned to
 *   SAST; `freshnessMinutes` is how long it may go without a successful run
 *   before /api/health calls it stale (lib/ops/cron-heartbeat.ts) — about
 *   twice its schedule, plus slack.
 * - `external`: the deployment's own scheduler calls it with the cron secret.
 *   Nothing in this repository schedules it; it must never be in-process too.
 * - `unwired`: deliberately unscheduled, with the reason.
 */
export type CronJob =
  | {
      route: string
      owner: "in-process"
      schedule: string
      method?: "GET" | "POST"
      freshnessMinutes: number
    }
  | { route: string; owner: "external" }
  | { route: string; owner: "unwired"; reason: string }

export function defineCronJobs<T extends readonly CronJob[]>(jobs: T): T {
  return jobs
}

/** See lib/integrations/simulation-guard.ts. */
export type SimulationRule = {
  sandboxEnvVar: string | null
  sandboxSafeValues: readonly string[]
  legacyMessage?: string
}

export function defineSimulatedIntegrations<T extends Readonly<Record<string, SimulationRule>>>(rules: T): T {
  return rules
}

/**
 * Who holds each permission: one map, read by lib/auth-guards.ts `canDo` on
 * the server and lib/permissions.ts `canDo` on the client. A single role is a
 * minimum on the ladder (ROLE_HIERARCHY); a list grants exactly the roles it
 * names, for a permission the ladder would hand to a specialist role that
 * should not have it.
 */
export type PermissionRule = UserRole | readonly UserRole[]

export function definePermissions<T extends Readonly<Record<string, PermissionRule>>>(permissions: T): T {
  return permissions
}
