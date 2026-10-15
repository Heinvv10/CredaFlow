import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runWithTenant } from "@/lib/tenant-scope"
import { refreshTenantScreening, type RefreshResult } from "@/lib/screening/refresh"
import { RESCREEN_TIME_BUDGET_MS } from "@/lib/screening/policy"

/**
 * Periodic PEP / sanctions re-screen (lib/screening/refresh.ts) for every
 * tenant with a screening provider configured. Tenants without one are not
 * read at all. CRON_SECRET-gated.
 *
 * Any provider error or failed client makes the response 503: the scheduler
 * treats only a non-2xx as a failure, and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const runAt = new Date()
  // One wall-clock budget across tenants; what is left is reported, not dropped.
  const deadline = runAt.getTime() + RESCREEN_TIME_BUDGET_MS
  const tenants = await prisma.tenantConfig.findMany({
    where: { screeningProvider: { not: null } },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  })

  const perTenant: Array<({ tenantId: string } & RefreshResult) | { tenantId: string; error: string }> = []
  for (const { tenantId } of tenants) {
    try {
      const result = await runWithTenant(tenantId, async () => await refreshTenantScreening(tenantId, runAt, deadline))
      perTenant.push({ tenantId, ...result })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !("error" in t) && t.failed === 0)
  return NextResponse.json({ ok, runAt: runAt.toISOString(), perTenant }, { status: ok ? 200 : 503 })
}
