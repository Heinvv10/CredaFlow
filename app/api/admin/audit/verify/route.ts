import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { chainStatus } from "@/lib/audit/store"

/**
 * The signed-in lender's audit chain status. ADMIN and above; the lender's own chain only.
 *
 * GET reads state, no walk: how far the chain is linked, the latest checkpoint and the last
 * verification results the daily job recorded. A walk needs AUDIT_CHAIN_KEY, which only the
 * worker holds (the web process has neither the key nor the database access): it is the daily
 * `audit-chain-verify` job, or `npm run audit:verify` run by an operator.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const status = await prisma.$transaction((tx) => chainStatus(tx, tenant.id))
    const results = await prisma.auditLog.findMany({
      where: { tenantId: tenant.id, action: { in: ["AUDIT_CHAIN_VERIFIED", "AUDIT_CHAIN_BROKEN"] } },
      orderBy: { createdAt: "desc" }, take: 10, select: { action: true, createdAt: true, newValue: true },
    })
    return NextResponse.json({
      chainedThroughSeq: status.headSeq,
      latestCheckpoint: status.checkpointSeq === null ? null : { seq: status.checkpointSeq, createdAt: status.checkpointAt },
      recentResults: results,
    })
  })
}
