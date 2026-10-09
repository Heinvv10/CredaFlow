import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runWithTenant } from "@/lib/tenant-scope"
import { sweepTenantCharges, type SweepResult } from "@/lib/loan/charges-sweep"

/**
 * Nightly default-charges sync. Default interest accrues by the day and the
 * post-maturity service fee on the 1st, whether or not a receipt arrives, so
 * every collectible loan of every tenant with TenantConfig.defaultChargesEnabled
 * is re-derived here (lib/loan/charges-sync.ts). Tenants with the flag off are
 * not read at all.
 *
 * Any failed loan or tenant makes the response 503: the scheduler treats only
 * a non-2xx as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const asOf = new Date()
  const tenants = await prisma.tenantConfig.findMany({
    // Flag on AND go-live recorded: the flag alone posts nothing.
    where: { defaultChargesEnabled: true, defaultChargesStartedAt: { not: null } },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  })

  const perTenant: Array<({ tenantId: string } & SweepResult) | { tenantId: string; error: string }> = []
  for (const { tenantId } of tenants) {
    try {
      const result = await runWithTenant(tenantId, async () =>
        await sweepTenantCharges(prisma, tenantId, asOf, { source: "cron:default-charges" }))
      perTenant.push({ tenantId, ...result })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !("error" in t) && t.failures.length === 0)
  return NextResponse.json(
    { ok, runAt: asOf.toISOString(), perTenant },
    { status: ok ? 200 : 503 },
  )
}
