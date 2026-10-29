import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { verifyAuditChains } from "@/lib/audit/chain-verify"

/**
 * Walks the signed-in lender's AuditLog hash chain now and reports the first
 * broken link, or that it holds. ADMIN and above; the lender's own chain only.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const result = await verifyAuditChains(prisma, { chainKey: tenant.id })
    return NextResponse.json({ ...result, checkedAt: new Date().toISOString() })
  })
}
