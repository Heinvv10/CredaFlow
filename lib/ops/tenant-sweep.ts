import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"

export interface SweepTenant {
  id: string
  name: string
}

export type TenantSweepOutcome<T> =
  | { tenant: SweepTenant; ok: true; value: T }
  | { tenant: SweepTenant; ok: false; error: string }

/**
 * Runs a nightly job once for EVERY ACTIVE tenant, each inside its own tenant
 * frame (the pattern of app/api/cron/cross-sell/route.ts). The crons run with
 * no request, so without a frame the tenant-scope extension cannot inject a
 * tenantId, and "the first ACTIVE tenant" would leave every other lender's
 * borrowers unreminded and unescalated.
 *
 * A tenant that throws (an unconfigured lender identity, say) is reported in
 * its outcome and never stops the tenants after it: the caller counts it as an
 * error so the cron answers 503.
 */
export async function sweepActiveTenants<T>(job: string, run: (tenant: SweepTenant) => Promise<T>): Promise<TenantSweepOutcome<T>[]> {
  const tenants = await prisma.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  })
  const outcomes: TenantSweepOutcome<T>[] = []
  for (const tenant of tenants) {
    try {
      outcomes.push({ tenant, ok: true, value: await runWithTenant(tenant.id, () => run(tenant)) })
    } catch (error) {
      console.error(`[cron/${job}] tenant ${tenant.id} failed:`, error)
      outcomes.push({ tenant, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}

/**
 * The detail line for a tenant whose run threw. Generic on purpose: the cause is
 * in the server log (sweepActiveTenants), and a cron response is not the place
 * for an exception message.
 */
export function tenantFailureDetail(tenant: SweepTenant): string {
  return `Tenant ${tenant.name} (${tenant.id}) failed; see the server log`
}

/**
 * The HTTP status of a sweep. A tenant that fails every night (an unconfigured
 * lender identity, say) is reported as that tenant's failure (`partial`, in the
 * body and the log) without turning the whole job red: 503 only when EVERY
 * tenant failed, or something other than a tenant failure went wrong
 * (`otherErrors`: sends that failed, reconciliation needed). The scheduler, the
 * run claim and /api/health all read a 2xx as a run that did its work.
 */
export function sweepStatus(s: { tenants: number; failedTenants: number; otherErrors: number }): { status: 200 | 503; partial: boolean } {
  const allFailed = s.tenants > 0 && s.failedTenants === s.tenants
  return { status: allFailed || s.otherErrors > 0 ? 503 : 200, partial: s.failedTenants > 0 && !allFailed }
}
