import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sweepTenantCharges } from "@/lib/loan/charges-sweep"
import { sweepActiveTenants, sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * Nightly default-charges sync. Default interest accrues by the day and the
 * post-maturity service fee on the 1st, whether or not a receipt arrives, so
 * every collectible loan of every ACTIVE tenant with
 * TenantConfig.defaultChargesEnabled is re-derived here
 * (lib/loan/charges-sync.ts). Tenants with the flag off are not read at all.
 *
 * A failed loan makes the response 503, as does every swept tenant failing; one
 * tenant whose sweep could not start is named in `perTenant` and answered 200
 * partial (sweepStatus). The scheduler treats only a non-2xx as a failure and
 * never reads the body, so the causes are logged, not returned.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const asOf = new Date()
  const outcomes = await sweepActiveTenants("default-charges", async (tenant) => {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId: tenant.id },
      select: { defaultChargesEnabled: true, defaultChargesStartedAt: true },
    })
    // Flag on AND go-live recorded: the flag alone posts nothing.
    if (!config?.defaultChargesEnabled || !config.defaultChargesStartedAt) return null
    return sweepTenantCharges(prisma, tenant.id, asOf, { source: "cron:default-charges" })
  })

  const perTenant: Array<{ tenantId: string; loans: number; changed: number; failures: Array<{ loanId: string }> } | { tenantId: string; error: "failed; see the server log" }> = []
  let failedLoans = 0
  let failedTenants = 0
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failedTenants++
      perTenant.push({ tenantId: outcome.tenant.id, error: "failed; see the server log" })
    } else if (outcome.value) {
      const { loans, changed, failures } = outcome.value
      for (const f of failures) console.error(`[cron/default-charges] tenant ${outcome.tenant.id} loan ${f.loanId} failed: ${f.error}`)
      failedLoans += failures.length
      perTenant.push({ tenantId: outcome.tenant.id, loans, changed, failures: failures.map((f) => ({ loanId: f.loanId })) })
    }
  }

  const { status, partial } = sweepStatus({ tenants: perTenant.length, failedTenants, otherErrors: failedLoans })
  return NextResponse.json({ ok: status === 200, partial, runAt: asOf.toISOString(), perTenant }, { status })
}
