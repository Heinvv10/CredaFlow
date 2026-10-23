/**
 * The nightly retention job (DESIGN.md §2.7): for every ACTIVE tenant, in its
 * own tenant frame, pseudonymise the credit decision records older than the
 * lender's retention period. The database function owns the clock (now()), the
 * tenant (the transaction's app.tenant_id, set here) and the one UPDATE the
 * append-only trigger allows (migration 20261023200000_decision_record_retention);
 * this only calls it and audits what it changed. A lender with no period set
 * changes nothing.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { sweepActiveTenants, tenantFailureDetail } from "@/lib/ops/tenant-sweep"

export type RetentionDb = Pick<typeof prisma, "$transaction">

export interface TenantRetentionRun {
  retentionMonths: number | null
  pseudonymised: number
}

/** One tenant, inside its frame; the change and its audit row commit together. */
export async function pseudonymiseTenantDecisionRecords(
  tenantId: string,
  db: RetentionDb = prisma,
): Promise<TenantRetentionRun> {
  return db.$transaction(async (tx) => {
    // The function takes its tenant from the transaction (RLS' own setting), so a
    // deployment with TENANT_RLS off, whose hook sets nothing, still names one.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { decisionRecordRetentionMonths: true } })
    const retentionMonths = config?.decisionRecordRetentionMonths ?? null
    if (retentionMonths === null) return { retentionMonths, pseudonymised: 0 }
    const [row] = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT public."pseudonymiseCreditDecisionRecords"() AS "count"`
    const pseudonymised = row?.count ?? 0
    if (pseudonymised > 0) {
      await logAuditStrict({
        tenantId, action: AuditAction.DECISION_RECORDS_PSEUDONYMISED,
        entity: "TenantConfig", entityId: tenantId, newValue: { retentionMonths, pseudonymised },
      }, tx)
    }
    return { retentionMonths, pseudonymised }
  })
}

export async function runDecisionRecordRetention() {
  const outcomes = await sweepActiveTenants("decision-record-retention", (tenant) => pseudonymiseTenantDecisionRecords(tenant.id))
  const perTenant = outcomes.map((o) => (o.ok
    ? { tenantId: o.tenant.id, ...o.value }
    : { tenantId: o.tenant.id, error: tenantFailureDetail(o.tenant) }))
  return {
    tenants: outcomes.length,
    failedTenants: outcomes.filter((o) => !o.ok).length,
    pseudonymised: outcomes.reduce((n, o) => n + (o.ok ? o.value.pseudonymised : 0), 0),
    perTenant,
  }
}
