/**
 * The nightly outcome job (DESIGN.md §4): for every ACTIVE tenant, in its own
 * tenant frame, each source adapter derives outcomes and the writer converges
 * DecisionOutcome on them. It reads servicing tables and writes only
 * DecisionOutcome: it sends nothing to anyone and changes no loan.
 */
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { sweepActiveTenants, tenantFailureDetail } from "@/lib/ops/tenant-sweep"
import type { OutcomeSourceAdapter } from "./adapter"
import { credaflowOutcomeAdapter } from "./credaflow-adapter"
import { syncOutcomes, type OutcomeWriterDb, type SyncCounts } from "./writer"

/** The writer's client plus the tenant's demo-lender flag. */
export type OutcomeJobDb = OutcomeWriterDb & Pick<typeof prisma, "tenantConfig">

export interface TenantOutcomeRun {
  sourceSystem: string
  decisions: number
  outcomes: number
  failedLoans: number
  written: SyncCounts
}

/** One tenant, inside its frame. A loan whose derivation threw is counted and logged; the rest are written. */
export async function runTenantDecisionOutcomes(
  tenantId: string,
  asOf: Date,
  adapters: readonly OutcomeSourceAdapter[] = [credaflowOutcomeAdapter(prisma)],
  db: OutcomeJobDb = prisma,
): Promise<TenantOutcomeRun[]> {
  const today = sastCalendarDate(asOf)
  // A demo lender's rows are kept and marked; a real lender's never include simulated rows (decision 4).
  const demoTenant = (await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }))?.isDemoLender === true
  const runs: TenantOutcomeRun[] = []
  for (const adapter of adapters) {
    const result = await adapter.derive({ tenantId, asOf, today, demoTenant })
    // No logger module exists yet; console.error matches lib/ops/tenant-sweep.ts.
    for (const f of result.failures) console.error(`[cron/decision-outcomes] tenant ${tenantId} ${adapter.sourceSystem} loan ${f.ref} failed: ${f.error}`)
    const written = await syncOutcomes(db, {
      tenantId, sourceSystem: adapter.sourceSystem, decisionRecordIds: result.decisionRecordIds, outcomes: result.outcomes, computedAt: asOf,
      demoData: demoTenant,
      keepDecisionRecordIds: result.failures.map((f) => f.decisionRecordId),
    })
    runs.push({
      sourceSystem: adapter.sourceSystem, decisions: new Set(result.decisionRecordIds).size,
      outcomes: result.outcomes.length, failedLoans: result.failures.length, written,
    })
  }
  return runs
}

export async function runDecisionOutcomes(asOf: Date) {
  const outcomes = await sweepActiveTenants("decision-outcomes", (tenant) => runTenantDecisionOutcomes(tenant.id, asOf))
  const perTenant = outcomes.map((o) => (o.ok
    ? { tenantId: o.tenant.id, runs: o.value }
    : { tenantId: o.tenant.id, error: tenantFailureDetail(o.tenant) }))
  return {
    tenants: outcomes.length,
    failedTenants: outcomes.filter((o) => !o.ok).length,
    failedLoans: outcomes.reduce((n, o) => n + (o.ok ? o.value.reduce((m, r) => m + r.failedLoans, 0) : 0), 0),
    perTenant,
  }
}
