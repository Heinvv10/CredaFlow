import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { screenSubjectNow, subjectScreeningResponse } from "@/lib/screening/subject-route"

/**
 * GET  /api/asset-finance/entities/[id]/screening — the entity's own screening
 *      state and latest run (its related people are screened as clients).
 * POST /api/asset-finance/entities/[id]/screening — screen the entity now
 *      (MANUAL, audited by runScreening).
 *
 * CREDIT_OFFICER and up, as for a client. Deciding a match is the senior
 * review route (/api/screening/checks/[id]/review).
 */
async function entityInTenant(tenantId: string, entityId: string): Promise<boolean> {
  const entity = await prisma.businessEntity.findFirst({ where: { id: entityId, tenantId }, select: { id: true } })
  return entity !== null
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await ctx.params
    if (!(await entityInTenant(tenant.id, id))) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    return subjectScreeningResponse(tenant.id, { entityId: id })
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await ctx.params
    if (!(await entityInTenant(tenant.id, id))) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    return screenSubjectNow(tenant.id, { entityId: id }, { id: guard.user.id, email: guard.user.email })
  })
}
